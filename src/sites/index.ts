import { mediaId, type FoundMedia } from '../shared/media';
import { summarize } from '../shared/streams';
import type { SiteAdapter, SiteFetch, SiteVideo } from './types';
import { bilibili } from './bilibili';
import { dailymotion } from './dailymotion';
import { douyin } from './douyin';
import { facebook } from './facebook';
import { instagram } from './instagram';
import { kick } from './kick';
import { manyvids } from './manyvids';
import { reddit } from './reddit';
import { rednote } from './rednote';
import { rutube } from './rutube';
import { telegram } from './telegram';
import { tiktok } from './tiktok';
import { twitch } from './twitch';
import { vimeo } from './vimeo';
import { vk } from './vk';
import { x } from './x';
import { youtube } from './youtube';

declare const __BUILD__: 'store' | 'full';

/**
 * The site adapters of this build, one per site. Only the
 * full build has YouTube and ManyVids (sites of bought videos); the store build has
 * none of their code — they are empty there.
 */
export const ADAPTERS: SiteAdapter[] = [
  vk,
  tiktok,
  douyin,
  bilibili,
  rednote,
  instagram,
  x,
  reddit,
  //
  twitch,
  kick,
  rutube,
  dailymotion,
  vimeo,
  //
  facebook,
  telegram,
  ...(__BUILD__ === 'full' ? [manyvids, youtube] : []),
].filter((a): a is SiteAdapter => !!a);

export function adapterFor(pageUrl: string): { adapter: SiteAdapter; id: string } | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  for (const adapter of ADAPTERS) {
    if (!adapter.matches(url)) continue;
    const id = adapter.videoId(url);
    return id ? { adapter, id } : undefined;
  }
  return undefined;
}

/** Sets the Referer (and User-Agent) of the extension's requests to a host: a session rule. */
export type UseHeaders = (urls: string[], referer: string, userAgent?: string) => Promise<unknown>;

/** A site's video as an item of the list; `id` is the site's (with `#n` for a post's n-th). */
export function asFound(site: string, id: string, v: SiteVideo, referer: string): FoundMedia {
  return {
    id: mediaId(v.kind, `${site}:${id}`),
    kind: v.kind,
    url: v.url,
    size: v.size,
    mimeType: v.mimeType,
    pageUrl: v.pageUrl,
    referer,
    foundAt: Date.now(),
    duration: v.duration,
    qualities: v.qualities,
    audio: v.audio,
    download: v.download,
    title: v.title,
    description: v.description,
    thumbnail: v.thumbnail,
    author: v.author,
    subtitles: v.subtitles,
    sensitive: v.sensitive,
    site,
    siteId: id,
  };
}

/** The extension's requests to a site: its headers set first, the person's cookies with them. */
function siteFetch(useHeaders: UseHeaders, pageUrl: string, userAgent?: string): SiteFetch {
  return async (url, init, referer) => {
    await useHeaders([url], referer ?? pageUrl, userAgent);
    return fetch(url, { credentials: 'include', ...init });
  };
}

/** The adapter's answer, asked from the extension; null when the site refused or failed. */
async function asked(
  adapter: SiteAdapter,
  id: string,
  page: URL,
  useHeaders: UseHeaders,
  fromPage: unknown,
): Promise<unknown> {
  if (!adapter.ask) return null;
  try {
    return await adapter.ask(
      id,
      page,
      siteFetch(useHeaders, page.href, adapter.userAgent),
      fromPage,
    );
  } catch {
    return null;
  }
}

/**
 * The videos a site's adapter finds on a tab: asked in the page, else from the extension.
 * Undefined: no adapter for this page, or it found nothing — the list falls back to what the
 * network showed.
 */
export async function siteVideos(
  tabId: number,
  pageUrl: string,
  useHeaders: UseHeaders,
): Promise<FoundMedia[] | undefined> {
  const match = adapterFor(pageUrl);
  if (!match) return undefined;
  const { adapter, id } = match;
  let fromPage: unknown = null;
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: adapter.collect,
      args: [id],
    });
    fromPage = frame?.result ?? null;
  } catch {
    fromPage = null;
  }
  const page = new URL(pageUrl);
  const answer =
    fromPage === null || adapter.askAlways
      ? await asked(adapter, id, page, useHeaders, fromPage)
      : fromPage;
  const videos = adapter.parse(answer, page, id);
  // A post with several videos (a carousel): each its own item.
  const key = (i: number) => (videos.length > 1 ? `${id}#${i + 1}` : id);
  if (!videos.length) return undefined;
  // A file only its page can read (Telegram Web): read through this tab.
  for (const v of videos) if (v.download?.page) v.download = { ...v.download, tab: tabId };
  return Promise.all(
    videos.map((v, i) => withSummary(asFound(adapter.id, key(i), v, pageUrl), useHeaders)),
  );
}

/**
 * A site's stream as the network's would be: its qualities, length, live or DRM, read from
 * its manifest — the site's answer names only the manifest.
 */
async function withSummary(m: FoundMedia, useHeaders: UseHeaders): Promise<FoundMedia> {
  if (m.kind === 'file' || m.qualities?.length) return m;
  const kind = m.kind;
  try {
    await useHeaders([m.url], m.referer ?? m.pageUrl, m.download?.userAgent);
    const s = await summarize(kind, m.url, async (url) => {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    return {
      ...m,
      duration: m.duration ?? s.duration,
      live: s.live || undefined,
      drm: s.drm || undefined,
      qualities: s.qualities.length ? s.qualities : undefined,
      subtitles: m.subtitles ?? (s.subtitles.length ? s.subtitles : undefined),
    };
  } catch {
    return m;
  }
}

/**
 * A saved video asked of its site again, without its tab — its links expire while it waits in
 * the queue. Undefined: not a site's video, or the site gave nothing now.
 */
export async function refreshed(
  media: { site?: string; siteId?: string; pageUrl: string; referer?: string },
  useHeaders: UseHeaders,
): Promise<FoundMedia | undefined> {
  const adapter = ADAPTERS.find((a) => a.id === media.site);
  if (!adapter?.ask || !media.siteId) return undefined;
  const [id, nth] = media.siteId.split('#') as [string, string | undefined];
  const page = new URL(media.pageUrl);
  const videos = adapter.parse(await asked(adapter, id, page, useHeaders, null), page, id);
  const video = videos[nth ? Number(nth) - 1 : 0];
  return video && asFound(adapter.id, media.siteId, video, media.referer ?? media.pageUrl);
}
