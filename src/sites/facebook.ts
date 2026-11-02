import { textOf, type SiteAdapter, type SiteVideo } from './types';

/**
 * Facebook: a video's page (`/<page>/videos/<id>`, `/watch/?v=<id>`, `/reel/<id>`,
 * `video.php?v=`), its data as the page carries it — the JSON in its scripts, or the watch page
 * asked again with the person's session when the page (a feed that moved on) does not have it.
 * The video is a file in HD and SD (`progressive_urls`, or the older `browser_native_*_url` and
 * `playable_url*`), named so — Facebook says no height; the title, the author, the picture and
 * the length beside it. Learned from yt-dlp's extractor (Unlicense).
 */
function idOf(url: URL): string | undefined {
  const v = url.searchParams.get('v') ?? url.searchParams.get('video_id');
  if (/^\/(watch(\/live)?|video\.php|video\/embed)\/?$/.test(url.pathname) && v && /^\d+$/.test(v))
    return v;
  return /\/(?:videos|reel|reels)\/(?:[^/]+\/)?(\d{6,})/.exec(url.pathname)?.[1];
}

/** A JSON string's value as it stands in the page (escaped). */
const unescape = (raw: string) => {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

const STRING = '"((?:[^"\\\\]|\\\\.)*)"';
const first = (text: string, field: string) => {
  const m = new RegExp(`"${field}":${STRING}`).exec(text);
  return m ? unescape(m[1]!) : undefined;
};

/** The part of the page about this video: around its id, else all of it. */
function around(text: string, id: string): string {
  const at = [`"video_id":"${id}"`, `"videoId":"${id}"`, `"id":"${id}"`]
    .map((mark) => text.indexOf(mark))
    .find((i) => i >= 0);
  return at === undefined ? text : text.slice(Math.max(0, at - 30_000), at + 30_000);
}

/** HD and SD files, best first. */
export function facebookFiles(text: string): { url: string; label: 'HD' | 'SD' }[] {
  const files: { url: string; label: 'HD' | 'SD' }[] = [];
  const add = (url: string | undefined, label: 'HD' | 'SD') => {
    if (url?.startsWith('https:') && !files.some((f) => f.label === label))
      files.push({ url, label });
  };
  const progressive = new RegExp(`"progressive_url":${STRING}[^}]*?"quality":"(HD|SD)"`, 'g');
  for (const m of text.matchAll(progressive)) add(unescape(m[1]!), m[2] as 'HD' | 'SD');
  add(first(text, 'browser_native_hd_url'), 'HD');
  add(first(text, 'playable_url_quality_hd'), 'HD');
  add(first(text, 'browser_native_sd_url'), 'SD');
  add(first(text, 'playable_url'), 'SD');
  return files.sort((a, b) => (a.label === b.label ? 0 : a.label === 'HD' ? -1 : 1));
}

export const facebook: SiteAdapter = {
  id: 'facebook',
  matches: (url) => /(^|\.)facebook\.com$/.test(url.hostname),
  videoId: idOf,
  collect: async (id) => {
    // Runs in the page by itself: its scripts' data first, else the watch page asked again.
    const known = [...document.querySelectorAll('script[type="application/json"]')]
      .map((s) => s.textContent ?? '')
      .filter(
        (t) => t.includes(id) && /progressive_url|browser_native_(hd|sd)_url|playable_url/.test(t),
      );
    const title =
      document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? '';
    if (known.length) return JSON.stringify({ text: known.join('\n'), title });
    const res = await fetch(`/watch/?v=${id}`, { credentials: 'include' });
    return res.ok ? JSON.stringify({ text: await res.text(), title: '' }) : null;
  },
  ask: (id, _page, fetchSite) =>
    fetchSite(`https://www.facebook.com/watch/?v=${id}`, {
      headers: { Accept: 'text/html' },
    }).then(textOf),
  parse(answer, page, id): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let text = answer;
    let title = '';
    if (answer.startsWith('{"text":')) {
      try {
        ({ text, title } = JSON.parse(answer) as { text: string; title: string });
      } catch {
        return [];
      }
    }
    const part = around(text, id);
    const files = facebookFiles(part);
    if (!files.length) return [];
    const meta = (property: string) => {
      const value = new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(text)?.[1];
      return value
        ?.replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    };
    const own = new RegExp(`"title":\\{"text":${STRING}`).exec(part);
    const named = (own && unescape(own[1]!)) || title || meta('og:title');
    const ms = /"playable_duration_in_ms":(\d+)/.exec(part)?.[1];
    const seconds = /"length_in_second":([\d.]+)/.exec(part)?.[1];
    return [
      {
        kind: 'file',
        url: files[0]!.url,
        qualities: files.map((f) => ({ key: f.url, label: f.label })),
        title: (named ?? '').replace(/\s*\|\s*Facebook\s*$/, '').trim() || `Facebook ${id}`,
        author: (() => {
          const m = new RegExp(`"owner":\\{[^{}]*?"name":${STRING}`).exec(part);
          return m ? unescape(m[1]!) : undefined;
        })(),
        thumbnail: (() => {
          const m = new RegExp(`"preferred_thumbnail":\\{"image":\\{"uri":${STRING}`).exec(part);
          return m ? unescape(m[1]!) : meta('og:image');
        })(),
        duration: ms ? Number(ms) / 1000 : seconds ? Number(seconds) : undefined,
        pageUrl: page.href.split('#')[0]!,
      },
    ];
  },
};
