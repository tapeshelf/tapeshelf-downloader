import type { Quality } from '../shared/media';
import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Instagram: a post or reel (`/p/<code>`, `/reel/<code>`, `/tv/<code>`) is asked of Instagram's
 * own web API (`/api/v1/media/<id>/info/`) from the page, with the person's session — so it sees
 * what they see, private accounts they follow included. Each video of a post (a carousel holds
 * several) comes with its MP4 versions, the caption and the cover.
 */
interface IgVersion {
  url?: string;
  width?: number;
  height?: number;
}

interface IgMedia {
  code?: string;
  video_versions?: IgVersion[];
  video_duration?: number;
  image_versions2?: { candidates?: IgVersion[] };
  carousel_media?: IgMedia[];
  caption?: { text?: string } | null;
  user?: { username?: string };
  product_type?: string;
}

const side = (w?: number, h?: number) => (w && h ? Math.min(w, h) : h || w || undefined);

function versions(media: IgMedia): Quality[] {
  const byHeight = new Map<number, Quality>();
  for (const v of media.video_versions ?? []) {
    const height = side(v.width, v.height);
    if (!v.url || !height || byHeight.has(height)) continue;
    byHeight.set(height, { key: v.url, height, width: v.width });
  }
  return [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

/** A post's numeric id from its code (base 64 in Instagram's alphabet). */
export function instagramId(code: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const c of code.length > 28 ? code.slice(0, -28) : code)
    id = id * 64n + BigInt(alphabet.indexOf(c));
  return id.toString();
}

export const instagram: SiteAdapter = {
  id: 'instagram',
  matches: (url) => /(^|\.)instagram\.com$/.test(url.hostname),
  videoId: (url) => /^(?:\/[^/]+)?\/(?:p|reels?|tv)\/([\w-]+)/.exec(url.pathname)?.[1],
  collect: async (code) => {
    // The post's numeric id from its code (base 64 in Instagram's alphabet).
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const c of code.length > 28 ? code.slice(0, -28) : code)
      id = id * 64n + BigInt(alphabet.indexOf(c));
    const res = await fetch(`/api/v1/media/${id}/info/`, {
      credentials: 'include',
      headers: {
        Accept: '*/*',
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '359341',
        'X-IG-WWW-Claim': sessionStorage.getItem('www-claim-v2') ?? '0',
      },
    });
    return res.ok ? res.text() : null;
  },
  ask: (code, page, fetchSite) =>
    fetchSite(`${page.origin}/api/v1/media/${instagramId(code)}/info/`, {
      headers: {
        Accept: '*/*',
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '359341',
        'X-IG-WWW-Claim': '0',
      },
    }).then(textOf),
  parse(answer, page, code) {
    if (typeof answer !== 'string') return [];
    let post: IgMedia | undefined;
    try {
      post = (JSON.parse(answer) as { items?: IgMedia[] }).items?.[0];
    } catch {
      return [];
    }
    if (!post) return [];
    const user = post.user?.username;
    const caption = post.caption?.text?.trim() || undefined;
    const title = caption?.split('\n')[0]?.trim() || (user ? `@${user}` : 'Instagram');
    const kind = post.product_type === 'clips' ? 'reel' : 'p';
    const parts = post.carousel_media?.length ? post.carousel_media : [post];
    const videos: SiteVideo[] = [];
    parts.forEach((media, i) => {
      const qualities = versions(media);
      if (!qualities[0]) return;
      videos.push({
        kind: 'file',
        url: qualities[0].key,
        qualities,
        title: parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title,
        author: user,
        description: caption,
        thumbnail: media.image_versions2?.candidates?.[0]?.url,
        duration: media.video_duration,
        pageUrl: `${page.origin}/${kind}/${post.code ?? code}/`,
      });
    });
    return videos;
  },
};
