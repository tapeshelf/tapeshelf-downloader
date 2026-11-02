import { describe, expect, it } from 'vitest';

import { jsonAfter } from '../src/shared/json-in-html';
import { adapterFor } from '../src/sites';
import { bilibili } from '../src/sites/bilibili';

/** Bilibili's page state, cut down. */
const ID = 'BV1aa411a7aa';
const PAGE = new URL(`https://www.bilibili.com/video/${ID}/`);
const stream = (height: number, codecid: number, bandwidth: number) => ({
  id: height,
  baseUrl: `https://upos-sz-mirror.bilivideo.com/v-${height}-${codecid}.m4s`,
  bandwidth,
  width: Math.round((height * 16) / 9),
  height,
  codecid,
});
const PLAYINFO = {
  code: 0,
  data: {
    dash: {
      duration: 120,
      video: [
        stream(1080, 12, 2_000_000),
        stream(1080, 7, 3_000_000),
        stream(720, 13, 900_000),
        stream(480, 7, 500_000),
      ],
      audio: [
        { id: 30216, baseUrl: 'https://upos-sz-mirror.bilivideo.com/a-64.m4s', bandwidth: 64_000 },
        {
          id: 30280,
          baseUrl: 'https://upos-sz-mirror.bilivideo.com/a-192.m4s',
          bandwidth: 192_000,
        },
      ],
    },
  },
};
const STATE = {
  videoData: {
    bvid: ID,
    aid: 2,
    title: 'Sea at dawn',
    desc: 'Filmed on the pier',
    pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
    duration: 300,
    pages: [
      { page: 1, part: 'Morning', duration: 120 },
      { page: 2, part: 'Evening', duration: 180 },
    ],
  },
};

describe('Bilibili', () => {
  it('knows the video a page names', () => {
    expect(adapterFor(PAGE.href)?.id).toBe(ID);
    expect(adapterFor('https://www.bilibili.com/video/av170001?p=2')?.id).toBe('av170001');
    expect(adapterFor('https://m.bilibili.com/video/BV1aa411a7aa')?.id).toBe(ID);
    expect(adapterFor('https://www.bilibili.com/')).toBeUndefined();
  });

  it('one file per height, H.264 first; the best sound apart; the part’s name and length', () => {
    const [video] = bilibili.parse(JSON.stringify({ playinfo: PLAYINFO, state: STATE }), PAGE, ID);
    expect(video).toMatchObject({
      kind: 'file',
      url: 'https://upos-sz-mirror.bilivideo.com/v-1080-7.m4s',
      audio: { url: 'https://upos-sz-mirror.bilivideo.com/a-192.m4s' },
      title: 'Sea at dawn — Morning',
      description: 'Filmed on the pier',
      thumbnail: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
      duration: 120,
      pageUrl: `https://www.bilibili.com/video/${ID}`,
    });
    expect(video!.qualities!.map((q) => [q.height, q.key.split('/').pop(), q.estimate])).toEqual([
      [1080, 'v-1080-7.m4s', 45_000_000],
      [720, 'v-720-13.m4s', 13_500_000],
      [480, 'v-480-7.m4s', 7_500_000],
    ]);
  });

  it('from the page’s HTML when the page moved on by script; another video’s state: nothing', () => {
    const html = `<html><script>window.__playinfo__=${JSON.stringify(PLAYINFO)}</script>
      <script>window.__INITIAL_STATE__=${JSON.stringify(STATE)};(function(){var s;}());</script></html>`;
    const second = new URL(`${PAGE.href}?p=2`);
    const [video] = bilibili.parse(html, second, ID);
    expect(video).toMatchObject({
      title: 'Sea at dawn — Evening',
      duration: 180,
      pageUrl: `https://www.bilibili.com/video/${ID}?p=2`,
    });
    expect(bilibili.parse(html, PAGE, 'BV1yy411c7mE')).toEqual([]);
    expect(bilibili.parse('<html></html>', PAGE, ID)).toEqual([]);
    expect(bilibili.parse(null, PAGE, ID)).toEqual([]);
  });

  it('reads a JSON object a script assigns, braces in strings included', () => {
    expect(
      jsonAfter('x=1; window.a = {"b":"}{","c":{"d":[1]}};(function(){})', 'window.a'),
    ).toEqual({
      b: '}{',
      c: { d: [1] },
    });
    expect(jsonAfter('nothing here', 'window.a')).toBeUndefined();
  });
});
