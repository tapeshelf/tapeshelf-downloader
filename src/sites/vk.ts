import { decodeEntities, htmlToText } from '../shared/html';
import type { Quality } from '../shared/media';
import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * VK (vk.com, vkvideo.ru): a video page names its video (`/video-1_2`, `?z=video-1_2`, clips
 * alike); VK's own `al_video.php?act=show` answers with the player's parameters — an MP4 file for
 * each quality (`url144`…`url2160`), HLS and DASH — and the title, description, picture and length.
 * The files are signed for the person's address, so only their browser can download them.
 */
interface VkParams {
  md_title?: string;
  description?: string;
  jpg?: string;
  duration?: number;
  /** 2: live now. */
  live?: number;
  hls?: string;
  dash_sep?: string;
  [key: string]: unknown;
}

interface VkOptions {
  player?: { params?: VkParams[] };
  mvData?: { title?: string; desc?: string; duration?: number };
}

const HOSTS = /(^|\.)(vk\.com|vk\.ru|vkvideo\.ru)$/;
const ID = /(?:^|[/=])(?:video|clip)(-?\d+_\d+)/;

export const vk: SiteAdapter = {
  id: 'vk',
  matches: (url) => HOSTS.test(url.hostname),
  videoId(url) {
    let address = url.pathname;
    try {
      address += `?${decodeURIComponent(url.search.slice(1))}`;
    } catch {
      address += url.search;
    }
    return ID.exec(address)?.[1];
  },
  collect: async (id) => {
    // On vk.com itself the page asks; other VK domains leave it to the extension.
    if (!/(^|\.)vk\.com$/.test(location.hostname)) return null;
    const res = await fetch('/al_video.php?act=show', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: `act=show&al=1&video=${encodeURIComponent(id)}`,
    });
    return res.ok ? res.text() : null;
  },
  ask: (id, _page, fetchSite) =>
    fetchSite(
      'https://vk.com/al_video.php?act=show',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: `act=show&al=1&video=${encodeURIComponent(id)}`,
      },
      'https://vk.com/',
    ).then(textOf),
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    let json: { payload?: [unknown, unknown[]] };
    try {
      json = JSON.parse(answer) as typeof json;
    } catch {
      return [];
    }
    // Anything but 0 is VK refusing: sign in (3), deleted, private, blocked in the region…
    const [code, parts] = json.payload ?? [];
    if (String(code) !== '0' || !Array.isArray(parts)) return [];
    const options = parts[parts.length - 1] as VkOptions | undefined;
    const p = options?.player?.params?.[0];
    if (!p || p.live === 2) return [];
    const qualities: Quality[] = Object.entries(p)
      .map(([key, value]) => ({ height: Number(/^url(\d+)$/.exec(key)?.[1]), value }))
      .filter((q) => q.height && typeof q.value === 'string' && /^https?:/.test(q.value))
      .map((q) => ({ key: q.value as string, height: q.height }))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const mv = options?.mvData ?? {};
    const common = {
      title: decodeEntities(mv.title ?? p.md_title ?? '').trim(),
      description: htmlToText(mv.desc ?? p.description),
      thumbnail: typeof p.jpg === 'string' ? p.jpg : undefined,
      duration: p.duration ?? mv.duration,
      pageUrl: `${page.origin}/video${id}`,
    };
    let video: SiteVideo | undefined;
    if (qualities[0]) video = { kind: 'file', url: qualities[0].key, qualities, ...common };
    else if (p.hls) video = { kind: 'hls', url: p.hls, ...common };
    else if (p.dash_sep) video = { kind: 'dash', url: p.dash_sep, ...common };
    return video ? [video] : [];
  },
};
