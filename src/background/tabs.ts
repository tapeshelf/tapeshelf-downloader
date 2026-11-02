import { adapterFor } from '../sites';
import type { FoundMedia } from '../shared/media';

/**
 * What each tab has shown, kept in session storage: the service worker sleeps between events and
 * forgets everything in memory, the browser's session does not. Changes go one after another, so
 * two responses arriving together never drop each other's video.
 */
export interface TabState {
  pageUrl: string;
  items: FoundMedia[];
  /** Addresses (without query) of HLS variants and audio a master playlist on the tab lists. */
  variants: string[];
}

const key = (tabId: number) => `tab:${tabId}`;
const cache = new Map<number, TabState>();
let queue: Promise<unknown> = Promise.resolve();

export async function getTab(tabId: number): Promise<TabState | undefined> {
  if (cache.has(tabId)) return cache.get(tabId);
  const stored = (await chrome.storage.session.get(key(tabId)))[key(tabId)] as TabState | undefined;
  if (stored) cache.set(tabId, stored);
  return stored;
}

export function updateTab(
  tabId: number,
  change: (state: TabState | undefined) => TabState | undefined,
): Promise<TabState | undefined> {
  const next = queue.then(async () => {
    const state = change(await getTab(tabId));
    if (state) {
      cache.set(tabId, state);
      await chrome.storage.session.set({ [key(tabId)]: state });
    }
    return state;
  });
  queue = next.catch(() => undefined);
  return next;
}

export async function forgetTab(tabId: number): Promise<void> {
  cache.delete(tabId);
  await chrome.storage.session.remove(key(tabId));
}

export const withoutQuery = (url: string) => url.split(/[?#]/)[0]!;

/**
 * The toolbar badge: there is a video to download here. The popup offers one, the likeliest, with
 * the page's others under it, so the badge says 1 — as on a site's video page, whose one
 * video its address names, whatever its player loads meanwhile.
 */
export async function showCount(tabId: number, state: TabState | undefined): Promise<void> {
  const any =
    !!state &&
    (!!adapterFor(state.pageUrl) ||
      state.items.some((i) => !i.hidden && (!i.live || i.kind === 'hls')));
  await chrome.action.setBadgeText({ tabId, text: any ? '1' : '' }).catch(() => undefined);
}
