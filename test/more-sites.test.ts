import { describe, expect, it } from 'vitest';

import { isAdultSite } from '../src/shared/adult';
import { jsonAfter } from '../src/shared/json-in-html';
import type { FoundMedia } from '../src/shared/media';
import { defaultMeta } from '../src/shared/request';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import { adapterFor } from '../src/sites';
import { instagram } from '../src/sites/instagram';
import { manyvids } from '../src/sites/manyvids';
import { reddit } from '../src/sites/reddit';
import { rednote } from '../src/sites/rednote';
import { x, xToken } from '../src/sites/x';

/** RedNote, Instagram, X and Reddit on their answers, cut down. */
describe('RedNote', () => {
  const ID = '6789abcdef0123456789abcd';
  const page = new URL(`https://www.xiaohongshu.com/explore/${ID}?xsec_token=x`);
  const stream = (w: number, h: number, size: number, n: string) => ({
    masterUrl: `http://sns-video-bd.xhscdn.com/${n}`,
    backupUrls: [`http://sns-video-hw.xhscdn.com/${n}`],
    width: w,
    height: h,
    size,
    duration: 21_500,
  });
  const state = {
    note: {
      noteDetailMap: {
        [ID]: {
          note: {
            noteId: ID,
            type: 'video',
            title: '海边',
            desc: '日出\n第二行',
            imageList: [{ urlDefault: 'http://sns-webpic-qc.xhscdn.com/cover' }],
            video: {
              media: {
                stream: {
                  h264: [stream(720, 1280, 3_000_000, 'h264-720')],
                  h265: [
                    stream(1080, 1920, 5_000_000, 'h265-1080'),
                    stream(720, 1280, 2_000_000, 'h265-720'),
                  ],
                  av1: [],
                  h266: null,
                },
              },
            },
          },
        },
      },
    },
  };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state).replace('"av1":[]', '"av1":undefined')}</script>`;

  it('a note’s page, its video by height (H.264 first), its title and text', () => {
    expect(adapterFor(page.href)?.id).toBe(ID);
    expect(adapterFor(`https://www.xiaohongshu.com/discovery/item/${ID}`)?.id).toBe(ID);
    expect(adapterFor('https://www.xiaohongshu.com/explore')).toBeUndefined();
    const [video] = rednote.parse(html, page, ID);
    expect(video).toMatchObject({
      title: '海边',
      description: '日出\n第二行',
      thumbnail: 'https://sns-webpic-qc.xhscdn.com/cover',
      duration: 21.5,
      pageUrl: `https://www.xiaohongshu.com/explore/${ID}`,
    });
    expect(video!.qualities!.map((q) => [q.height, q.key.split('/').pop()])).toEqual([
      [1080, 'h265-1080'],
      [720, 'h264-720'],
    ]);
  });

  it('a picture note or another note: nothing; the state’s undefined reads as null', () => {
    expect(rednote.parse(html, page, 'ffffffffffffffffffffffff')).toEqual([]);
    expect(rednote.parse(html.replace('"type":"video"', '"type":"normal"'), page, ID)).toEqual([]);
    expect(jsonAfter('s={"a":undefined,"b":"undefined","c":[undefined]}', 's=')).toEqual({
      a: null,
      b: 'undefined',
      c: [null],
    });
  });
});

