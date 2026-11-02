import { describe, expect, it } from 'vitest';

import { parseHls, type HlsMedia } from '../src/shared/hls';
import { adapterFor } from '../src/sites';
import { dailymotion } from '../src/sites/dailymotion';
import { kick } from '../src/sites/kick';
import { rutube, rutubeApi } from '../src/sites/rutube';
import { twitch } from '../src/sites/twitch';
import { vimeo, vimeoConfig } from '../src/sites/vimeo';

/** Twitch, Kick, Rutube, Dailymotion and Vimeo on their answers, cut down. */
const idOf = (url: string) => adapterFor(url)?.id;
const siteOf = (url: string) => adapterFor(url)?.adapter.id;

describe('Twitch', () => {
  it('a channel, a past broadcast and a clip by their addresses; Twitch’s own pages are none', () => {
    expect(idOf('https://www.twitch.tv/Samplechannel')).toBe('live:samplechannel');
    expect(idOf('https://www.twitch.tv/videos/2290001234')).toBe('vod:2290001234');
    expect(idOf('https://www.twitch.tv/samplechannel/v/2290001234')).toBe('vod:2290001234');
    expect(idOf('https://www.twitch.tv/samplechannel/clip/FunnyClipSlug-abc')).toBe(
      'clip:FunnyClipSlug-abc',
    );
    expect(idOf('https://clips.twitch.tv/FunnyClipSlug-abc')).toBe('clip:FunnyClipSlug-abc');
    expect(idOf('https://player.twitch.tv/?channel=samplechannel&parent=x.com')).toBe(
      'live:samplechannel',
    );
    expect(idOf('https://player.twitch.tv/?video=v2290001234')).toBe('vod:2290001234');
    expect(idOf('https://www.twitch.tv/directory')).toBeUndefined();
    expect(idOf('https://www.twitch.tv/samplechannel/videos')).toBeUndefined();
  });

  it('a channel on air: its usher stream with the token; off air: nothing', () => {
    const page = new URL('https://www.twitch.tv/samplechannel');
    const on = {
      data: {
        user: {
          login: 'samplechannel',
          displayName: 'Samplechannel',
          stream: { title: 'CDL Hijack', previewImageURL: 'https://static-cdn.jtvnw.net/p.jpg' },
        },
        token: { value: '{"channel":"samplechannel"}', signature: 'abc123' },
      },
    };
    const [v] = twitch.parse(JSON.stringify(on), page, 'live:samplechannel');
    expect(v).toMatchObject({ kind: 'hls', title: 'CDL Hijack', author: 'Samplechannel' });
    const url = new URL(v!.url);
    expect(url.host + url.pathname).toBe('usher.ttvnw.net/api/channel/hls/samplechannel.m3u8');
    expect(url.searchParams.get('sig')).toBe('abc123');
    expect(url.searchParams.get('token')).toBe('{"channel":"samplechannel"}');
    const off = { data: { ...on.data, user: { ...on.data.user, stream: null } } };
    expect(twitch.parse(JSON.stringify(off), page, 'live:samplechannel')).toEqual([]);
  });

  it('a past broadcast: usher’s VOD stream with nauth; a clip: each quality a signed file, best first', () => {
    const vod = {
      data: {
        video: {
          id: '2290001234',
          title: 'Finals',
          lengthSeconds: 7200,
          owner: { displayName: 'Samplechannel' },
        },
        token: { value: 'tok', signature: 'sig' },
      },
    };
    const [v] = twitch.parse(
      JSON.stringify(vod),
      new URL('https://www.twitch.tv/videos/2290001234'),
      'vod:2290001234',
    );
    expect(v).toMatchObject({ kind: 'hls', title: 'Finals', duration: 7200 });
    expect(new URL(v!.url).pathname).toBe('/vod/2290001234.m3u8');
    expect(new URL(v!.url).searchParams.get('nauthsig')).toBe('sig');
    const clip = {
      data: {
        clip: {
          slug: 'Slug',
          title: 'Ace',
          durationSeconds: 28,
          broadcaster: { login: 'samplechannel', displayName: 'Samplechannel' },
          videoQualities: [
            { quality: '480', sourceURL: 'https://clips-media.twitch.tv/480.mp4' },
            { quality: '1080', sourceURL: 'https://clips-media.twitch.tv/1080.mp4' },
          ],
          playbackAccessToken: { value: '{"clip":1}', signature: 'cs' },
        },
      },
    };
    const [c] = twitch.parse(
      JSON.stringify(clip),
      new URL('https://clips.twitch.tv/Slug'),
      'clip:Slug',
    );
    expect(c).toMatchObject({
      kind: 'file',
      title: 'Ace',
      pageUrl: 'https://www.twitch.tv/samplechannel/clip/Slug',
    });
    expect(c!.qualities!.map((q) => q.height)).toEqual([1080, 480]);
    expect(c!.url).toBe(
      `https://clips-media.twitch.tv/1080.mp4?sig=cs&token=${encodeURIComponent('{"clip":1}')}`,
    );
  });

  it('ads stitched into a live playlist are marked: Twitch titles its own segments “live”', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXTINF:2.000,live',
      'a.ts',
      '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-27T00:00:00Z",DURATION=4',
      '#EXTINF:2.000,Amazon|123',
      'ad1.ts',
      '#EXTINF:2.000,Amazon|123',
      'ad2.ts',
      '#EXTINF:2.000,live',
      'b.ts',
    ].join('\n');
    const m = parseHls(playlist, 'https://video-edge.x.ttvnw.net/v1/playlist/p.m3u8') as HlsMedia;
    expect(m.segments.map((s) => !!s.ad)).toEqual([false, true, true, false]);
    // Without Twitch's mark, titles mean nothing.
    const plain = parseHls(
      playlist.replace(/#EXT-X-DATERANGE[^\n]*\n/, ''),
      'https://x/p.m3u8',
    ) as HlsMedia;
    expect(plain.segments.some((s) => s.ad)).toBe(false);
  });
});

