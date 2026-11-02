import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { adapterFor } from '../src/sites';
import { tiktok } from '../src/sites/tiktok';

/** A TikTok page's own JSON, cut down. */
const ANSWER = readFileSync(new URL('fixtures/tiktok-universal.json', import.meta.url), 'utf8');
const ID = '7000000000000000001';
const PAGE = new URL(`https://www.tiktok.com/@seaside/video/${ID}`);

describe('TikTok', () => {
  it('knows the video a page names', () => {
    const id = (url: string) => adapterFor(url)?.id;
    expect(id(PAGE.href)).toBe(ID);
    expect(id(`https://www.tiktok.com/@some.one/video/${ID}?is_from_webapp=1`)).toBe(ID);
    expect(id(`https://www.tiktok.com/embed/v2/${ID}`)).toBe(ID);
    expect(id(`https://m.tiktok.com/share/video/${ID}`)).toBe(ID);
    expect(adapterFor('https://www.tiktok.com/@seaside')).toBeUndefined();
    expect(adapterFor('https://www.tiktok.com/foryou')).toBeUndefined();
  });

  it('a file per quality with its size, H.264 first at a height; no H.266, no silent video', () => {
    const [video] = tiktok.parse(ANSWER, PAGE, ID);
    expect(video).toMatchObject({
      kind: 'file',
      title: 'Sea at dawn #sea',
      description: 'Sea at dawn #sea\nfilmed on the pier',
      thumbnail: 'https://p16-sign.tiktokcdn.com/origin.jpg',
      duration: 13,
      pageUrl: PAGE.href,
    });
    expect(video!.qualities).toEqual([
      {
        key: 'https://v16-webapp-prime.tiktok.com/video/h265-1080/',
        height: 1080,
        width: 1080,
        estimate: 4_000_000,
      },
      {
        key: 'https://v16-webapp-prime.tiktok.com/video/h264-720/',
        height: 720,
        width: 720,
        estimate: 2_400_000,
      },
    ]);
  });

  it('another video’s JSON, a slideshow or no JSON: nothing', () => {
    expect(tiktok.parse(ANSWER, PAGE, '7000000000000000002')).toEqual([]);
    const json = JSON.parse(ANSWER) as {
      __DEFAULT_SCOPE__: Record<string, { itemInfo: { itemStruct: Record<string, unknown> } }>;
    };
    json.__DEFAULT_SCOPE__['webapp.video-detail']!.itemInfo.itemStruct['imagePost'] = {
      images: [],
    };
    expect(tiktok.parse(JSON.stringify(json), PAGE, ID)).toEqual([]);
    expect(tiktok.parse('not json', PAGE, ID)).toEqual([]);
    expect(tiktok.parse(null, PAGE, ID)).toEqual([]);
  });
});
