import type { Quality } from '../shared/media';
import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * X (Twitter): a post (`/<user>/status/<id>`) is asked of the endpoint X's own embeds use
 * (`cdn.syndication.twimg.com/tweet-result`), which needs no sign-in: each video or GIF of the
 * post with its MP4 versions, the text, the cover, and whether X marks it sensitive. Posts it does
 * not give (protected accounts) fall back to what the page loads — X's player plays HLS, which the
 * extension finds by itself.
 */
interface XVariant {
  content_type?: string;
  bitrate?: number;
  url?: string;
}

interface XMedia {
  type?: string;
  media_url_https?: string;
  video_info?: { duration_millis?: number; variants?: XVariant[] };
}

interface XPost {
  id_str?: string;
  text?: string;
  user?: { screen_name?: string };
  possibly_sensitive?: boolean;
  mediaDetails?: XMedia[];
}

/** The token X's embeds send with a post's id. */
export const xToken = (id: string) =>
  ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

function variants(media: XMedia): Quality[] {
  const byHeight = new Map<number, Quality & { bitrate: number }>();
  for (const v of media.video_info?.variants ?? []) {
    if (v.content_type !== 'video/mp4' || !v.url) continue;
    const [w, h] = (/\/(\d+)x(\d+)\//.exec(v.url) ?? []).slice(1).map(Number);
    const height = w && h ? Math.min(w, h) : 0;
    const known = byHeight.get(height);
    if (!known || (v.bitrate ?? 0) > known.bitrate)
      byHeight.set(height, {
        key: v.url,
        height: height || undefined,
        width: w,
        bitrate: v.bitrate ?? 0,
      });
  }
  return [...byHeight.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate)
    .map(({ key, height, width }) => ({ key, height, width }));
}

export const x: SiteAdapter = {
  id: 'x',
  matches: (url) => /(^|\.)(x\.com|twitter\.com)$/.test(url.hostname),
  videoId: (url) => /\/status(?:es)?\/(\d{5,})/.exec(url.pathname)?.[1],
  // The page could not ask a third host; the extension does.
  collect: () => Promise.resolve(null),
  ask: (id, _page, fetchSite) =>
    fetchSite(
      `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${xToken(id)}&lang=en`,
      { credentials: 'omit' },
      'https://platform.twitter.com/',
    ).then(textOf),
  parse(answer, _page, id) {
    if (typeof answer !== 'string') return [];
    let post: XPost;
    try {
      post = JSON.parse(answer) as XPost;
    } catch {
      return [];
    }
    if (post.id_str !== id) return [];
    const user = post.user?.screen_name;
    const text = post.text?.replace(/\s*https:\/\/t\.co\/\w+/g, '').trim() || undefined;
    const title = text?.split('\n')[0]?.trim() || (user ? `@${user}` : 'X');
    const media = (post.mediaDetails ?? []).filter(
      (m) => m.type === 'video' || m.type === 'animated_gif',
    );
    const out: SiteVideo[] = [];
    media.forEach((m, i) => {
      const qualities = variants(m);
      if (!qualities[0]) return;
      out.push({
        kind: 'file',
        url: qualities[0].key,
        qualities,
        title: media.length > 1 ? `${title} (${i + 1}/${media.length})` : title,
        author: user,
        description: text,
        thumbnail: m.media_url_https,
        duration: m.video_info?.duration_millis ? m.video_info.duration_millis / 1000 : undefined,
        pageUrl: `https://x.com/${user ?? 'i'}/status/${id}`,
        sensitive: post.possibly_sensitive || undefined,
      });
    });
    return out;
  },
};
