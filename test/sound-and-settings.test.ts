import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { extractAudio, needsJoin } from '../src/offscreen/join';
import { SaveError, makePlan, type Net } from '../src/offscreen/plan';
import { parseDash } from '../src/shared/dash';
import { parseHls, type HlsMedia } from '../src/shared/hls';
import type { FoundMedia, SaveRequest } from '../src/shared/media';
import { downloadJob } from '../src/shared/request';
import { DEFAULT_SETTINGS, onSite, siteKey } from '../src/shared/settings';
import { sameLanguage } from '../src/shared/streams';

/**
 * the sound alone and MP3, the sound's language, subtitles of DASH, ad breaks
 * left out of HLS, a site's own file name, sites the extension is off on.
 */
const fixture = (name: string) =>
  new Blob([readFileSync(fileURLToPath(new URL(`fixtures/media/${name}`, import.meta.url)))]);

function memoryFile() {
  let bytes = new Uint8Array(0);
  const handle = {
    createWritable: async () =>
      new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
        write({ data, position }) {
          const end = position + data.byteLength;
          if (end > bytes.length) {
            const grown = new Uint8Array(end);
            grown.set(bytes);
            bytes = grown;
          }
          bytes.set(data, position);
        },
      }),
  } as unknown as FileSystemFileHandle;
  return { handle, bytes: () => bytes };
}

async function tracksOf(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const out = {
    format: (await input.getFormat()).name,
    codecs: (await input.getTracks()).map((t) => `${t.type}:${t.codec}`),
  };
  input.dispose();
  return out;
}

const never = new AbortController().signal;

const net = (files: Record<string, string>, sizes: Record<string, number> = {}): Net => ({
  text: async (url) => {
    if (!(url in files)) throw new SaveError('source', 404);
    return files[url]!;
  },
  size: async (url) => sizes[url],
});

const request = (
  media: Partial<SaveRequest['media']>,
  extra: Partial<SaveRequest> = {},
): SaveRequest => ({
  media: { kind: 'file', url: 'https://cdn.x/a.mp4', pageUrl: 'https://site.x/', ...media },
  pref: 'best',
  meta: { title: 'T', visibility: 'PRIVATE', sensitive: false },
  ...extra,
});