describe('Instagram', () => {
  const answer = (media: object) => JSON.stringify({ items: [media], num_results: 1 });
  const versions = (code: string) => [
    {
      type: 101,
      url: `https://scontent.cdninstagram.com/${code}-720.mp4`,
      width: 720,
      height: 1280,
    },
    {
      type: 102,
      url: `https://scontent.cdninstagram.com/${code}-480.mp4`,
      width: 480,
      height: 854,
    },
    {
      type: 103,
      url: `https://scontent.cdninstagram.com/${code}-480b.mp4`,
      width: 480,
      height: 854,
    },
  ];
  const page = new URL('https://www.instagram.com/reel/DAbC12_xyz/');

  it('posts, reels and a user’s posts; a reel’s versions by height, its caption', () => {
    expect(adapterFor(page.href)?.id).toBe('DAbC12_xyz');
    expect(adapterFor('https://www.instagram.com/p/C9xYz-123/?img_index=1')?.id).toBe('C9xYz-123');
    expect(adapterFor('https://www.instagram.com/someone/reel/C9xYz-123/')?.id).toBe('C9xYz-123');
    expect(adapterFor('https://www.instagram.com/someone/')).toBeUndefined();
    const [video] = instagram.parse(
      answer({
        code: 'DAbC12_xyz',
        product_type: 'clips',
        user: { username: 'seaside' },
        caption: { text: 'Sea at dawn\n#sea' },
        video_versions: versions('reel'),
        video_duration: 12.4,
        image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/cover.jpg' }] },
      }),
      page,
      'DAbC12_xyz',
    );
    expect(video).toMatchObject({
      title: 'Sea at dawn',
      description: 'Sea at dawn\n#sea',
      duration: 12.4,
      thumbnail: 'https://scontent.cdninstagram.com/cover.jpg',
      pageUrl: 'https://www.instagram.com/reel/DAbC12_xyz/',
    });
    expect(video!.qualities!.map((q) => q.height)).toEqual([720, 480]);
  });

  it('a carousel: each video its own item, pictures left out', () => {
    const videos = instagram.parse(
      answer({
        code: 'C9xYz-123',
        user: { username: 'seaside' },
        caption: null,
        carousel_media: [
          { video_versions: versions('one') },
          { image_versions2: { candidates: [{ url: 'https://x/pic.jpg' }] } },
          { video_versions: versions('three') },
        ],
      }),
      new URL('https://www.instagram.com/p/C9xYz-123/'),
      'C9xYz-123',
    );
    expect(videos.map((v) => v.title)).toEqual(['@seaside (1/3)', '@seaside (3/3)']);
    expect(instagram.parse('{"message":"login_required"}', page, 'x')).toEqual([]);
  });
});

describe('X', () => {
  const ID = '1580661436132757506';
  const post = {
    __typename: 'Tweet',
    id_str: ID,
    text: 'Sea at dawn\nfilmed today https://t.co/AbCdEf',
    user: { screen_name: 'seaside' },
    possibly_sensitive: true,
    mediaDetails: [
      {
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/cover.jpg',
        video_info: {
          duration_millis: 30_200,
          variants: [
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
            {
              content_type: 'video/mp4',
              bitrate: 256_000,
              url: 'https://video.twimg.com/vid/avc1/480x270/a.mp4',
            },
            {
              content_type: 'video/mp4',
              bitrate: 2_176_000,
              url: 'https://video.twimg.com/vid/avc1/1280x720/b.mp4',
            },
          ],
        },
      },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/pic.jpg' },
    ],
  };

  it('a post’s video: its MP4 versions, its text without the link, X’s sensitive mark', async () => {
    expect(adapterFor(`https://x.com/seaside/status/${ID}`)?.id).toBe(ID);
    expect(adapterFor(`https://twitter.com/seaside/status/${ID}/video/1`)?.id).toBe(ID);
    expect(adapterFor('https://x.com/home')).toBeUndefined();
    const asked: [string, RequestInit | undefined, string | undefined][] = [];
    await x.ask!(
      ID,
      new URL('https://x.com/'),
      async (url, init, referer) => {
        asked.push([url, init, referer]);
        return new Response('{}');
      },
      null,
    );
    expect(asked).toEqual([
      [
        `https://cdn.syndication.twimg.com/tweet-result?id=${ID}&token=${xToken(ID)}&lang=en`,
        { credentials: 'omit' },
        'https://platform.twitter.com/',
      ],
    ]);
    expect(xToken('20')).toMatch(/^[0-9a-z]+$/);
    const [video] = x.parse(
      JSON.stringify(post),
      new URL(`https://x.com/seaside/status/${ID}`),
      ID,
    );
    expect(video).toMatchObject({
      title: 'Sea at dawn',
      description: 'Sea at dawn\nfilmed today',
      duration: 30.2,
      sensitive: true,
      pageUrl: `https://x.com/seaside/status/${ID}`,
    });
    expect(video!.qualities!.map((q) => [q.height, q.key.split('/').pop()])).toEqual([
      [720, 'b.mp4'],
      [270, 'a.mp4'],
    ]);
    expect(x.parse('{"__typename":"TweetTombstone"}', new URL('https://x.com/'), ID)).toEqual([]);
  });
});

