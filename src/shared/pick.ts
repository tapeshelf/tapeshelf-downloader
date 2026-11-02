import { mediaId, type FoundMedia } from './media';
import type { PageVideo } from './page-info';

/**
 * What the list offers: no variants standing for their master; a live HLS stream to record,
 * no other live one; DRM stays, greyed.
 */
export const listed = (items: FoundMedia[]) =>
  items.filter((i) => !i.hidden && (!i.live || i.kind === 'hls'));

export const saveable = (m: FoundMedia) => !m.drm && !m.live && !m.hidden;

/** A live HLS stream: recorded to the computer from its start or from now. */
export const recordable = (m: FoundMedia) => !!m.live && m.kind === 'hls' && !m.drm && !m.hidden;

/** Addresses of previews, ads and teasers, not of the video itself. */
const PREVIEW = /(preview|thumb|teaser|trailer|sample|sprite|promo|hover|banner|\bads?\b|vast)/i;
const MB = 1024 * 1024;

/**
 * Files that are pieces of one video, not videos: three or more in one folder whose names differ
 * only in their numbers ("…_720p_h264_501.mp4", "…_502.mp4").
 */
export function pieces(items: FoundMedia[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const m of items) {
    if (m.kind !== 'file') continue;
    let url: URL;
    try {
      url = new URL(m.url);
    } catch {
      continue;
    }
    const at = url.pathname.lastIndexOf('/');
    const name = url.pathname.slice(at + 1);
    if (!/\d/.test(name)) continue;
    const key = `${url.host}${url.pathname.slice(0, at)}/${name.replace(/\d+/g, '#')}`;
    groups.set(key, [...(groups.get(key) ?? []), m.id]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length >= 3).flat());
}

/**
 * How likely each found video is the one the person came for. The page's big playing
 * player says the most: its file, or — a player that builds its video from a stream's pieces has
 * no address of its own — the stream of its length. Files of the small players (previews of other
 * videos), pieces of one video, previews and ads by their address, and small files go down.
 */
export function rankMedia(
  items: FoundMedia[],
  videos: PageVideo[] = [],
): { main?: FoundMedia; others: FoundMedia[] } {
  // The page's player: the biggest — a playing one only among those near its size, so a preview
  // playing under the pointer does not take its place.
  const byArea = [...videos].filter((v) => v.area > 0).sort((a, b) => b.area - a.area);
  const player = byArea.find((v) => v.playing && v.area >= byArea[0]!.area / 2) ?? byArea[0];
  const split = pieces(items);
  const biggest = Math.max(0, ...items.map((m) => m.size ?? 0));
  const score = (m: FoundMedia): number => {
    if (!saveable(m) && !recordable(m)) return -Infinity;
    let s = m.site ? 2000 : 0;
    const shown = videos.find((v) => v.src === m.url);
    if (shown && player) s += shown === player ? 1000 : shown.area >= player.area / 2 ? 400 : -400;
    if (m.kind !== 'file') {
      s += 300;
      const length = player?.duration;
      if (length && m.duration && Math.abs(length - m.duration) <= Math.max(2, length * 0.02))
        s += 600;
      if (m.duration !== undefined && m.duration < 30) s -= 200;
    } else {
      s += Math.min(200, ((m.size ?? 0) / MB) * 2);
      if (m.size !== undefined && m.size < 5 * MB && biggest >= 20 * MB) s -= 150;
    }
    if (split.has(m.id)) s -= 600;
    try {
      if (PREVIEW.test(new URL(m.url).pathname)) s -= 300;
    } catch {
      // Not an address: no clue from it.
    }
    // The newest of equals: what the player loaded last.
    return s + m.foundAt / 1e15;
  };
  const ranked = items
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => b.s - a.s)
    .map((r) => r.m);
  const main = ranked.find((m) => saveable(m) || recordable(m));
  return { main, others: ranked.filter((m) => m !== main) };
}

/** The page's video, for the shortcut and the menu on the page: the likeliest. */
export const mainMedia = (items: FoundMedia[], videos: PageVideo[] = []) =>
  rankMedia(items, videos).main;

/** A URL a menu or a link points at, as something to save: one the tab found, or a new one. */
export function fromUrl(url: string, pageUrl: string, items: FoundMedia[]): FoundMedia {
  const path = new URL(url).pathname.toLowerCase();
  const kind = path.endsWith('.m3u8') ? 'hls' : path.endsWith('.mpd') ? 'dash' : 'file';
  return (
    items.find((i) => i.url === url) ?? {
      id: mediaId(kind, url),
      kind,
      url,
      pageUrl,
      referer: pageUrl,
      foundAt: Date.now(),
    }
  );
}
