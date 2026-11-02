import { jsonAfter } from '../shared/json-in-html';
import type { Quality } from '../shared/media';
import { estimateBytes } from '../shared/quality';
import { textOf, type SiteAdapter } from './types';

/**
 * Bilibili: a video's page (`/video/BV…`, `?p=` for a part of a multi-part video) holds the player's
 * streams in `window.__playinfo__` — DASH as separate files, a video file per quality and codec
 * and audio files — and the video's title, description and cover in `window.__INITIAL_STATE__`.
 * Video and sound are uploaded as two files and muxed by the worker. A page moved on by script is
 * fetched again.
 */
interface BiliStream {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecid?: number;
  codecs?: string;
  size?: number;
}

interface BiliPlayInfo {
  data?: { dash?: { duration?: number; video?: BiliStream[]; audio?: BiliStream[] } };
}

interface BiliState {
  videoData?: {
    bvid?: string;
    aid?: number;
    title?: string;
    desc?: string;
    pic?: string;
    owner?: { name?: string };
    duration?: number;
    pages?: { page?: number; part?: string; duration?: number }[];
  };
}

/** H.264 plays everywhere, then HEVC, then AV1 (Bilibili's codec ids 7, 12, 13). */
const CODEC_RANK: Record<number, number> = { 7: 0, 12: 1, 13: 2 };

const urlOf = (s: BiliStream) => s.baseUrl ?? s.base_url;

export function bilibiliQualities(video: BiliStream[], seconds: number | undefined): Quality[] {
  const best = new Map<number, BiliStream>();
  for (const v of video) {
    if (!urlOf(v) || !v.height) continue;
    const known = best.get(v.height);
    const rank = (s: BiliStream) => CODEC_RANK[s.codecid ?? 0] ?? 3;
    if (!known || rank(v) < rank(known)) best.set(v.height, v);
  }
  return [...best.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((v) => ({
      key: urlOf(v)!,
      width: v.width,
      height: v.height,
      estimate:
        v.size || (v.bandwidth && seconds ? estimateBytes(v.bandwidth, seconds) : undefined),
    }));
}

export const bilibili: SiteAdapter = {
  id: 'bilibili',
  matches: (url) => /(^|\.)bilibili\.com$/.test(url.hostname),
  videoId: (url) => /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(url.pathname)?.[1],
  collect: async (id) => {
    const w = window as unknown as {
      __playinfo__?: unknown;
      __INITIAL_STATE__?: { videoData?: { bvid?: string; aid?: number } };
    };
    const shown = w.__INITIAL_STATE__?.videoData;
    const same = shown && (shown.bvid === id || `av${shown.aid}` === id.toLowerCase());
    // The page's own state is of this video (and part): hand it over as it is.
    if (same && w.__playinfo__ && !/[?&]p=([2-9]|\d\d)/.test(location.search))
      return JSON.stringify({ playinfo: w.__playinfo__, state: w.__INITIAL_STATE__ });
    const res = await fetch(location.href, { credentials: 'include' });
    return res.ok ? res.text() : null;
  },
  ask: (_id, page, fetchSite) => fetchSite(page.href).then(textOf),
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    let play: BiliPlayInfo | undefined;
    let state: BiliState | undefined;
    if (answer.trimStart().startsWith('{')) {
      try {
        ({ playinfo: play, state } = JSON.parse(answer) as {
          playinfo: BiliPlayInfo;
          state: BiliState;
        });
      } catch {
        return [];
      }
    } else {
      play = jsonAfter(answer, 'window.__playinfo__') as BiliPlayInfo | undefined;
      state = jsonAfter(answer, 'window.__INITIAL_STATE__') as BiliState | undefined;
    }
    const data = state?.videoData;
    const dash = play?.data?.dash;
    if (!data || !dash) return [];
    if (data.bvid !== id && `av${data.aid}` !== id.toLowerCase()) return [];
    const part = Number(page.searchParams.get('p') ?? 1);
    const pages = data.pages ?? [];
    const piece = pages.length > 1 ? pages.find((p) => p.page === part) : undefined;
    const seconds = piece?.duration ?? dash.duration ?? data.duration;
    const qualities = bilibiliQualities(dash.video ?? [], seconds);
    const audio = [...(dash.audio ?? [])]
      .filter((a) => urlOf(a))
      .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (!qualities[0]) return [];
    const title = (data.title ?? '').trim();
    return [
      {
        kind: 'file',
        url: qualities[0].key,
        qualities,
        audio: audio && { url: urlOf(audio)! },
        title: piece?.part && piece.part !== title ? `${title} — ${piece.part}` : title,
        author: state?.videoData?.owner?.name,
        description: data.desc?.trim() || undefined,
        thumbnail: data.pic?.replace(/^http:/, 'https:'),
        duration: seconds,
        pageUrl: `${page.origin}/video/${id}${part > 1 ? `?p=${part}` : ''}`,
      },
    ];
  },
};
