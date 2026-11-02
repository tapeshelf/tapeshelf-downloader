import type { Quality } from '../shared/media';
import { textOf, type SiteAdapter } from './types';

/**
 * Douyin: a video's page (`/video/<id>`, or a feed with `?modal_id=<id>`) asks Douyin's web API
 * (`/aweme/v1/web/aweme/detail/`) for the video, with the person's session there: an MP4 per
 * quality with its size (`bit_rate`), the description, the cover. Slideshows have no video.
 */
interface DyAddr {
  url_list?: string[];
  data_size?: number;
  width?: number;
  height?: number;
}

interface DyAweme {
  aweme_id?: string;
  desc?: string;
  author?: { unique_id?: string; nickname?: string };
  images?: unknown[] | null;
  video?: {
    play_addr?: DyAddr;
    bit_rate?: {
      gear_name?: string;
      bit_rate?: number;
      is_h265?: number;
      is_bytevc1?: number;
      play_addr?: DyAddr;
    }[];
    duration?: number;
    width?: number;
    height?: number;
    cover?: { url_list?: string[] };
    origin_cover?: { url_list?: string[] };
  };
}

const side = (w?: number, h?: number) => (w && h ? Math.min(w, h) : h || w || undefined);
const https = (url: string) => url.replace(/^http:/, 'https:');

export function douyinQualities(aweme: DyAweme): Quality[] {
  const v = aweme.video ?? {};
  const byHeight = new Map<number, { q: Quality; h264: boolean }>();
  const add = (addr: DyAddr | undefined, h264: boolean, bitrate = 0) => {
    const url = addr?.url_list?.find((u) => /^https?:/.test(u));
    if (!url) return;
    const height = side(addr!.width, addr!.height) ?? side(v.width, v.height) ?? 0;
    const q: Quality = {
      key: https(url),
      height,
      width: addr!.width,
      estimate:
        addr!.data_size ||
        (bitrate && v.duration ? Math.ceil((bitrate * v.duration) / 8000) : undefined),
    };
    const known = byHeight.get(height);
    if (!known || (h264 && !known.h264)) byHeight.set(height, { q, h264 });
  };
  for (const b of v.bit_rate ?? []) add(b.play_addr, !(b.is_h265 || b.is_bytevc1), b.bit_rate);
  if (!byHeight.size) add(v.play_addr, true);
  return [...byHeight.values()].map((b) => b.q).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

export const douyin: SiteAdapter = {
  id: 'douyin',
  matches: (url) => /(^|\.)douyin\.com$/.test(url.hostname),
  videoId: (url) =>
    /^\/video\/(\d{6,})/.exec(url.pathname)?.[1] ??
    (/^\d{6,}$/.test(url.searchParams.get('modal_id') ?? '')
      ? url.searchParams.get('modal_id')!
      : undefined),
  collect: async (id) => {
    const query = new URLSearchParams({ aweme_id: id, aid: '6383', device_platform: 'webapp' });
    const res = await fetch(`/aweme/v1/web/aweme/detail/?${query}`, { credentials: 'include' });
    const text = res.ok ? await res.text() : '';
    return text || null;
  },
  ask: (id, page, fetchSite) =>
    fetchSite(
      `${page.origin}/aweme/v1/web/aweme/detail/?${new URLSearchParams({ aweme_id: id, aid: '6383', device_platform: 'webapp' })}`,
    ).then(textOf),
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    let aweme: DyAweme | undefined;
    try {
      aweme = (JSON.parse(answer) as { aweme_detail?: DyAweme }).aweme_detail;
    } catch {
      return [];
    }
    if (!aweme || aweme.aweme_id !== id || aweme.images?.length) return [];
    const qualities = douyinQualities(aweme);
    if (!qualities[0]) return [];
    const desc = aweme.desc?.trim();
    const cover = aweme.video?.origin_cover?.url_list?.[0] ?? aweme.video?.cover?.url_list?.[0];
    return [
      {
        kind: 'file',
        url: qualities[0].key,
        qualities,
        title: desc?.split('\n')[0]?.trim() || aweme.author?.nickname || 'Douyin',
        author: aweme.author?.nickname,
        description: desc,
        thumbnail: cover && https(cover),
        // Douyin counts in milliseconds.
        duration: aweme.video?.duration ? aweme.video.duration / 1000 : undefined,
        pageUrl: `${page.origin}/video/${id}`,
      },
    ];
  },
};