describe('the sound alone', () => {
  it('AAC out of a video as it is: an M4A with no picture', async () => {
    const out = memoryFile();
    const result = await extractAudio(fixture('both.mp4'), out.handle, false, () => {}, never);
    expect(result.ext).toBe('m4a');
    expect(await tracksOf(out.bytes())).toEqual({ format: 'MP4', codecs: ['audio:aac'] });
  });

  it('Opus as it is: an .opus file (Ogg)', async () => {
    const out = memoryFile();
    const result = await extractAudio(fixture('opus.webm'), out.handle, false, () => {}, never);
    expect(result.ext).toBe('opus');
    expect((await tracksOf(out.bytes())).codecs).toEqual(['audio:opus']);
  });

  it('a video without sound: said so', async () => {
    const out = memoryFile();
    await expect(
      extractAudio(fixture('video.mp4'), out.handle, false, () => {}, never),
    ).rejects.toMatchObject({ code: 'noAudio' });
  });

  it('planned from the sound’s own file when there is one, else from the smallest picture', async () => {
    // A site's sound apart (YouTube, Bilibili).
    const site = await makePlan(
      request(
        { audio: { url: 'https://cdn.x/a.webm', size: 900, mimeType: 'audio/webm' } },
        { format: 'audio' },
      ),
      -1,
      net({}),
    );
    expect(site).toMatchObject({
      audioOnly: true,
      video: { url: 'https://cdn.x/a.webm', ext: 'webm', size: 900 },
    });
    expect(site.audio).toBeUndefined();
    expect(needsJoin(site)).toBe(true);
    // A site's qualities, each with its sound: the smallest, no quality in the name.
    const qualities = await makePlan(
      request(
        {
          qualities: [
            { key: 'https://cdn.x/1080.mp4', height: 1080, size: 300 },
            { key: 'https://cdn.x/360.mp4', height: 360, size: 30 },
          ],
        },
        { format: 'mp3' },
      ),
      -1,
      net({}),
    );
    expect(qualities).toMatchObject({ audioOnly: true, video: { url: 'https://cdn.x/360.mp4' } });
    expect(qualities.quality).toBeUndefined();
  });

  it('HLS: the audio rendition in the language wanted; without one, the smallest variant', async () => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="en",NAME="English",DEFAULT=YES,URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="ru",NAME="Русский",URI="ru.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,AUDIO="a"
1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"
360.m3u8
`;
    const list = (name: string) =>
      `#EXTM3U\n#EXTINF:5,\n${name}-1.ts\n#EXTINF:5,\n${name}-2.ts\n#EXT-X-ENDLIST`;
    const B = 'https://cdn.x/s/';
    const files = {
      [`${B}m.m3u8`]: master,
      [`${B}1080.m3u8`]: list('v1080'),
      [`${B}360.m3u8`]: list('v360'),
      [`${B}en.m3u8`]: list('en'),
      [`${B}ru.m3u8`]: list('ru'),
    };
    const hls = (extra: Partial<SaveRequest>) =>
      makePlan(request({ kind: 'hls', url: `${B}m.m3u8` }, extra), -1, net(files));
    expect((await hls({ format: 'audio', audioLanguage: 'ru-RU' })).video.segments![0]!.url).toBe(
      `${B}ru-1.ts`,
    );
    expect((await hls({ format: 'audio', audioLanguage: 'de' })).video.segments![0]!.url).toBe(
      `${B}en-1.ts`,
    );
    // The video too takes the sound in the language wanted.
    expect((await hls({ audioLanguage: 'ru' })).audio!.segments![0]!.url).toBe(`${B}ru-1.ts`);
    const noRenditions = master.replace(/#EXT-X-MEDIA.*\n/g, '').replace(/,AUDIO="a"/g, '');
    const plain = await makePlan(
      request({ kind: 'hls', url: `${B}m.m3u8` }, { format: 'audio' }),
      -1,
      net({ ...files, [`${B}m.m3u8`]: noRenditions }),
    );
    expect(plain.video.segments![0]!.url).toBe(`${B}v360-1.ts`);
    expect(plain.audioOnly).toBe(true);
  });
});

describe('the sound’s language and subtitles of a DASH manifest', () => {
  it('audio tracks keep their language; WebVTT text tracks are subtitles', () => {
    const mpd = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1000000" width="640" height="360"><BaseURL>v.mp4</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="a-en" bandwidth="128000"><BaseURL>en.m4a</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="ru">
      <Representation id="a-ru" bandwidth="96000"><BaseURL>ru.m4a</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="de" label="Deutsch">
      <Representation id="t-de" bandwidth="1"><BaseURL>de.vtt</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseDash(mpd, 'https://cdn.x/d/m.mpd');
    expect(m.audio.map((a) => a.lang)).toEqual(['en', 'ru']);
    expect(m.text).toEqual([
      { kind: 'vtt', url: 'https://cdn.x/d/de.vtt', language: 'de', label: 'Deutsch' },
    ]);
    expect(sameLanguage('pt-BR', 'PT')).toBe(true);
    expect(sameLanguage('en', undefined)).toBe(false);
  });
});

