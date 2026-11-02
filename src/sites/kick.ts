import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Kick: a channel on air, a past broadcast (`/<channel>/videos/<uuid>`) and a clip
 * (`/<channel>/clips/<id>` or `?clip=<id>`), asked of Kick's own API from the page — its address
 * and its cookies get past the site's protection; the extension asks only when the page cannot.
 * Broadcasts are HLS; a clip is HLS or a file. Learned from yt-dlp's extractor (Unlicense).
 */
const NOT_CHANNELS = new Set([
  'browse',
  'categories',
  'category',
  'following',
  'search',
  'dashboard',
  'settings',
  'subscriptions',
  'about',
  'careers',
  'emotes',
  'privacy-policy',
  'terms-of-service',
  'community-guidelines',
  'dmca-policy',
]);

/** "live:<channel>", "vod:<uuid>", "clip:<id>". */
function idOf(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const clip = url.searchParams.get('clip') ?? (parts[1] === 'clips' ? parts[2] : undefined);
  if (clip && /^clip_\w+$/.test(clip)) return `clip:${clip}`;
  if (parts[1] === 'videos' && /^[\da-f-]{36}$/i.test(parts[2] ?? '')) return `vod:${parts[2]}`;
  if (parts[0] === 'video' && /^[\da-f-]{36}$/i.test(parts[1] ?? '')) return `vod:${parts[1]}`;
  if (parts.length === 1 && /^[\w-]{3,25}$/.test(parts[0]!) && !NOT_CHANNELS.has(parts[0]!))
    return `live:${parts[0]!.toLowerCase()}`;
  return undefined;
}

/** Where Kick's API answers about one video. */
export function kickApi(id: string): string {
  const [kind, key] = id.split(':') as ['live' | 'vod' | 'clip', string];
  return kind === 'live'
    ? `https://kick.com/api/v2/channels/${key}`
    : kind === 'vod'
      ? `https://kick.com/api/v1/video/${key}`
      : `https://kick.com/api/v2/clips/${key}`;
}

interface Channel {
  slug?: string;
  playback_url?: string;
  user?: { username?: string };
  livestream?: { session_title?: string; thumbnail?: { url?: string } | null } | null;
}

interface Video {
  uuid?: string;
  source?: string;
  livestream?: {
    session_title?: string;
    duration?: number;
    thumbnail?: string;
    channel?: { slug?: string; user?: { username?: string } };
  };
}

interface Clip {
  clip?: {
    id?: string;
    title?: string;
    clip_url?: string;
    video_url?: string;
    thumbnail_url?: string;
    duration?: number;
    channel?: { slug?: string; username?: string };
  };
}

export const kick: SiteAdapter = {
  id: 'kick',
  matches: (url) => /(^|\.)kick\.com$/.test(url.hostname),
  videoId: idOf,
  collect: async (id) => {
    // Runs in the page by itself: the API's address is worked out here again.
    const [kind, key] = id.split(':');
    const path =
      kind === 'live'
        ? `/api/v2/channels/${key}`
        : kind === 'vod'
          ? `/api/v1/video/${key}`
          : `/api/v2/clips/${key}`;
    const res = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    return res.ok ? res.text() : null;
  },
  ask: (id, _page, fetchSite) =>
    fetchSite(kickApi(id), { headers: { Accept: 'application/json' } }).then(textOf),
  parse(answer, _page, id): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let json: unknown;
    try {
      json = JSON.parse(answer);
    } catch {
      return [];
    }
    const [kind, key] = id.split(':');
    if (kind === 'live') {
      const c = json as Channel;
      if (!c.livestream || !c.playback_url) return [];
      const name = c.user?.username ?? c.slug ?? key!;
      return [
        {
          kind: 'hls',
          url: c.playback_url,
          title: c.livestream.session_title?.trim() || `${name} · Kick`,
          author: name,
          thumbnail: c.livestream.thumbnail?.url,
          pageUrl: `https://kick.com/${c.slug ?? key}`,
        },
      ];
    }
    if (kind === 'vod') {
      const v = json as Video;
      if (!v.source) return [];
      const channel = v.livestream?.channel;
      return [
        {
          kind: 'hls',
          url: v.source,
          title: v.livestream?.session_title?.trim() || `Kick ${key}`,
          author: channel?.user?.username ?? channel?.slug,
          thumbnail: v.livestream?.thumbnail,
          // Kick says a broadcast's length in milliseconds.
          duration: v.livestream?.duration ? v.livestream.duration / 1000 : undefined,
          pageUrl: channel?.slug
            ? `https://kick.com/${channel.slug}/videos/${v.uuid ?? key}`
            : `https://kick.com/video/${v.uuid ?? key}`,
        },
      ];
    }
    const c = (json as Clip).clip;
    const url = c?.video_url ?? c?.clip_url;
    if (!c || !url) return [];
    return [
      {
        kind: /\.m3u8(\?|$)/.test(url) ? 'hls' : 'file',
        url,
        title: c.title?.trim() || `Kick ${key}`,
        author: c.channel?.username ?? c.channel?.slug,
        thumbnail: c.thumbnail_url,
        duration: c.duration,
        pageUrl: c.channel?.slug
          ? `https://kick.com/${c.channel.slug}/clips/${c.id ?? key}`
          : `https://kick.com/clips/${c.id ?? key}`,
      },
    ];
  },
};
