import { jsonAfter } from '../shared/json-in-html';
import type { Quality } from '../shared/media';
import { textOf, type SiteAdapter } from './types';

/**
 * RedNote (Xiaohongshu): a note's page (`/explore/<id>`, `/discovery/item/<id>`) holds the note in
 * `window.__INITIAL_STATE__` (written with JavaScript's `undefined`): for a video note, MP4 streams
 * by codec with their sizes, the title, the text and the pictures. A feed opening notes over itself
 * keeps the first page's state; then the note's page is fetched again.
 */
interface RnStream {
  masterUrl?: string;
  backupUrls?: string[];
  width?: number;
  height?: number;
  size?: number;
  duration?: number;
}

interface RnNote {
  noteId?: string;
  type?: string;
  title?: string;
  desc?: string;
  user?: { nickname?: string };
  imageList?: { urlDefault?: string }[];
  video?: { media?: { stream?: Record<string, RnStream[] | null> } };
}

/** H.264 plays everywhere, then H.265, then AV1. */
const CODECS = ['h264', 'h265', 'av1'];
const side = (w?: number, h?: number) => (w && h ? Math.min(w, h) : h || w || undefined);
const https = (url: string) => url.replace(/^http:/, 'https:');

export function rednoteQualities(note: RnNote): { qualities: Quality[]; seconds?: number } {
  const stream = note.video?.media?.stream ?? {};
  const byHeight = new Map<number, Quality>();
  let seconds: number | undefined;
  for (const codec of [...CODECS, ...Object.keys(stream).filter((k) => !CODECS.includes(k))]) {
    for (const s of stream[codec] ?? []) {
      const url = s.masterUrl ?? s.backupUrls?.[0];
      const height = side(s.width, s.height);
      if (!url || !height || byHeight.has(height)) continue;
      byHeight.set(height, {
        key: https(url),
        height,
        width: s.width,
        estimate: s.size || undefined,
      });
      seconds ??= s.duration ? s.duration / 1000 : undefined;
    }
  }
  return {
    qualities: [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0)),
    seconds,
  };
}

export const rednote: SiteAdapter = {
  id: 'rednote',
  matches: (url) => /(^|\.)(xiaohongshu\.com|rednote\.com)$/.test(url.hostname),
  videoId: (url) => /^\/(?:explore|discovery\/item)\/([\da-f]{24})/.exec(url.pathname)?.[1],
  collect: async (id) => {
    const own = [...document.scripts]
      .map((s) => s.textContent ?? '')
      .find((t) => t.includes('window.__INITIAL_STATE__'));
    if (own?.includes(id)) return own;
    const res = await fetch(location.href, { credentials: 'include' });
    return res.ok ? res.text() : null;
  },
  ask: (_id, page, fetchSite) => fetchSite(page.href).then(textOf),
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    const state = jsonAfter(answer, 'window.__INITIAL_STATE__') as
      { note?: { noteDetailMap?: Record<string, { note?: RnNote }> } } | undefined;
    const note = state?.note?.noteDetailMap?.[id]?.note;
    if (!note || note.type !== 'video') return [];
    const { qualities, seconds } = rednoteQualities(note);
    if (!qualities[0]) return [];
    const desc = note.desc?.trim() || undefined;
    const cover = note.imageList?.[0]?.urlDefault;
    return [
      {
        kind: 'file',
        url: qualities[0].key,
        qualities,
        title: note.title?.trim() || desc?.split('\n')[0] || note.user?.nickname || 'RedNote',
        author: note.user?.nickname,
        description: desc,
        thumbnail: cover && https(cover),
        duration: seconds,
        pageUrl: `${page.origin}/explore/${id}`,
      },
    ];
  },
};
