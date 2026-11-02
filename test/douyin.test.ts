import { describe, expect, it } from 'vitest';

import { adapterFor } from '../src/sites';
import { douyin } from '../src/sites/douyin';

/** Douyin's web API answer, cut down. */
const ID = '7300000000000000001';
const PAGE = new URL(`https://www.douyin.com/video/${ID}`);
const addr = (name: string, w: number, h: number, size?: number) => ({
  url_list: [`http://v26-web.douyinvod.com/${name}/`, `https://v3-web.douyinvod.com/${name}/`],
  width: w,
  height: h,
  data_size: size,
});
const ANSWER = JSON.stringify({
  aweme_detail: {
    aweme_id: ID,
    desc: '海边日出 #sea\n第二行',
    author: { unique_id: 'seaside', nickname: '海边' },
    video: {
      width: 1080,
      height: 1920,
      duration: 15_300,
      origin_cover: { url_list: ['http://p3-pc.douyinpic.com/origin.jpeg'] },
      play_addr: addr('play', 720, 1280),
      bit_rate: [
        {
          gear_name: 'normal_1080_0',
          bit_rate: 2_000_000,
          is_h265: 1,
          play_addr: addr('h265-1080', 1080, 1920, 4_000_000),
        },
        {
          gear_name: 'normal_720_0',
          bit_rate: 1_000_000,
          is_h265: 1,
          play_addr: addr('h265-720', 720, 1280, 1_800_000),
        },
        {
          gear_name: 'normal_720_1',
          bit_rate: 1_400_000,
          is_h265: 0,
          play_addr: addr('h264-720', 720, 1280),
        },
      ],
    },
  },
});

describe('Douyin', () => {
  it('knows the video a page names, on its page or in a feed', () => {
    expect(adapterFor(PAGE.href)?.id).toBe(ID);
    expect(adapterFor(`https://www.douyin.com/jingxuan?modal_id=${ID}`)?.id).toBe(ID);
    expect(adapterFor('https://www.douyin.com/jingxuan')).toBeUndefined();
  });

  it('a file per quality, H.264 first at a height, sizes from the answer or the bit rate', () => {
    const [video] = douyin.parse(ANSWER, PAGE, ID);
    expect(video).toMatchObject({
      kind: 'file',
      title: '海边日出 #sea',
      description: '海边日出 #sea\n第二行',
      thumbnail: 'https://p3-pc.douyinpic.com/origin.jpeg',
      duration: 15.3,
      pageUrl: PAGE.href,
    });
    expect(video!.qualities!.map((q) => [q.height, q.key, q.estimate])).toEqual([
      [1080, 'https://v26-web.douyinvod.com/h265-1080/', 4_000_000],
      [720, 'https://v26-web.douyinvod.com/h264-720/', Math.ceil((1_400_000 * 15_300) / 8000)],
    ]);
  });

  it('another video, a slideshow, an empty answer (no session yet): nothing', () => {
    expect(douyin.parse(ANSWER, PAGE, '7300000000000000002')).toEqual([]);
    const slides = JSON.parse(ANSWER) as { aweme_detail: Record<string, unknown> };
    slides.aweme_detail['images'] = [{ url_list: ['x'] }];
    expect(douyin.parse(JSON.stringify(slides), PAGE, ID)).toEqual([]);
    expect(douyin.parse('{"status_code":0}', PAGE, ID)).toEqual([]);
    expect(douyin.parse(null, PAGE, ID)).toEqual([]);
  });
});