describe('Reddit', () => {
  const answer = (post: object) =>
    JSON.stringify([{ kind: 'Listing', data: { children: [{ kind: 't3', data: post }] } }, {}]);
  const video = {
    hls_url: 'https://v.redd.it/abc/HLSPlaylist.m3u8?a=1',
    dash_url: 'https://v.redd.it/abc/DASH.mpd',
    duration: 25,
  };

  it('a post’s Reddit video as HLS with its sound, its title, 18+ as Reddit marks it', () => {
    const page = new URL('https://www.reddit.com/r/sea/comments/1abcde/sea_at_dawn/');
    expect(adapterFor(page.href)?.id).toBe('1abcde');
    expect(adapterFor('https://www.reddit.com/r/sea/')).toBeUndefined();
    const [found] = reddit.parse(
      answer({
        id: '1abcde',
        title: 'Sea at dawn',
        selftext: '',
        over_18: true,
        permalink: '/r/sea/comments/1abcde/sea_at_dawn/',
        secure_media: { reddit_video: video },
        preview: { images: [{ source: { url: 'https://preview.redd.it/cover.jpg' } }] },
      }),
      page,
      '1abcde',
    );
    expect(found).toEqual({
      kind: 'hls',
      url: video.hls_url,
      title: 'Sea at dawn',
      description: undefined,
      thumbnail: 'https://preview.redd.it/cover.jpg',
      duration: 25,
      pageUrl: 'https://www.reddit.com/r/sea/comments/1abcde/sea_at_dawn/',
      sensitive: true,
    });
  });

  it('a crosspost: the video of the post it shares; no video: nothing', () => {
    const page = new URL('https://www.reddit.com/r/b/comments/2xyz/x/');
    const [found] = reddit.parse(
      answer({
        id: '2xyz',
        title: 'Shared',
        crosspost_parent_list: [{ media: { reddit_video: video } }],
      }),
      page,
      '2xyz',
    );
    expect(found).toMatchObject({ kind: 'hls', title: 'Shared' });
    expect(reddit.parse(answer({ id: '2xyz', title: 'Text only' }), page, '2xyz')).toEqual([]);
  });
});

describe('sites for adults', () => {
  it('a video saved from one is marked 18+; the form can take it off', () => {
    expect(isAdultSite('https://www.xvideos.com/video123/x')).toBe(true);
    expect(isAdultSite('https://de.pornhub.com/view_video.php?viewkey=1')).toBe(true);
    expect(isAdultSite('https://notpornhub.com/')).toBe(false);
    expect(isAdultSite('https://vk.com/video-1_2')).toBe(false);
    const media: FoundMedia = {
      id: 'x',
      kind: 'file',
      url: 'https://cdn.example/x.mp4',
      pageUrl: 'https://xhamster.com/videos/x-1',
      foundAt: 1,
    };
    expect(defaultMeta(media, undefined, DEFAULT_SETTINGS).sensitive).toBe(true);
    expect(
      defaultMeta({ ...media, pageUrl: 'https://example.com/' }, undefined, DEFAULT_SETTINGS)
        .sensitive,
    ).toBe(false);
  });
});

describe('ManyVids', () => {
  const page = new URL('https://www.manyvids.com/Video/4321/sea-at-dawn');
  const answer = (files: object | null) =>
    JSON.stringify({
      files,
      meta: {
        data: {
          title: 'Sea &amp; sky',
          description: '<p>Waves</p>',
          screenshot: 'https://cdn5.manyvids.com/cover.jpg',
          videoDuration: '00:12:30',
        },
      },
    });

  it('a bought video: its original file, its title, description, cover and length, 18+', () => {
    expect(adapterFor(page.href)?.id).toBe('4321');
    const [video] = manyvids.parse(
      answer({
        data: { filepath: 'https://video.manyvids.com/original.mp4', teaser: { filepath: 'x' } },
      }),
      page,
      '4321',
    );
    expect(video).toEqual({
      kind: 'file',
      url: 'https://video.manyvids.com/original.mp4',
      title: 'Sea & sky',
      description: 'Waves',
      thumbnail: 'https://cdn5.manyvids.com/cover.jpg',
      duration: 750,
      pageUrl: 'https://www.manyvids.com/Video/4321',
      sensitive: true,
    });
  });

  it('only the teaser (not bought): nothing, the page’s player stays', () => {
    expect(
      manyvids.parse(
        answer({ data: { teaser: { filepath: 'https://x/teaser.mp4' } } }),
        page,
        '4321',
      ),
    ).toEqual([]);
    expect(manyvids.parse(answer(null), page, '4321')).toEqual([]);
  });
});
