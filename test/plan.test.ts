import { describe, expect, it } from 'vitest';

import type { SaveRequest } from '../src/shared/media';
import { SaveError, fileExt, makePlan, planUrls, type Net } from '../src/offscreen/plan';

const MB = 1024 * 1024;
const net = (files: Record<string, string>, sizes: Record<string, number> = {}): Net => ({
  text: async (url) => {
    if (!(url in files)) throw new SaveError('source', 404);
    return files[url]!;
  },
  size: async (url) => sizes[url],
});
const request = (
  over: Partial<SaveRequest['media']>,
  extra: Partial<SaveRequest> = {},
): SaveRequest => ({
  media: {
    kind: 'file',
    url: 'https://cdn.example.com/a.mp4',
    pageUrl: 'https://site.example.com/',
    ...over,
  },
  pref: 'best',
  meta: { title: 'T', visibility: 'PRIVATE', sensitive: false },
  ...extra,
});

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,AUDIO="a"
1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"
360.m3u8
`;
const media = (name: string, init = false) => `#EXTM3U
${init ? '#EXT-X-MAP:URI="init.mp4"' : ''}
#EXT-X-KEY:METHOD=AES-128,URI="k.bin"
#EXTINF:50,
${name}-1.${init ? 'm4s' : 'ts'}
#EXTINF:50,
${name}-2.${init ? 'm4s' : 'ts'}
#EXT-X-ENDLIST`;
const B = 'https://cdn.example.com/s/';

describe('the download plan', () => {
  it('a file: its type from the address, its size from the request or a HEAD', async () => {
    expect(fileExt('https://x.com/a.webm?x')).toBe('webm');
    expect(fileExt('https://x.com/get', 'video/quicktime')).toBe('mov');
    expect(fileExt('https://x.com/get')).toBe('mp4');
    const plan = await makePlan(
      request({}),
      -1,
      net({}, { 'https://cdn.example.com/a.mp4': 1234 }),
    );
    expect(plan.video).toEqual({
      url: 'https://cdn.example.com/a.mp4',
      ext: 'mp4',
      mimeType: 'video/mp4',
      size: 1234,
    });
  });

  it('HLS: the best variant that fits the room, its segments with keys, the audio rendition apart', async () => {
    const files = {
      [`${B}master.m3u8`]: MASTER,
      [`${B}1080.m3u8`]: media('hd', true),
      [`${B}360.m3u8`]: media('sd', true),
      [`${B}audio.m3u8`]: media('aud', true),
    };
    const roomy = await makePlan(request({ kind: 'hls', url: `${B}master.m3u8` }), -1, net(files));
    expect(roomy.quality).toBe('1080p');
    expect(roomy.video.ext).toBe('mp4');
    expect(roomy.video.estimate).toBe(100 * 1_000_000);
    expect(roomy.video.segments!.map((s) => s.url.replace(B, ''))).toEqual([
      'init.mp4',
      'hd-1.m4s',
      'hd-2.m4s',
    ]);
    expect(roomy.video.segments![1]!.key).toEqual({ url: `${B}k.bin`, iv: null, sequence: 0 });
    expect(roomy.audio).toMatchObject({ ext: 'm4a', mimeType: 'audio/mp4' });
    // 100 MB for 1080p does not fit in 50: 360p does.
    const tight = await makePlan(
      request({ kind: 'hls', url: `${B}master.m3u8` }),
      50 * MB,
      net(files),
    );
    expect(tight.quality).toBe('360p');
    // The form's choice wins.
    const chosen = await makePlan(
      request({ kind: 'hls', url: `${B}master.m3u8` }, { quality: `${B}360.m3u8` }),
      -1,
      net(files),
    );
    expect(chosen.quality).toBe('360p');
    expect(planUrls(chosen)).toContain(`${B}k.bin`);
  });

  it('HLS without a master: MPEG-TS, the size from the first segment', async () => {
    const plan = await makePlan(
      request({ kind: 'hls', url: `${B}one.m3u8` }),
      -1,
      net({ [`${B}one.m3u8`]: media('x') }, { [`${B}x-1.ts`]: 5_000_000 }),
    );
    expect(plan.video).toMatchObject({ ext: 'ts', mimeType: 'video/mp2t', estimate: 10_000_000 });
  });

  it('refuses DRM and live streams', async () => {
    const drm = `#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://1"\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST`;
    await expect(
      makePlan(request({ kind: 'hls', url: `${B}d.m3u8` }), -1, net({ [`${B}d.m3u8`]: drm })),
    ).rejects.toMatchObject({
      code: 'drm',
    });
    const live = `#EXTM3U\n#EXTINF:5,\na.ts`;
    await expect(
      makePlan(request({ kind: 'hls', url: `${B}l.m3u8` }), -1, net({ [`${B}l.m3u8`]: live })),
    ).rejects.toMatchObject({
      code: 'live',
    });
  });

  it('DASH: the chosen video and the best audio, two tracks', async () => {
    const mpd = `<MPD mediaPresentationDuration="PT8S"><Period>
      <AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="4" initialization="$RepresentationID$/i.mp4" media="$RepresentationID$/$Number$.m4s"/>
        <Representation id="hi" bandwidth="4000000" height="1080"/><Representation id="lo" bandwidth="1000000" height="480"/></AdaptationSet>
      <AdaptationSet mimeType="audio/mp4"><Representation id="aud" bandwidth="128000"><BaseURL>aud.m4a</BaseURL></Representation></AdaptationSet>
    </Period></MPD>`;
    const plan = await makePlan(
      request({ kind: 'dash', url: `${B}m.mpd` }, { pref: 720 }),
      -1,
      net({ [`${B}m.mpd`]: mpd }),
    );
    expect(plan.quality).toBe('480p');
    expect(plan.video.segments!.map((s) => s.url.replace(B, ''))).toEqual([
      'lo/i.mp4',
      'lo/1.m4s',
      'lo/2.m4s',
    ]);
    expect(plan.audio).toEqual({
      ext: 'm4a',
      mimeType: 'audio/mp4',
      estimate: 128_000,
      url: `${B}aud.m4a`,
    });
  });
});
