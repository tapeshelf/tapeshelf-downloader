import { describe, expect, it } from 'vitest';

import { formatBytes, formatDuration } from '../src/shared/format';
import type { FoundMedia } from '../src/shared/media';
import type { PageInfo, PageVideo } from '../src/shared/page-info';
import { fromUrl, mainMedia, pieces, rankMedia } from '../src/shared/pick';
import { defaultMeta, nameFromUrl, saveRequest } from '../src/shared/request';
import { DEFAULT_SETTINGS, normalizeServer } from '../src/shared/settings';

const media = (over: Partial<FoundMedia>): FoundMedia => ({
  id: over.url ?? 'x',
  kind: 'file',
  url: 'https://cdn.example.com/a.mp4',
  pageUrl: 'https://site.example.com/watch/1',
  foundAt: 1,
  ...over,
});
const video = (over: Partial<PageVideo>): PageVideo => ({
  width: 1280,
  height: 720,
  playing: false,
  area: 100,
  ...over,
});
const page: PageInfo = {
  url: 'https://site.example.com/watch/1',
  title: 'A trip to the sea',
  description: 'Waves.',
  adult: false,
  videos: [],
};

describe('the page’s video', () => {
  it('the one the biggest playing video element shows, else a stream, else the biggest file', () => {
    const small = media({ url: 'https://cdn.example.com/small.mp4', size: 10 });
    const big = media({ url: 'https://cdn.example.com/big.mp4', size: 99 });
    const hls = media({ url: 'https://cdn.example.com/m.m3u8', kind: 'hls', foundAt: 5 });
    const drm = media({
      url: 'https://cdn.example.com/drm.mpd',
      kind: 'dash',
      drm: true,
      foundAt: 9,
    });
    expect(
      mainMedia(
        [small, big, hls],
        [video({ src: small.url, playing: true, area: 900 }), video({ src: big.url, area: 999 })],
      ),
    ).toBe(small);
    expect(mainMedia([small, big, hls, drm])).toBe(hls);
    expect(mainMedia([small, big])).toBe(big);
    expect(mainMedia([drm])).toBeUndefined();
    // The rest under it, likeliest first; what cannot be saved last.
    const { main, others } = rankMedia([small, drm, big, hls]);
    expect(main).toBe(hls);
    expect(others.map((m) => m.url)).toEqual([big.url, small.url, drm.url]);
  });

  it('a stream page as a collection of recordings has it: the stream of the player’s length, pieces and previews under it', () => {
    const MB = 1024 * 1024;
    const recording = media({
      url: 'https://edge.example/rec/master.m3u8',
      kind: 'hls',
      duration: 974,
      foundAt: 1,
    });
    const teaser = media({
      url: 'https://edge.example/teaser/master.m3u8',
      kind: 'hls',
      duration: 100,
      foundAt: 2,
    });
    const parts = [501, 502, 503, 504].map((n) =>
      media({
        url: `https://cdn.example/v/mrg_284202242_720p_h264_${n}.mp4`,
        size: 2.8 * MB,
        foundAt: 3 + n,
      }),
    );
    const hover = media({
      url: 'https://cdn.example/previews/other.mp4',
      size: 3 * MB,
      foundAt: 9,
    });
    // The player builds its video from the stream's pieces: no address, only its length.
    const player = video({ playing: true, area: 900_000, duration: 974 });
    const small = video({ src: hover.url, area: 20_000, playing: true });
    const { main, others } = rankMedia([...parts, teaser, hover, recording], [player, small]);
    expect(main).toBe(recording);
    expect(others[0]).toBe(teaser);
    expect(others).toHaveLength(6);
    expect(pieces([...parts, hover, recording])).toEqual(new Set(parts.map((p) => p.id)));
    // Without the player, still the stream before the pieces.
    expect(mainMedia([...parts, recording])).toBe(recording);
  });

  it('a file the big player shows beats a bigger file; a small player’s file is a preview', () => {
    const MB = 1024 * 1024;
    const shown = media({ url: 'https://cdn.example/a.mp4', size: 30 * MB });
    const bigger = media({ url: 'https://cdn.example/b.mp4', size: 300 * MB });
    const preview = media({ url: 'https://cdn.example/c.mp4', size: 400 * MB });
    expect(
      mainMedia(
        [preview, bigger, shown],
        [
          video({ src: shown.url, area: 500_000 }),
          video({ src: preview.url, area: 10_000, playing: true }),
        ],
      ),
    ).toBe(shown);
  });

  it('a URL from the menu: one the tab found, or a new item of its kind', () => {
    const known = media({});
    expect(fromUrl(known.url, page.url, [known])).toBe(known);
    expect(fromUrl('https://x.com/live/index.m3u8?a=1', page.url, [])).toMatchObject({
      kind: 'hls',
      referer: page.url,
    });
  });
});

