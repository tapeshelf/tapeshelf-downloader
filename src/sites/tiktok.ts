import type { Quality } from '../shared/media';
import { textOf, type SiteAdapter } from './types';

/**
 * TikTok: a video's page (`/@user/video/<id>`) carries the video in its own JSON
 * (`__UNIVERSAL_DATA_FOR_REHYDRATION__`): an MP4 for each quality with its exact size
 * (`bitrateInfo`), the description, the cover. A feed moves from video to video by script, so the
 * page's JSON may be of another video; then the page of this one is fetched with the person's
 * session. Slideshows (photos) have no video.
 */
interface TtAddr {
  UrlList?: string[];
  DataSize?: number | string;
  Width?: number;
  Height?: number;
  UrlKey?: string;
}

interface TtItem {
  id?: string;
  desc?: string;
  author?: { uniqueId?: string };
  imagePost?: unknown;
  video?: {
    playAddr?: string;
    bitrateInfo?: { PlayAddr?: TtAddr; CodecType?: string; Bitrate?: number }[];
    duration?: number;
    width?: number;
    height?: number;
    cover?: string;
    originCover?: string;
  };
}

/** A file TikTok's own downloaders skip: on the web host (broken), video without sound, H.266. */
function usable(url: string | undefined, codec = ''): url is string {
  if (!url || /bytevc2/i.test(codec)) return false;
  try {
    const u = new URL(url);
    return u.hostname !== 'www.tiktok.com' && !u.pathname.endsWith('/media-video-hvc1/');
  } catch {
    return false;
  }
}

/** The short side: "720p" of a vertical video is its width. */
const side = (w?: number, h?: number) => (w && h ? Math.min(w, h) : h || w || undefined);

export function tiktokQualities(item: TtItem): Quality[] {
  const v = item.video ?? {};
  const byHeight = new Map<number, { q: Quality; h264: boolean }>();
  for (const b of v.bitrateInfo ?? []) {
    const addr = b.PlayAddr ?? {};
    const url = (addr.UrlList ?? []).find((u) => usable(u, `${b.CodecType} ${addr.UrlKey}`));
    if (!url) continue;
    const height = side(addr.Width, addr.Height) ?? side(v.width, v.height) ?? 0;
    const q: Quality = {
      key: url,
      height,
      width: addr.Width,
      estimate: Number(addr.DataSize) || undefined,
    };
    const h264 = /h264/i.test(b.CodecType ?? '');
    // One file per height: H.264 plays everywhere, else the bigger one.
    const known = byHeight.get(height);
    const bigger = (q.estimate ?? 0) > (known?.q.estimate ?? 0);
    if (!known || (h264 && !known.h264) || (h264 === known.h264 && bigger))
      byHeight.set(height, { q, h264 });
  }
  const list = [...byHeight.values()].map((b) => b.q);
  if (!list.length && usable(v.playAddr))
    list.push({ key: v.playAddr, height: side(v.width, v.height), width: v.width });
  return list.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

export const tiktok: SiteAdapter = {
  id: 'tiktok',
  matches: (url) => /(^|\.)tiktok\.com$/.test(url.hostname),
  videoId: (url) =>
    /^\/(?:@[^/]+|share|embed(?:\/v2)?)\/(?:video\/)?(\d{6,})/.exec(url.pathname)?.[1],
  collect: async (id) => {
    const tag = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
    const own = document.getElementById(tag)?.textContent ?? '';
    if (own.includes(`"id":"${id}"`)) return own;
    const res = await fetch(location.href, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    const m = new RegExp(`<script[^>]+id="${tag}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
    return m?.[1] ?? null;
  },
  ask: (_id, page, fetchSite) => fetchSite(page.href).then(textOf),
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    // The page's script, or the whole page fetched again: its JSON either way.
    const json = answer.trimStart().startsWith('<')
      ? /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(
          answer,
        )?.[1]
      : answer;
    if (!json) return [];
    let item: TtItem | undefined;
    try {
      const data = JSON.parse(json) as {
        __DEFAULT_SCOPE__?: { 'webapp.video-detail'?: { itemInfo?: { itemStruct?: TtItem } } };
      };
      item = data.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    } catch {
      return [];
    }
    if (!item || item.id !== id || item.imagePost) return [];
    const qualities = tiktokQualities(item);
    if (!qualities[0]) return [];
    const desc = item.desc?.trim();
    const user = item.author?.uniqueId;
    return [
      {
        kind: 'file',
        url: qualities[0].key,
        qualities,
        // The description's first line is the title; TikTok has no other.
        title: desc?.split('\n')[0]?.trim() || (user ? `@${user}` : 'TikTok'),
        author: user,
        description: desc,
        thumbnail: item.video?.originCover || item.video?.cover,
        duration: item.video?.duration,
        pageUrl: `${page.origin}/@${user ?? '_'}/video/${id}`,
      },
    ];
  },
};
