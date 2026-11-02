import { AUDIO, videoChoices, type Choice } from '../shared/choices';
import { allowedToSend } from '../shared/consent';
import { loadTranslate } from '../shared/i18n';
import type { FoundMedia } from '../shared/media';
import type { PageBytes, PendingSave } from '../shared/messages';
import { pickQuality } from '../shared/quality';
import { defaultMeta, downloadJob, saveRequest } from '../shared/request';
import { getAccount, getSettings } from '../shared/settings';
import { fileSize } from '../shared/size';
import { adapterFor, siteVideos } from '../sites';
import { useReferer } from './headers';
import { currentLang } from './lang';
import { openPopup } from './menus';
import { enqueue } from './queue';

/**
 * The button on a site's page: beside the site's own buttons of a post, a menu of the
 * post's video — each quality with its size, the sound alone, MP3, "Save to My shelf". The post is
 * asked of its site's adapter, as the popup asks for the page's.
 */
export interface PageVideo {
  title: string;
  choices: Choice[];
  /** The settings' quality, picked unless changed. */
  picked: string;
}

export interface PageMenu {
  videos: PageVideo[];
  labels: { mp3: string; shelf: string; nothing: string; started: string; title: string };
}

/** What each tab's posts were found to have, while their menus are open (the worker may sleep). */
const asked = new Map<string, FoundMedia[]>();
const key = (tabId: number, url: string) => `${tabId} ${url}`;

/** The button's word, and whether the page's address names a post an adapter of this build knows. */
export async function pageSite(url: string): Promise<{ here: boolean; label: string }> {
  const t = await loadTranslate(await currentLang());
  return { here: !!adapterFor(url), label: t('page.button') };
}

/** Sizes of a site's files its answer did not give, asked of their servers — two seconds at most. */
async function sizesOf(videos: FoundMedia[]): Promise<Map<string, number | null>> {
  const sizes = new Map<string, number | null>();
  const urls = videos.flatMap((m) => [
    ...(m.kind === 'file'
      ? (m.qualities ?? []).filter((q) => q.size === undefined).map((q) => q.key)
      : []),
    ...(m.audio && m.audio.size === undefined ? [m.audio.url] : []),
  ]);
  const signal = AbortSignal.timeout(2000);
  await Promise.all(
    urls.slice(0, 12).map(async (url) => {
      const m = videos.find(
        (v) => v.qualities?.some((q) => q.key === url) || v.audio?.url === url,
      )!;
      await useReferer([url], m.referer ?? m.pageUrl, m.download?.userAgent).catch(() => undefined);
      sizes.set(url, (await fileSize(url, signal).catch(() => undefined)) ?? null);
    }),
  );
  return sizes;
}

export async function pageMenu(tabId: number, url: string): Promise<PageMenu> {
  const [settings, t, lang] = await Promise.all([
    getSettings(),
    currentLang().then(loadTranslate),
    currentLang(),
  ]);
  const labels = {
    mp3: 'MP3',
    shelf: t('save.button'),
    nothing: t('page.nothing'),
    started: t('page.started'),
    title: t('page.button'),
  };
  if (!adapterFor(url)) return { videos: [], labels };
  const videos = (await siteVideos(tabId, url, useReferer)) ?? [];
  asked.set(key(tabId, url), videos);
  const sizes = await sizesOf(videos);
  return {
    labels,
    videos: videos.map((m) => ({
      title: m.title ?? '',
      choices: videoChoices(m, sizes, t, lang),
      picked: (m.qualities?.length && pickQuality(m.qualities, settings.quality, -1)?.key) || '',
    })),
  };
}

/**
 * A choice of the menu: to the computer in that quality, its sound, MP3 — or to the shelf, through
 * the popup's form (or connecting) unless the form is off. Answers whether the popup took it.
 */
export async function pageSave(
  tabId: number,
  url: string,
  index: number,
  choice: string,
  to: 'disk' | 'mp3' | 'shelf',
): Promise<'started' | 'popup' | 'none'> {
  const videos = asked.get(key(tabId, url)) ?? (await siteVideos(tabId, url, useReferer)) ?? [];
  const m = videos[index];
  if (!m) return 'none';
  const settings = await getSettings();
  const meta = defaultMeta(m, undefined, settings);
  if (to === 'shelf') {
    // Firefox's consent to send a video is asked in a click: the popup's, when not given yet.
    if (!(await getAccount()) || settings.showForm || !(await allowedToSend())) {
      await chrome.storage.session.set({ pending: { tabId, media: m } satisfies PendingSave });
      await openPopup();
      return 'popup';
    }
    await enqueue(
      [{ target: 'shelf', request: saveRequest(m, meta, settings), thumbnail: m.thumbnail }],
      true,
    );
    return 'started';
  }
  const format = to === 'mp3' ? 'mp3' : choice === AUDIO ? 'audio' : 'video';
  const quality = format === 'video' ? choice || undefined : undefined;
  const job = downloadJob(m, meta, settings, quality, m.thumbnail, format);
  // A live stream: recorded from now, as from the menu.
  if (m.live) job.request.live = { from: 'now' };
  await enqueue([job], true);
  return 'started';
}

/**
 * Bytes of a file only its page can read (Telegram Web's own service worker answers its
 * addresses): fetched in the page's own world, as its player would, and handed over as base64.
 * The tab gone, or another page in it: an error the download says in words.
 */
export async function pageFetch(
  tabId: number,
  url: string,
  start: number,
  end: number,
): Promise<PageBytes> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [url, start, end],
      func: async (url: string, start: number, end: number) => {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Range: `bytes=${start}-${end}` },
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const total = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '')?.[1];
        return { status: res.status, total: total ? Number(total) : undefined, b64: btoa(text) };
      },
    });
    return (frame?.result as PageBytes | undefined) ?? { error: 'no answer' };
  } catch (err) {
    return { error: String(err) };
  }
}
