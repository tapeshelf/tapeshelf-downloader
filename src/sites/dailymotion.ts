import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Dailymotion: a video's page, a short link (`dai.ly/<id>`) or an embedded player, asked
 * of Dailymotion's player metadata — the title, the channel, the length, the picture, the HLS
 * stream and the subtitles. A private or geo-blocked video answers with an error: nothing found.
 * Learned from yt-dlp's extractor (Unlicense).
 */
function idOf(url: URL): string | undefined {
  if (url.hostname === 'dai.ly') return /^\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  const fromPath = /\/(?:embed\/)?video\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  return fromPath ?? url.searchParams.get('video') ?? undefined;
}

export const dailymotionApi = (id: string) =>
  `https://www.dailymotion.com/player/metadata/video/${id}?embedder=${encodeURIComponent('https://www.dailymotion.com/')}&locale=en`;

interface Metadata {
  id?: string;
  title?: string;
  duration?: number;
  is_live?: boolean;
  owner?: { screenname?: string; username?: string };
  posters?: Record<string, string>;
  qualities?: Record<string, { type?: string; url?: string }[]>;
  subtitles?: { data?: Record<string, { label?: string; urls?: string[] }> };
  error?: unknown;
}

export const dailymotion: SiteAdapter = {
  id: 'dailymotion',
  matches: (url) => /(^|\.)(dailymotion\.com|dai\.ly)$/.test(url.hostname),
  videoId: idOf,
  collect: () => Promise.resolve(null),
  ask: (id, _page, fetchSite) =>
    fetchSite(dailymotionApi(id), undefined, 'https://www.dailymotion.com/').then(textOf),
  parse(answer, _page, id): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let m: Metadata;
    try {
      m = JSON.parse(answer) as Metadata;
    } catch {
      return [];
    }
    if (m.error) return [];
    const url = Object.values(m.qualities ?? {})
      .flat()
      .find((q) => q.type === 'application/x-mpegURL' && q.url)?.url;
    if (!url) return [];
    const posters = Object.entries(m.posters ?? {}).sort((a, b) => Number(b[0]) - Number(a[0]));
    return [
      {
        kind: 'hls',
        url,
        title: m.title?.trim() || `Dailymotion ${id}`,
        author: m.owner?.screenname ?? m.owner?.username,
        thumbnail: posters[0]?.[1],
        duration: m.duration || undefined,
        subtitles: Object.entries(m.subtitles?.data ?? {}).flatMap(([language, s]) =>
          s.urls?.[0]
            ? [
                {
                  kind: /\.srt($|\?)/i.test(s.urls[0]) ? ('srt' as const) : ('vtt' as const),
                  url: s.urls[0],
                  language,
                  label: s.label,
                },
              ]
            : [],
        ),
        pageUrl: `https://www.dailymotion.com/video/${m.id ?? id}`,
      },
    ];
  },
};