describe('Kick', () => {
  it('a channel, a past broadcast and a clip by their addresses', () => {
    expect(idOf('https://kick.com/SampleLive')).toBe('live:samplelive');
    expect(idOf('https://kick.com/samplelive/videos/0b1f2c3d-4e5f-6789-abcd-ef0123456789')).toBe(
      'vod:0b1f2c3d-4e5f-6789-abcd-ef0123456789',
    );
    expect(idOf('https://kick.com/samplelive/clips/clip_01JABCDEF')).toBe('clip:clip_01JABCDEF');
    expect(idOf('https://kick.com/samplelive?clip=clip_01JABCDEF')).toBe('clip:clip_01JABCDEF');
    expect(idOf('https://kick.com/browse')).toBeUndefined();
  });

  it('on air: its playback stream; off air: nothing; a past broadcast’s length from milliseconds', () => {
    const live = {
      slug: 'samplelive',
      playback_url: 'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/x.m3u8',
      user: { username: 'SampleLive' },
      livestream: {
        session_title: 'Late night',
        thumbnail: { url: 'https://images.kick.com/t.jpg' },
      },
    };
    const page = new URL('https://kick.com/samplelive');
    expect(kick.parse(JSON.stringify(live), page, 'live:samplelive')).toEqual([
      expect.objectContaining({
        kind: 'hls',
        url: live.playback_url,
        title: 'Late night',
        author: 'SampleLive',
      }),
    ]);
    expect(
      kick.parse(JSON.stringify({ ...live, livestream: null }), page, 'live:samplelive'),
    ).toEqual([]);
    const vod = {
      uuid: '0b1f2c3d-4e5f-6789-abcd-ef0123456789',
      source: 'https://stream.kick.com/ivs/v1/x/master.m3u8',
      livestream: {
        session_title: 'Yesterday',
        duration: 3_600_000,
        channel: { slug: 'samplelive' },
      },
    };
    const [v] = kick.parse(JSON.stringify(vod), page, `vod:${vod.uuid}`);
    expect(v).toMatchObject({ kind: 'hls', title: 'Yesterday', duration: 3600 });
  });
});

describe('Rutube', () => {
  it('a video, a Short, a broadcast and the embedded player; a private video’s key goes along', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(idOf(`https://rutube.ru/video/${id}/`)).toBe(id);
    expect(idOf(`https://rutube.ru/shorts/${id}/`)).toBe(id);
    expect(idOf(`https://rutube.ru/live/video/${id}/`)).toBe(id);
    expect(idOf(`https://rutube.ru/play/embed/${id}`)).toBe(id);
    expect(idOf(`https://rutube.ru/video/private/${id}/?p=KeY123`)).toBe(`${id}@KeY123`);
    const api = new URL(
      rutubeApi(`${id}@KeY123`, new URL(`https://rutube.ru/video/private/${id}/`)),
    );
    expect(api.pathname).toBe(`/api/play/options/${id}/`);
    expect(api.searchParams.get('p')).toBe('KeY123');
  });

  it('its HLS, title, author, text and subtitles', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const options = {
      title: 'Море',
      description: 'Рассвет',
      duration: 61,
      author: { name: 'Канал' },
      video_balancer: { m3u8: 'https://bl.rutube.ru/route/x.m3u8' },
      captions: [{ code: 'ru', file: 'https://pic.rutubelist.ru/c.vtt', langTitle: 'Русский' }],
    };
    expect(
      rutube.parse(JSON.stringify(options), new URL(`https://rutube.ru/video/${id}/`), id),
    ).toEqual([
      expect.objectContaining({
        kind: 'hls',
        url: 'https://bl.rutube.ru/route/x.m3u8',
        title: 'Море',
        author: 'Канал',
        subtitles: [
          { kind: 'vtt', url: 'https://pic.rutubelist.ru/c.vtt', language: 'ru', label: 'Русский' },
        ],
      }),
    ]);
  });
});

