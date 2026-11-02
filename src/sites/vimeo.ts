import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Vimeo: a video's page (`vimeo.com/<id>`, an unlisted one's `/<id>/<hash>`, a channel's,
 * a group's, a showcase's) or its player (`player.vimeo.com/video/<id>?h=<hash>`), asked of the
 * player's config — the title, the owner, the length, the picture, the subtitles, and the HLS
 * stream (its sound apart, as Vimeo gives it), or the files where Vimeo still gives them.
 * Learned from yt-dlp's extractor (Unlicense).
 */

/** "<id>", or "<id>@<hash>" for an unlisted video. */
function idOf(url: URL): string | undefined {
  const m =
    url.hostname === 'player.vimeo.com'
      ? /^\/video\/(\d+)/.exec(url.pathname)
      : /^\/(?:(?:channels\/[\w-]+|groups\/[\w-]+\/videos|(?:showcase|album)\/\d+\/video)\/)?(\d{5,})(?:\/([\da-f]{6,}))?\/?$/.exec(
          url.pathname,
        );
  if (!m) return undefined;
  const hash = url.searchParams.get('h') ?? m[2];
  return hash ? `${m[1]}@${hash}` : m[1];
}

/** The player's config of a video, an unlisted one's hash with it. */
export function vimeoConfig(id: string): string {
  const [video, hash] = id.split('@') as [string, string | undefined];
  return `https://player.vimeo.com/video/${video}/config${hash ? `?h=${hash}` : ''}`;
}

interface Config {
  video?: {
    id?: number;
    title?: string;
    duration?: number;
    owner?: { name?: string };
    thumbs?: Record<string, string>;
    url?: string;
  };
  request?: {
    files?: {
      hls?: { default_cdn?: string; cdns?: Record<string, { url?: string }> };
      progressive?: { url?: string; width?: number; height?: number; size?: number }[];
    };
    text_tracks?: { url?: string; lang?: string; label?: string }[];
  };
}

export const vimeo: SiteAdapter = {
  id: 'vimeo',
  matches: (url) => /(^|\.)vimeo\.com$/.test(url.hostname),
  videoId: idOf,
  collect: () => Promise.resolve(null),
  ask: (id, page, fetchSite) =>
    fetchSite(
      vimeoConfig(id),
      undefined,
      page.hostname.endsWith('vimeo.com') ? 'https://vimeo.com/' : page.href,
    ).then(textOf),
  parse(answer, page, id): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let c: Config;
    try {
      c = JSON.parse(answer) as Config;
    } catch {
      return [];
    }
    const files = c.request?.files;
    const hls = files?.hls?.cdns;
    const hlsUrl = hls
      ? (hls[files!.hls!.default_cdn ?? ''] ?? Object.values(hls)[0])?.url
      : undefined;
    const progressive = (files?.progressive ?? [])
      .filter((f) => f.url)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const video = c.video;
    const [videoId] = id.split('@') as [string];
    const thumbs = Object.entries(video?.thumbs ?? {}).sort(
      (a, b) => (Number(b[0]) || 0) - (Number(a[0]) || 0),
    );
    const common = {
      title: video?.title?.trim() || `Vimeo ${videoId}`,
      author: video?.owner?.name,
      thumbnail: thumbs[0]?.[1],
      duration: video?.duration,
      subtitles: (c.request?.text_tracks ?? [])
        .filter((t) => t.url)
        .map((t) => ({
          kind: 'vtt' as const,
          url: new URL(t.url!, 'https://player.vimeo.com/').href,
          language: t.lang,
          label: t.label,
        })),
      pageUrl:
        page.hostname === 'vimeo.com' ? page.href : (video?.url ?? `https://vimeo.com/${videoId}`),
    };
    // The files, when Vimeo gives them: each quality as it is; else its stream.
    if (progressive.length)
      return [
        {
          kind: 'file',
          url: progressive[0]!.url!,
          qualities: progressive.map((f) => ({
            key: f.url!,
            width: f.width,
            height: f.height,
            size: f.size,
          })),
          ...common,
        },
      ];
    return hlsUrl ? [{ kind: 'hls', url: hlsUrl, ...common }] : [];
  },
};
