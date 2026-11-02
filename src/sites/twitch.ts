import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Twitch: a channel on air, a past broadcast (`/videos/<id>`) and a clip, asked of Twitch's
 * GraphQL with its website's public client id — the title, the channel, the picture, and the token
 * its video servers want. A broadcast and a past one are HLS from Twitch's "usher" (ads stitched
 * into a live one are marked there and left out); a clip is a file in each of its qualities.
 * Learned from yt-dlp's extractor (Unlicense).
 */
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const PARAMS = '{platform: "web", playerBackend: "mediaplayer", playerType: "site"}';

/** Twitch's own pages, not channels. */
const NOT_CHANNELS = new Set([
  'directory',
  'videos',
  'settings',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'downloads',
  'jobs',
  'search',
  'turbo',
  'prime',
  'store',
  'friends',
  'messages',
  'payments',
  'p',
  'legal',
  'team',
  'login',
  'signup',
  'logout',
  'broadcast',
  'dashboard',
  'moderator',
  'popout',
  'embed',
  'following',
  'bits',
  'products',
  'event',
  'collections',
  'u',
]);

/** "live:<login>", "vod:<id>", "clip:<slug>". */
function idOf(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'clips.twitch.tv') {
    const slug = url.searchParams.get('clip') ?? (parts[0] !== 'embed' ? parts[0] : undefined);
    return slug ? `clip:${slug}` : undefined;
  }
  if (url.hostname === 'player.twitch.tv') {
    const video = url.searchParams.get('video')?.replace(/^v/, '');
    const channel = url.searchParams.get('channel');
    return video ? `vod:${video}` : channel ? `live:${channel.toLowerCase()}` : undefined;
  }
  if (parts[0] === 'videos' && /^\d+$/.test(parts[1] ?? '')) return `vod:${parts[1]}`;
  if (parts[1] === 'v' && /^\d+$/.test(parts[2] ?? '')) return `vod:${parts[2]}`;
  if (parts[1] === 'clip' && parts[2]) return `clip:${parts[2]}`;
  if (
    parts.length === 1 &&
    /^\w{3,25}$/.test(parts[0]!) &&
    !NOT_CHANNELS.has(parts[0]!.toLowerCase())
  )
    return `live:${parts[0]!.toLowerCase()}`;
  return undefined;
}

/** The questions for one video, sent together. */
export function twitchQuery(id: string): string {
  const [kind, key] = id.split(':') as ['live' | 'vod' | 'clip', string];
  const q = JSON.stringify(key);
  const query =
    kind === 'live'
      ? `query { user(login: ${q}) { login displayName stream { id title previewImageURL(width: 1280, height: 720) } } token: streamPlaybackAccessToken(channelName: ${q}, params: ${PARAMS}) { value signature } }`
      : kind === 'vod'
        ? `query { video(id: ${q}) { id title description lengthSeconds previewThumbnailURL(width: 1280, height: 720) owner { login displayName } } token: videoPlaybackAccessToken(id: ${q}, params: ${PARAMS}) { value signature } }`
        : `query { clip(slug: ${q}) { slug title durationSeconds thumbnailURL broadcaster { login displayName } videoQualities { quality frameRate sourceURL } playbackAccessToken(params: ${PARAMS}) { value signature } } }`;
  return JSON.stringify({ query });
}

interface Token {
  value?: string;
  signature?: string;
}

interface Answer {
  data?: {
    user?: {
      login?: string;
      displayName?: string;
      stream?: { title?: string; previewImageURL?: string } | null;
    } | null;
    video?: {
      id?: string;
      title?: string;
      description?: string | null;
      lengthSeconds?: number;
      previewThumbnailURL?: string;
      owner?: { login?: string; displayName?: string };
    } | null;
    clip?: {
      slug?: string;
      title?: string;
      durationSeconds?: number;
      thumbnailURL?: string;
      broadcaster?: { login?: string; displayName?: string };
      videoQualities?: { quality?: string; frameRate?: number; sourceURL?: string }[];
      playbackAccessToken?: Token;
    } | null;
    token?: Token | null;
  };
}

/** A number the video servers want to see differ between requests. */
const random = () => String(Math.floor(1_000_000 + Math.random() * 9_000_000));

function usher(path: string, token: Token, vod: boolean): string {
  const params = new URLSearchParams({
    allow_source: 'true',
    allow_audio_only: 'true',
    p: random(),
    platform: 'web',
    player: 'twitchweb',
    playlist_include_framerate: 'true',
    supported_codecs: 'h264',
    ...(vod
      ? { nauth: token.value!, nauthsig: token.signature! }
      : { token: token.value!, sig: token.signature! }),
  });
  return `https://usher.ttvnw.net/${path}.m3u8?${params}`;
}

export const twitch: SiteAdapter = {
  id: 'twitch',
  matches: (url) => /(^|\.)twitch\.tv$/.test(url.hostname),
  videoId: idOf,
  // Twitch's GraphQL is another host than its pages: the extension asks it.
  collect: () => Promise.resolve(null),
  ask: (id, _page, fetchSite) =>
    fetchSite(
      'https://gql.twitch.tv/gql',
      {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
        body: twitchQuery(id),
      },
      'https://www.twitch.tv/',
    ).then(textOf),
  parse(answer, _page, id): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let data: Answer['data'];
    try {
      data = (JSON.parse(answer) as Answer).data;
    } catch {
      return [];
    }
    const [kind] = id.split(':');
    const token = data?.token;
    if (kind === 'live') {
      const user = data?.user;
      if (!user?.login || !user.stream || !token?.value || !token.signature) return [];
      return [
        {
          kind: 'hls',
          url: usher(`api/channel/hls/${user.login}`, token, false),
          title: user.stream.title?.trim() || `${user.displayName ?? user.login} · Twitch`,
          author: user.displayName ?? user.login,
          thumbnail: user.stream.previewImageURL,
          pageUrl: `https://www.twitch.tv/${user.login}`,
        },
      ];
    }
    if (kind === 'vod') {
      const video = data?.video;
      if (!video?.id || !token?.value || !token.signature) return [];
      return [
        {
          kind: 'hls',
          url: usher(`vod/${video.id}`, token, true),
          title: video.title?.trim() || `Twitch ${video.id}`,
          description: video.description?.trim() || undefined,
          author: video.owner?.displayName ?? video.owner?.login,
          thumbnail: video.previewThumbnailURL,
          duration: video.lengthSeconds,
          pageUrl: `https://www.twitch.tv/videos/${video.id}`,
        },
      ];
    }
    const clip = data?.clip;
    const access = clip?.playbackAccessToken;
    const files = (clip?.videoQualities ?? []).filter((q) => q.sourceURL);
    if (!clip?.slug || !access?.value || !access.signature || !files.length) return [];
    const signed = (url: string) =>
      `${url}${url.includes('?') ? '&' : '?'}sig=${access.signature}&token=${encodeURIComponent(access.value!)}`;
    const qualities = files
      .map((q) => ({ key: signed(q.sourceURL!), height: Number(q.quality) || undefined }))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    return [
      {
        kind: 'file',
        url: qualities[0]!.key,
        qualities,
        title: clip.title?.trim() || clip.slug,
        author: clip.broadcaster?.displayName ?? clip.broadcaster?.login,
        thumbnail: clip.thumbnailURL,
        duration: clip.durationSeconds,
        pageUrl: clip.broadcaster?.login
          ? `https://www.twitch.tv/${clip.broadcaster.login}/clip/${clip.slug}`
          : `https://clips.twitch.tv/${clip.slug}`,
      },
    ];
  },
};