describe('Dailymotion', () => {
  it('a video’s page, a short link, an embedded player', () => {
    expect(idOf('https://www.dailymotion.com/video/x8abcd1')).toBe('x8abcd1');
    expect(idOf('https://dai.ly/x8abcd1')).toBe('x8abcd1');
    expect(idOf('https://www.dailymotion.com/embed/video/x8abcd1')).toBe('x8abcd1');
    expect(idOf('https://geo.dailymotion.com/player/xyz.html?video=x8abcd1')).toBe('x8abcd1');
  });

  it('its HLS, title, channel, biggest poster and subtitles; an error answer: nothing', () => {
    const meta = {
      id: 'x8abcd1',
      title: 'Sea',
      duration: 95,
      owner: { screenname: 'Channel' },
      posters: { '120': 'https://s1.dmcdn.net/120.jpg', '1080': 'https://s1.dmcdn.net/1080.jpg' },
      qualities: {
        auto: [
          { type: 'application/x-mpegURL', url: 'https://cdndirector.dailymotion.com/m.m3u8' },
        ],
      },
      subtitles: {
        data: { en: { label: 'English', urls: ['https://static2.dmcdn.net/s_en.srt'] } },
      },
    };
    const page = new URL('https://www.dailymotion.com/video/x8abcd1');
    expect(dailymotion.parse(JSON.stringify(meta), page, 'x8abcd1')).toEqual([
      expect.objectContaining({
        kind: 'hls',
        title: 'Sea',
        author: 'Channel',
        thumbnail: 'https://s1.dmcdn.net/1080.jpg',
        subtitles: [
          {
            kind: 'srt',
            url: 'https://static2.dmcdn.net/s_en.srt',
            language: 'en',
            label: 'English',
          },
        ],
      }),
    ]);
    expect(
      dailymotion.parse(JSON.stringify({ error: { title: 'Private' } }), page, 'x8abcd1'),
    ).toEqual([]);
  });
});

describe('Vimeo', () => {
  it('a video’s page, an unlisted one’s hash, a channel’s, a showcase’s, the player', () => {
    expect(idOf('https://vimeo.com/123456789')).toBe('123456789');
    expect(idOf('https://vimeo.com/123456789/af1e9b2c3d')).toBe('123456789@af1e9b2c3d');
    expect(idOf('https://vimeo.com/channels/staffpicks/123456789')).toBe('123456789');
    expect(idOf('https://vimeo.com/showcase/123456/video/123456789')).toBe('123456789');
    expect(idOf('https://player.vimeo.com/video/123456789?h=af1e9b2c3d')).toBe(
      '123456789@af1e9b2c3d',
    );
    expect(idOf('https://vimeo.com/channels/staffpicks')).toBeUndefined();
    expect(vimeoConfig('123456789@af1e9b2c3d')).toBe(
      'https://player.vimeo.com/video/123456789/config?h=af1e9b2c3d',
    );
  });

  it('its files when Vimeo gives them, best first; else its HLS; subtitles from the player’s host', () => {
    const page = new URL('https://vimeo.com/123456789');
    const config = {
      video: {
        title: 'The New Vimeo Player',
        duration: 62,
        owner: { name: 'Vimeo' },
        thumbs: { '640': 't640', '1280': 't1280' },
      },
      request: {
        files: {
          hls: {
            default_cdn: 'akfire',
            cdns: { akfire: { url: 'https://vod-adaptive-ak.vimeocdn.com/m.m3u8' } },
          },
          progressive: [
            { url: 'https://vod-progressive.akamaized.net/360.mp4', width: 640, height: 360 },
            { url: 'https://vod-progressive.akamaized.net/1080.mp4', width: 1920, height: 1080 },
          ],
        },
        text_tracks: [{ url: '/texttrack/1.vtt?token=x', lang: 'en', label: 'English' }],
      },
    };
    const [files] = vimeo.parse(JSON.stringify(config), page, '123456789');
    expect(files).toMatchObject({
      kind: 'file',
      title: 'The New Vimeo Player',
      author: 'Vimeo',
      thumbnail: 't1280',
    });
    expect(files!.qualities!.map((q) => q.height)).toEqual([1080, 360]);
    expect(files!.subtitles![0]!.url).toBe('https://player.vimeo.com/texttrack/1.vtt?token=x');
    const noFiles = {
      ...config,
      request: { ...config.request, files: { ...config.request.files, progressive: [] } },
    };
    expect(vimeo.parse(JSON.stringify(noFiles), page, '123456789')).toEqual([
      expect.objectContaining({ kind: 'hls', url: 'https://vod-adaptive-ak.vimeocdn.com/m.m3u8' }),
    ]);
  });

  it('every new site is its own adapter', () => {
    expect(siteOf('https://www.twitch.tv/samplechannel')).toBe('twitch');
    expect(siteOf('https://kick.com/samplelive')).toBe('kick');
    expect(siteOf('https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/')).toBe('rutube');
    expect(siteOf('https://dai.ly/x8abcd1')).toBe('dailymotion');
    expect(siteOf('https://vimeo.com/123456789')).toBe('vimeo');
  });
});
