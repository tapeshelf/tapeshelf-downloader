import { FIREFOX } from '../shared/build';
import { listenHere, type BackgroundMessage, type TabMedia } from '../shared/messages';
import { getAccount } from '../shared/settings';
import { connect, disconnect } from './connect';
import { listenForMedia } from './detect';
import { useReferer } from './headers';
import { currentLang } from './lang';
import { pageFetch, pageMenu, pageSave, pageSite } from './buttons';
import { buildMenus, listenForMenus, openPopup } from './menus';
import {
  cancel,
  bufferOpen,
  captureArmed,
  captureReady,
  captureStop,
  clear,
  deliver,
  deliverFile,
  enqueue,
  idle,
  kick,
  listenForDownloads,
  listenForNotificationClicks,
  remove,
  reported,
  retry,
  shelve,
  stop,
  trimHistory,
} from './queue';
import { forgetTab, getTab } from './tabs';

/**
 * The extension's service worker. Listeners are registered at the top level, as MV3
 * wants: the browser wakes the worker for each event and stops it when idle.
 */
listenForMedia();
listenForMenus();
listenForNotificationClicks();
listenForDownloads();

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

/** The badge in tapeshelf's orange with ink figures, as the app's counters. */
function paintBadge(): void {
  void chrome.action.setBadgeBackgroundColor({ color: '#fc753e' });
  void chrome.action.setBadgeTextColor({ color: '#171717' });
}

chrome.runtime.onInstalled.addListener(() => {
  paintBadge();
  void buildMenus();
  void kick();
});

// The browser started again: videos it was saving when it closed go on from their last part.
chrome.runtime.onStartup.addListener(() => {
  paintBadge();
  void buildMenus();
  void trimHistory(true).then(kick);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes['settings']) return;
  const before = changes['settings'].oldValue as { language?: string } | undefined;
  const after = changes['settings'].newValue as { language?: string } | undefined;
  if (before?.language !== after?.language) void buildMenus();
});

async function handle(
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case 'connect': {
      const account = await connect();
      if (account && message.reopen) await openPopup().catch(() => undefined);
      return account;
    }
    case 'disconnect':
      return disconnect();
    case 'tab-media': {
      const state = await getTab(message.tabId);
      return { pageUrl: state?.pageUrl ?? '', items: state?.items ?? [] } satisfies TabMedia;
    }
    case 'enqueue':
      return enqueue(message.jobs);
    case 'shelve':
      return shelve(message.id);
    case 'cancel':
      return cancel(message.id);
    case 'retry':
      return retry(message.id);
    case 'stop':
      return stop(message.id);
    case 'remove':
      return remove(message.id);
    case 'clear':
      return clear();
    case 'auth':
      return { account: await getAccount(), lang: await currentLang() };
    case 'headers':
      return useReferer(message.urls, message.referer, message.userAgent);
    case 'job':
      return reported(message.job);
    case 'idle':
      return idle();
    case 'deliver':
      return deliver(message.id, message.url, message.filename);
    case 'deliverFile':
      return deliverFile(message.url, message.filename);
    case 'captureReady':
      return captureReady(message.id, message.tabId);
    case 'captureStop':
      return captureStop(message.tabId);
    case 'captureArmed':
      return captureArmed(sender.tab?.id, sender.tab?.url);
    case 'bufferOpen':
      return bufferOpen();
    case 'pageSite':
      return pageSite(message.url);
    case 'pageMenu':
      return sender.tab?.id === undefined ? null : pageMenu(sender.tab.id, message.url);
    case 'pageFetch':
      return pageFetch(message.tabId, message.url, message.start, message.end);
    case 'pageSave':
      return sender.tab?.id === undefined
        ? 'none'
        : pageSave(sender.tab.id, message.url, message.index, message.choice, message.to);
  }
}

// Firefox: the queue's work runs in this page, and its messages are handed over here.
if (FIREFOX)
  listenHere((message) =>
    'target' in message ? undefined : handle(message, { id: chrome.runtime.id }),
  );

const FROM_PAGES = new Set<string>([
  'captureArmed',
  'bufferOpen',
  'pageSite',
  'pageMenu',
  'pageSave',
]);

chrome.runtime.onMessage.addListener(
  (message: BackgroundMessage & { target?: string }, sender, reply) => {
    // Only the extension's own pages talk to it, and the offscreen document's messages are its own.
    if (sender.id !== chrome.runtime.id || message.target === 'offscreen') return;
    // A content script in a page — the recording mode's relay, the button on a
    // site's page — asks these only, about a page of the web.
    const fromPage = !!sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''));
    if (fromPage && !FROM_PAGES.has(message.type)) return;
    if (fromPage && 'url' in message && !/^https?:\/\//.test(String(message.url))) return;
    handle(message, sender).then(reply, (err: unknown) => reply({ error: String(err) }));
    return true;
  },
);