describe('ad breaks in HLS', () => {
  it('marked by SCTE-35 cues or their DATERANGEs: left out when asked; never all of it', async () => {
    const playlist = `#EXTM3U
#EXTINF:6,
c1.ts
#EXT-X-CUE-OUT:30
#EXTINF:6,
ad1.ts
#EXT-X-CUE-OUT-CONT:6/30
#EXTINF:6,
ad2.ts
#EXT-X-CUE-IN
#EXTINF:6,
c2.ts
#EXT-X-DATERANGE:ID="b",START-DATE="2026-01-01T00:00:00Z",SCTE35-OUT=0xFC
#EXTINF:6,
ad3.ts
#EXT-X-DATERANGE:ID="b",START-DATE="2026-01-01T00:00:00Z",SCTE35-IN=0xFC
#EXTINF:6,
c3.ts
#EXT-X-ENDLIST`;
    const m = parseHls(playlist, 'https://cdn.x/p.m3u8') as HlsMedia;
    expect(m.segments.filter((s) => s.ad).map((s) => s.url.split('/').pop())).toEqual([
      'ad1.ts',
      'ad2.ts',
      'ad3.ts',
    ]);
    const urls = async (skipAds: boolean) =>
      (
        await makePlan(
          request({ kind: 'hls', url: 'https://cdn.x/p.m3u8' }, { skipAds }),
          -1,
          net({ 'https://cdn.x/p.m3u8': playlist }),
        )
      ).video.segments!.map((s) => s.url.split('/').pop());
    expect(await urls(true)).toEqual(['c1.ts', 'c2.ts', 'c3.ts']);
    expect(await urls(false)).toHaveLength(6);
    const allAds = '#EXTM3U\n#EXT-X-CUE-OUT:6\n#EXTINF:6,\nx.ts\n#EXT-X-ENDLIST';
    expect(
      (
        await makePlan(
          request({ kind: 'hls', url: 'https://cdn.x/a.m3u8' }, { skipAds: true }),
          -1,
          net({ 'https://cdn.x/a.m3u8': allAds }),
        )
      ).video.segments,
    ).toHaveLength(1);
  });

  it('stitched in without marks: a short stretch between discontinuities from another host', () => {
    const playlist = `#EXTM3U
#EXTINF:10,
https://video.x/1.ts
#EXTINF:10,
https://video.x/2.ts
#EXT-X-DISCONTINUITY
#EXTINF:15,
https://ads.example/a1.ts
#EXTINF:15,
https://ads.example/a2.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://video.x/3.ts
#EXTINF:10,
https://video.x/4.ts
#EXT-X-ENDLIST`;
    const m = parseHls(playlist, 'https://video.x/p.m3u8') as HlsMedia;
    expect(m.segments.filter((s) => s.ad).map((s) => s.url)).toEqual([
      'https://ads.example/a1.ts',
      'https://ads.example/a2.ts',
    ]);
  });
});

describe('sites in the settings', () => {
  it('a site as typed; the extension off on it and its subdomains', () => {
    expect(siteKey(' https://www.VK.com/video ')).toBe('vk.com');
    expect(siteKey('m.example.org')).toBe('m.example.org');
    expect(siteKey('')).toBe('');
    expect(onSite('https://m.vk.com/v', ['vk.com'])).toBe('vk.com');
    expect(onSite('https://notvk.com/', ['vk.com'])).toBeUndefined();
  });

  it('a site’s own file name, else the general one', () => {
    const media: FoundMedia = {
      id: 'file:x',
      kind: 'file',
      url: 'https://vk.com/x.mp4',
      pageUrl: 'https://m.vk.com/video1',
      foundAt: 0,
    };
    const meta = { title: 'T', visibility: 'PRIVATE' as const, sensitive: false };
    const settings = {
      ...DEFAULT_SETTINGS,
      siteNames: [{ site: 'vk.com', template: '{author} — {title}' }],
    };
    expect(downloadJob(media, meta, settings).name!.template).toBe('{author} — {title}');
    expect(
      downloadJob({ ...media, pageUrl: 'https://rutube.ru/v' }, meta, settings).name!.template,
    ).toBe('{title}');
    // The sound alone carries no subtitles and no quality.
    const audio = downloadJob(media, meta, settings, 'q', undefined, 'audio', {
      kind: 'vtt',
      url: 'https://x/s.vtt',
    });
    expect(audio.request).toMatchObject({
      format: 'audio',
      quality: undefined,
      subtitles: undefined,
    });
  });
});
