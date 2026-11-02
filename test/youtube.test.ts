import { afterEach, describe, expect, it, vi } from 'vitest';

import { readTrack, type Piece } from '../src/offscreen/download';
import { makePlan, type Net } from '../src/offscreen/plan';
import type { SaveRequest } from '../src/shared/media';
import { asFound } from '../src/sites';
import { YT_CLIENT, playerRequest, youtube } from '../src/sites/youtube';

/** YouTube's player answer, cut down. */
const ID = 'dQw4w9WgXcQ';
const PAGE = new URL(`https://www.youtube.com/watch?v=${ID}&t=42`);
const gv = (itag: number) =>
  `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${itag}&c=VISIONOS`;
const fmt = (itag: number, mime: string, w: number, h: number, bitrate: number, size: number) => ({
  itag,
  url: gv(itag),
  mimeType: mime,
  width: w,
  height: h,
  bitrate,
  contentLength: String(size),
});
const PLAYER = {
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: ID,
    title: 'Sea at dawn',
    shortDescription: 'Filmed on the pier\n#sea',
    lengthSeconds: '212',
    thumbnail: {
      thumbnails: [
        { url: 'https://i.ytimg.com/vi/x/default.jpg' },
        { url: 'https://i.ytimg.com/vi/x/maxres.jpg' },
      ],
    },
  },
  streamingData: {
    formats: [fmt(18, 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', 640, 360, 500_000, 12_000_000)],
    adaptiveFormats: [
      fmt(313, 'video/webm; codecs="vp9"', 3840, 2160, 20_000_000, 900_000_000),
      fmt(137, 'video/mp4; codecs="avc1.640028"', 1920, 1080, 4_000_000, 100_000_000),
      fmt(248, 'video/webm; codecs="vp9"', 1920, 1080, 3_000_000, 80_000_000),
      fmt(22, 'video/mp4; codecs="avc1.4d401f"', 1280, 720, 2_000_000, 50_000_000),
      {
        itag: 399,
        signatureCipher: 's=x&url=y',
        mimeType: 'video/mp4; codecs="av01"',
        width: 1920,
        height: 1080,
      },
      {
        itag: 140,
        url: gv(140),
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 130_000,
        contentLength: '3400000',
      },
      {
        itag: 251,
        url: gv(251),
        mimeType: 'audio/webm; codecs="opus"',
        bitrate: 160_000,
        contentLength: '3600000',
      },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('YouTube', () => {
  it('a watch page, a Short, a live recording, a short link name their video', () => {
    const id = (u: string) => youtube.videoId(new URL(u));
    expect(id(PAGE.href)).toBe(ID);
    expect(id(`https://youtu.be/${ID}?si=x`)).toBe(ID);
    expect(id(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(id(`https://m.youtube.com/live/${ID}`)).toBe(ID);
    expect(id('https://www.youtube.com/feed/subscriptions')).toBeUndefined();
    expect(youtube.matches(new URL('https://music.youtube.com/'))).toBe(true);
  });

  it('asks the player API as its device client, with the page’s visitor id, no cookies', () => {
    const init = playerRequest(
      ID,
      JSON.stringify({ visitorData: 'Cgt2aXNpdG9y', hl: 'ru', gl: 'RU' }),
    );
    expect(init.credentials).toBe('omit');
    expect(init.headers).toMatchObject({
      'X-YouTube-Client-Name': '101',
      'X-Goog-Visitor-Id': 'Cgt2aXNpdG9y',
    });
    const body = JSON.parse(init.body as string) as {
      context: { client: Record<string, string> };
      videoId: string;
    };
    expect(body.videoId).toBe(ID);
    expect(body.context.client).toMatchObject({
      clientName: 'VISIONOS',
      hl: 'ru',
      gl: 'RU',
      visitorData: 'Cgt2aXNpdG9y',
    });
    expect(youtube.userAgent).toBe(YT_CLIENT.userAgent);
    expect(youtube.askAlways).toBe(true);
    // Without the page's answer, still a question.
    expect(JSON.parse(playerRequest(ID, null).body as string).context.client.hl).toBe('en');
  });

  it('picture by height (H.264 first, VP9 where it is all there is), AAC sound apart, exact sizes', () => {
    const [video] = youtube.parse(JSON.stringify(PLAYER), PAGE, ID);
    expect(video).toMatchObject({
      kind: 'file',
      title: 'Sea at dawn',
      description: 'Filmed on the pier\n#sea',
      thumbnail: 'https://i.ytimg.com/vi/x/maxres.jpg',
      duration: 212,
      pageUrl: `https://www.youtube.com/watch?v=${ID}`,
      audio: { url: gv(140), size: 3_400_000 },
      download: { userAgent: YT_CLIENT.userAgent, chunk: 10 * 1024 * 1024 },
    });
    expect(
      video!.qualities!.map((q) => [
        q.height,
        new URL(q.key).searchParams.get('itag'),
        q.size,
        q.mimeType,
      ]),
    ).toEqual([
      [2160, '313', 900_000_000, 'video/webm'],
      [1080, '137', 100_000_000, undefined],
      [720, '22', 50_000_000, undefined],
    ]);
  });

  it('no separate sound: the files with both; not playable, live or another video: nothing', () => {
    const progressive = structuredClone(PLAYER);
    progressive.streamingData.adaptiveFormats = progressive.streamingData.adaptiveFormats.filter(
      (f) => !f.mimeType?.startsWith('audio/'),
    );
    const [single] = youtube.parse(JSON.stringify(progressive), PAGE, ID);
    expect(single).toMatchObject({ url: gv(18), audio: undefined });
    expect(
      youtube.parse(
        JSON.stringify({ ...PLAYER, playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
        PAGE,
        ID,
      ),
    ).toEqual([]);
    expect(
      youtube.parse(
        JSON.stringify({ ...PLAYER, videoDetails: { ...PLAYER.videoDetails, isLive: true } }),
        PAGE,
        ID,
      ),
    ).toEqual([]);
    expect(youtube.parse(JSON.stringify(PLAYER), PAGE, 'aaaaaaaaaaa')).toEqual([]);
  });

  it('planned as two tracks read in 10 MB ranges, the quality that fits, sizes not asked again', async () => {
    const [video] = youtube.parse(JSON.stringify(PLAYER), PAGE, ID);
    const found = asFound('youtube', ID, video!, PAGE.href);
    const asked: string[] = [];
    const net: Net = {
      text: () => Promise.reject(new Error('no')),
      size: async (u) => (asked.push(u), undefined),
    };
    const req = (extra: Partial<SaveRequest> = {}): SaveRequest => ({
      media: { ...found },
      pref: 'best',
      meta: { title: 'x', visibility: 'PRIVATE', sensitive: false },
      ...extra,
    });
    const best = await makePlan(req(), -1, net);
    expect(best.quality).toBe('2160p');
    expect(best.video).toMatchObject({
      ext: 'webm',
      mimeType: 'video/webm',
      size: 900_000_000,
      chunk: 10 << 20,
    });
    expect(best.audio).toMatchObject({
      url: gv(140),
      ext: 'm4a',
      size: 3_400_000,
      chunk: 10 << 20,
    });
    expect((await makePlan(req(), 200_000_000, net)).quality).toBe('1080p');
    expect((await makePlan(req({ pref: 720 }), -1, net)).video).toMatchObject({
      ext: 'mp4',
      size: 50_000_000,
    });
    expect(asked).toEqual([]);
  });

  it('a file read in ranges from where the upload stopped; a short answer stops it', async () => {
    const body = Uint8Array.from({ length: 2500 }, (_, i) => i % 251);
    const ranges: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const range = (init.headers as Record<string, string>)['Range']!;
        ranges.push(range);
        const [a, b] = range.replace('bytes=', '').split('-').map(Number) as [number, number];
        return new Response(body.slice(a, b + 1), { status: 206 });
      }),
    );
    const read = async (from: number) => {
      const out: Piece[] = [];
      for await (const p of readTrack(
        { url: 'https://x/v', ext: 'mp4', mimeType: 'video/mp4', size: 2500, chunk: 1000 },
        { segment: 0, offset: from },
        new AbortController().signal,
      ))
        out.push({ ...p, bytes: p.bytes.slice() });
      return out;
    };
    const all = await read(0);
    expect(ranges).toEqual(['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2499']);
    expect(all.reduce((n, p) => n + p.bytes.length, 0)).toBe(2500);
    expect(all.at(-1)!.at.offset + all.at(-1)!.bytes.length).toBe(2500);
    ranges.length = 0;
    const resumed = await read(1500);
    expect(ranges).toEqual(['bytes=1500-2499']);
    expect(resumed[0]!.at.offset).toBe(1500);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body.slice(0, 10), { status: 206 })),
    );
    await expect(read(0)).rejects.toMatchObject({ code: 'source' });
  });
});
