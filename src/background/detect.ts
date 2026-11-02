import { BUILD, isYoutube } from '../shared/build';
import { classify } from '../shared/classify';
import { mediaId, type FoundMedia } from '../shared/media';
import { getSettings, onSite } from '../shared/settings';
import { summarize } from '../shared/streams';
import { useReferer } from './headers';
import { getTab, showCount, updateTab, withoutQuery, type TabState } from './tabs';

/**
 * Finding videos: every response a tab gets is looked at as it arrives; files and stream
 * manifests are kept for that tab, and a manifest is read once to learn its length and qualities.
 * A new page in the tab starts its list afresh.
 */
async function pageOf(tabId: number): Promise<string | undefined> {
  const known = await getTab(tabId);
  if (known) return known.pageUrl;
  return chrome.tabs
    .get(tabId)
    .then((t) => t.url)
    .catch(() => undefined);
}

/** The Referer a download of this response needs: its frame's address when it is not the page. */
function refererOf(d: chrome.webRequest.OnHeadersReceivedDetails, pageUrl: string): string {
  return d.frameId !== 0 && d.initiator ? `${d.initiator}/` : pageUrl;
}

async function onResponse(d: chrome.webRequest.OnHeadersReceivedDetails): Promise<void> {
  if (d.tabId < 0) return;
  const seen = classify(d);
  if (!seen) return;
  const pageUrl = await pageOf(d.tabId);
  if (!pageUrl || (BUILD === 'store' && isYoutube(pageUrl))) return;
  // A site the person turned the extension off on.
  if (onSite(pageUrl, (await getSettings()).blockedSites)) return;
  const id = mediaId(seen.kind, d.url);
  let added: FoundMedia | undefined;
  const state = await updateTab(d.tabId, (s) => {
    const tab: TabState = s ?? { pageUrl, items: [], variants: [] };
    const known = tab.items.find((i) => i.id === id);
    if (known) {
      // A player reads a file in ranges: a later response may tell the size the first did not.
      if (seen.size && !known.size) known.size = seen.size;
      return tab;
    }
    // The same file under another token or signature in its query: one video, the newest
    // address kept (the older one may have expired).
    const again =
      seen.kind === 'file' && seen.size
        ? tab.items.find(
            (i) =>
              i.kind === 'file' &&
              i.size === seen.size &&
              withoutQuery(i.url) === withoutQuery(d.url),
          )
        : undefined;
    if (again) {
      again.url = d.url;
      again.id = id;
      again.foundAt = Date.now();
      return tab;
    }
    added = {
      id,
      kind: seen.kind,
      url: d.url,
      pageUrl,
      referer: refererOf(d, pageUrl),
      foundAt: Date.now(),
      size: seen.size,
      mimeType: seen.mimeType,
      hidden: tab.variants.includes(withoutQuery(d.url)),
    };
    tab.items.push(added);
    return tab;
  });
  await showCount(d.tabId, state);
  if (added && added.kind !== 'file' && !added.hidden) await inspect(d.tabId, added);
}

/** Reads a stream's manifest: length, qualities, live or DRM; its variants hide behind it. */
async function inspect(tabId: number, item: FoundMedia): Promise<void> {
  const kind = item.kind as 'hls' | 'dash';
  let summary;
  try {
    await useReferer([item.url], item.referer ?? item.pageUrl);
    summary = await summarize(kind, item.url, async (url) => {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
  } catch {
    return;
  }
  const variants = summary.variants.map(withoutQuery);
  const state = await updateTab(tabId, (tab) => {
    if (!tab) return tab;
    const own = tab.items.find((i) => i.id === item.id);
    if (!own) return tab;
    Object.assign(own, {
      duration: summary.duration,
      live: summary.live,
      drm: summary.drm,
      qualities: summary.qualities,
      subtitles: summary.subtitles.length ? summary.subtitles : undefined,
    });
    tab.variants = [...new Set([...tab.variants, ...variants])];
    for (const i of tab.items)
      if (i.id !== own.id && tab.variants.includes(withoutQuery(i.url))) i.hidden = true;
    return tab;
  });
  await showCount(tabId, state);
}

export function listenForMedia(): void {
  chrome.webRequest.onHeadersReceived.addListener(
    (d) => void onResponse(d).catch(() => undefined),
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
    ['responseHeaders'],
  );
  // A new page in the tab: a new list.
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0) return;
      void updateTab(d.tabId, () => ({ pageUrl: d.url, items: [], variants: [] })).then((s) =>
        showCount(d.tabId, s),
      );
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );
  // A page that changes its address by script (a feed, a player app) keeps what it showed.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    void updateTab(tabId, (s) => ({
      pageUrl: change.url!,
      items: s?.items ?? [],
      variants: s?.variants ?? [],
    })).then((s) => showCount(tabId, s));
  });
}