describe('what a video is saved as', () => {
  it('a file’s name from its address', () => {
    expect(nameFromUrl('https://x.com/media/Holiday%20clip_final.mp4?x=1')).toBe(
      'Holiday clip final',
    );
    expect(nameFromUrl('https://x.com/')).toBe('');
  });

  it('the page’s title and description, the defaults, 18+ for a page that says so', () => {
    const m = media({});
    expect(defaultMeta(m, page, DEFAULT_SETTINGS)).toEqual({
      title: 'A trip to the sea',
      description: 'Waves.',
      categoryId: undefined,
      visibility: 'PRIVATE',
      sensitive: false,
    });
    expect(defaultMeta(m, { ...page, adult: true }, DEFAULT_SETTINGS).sensitive).toBe(true);
    // Another page's info is not this video's.
    expect(
      defaultMeta(m, { ...page, url: 'https://other.example.com/' }, DEFAULT_SETTINGS).title,
    ).toBe('a');
    // A remembered category that is gone is left out.
    const settings = { ...DEFAULT_SETTINGS, categoryId: 'c1', visibility: 'PUBLIC' as const };
    expect(defaultMeta(m, page, settings, [{ id: 'c1' }])).toMatchObject({
      categoryId: 'c1',
      visibility: 'PUBLIC',
    });
    expect(defaultMeta(m, page, settings, [{ id: 'c2' }]).categoryId).toBeUndefined();
    expect(
      defaultMeta(m, { ...page, title: 'x'.repeat(400) }, DEFAULT_SETTINGS).title,
    ).toHaveLength(150);
  });

  it('the source link only when the settings say so', () => {
    const m = media({});
    const meta = defaultMeta(m, page, DEFAULT_SETTINGS);
    expect(saveRequest(m, meta, DEFAULT_SETTINGS).sourceUrl).toBeUndefined();
    expect(saveRequest(m, meta, { ...DEFAULT_SETTINGS, saveSource: true }, 'q').sourceUrl).toBe(
      page.url,
    );
    expect(
      saveRequest(m, { ...meta, description: '  ' }, DEFAULT_SETTINGS).meta.description,
    ).toBeUndefined();
  });
});

describe('settings and formatting', () => {
  it('a server address as an origin, https unless local', () => {
    expect(normalizeServer('videos.example.org')).toBe('https://videos.example.org');
    expect(normalizeServer('https://videos.example.org/some/page?x')).toBe(
      'https://videos.example.org',
    );
    expect(normalizeServer('http://localhost:4200/')).toBe('http://localhost:4200');
    expect(normalizeServer('http://videos.example.org')).toBeNull();
    expect(normalizeServer('not a server')).toBeNull();
    expect(normalizeServer('')).toBeNull();
  });

  it('sizes and lengths', () => {
    expect(formatBytes(1536 * 1024 * 1024, 'en')).toBe('1.5 GB');
    expect(formatBytes(230 * 1024 * 1024, 'en')).toBe('230 MB');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
