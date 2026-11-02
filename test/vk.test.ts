import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makePlan, type Net } from '../src/offscreen/plan';
import { htmlToText } from '../src/shared/html';
import type { SaveRequest } from '../src/shared/media';
import { defaultMeta } from '../src/shared/request';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import { adapterFor, asFound } from '../src/sites';
import { vk } from '../src/sites/vk';

/** VK's answer to al_video.php?act=show, cut down. */
const ANSWER = readFileSync(new URL('fixtures/vk-show.json', import.meta.url), 'utf8');
const PAGE = new URL('https://vk.com/video-100000001_456000001');

describe('VK', () => {
  it('knows its sites and the video a page names', () => {
    const id = (url: string) => adapterFor(url)?.id;
    expect(id('https://vk.com/video-100000001_456000001')).toBe('-100000001_456000001');
    expect(id('https://vk.com/video200000002_165000002?list=ln-aaaaaaaaaaaaaaaaaaaa')).toBe(
      '200000002_165000002',
    );
    expect(id('https://vk.com/videos-100003?z=video-100003_162000003%2Fclub100003')).toBe(
      '-100003_162000003',
    );
    expect(id('https://vk.com/clips-100000004?z=clip-100000004_456000004')).toBe(
      '-100000004_456000004',
    );
    expect(id('https://vkvideo.ru/video-100000005_456000005')).toBe('-100000005_456000005');
    expect(id('https://m.vk.com/video-1_2')).toBe('-1_2');
    expect(adapterFor('https://vk.com/feed')).toBeUndefined();
    expect(adapterFor('https://example.com/video-1_2')).toBeUndefined();
  });

  it('every quality as its own file, best first; the title, description, picture and length', () => {
    const [video] = vk.parse(ANSWER, PAGE, '-100000001_456000001');
    expect(video).toMatchObject({
      kind: 'file',
      url: 'https://vkvd423.okcdn.ru/?expires=1&type=3&sig=e',
      title: 'Пример видео в стиле "Кино"',
      description: 'Новый адрес:\nhttps://vk.com/example',
      thumbnail: 'https://sun9-39.userapi.com/c100000/sampleThumb.jpg',
      duration: 60,
      pageUrl: 'https://vk.com/video-100000001_456000001',
    });
    expect(video!.qualities!.map((q) => q.height)).toEqual([720, 480, 360, 240, 144]);
  });

  it('only a stream: HLS; VK refusing, live or no answer: nothing (the network’s list stays)', () => {
    const json = JSON.parse(ANSWER) as { payload: [number, unknown[]] };
    const params = (json.payload[1][4] as { player: { params: Record<string, unknown>[] } }).player
      .params[0]!;
    for (const k of Object.keys(params)) if (/^url\d+$/.test(k)) delete params[k];
    const [hls] = vk.parse(JSON.stringify(json), PAGE, '-1_2');
    expect(hls).toMatchObject({ kind: 'hls', url: params['hls'] });
    params['live'] = 2;
    expect(vk.parse(JSON.stringify(json), PAGE, '-1_2')).toEqual([]);
    expect(vk.parse(JSON.stringify({ payload: ['3', ['Sign in']] }), PAGE, '-1_2')).toEqual([]);
    expect(vk.parse('<html>', PAGE, '-1_2')).toEqual([]);
    expect(vk.parse(null, PAGE, '-1_2')).toEqual([]);
  });

  it('saved with the site’s title and description; the quality that fits the room', async () => {
    const [video] = vk.parse(ANSWER, PAGE, '-100000001_456000001');
    const found = asFound('vk', '-100000001_456000001', video!, PAGE.href);
    const meta = defaultMeta(found, undefined, DEFAULT_SETTINGS);
    expect(meta).toMatchObject({ title: video!.title, description: video!.description });
    const MB = 1024 * 1024;
    const sizes: Record<string, number> = Object.fromEntries(
      video!.qualities!.map((q) => [q.key, (q.height ?? 0) * MB]),
    );
    const net: Net = { text: () => Promise.reject(new Error('no')), size: async (u) => sizes[u] };
    const request = (extra: Partial<SaveRequest>): SaveRequest => ({
      media: { kind: 'file', url: found.url, pageUrl: found.pageUrl, qualities: found.qualities },
      pref: 'best',
      meta,
      ...extra,
    });
    expect((await makePlan(request({}), -1, net)).quality).toBe('720p');
    expect((await makePlan(request({}), 500 * MB, net)).quality).toBe('480p');
    expect((await makePlan(request({ pref: 360 }), -1, net)).video).toMatchObject({
      url: video!.qualities![2]!.key,
      size: 360 * MB,
    });
    expect((await makePlan(request({ quality: video!.qualities![4]!.key }), -1, net)).quality).toBe(
      '144p',
    );
    // Nothing fits: the smallest, and the upload says why.
    expect((await makePlan(request({}), 10 * MB, net)).quality).toBe('144p');
  });

  it('reads text out of a site’s HTML', () => {
    expect(htmlToText('a<br/>b &amp; c <b>d</b>&#33;')).toBe('a\nb & c d!');
    expect(htmlToText('<p></p>')).toBeUndefined();
  });
});
