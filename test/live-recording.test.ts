import { describe, expect, it } from 'vitest';

import { parseHls, type HlsMedia } from '../src/shared/hls';
import type { FoundMedia } from '../src/shared/media';
import { listed, rankMedia, recordable, saveable } from '../src/shared/pick';
import { bufferAhead, DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

/** Live streams to record, and what a recording keeps. */
const media = (over: Partial<FoundMedia>): FoundMedia => ({
  id: over.url ?? 'x',
  kind: 'hls',
  url: 'https://cdn.x/live.m3u8',
  pageUrl: 'https://site.x/',
  foundAt: 1,
  ...over,
});

describe('a live stream', () => {
  it('a live HLS stream is listed to record, not to download; a live DASH one is not listed', () => {
    const hls = media({ live: true });
    const dash = media({ url: 'https://cdn.x/live.mpd', kind: 'dash', live: true });
    expect(listed([hls, dash])).toEqual([hls]);
    expect(saveable(hls)).toBe(false);
    expect(recordable(hls)).toBe(true);
    expect(recordable(media({ live: true, drm: true }))).toBe(false);
  });

  it('a page whose video is on air: the live stream is the video, a teaser file under it', () => {
    const live = media({ live: true });
    const teaser = media({ url: 'https://cdn.x/teaser.mp4', kind: 'file', size: 3 * 1024 * 1024 });
    const { main, others } = rankMedia([teaser, live]);
    expect(main).toBe(live);
    expect(others).toEqual([teaser]);
  });

  it('its playlist says how long a segment lasts: how often to ask again', () => {
    const m = parseHls(
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n',
      'https://cdn.x/p.m3u8',
    ) as HlsMedia;
    expect(m).toMatchObject({ live: true, targetDuration: 4 });
    expect(m.segments.map((s) => s.sequence)).toEqual([120, 121]);
  });
});

describe('recording without reloading', () => {
  const settings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });
  const GB = 1024 * 1024 * 1024;

  it('by default a recording reloads the page: nothing is buffered ahead', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ captureMode: 'reload', captureBufferMb: 2048 });
    expect(bufferAhead('https://site.x/v/1', DEFAULT_SETTINGS)).toBe(0);
  });

  it('on every site, or on the sites listed and their subdomains, as much as the settings say', () => {
    expect(bufferAhead('https://site.x/v/1', settings({ captureMode: 'all' }))).toBe(2 * GB);
    const listed = settings({
      captureMode: 'sites',
      captureSites: ['site.x'],
      captureBufferMb: 512,
    });
    expect(bufferAhead('https://m.site.x/v/1', listed)).toBe(GB / 2);
    expect(bufferAhead('https://other.x/v/1', listed)).toBe(0);
  });

  it('nothing on a site the extension is off on', () => {
    const s = settings({ captureMode: 'all', blockedSites: ['site.x'] });
    expect(bufferAhead('https://site.x/v/1', s)).toBe(0);
  });
});
