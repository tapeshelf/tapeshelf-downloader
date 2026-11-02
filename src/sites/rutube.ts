import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Rutube: a video, a Short or a broadcast (`/video/<id>/`, `/shorts/<id>/`,
 * `/live/video/<id>/`, the embedded player), asked of Rutube's player API — the title, the text,
 * the author, the picture, the HLS stream and the subtitles. A private video's key (`?p=`) goes
 * along. Learned from yt-dlp's extractor (Unlicense).
 */
const ID = /(?:\/video\/|\/shorts\/|\/live\/video\/|\/play\/embed\/)(?:private\/)?([\da-f]{32})/;

/** Rutube's API for a video, its private key with it. */
export function rutubeApi(id: string, page: URL): string {
  const [video, key] = id.split('@') as [string, string | undefined];
  const params = new URLSearchParams({ no_404: 'true', referer: page.href, pver: 'v2' });
  if (key) params.set('p', key);
  return `https://rutube.ru/api/play/options/${video}/?${params}`;
}

interface Options {
  title?: string;
  description?: string;
  duration?: number;
  thumbnail_url?: string;
  author?: { name?: string };
  is_adult?: boolean;
  video_balancer?: { m3u8?: string };
  live_streams?: { hls?: { url?: string }[] };
  captions?: { code?: string; file?: string; langTitle?: string }[];
}

export const rutube: SiteAdapter = {
  id: 'rutube',
  matches: (url) => /(^|\.)rutube\.ru$/.test(url.hostname),
  /** "<id>", or "<id>@<private key>". */
  videoId: (url) => {
    const id = ID.exec(url.pathname)?.[1];
    const key = url.searchParams.get('p');
    return id && (key ? `${id}@${key}` : id);
  },
  collect: () => Promise.resolve(null),
  ask: (id, page, fetchSite) => fetchSite(rutubeApi(id, page)).then(textOf),
  parse(answer, page, id): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let o: Options;
    try {
      o = JSON.parse(answer) as Options;
    } catch {
      return [];
    }
    const url = o.video_balancer?.m3u8 ?? o.live_streams?.hls?.[0]?.url;
    if (!url) return [];
    const video = id.split('@')[0]!;
    return [
      {
        kind: 'hls',
        url,
        title: o.title?.trim() || `Rutube ${video}`,
        description: o.description?.trim() || undefined,
        author: o.author?.name,
        thumbnail: o.thumbnail_url,
        duration: o.duration,
        subtitles: (o.captions ?? [])
          .filter((c) => c.file)
          .map((c) => ({
            kind: /\.srt($|\?)/i.test(c.file!) ? ('srt' as const) : ('vtt' as const),
            url: c.file!,
            language: c.code,
            label: c.langTitle,
          })),
        pageUrl:
          page.hostname.endsWith('rutube.ru') && !page.pathname.includes('/play/embed/')
            ? page.href
            : `https://rutube.ru/video/${video}/`,
        sensitive: o.is_adult || undefined,
      },
    ];
  },
};
