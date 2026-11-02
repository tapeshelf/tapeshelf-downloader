import { ApiError, api, type ExtensionContext } from '../shared/api';
import { BUILD, FIREFOX, SELF_UPDATING, isYoutube } from '../shared/build';
import { askToSend } from '../shared/consent';
import { ICONS, h, icon, logo, replace, type Child } from '../shared/dom';
import { formatBytes, formatDuration } from '../shared/format';
import { browserLang, loadTranslate, type Lang, type Translate } from '../shared/i18n';
import { inQueueOrder, isActive, listJobs, targetOf, type Job } from '../shared/jobs';
import {
  mediaId,
  type FoundMedia,
  type Quality,
  type SubtitleTrack,
  type VideoMeta,
  type Visibility,
} from '../shared/media';
import {
  send,
  type BackgroundMessage,
  type NewJob,
  type PendingSave,
  type TabMedia,
} from '../shared/messages';
import { pageInfo } from '../shared/page';
import type { PageInfo } from '../shared/page-info';
import { fromUrl, listed, rankMedia, recordable, saveable } from '../shared/pick';
import { pickQuality, roomFor } from '../shared/quality';
import {
  DESCRIPTION_MAX,
  TITLE_MAX,
  defaultMeta,
  downloadJob,
  nameFromUrl,
  saveRequest,
} from '../shared/request';
import {
  bufferAhead,
  getAccount,
  getSettings,
  onSite,
  setAccount,
  setSettings,
  type Account,
  type Settings,
} from '../shared/settings';
import { fileSize } from '../shared/size';
import {
  AUDIO,
  sizeLabel as sizeLabelIn,
  sizeOf as sizeOfIn,
  videoChoices,
} from '../shared/choices';
import { qualityLabel, sameLanguage } from '../shared/streams';
import { availableUpdate, type Release } from '../shared/update';
import { siteVideos } from '../sites';

/**
 * The popup: what the tab offers, each video with its quality and size; "Download"
 * first — no account needed — and "Save to My shelf" second, which asks to connect the first time;
 * the short form for the shelf; the downloads and saves under way, and the latest finished.
 * The same page is the browser's side panel: it stays open and follows the window's tab.
 */
const PANEL = location.pathname.endsWith('/sidepanel.html');
interface Draft {
  meta: VideoMeta;
  quality?: string;
}

const state = {
  t: ((key: string) => key) as Translate,
  lang: 'en' as Lang,
  settings: undefined as unknown as Settings,
  account: null as Account | null,
  context: undefined as ExtensionContext | undefined,
  contextError: undefined as string | undefined,
  tab: undefined as chrome.tabs.Tab | undefined,
  page: undefined as PageInfo | undefined,
  items: [] as FoundMedia[],
  main: undefined as FoundMedia | undefined,
  selected: new Set<string>(),
  /**
   * A finished download on its way to the shelf (the line under it): not a video of this
   * page, so not in its list — only in the form or the connecting that follow.
   */
  extra: undefined as FoundMedia | undefined,
  /** The quality picked for each video (its key); the settings' one until changed. */
  choice: new Map<string, string>(),
  /** The subtitles picked for each video: an index in its list, -1 for none. */
  subs: new Map<string, number>(),
  /** File sizes asked of the sites' servers, by address (null: it did not say). */
  sizes: new Map<string, number | null>(),
  drafts: new Map<string, Draft>(),
  view: 'list' as 'list' | 'form' | 'connect',
  jobs: [] as Job[],
  connecting: false,
  update: null as Release | null,
  /** The section of the page's other videos is open (closed unless something in it is wanted). */
  moreOpen: false,
};

const app = document.getElementById('app')!;
const t = (key: string, params?: Record<string, string | number>) => state.t(key, params);
const useHeaders = (urls: string[], referer: string, userAgent?: string) =>
  send({ type: 'headers', urls, referer, userAgent });

async function init(): Promise<void> {
  state.settings = await getSettings();
  state.lang = state.settings.language === 'auto' ? browserLang() : state.settings.language;
  state.t = await loadTranslate(state.lang);
  document.documentElement.lang = state.lang;
  if (PANEL || new URLSearchParams(location.search).has('window'))
    document.body.classList.add('window');
  document.title = t('popup.title');
  state.account = await getAccount();
  const { pending } = (await chrome.storage.session.get('pending')) as { pending?: PendingSave };
  if (pending) await chrome.storage.session.remove('pending');
  const [update, context] = await Promise.all([
    // A build from the site is installed by hand: it looks for its own updates.
    SELF_UPDATING
      ? availableUpdate(state.settings.server, chrome.runtime.getManifest().version)
      : null,
    state.account
      ? api<ExtensionContext>(
          state.account,
          'GET',
          '/extension/context',
          undefined,
          state.lang,
        ).catch((err: unknown) => err as Error)
      : undefined,
    loadTab(pending),
  ]);
  state.update = update;
  if (context instanceof ApiError && context.code === 'appTokenInvalid') {
    await setAccount(null);
    state.account = null;
  } else if (context instanceof Error) state.contextError = context.message;
  else state.context = context;
  // A post's video from the button on its site's page: the form, or connecting first.
  if (pending?.media) {
    state.extra = pending.media;
    if (!pending.shelf) state.selected = new Set([pending.media.id]);
  }
  // A finished download that asked to connect before going to the shelf.
  for (const id of pending?.shelf ?? []) {
    const job = id.startsWith('job:') ? state.jobs.find((j) => `job:${j.id}` === id) : undefined;
    if (job) state.extra = mediaOfJob(job);
  }
  if (pending?.shelf?.length && state.account) {
    // Connected after "Save to My shelf": those videos go on to the shelf.
    state.selected = new Set(pending.shelf.filter((id) => all().some((m) => m.id === id)));
    if (state.selected.size) onShelf(false);
  } else if (pending && !pending.shelf && state.selected.size) {
    // The menu or the shortcut "Save to My shelf": the form, or connecting first.
    if (!state.account) state.view = 'connect';
    else if (state.settings.showForm) {
      prepareDrafts();
      state.view = 'form';
    }
  }
  render();
  void askSizes();
}

/** The tab's videos, its page and the jobs: the popup's tab, or the panel's window's tab now. */
async function loadTab(pending?: PendingSave): Promise<void> {
  // popup.html?tab=<id>: the popup for that tab, opened as a page (a window, the e2e tests);
  // sidepanel.html?windowId=<id>: the panel of that window, opened as a page (the e2e tests).
  const params = new URLSearchParams(location.search);
  const tabId = pending?.tabId ?? Number(params.get('tab'));
  const windowId = Number(params.get('windowId'));
  state.tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => undefined)
    : (
        await chrome.tabs.query(
          windowId ? { active: true, windowId } : { active: true, currentWindow: true },
        )
      )[0];
  const tabUrl = state.tab?.url ?? '';
  const [found, page, jobs, site] = await Promise.all([
    state.tab?.id === undefined
      ? undefined
      : send<TabMedia>({ type: 'tab-media', tabId: state.tab.id }),
    state.tab?.id === undefined ? undefined : pageInfo(state.tab.id),
    listJobs(),
    state.tab?.id === undefined ? undefined : siteVideos(state.tab.id, tabUrl, useHeaders),
  ]);
  state.page = page;
  state.jobs = jobs;
  collect(site ? { pageUrl: tabUrl, items: site } : found, page, pending, !!site);
}

/**
 * The side panel follows its window's tab: another tab, another page in it, a video it
 * found since — the list is made again. Not while a form or the connecting is open.
 */
let following: ReturnType<typeof setTimeout> | undefined;
function follow(): void {
  clearTimeout(following);
  following = setTimeout(() => {
    if (state.view !== 'list') return;
    state.items = [];
    state.main = undefined;
    state.selected = new Set();
    state.extra = undefined;
    state.choice = new Map();
    state.subs = new Map();
    state.moreOpen = false;
    void loadTab().then(() => {
      render();
      void askSizes();
    });
  }, 300);
}

if (PANEL) {
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === state.tab?.windowId) follow();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === state.tab?.id && (change.url || change.status === 'complete')) follow();
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (state.tab?.id !== undefined && `tab:${state.tab.id}` in changes) follow();
  });
}

/** The tab's list, with the page's own video elements it did not see go by, and the menu's URL. */
function collect(
  found: TabMedia | undefined,
  page: PageInfo | undefined,
  pending?: PendingSave,
  fromSite = false,
) {
  const pageUrl = found?.pageUrl || page?.url || state.tab?.url || '';
  const items = listed(found?.items ?? []);
  // A site's adapter knows its page's videos; the player's own files would only repeat them.
  for (const v of fromSite ? [] : (page?.videos ?? [])) {
    if (!v.src || items.some((i) => i.url === v.src)) continue;
    items.push({
      id: mediaId('file', v.src),
      kind: 'file',
      url: v.src,
      pageUrl,
      referer: pageUrl,
      foundAt: 0,
    });
  }
  if (pending?.url && !items.some((i) => i.url === pending.url))
    items.push(fromUrl(pending.url, pageUrl, items));
  // The likeliest first; the rest — previews, pieces, the page's other videos — under it.
  const ranked = fromSite
    ? { main: items[0], others: items.slice(1) }
    : rankMedia(items, page?.videos);
  state.main = ranked.main;
  state.items = ranked.main ? [ranked.main, ...ranked.others] : ranked.others;
  for (const m of state.items) {
    const best = m.qualities?.length
      ? pickQuality(m.qualities, state.settings.quality, -1)
      : undefined;
    if (best) state.choice.set(m.id, best.key);
  }
  const chosen = pending?.url ? items.find((i) => i.url === pending.url) : state.main;
  if (chosen && saveable(chosen)) state.selected.add(chosen.id);
  // The menu was opened on one of the others: they are shown.
  state.moreOpen = !!chosen && chosen !== state.main;
}

/** The page's video element showing this media, for its picture, length and height. */
const shownBy = (m: FoundMedia) => state.page?.videos.find((v) => v.src === m.url);

/** Names a stream's file always has, which say nothing of the video. */
const GENERIC =
  /^(master|manifest|index|playlist|chunklist|prog_index|stream|video|media|main|hls|dash|[\da-f-]{16,})$/i;

/** The page's title for its video and its streams, a file's own name otherwise. */
function nameOf(m: FoundMedia): string {
  if (m.title) return m.title;
  const own = nameFromUrl(m.url);
  const page = state.page?.title;
  if (page && (m === state.main || m.kind !== 'file' || !own || GENERIC.test(own))) return page;
  return own || new URL(m.url).hostname;
}

/** HLS, DASH, or the file's type: MP4, WEBM… */
function kindLabel(m: FoundMedia): string {
  if (m.kind !== 'file') return m.kind.toUpperCase();
  const ext = /\.([a-z0-9]{2,4})$/i.exec(new URL(m.url).pathname)?.[1];
  return (ext ?? m.mimeType?.split('/')[1] ?? 'video').toUpperCase();
}

const sizeOf = (m: FoundMedia, q?: Quality) => sizeOfIn(m, q, state.sizes);
const sizeLabel = (size: { bytes: number; exact: boolean } | undefined) =>
  sizeLabelIn(size, state.lang);

/** Its type and length; the quality and the size are in its list (a video that can be saved). */
function details(m: FoundMedia): string {
  const video = shownBy(m);
  const listed = saveable(m);
  const only = m.qualities?.length === 1 ? m.qualities[0] : undefined;
  const parts = [
    kindLabel(m),
    m.live ? t('found.live') : '',
    listed ? '' : only ? qualityLabel(only) : video?.height ? `${video.height}p` : '',
    // A live stream's length is only the window its playlist keeps.
    m.live
      ? ''
      : m.duration
        ? formatDuration(m.duration)
        : video?.duration
          ? formatDuration(video.duration)
          : '',
    listed ? '' : sizeLabel(sizeOf(m, only)),
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * A video's subtitles: its own (a stream's, a site's), else the <track>s of the player
 * showing it — for the page's video, of the page's player.
 */
function subtitlesOf(m: FoundMedia): SubtitleTrack[] {
  if (m.subtitles?.length) return m.subtitles;
  const players = [...(state.page?.videos ?? [])].sort((a, b) => b.area - a.area);
  const element = shownBy(m) ?? (m === state.main ? players[0] : undefined);
  return (element?.tracks ?? []).map((t) => ({
    kind: /\.srt($|\?)/i.test(t.src) ? ('srt' as const) : ('vtt' as const),
    url: t.src,
    language: t.language,
    label: t.label,
  }));
}

/** The subtitles picked: the browser's language unless changed, else none. */
function subsIndex(m: FoundMedia, subs: SubtitleTrack[]): number {
  const picked = state.subs.get(m.id);
  if (picked !== undefined) return picked;
  return subs.findIndex((s) => sameLanguage(s.language, navigator.language));
}

function subtitleName(s: SubtitleTrack): string {
  if (s.label) return s.label;
  try {
    return (
      (s.language && new Intl.DisplayNames([state.lang], { type: 'language' }).of(s.language)) ||
      '?'
    );
  } catch {
    return s.language ?? '?';
  }
}

/**
 * Sizes the list does not know yet, asked of the sites' servers: each quality of a site's video,
 * a file the player did not say the size of, a sound apart. Shown as they come.
 */
async function askSizes(): Promise<void> {
  const wanted: { url: string; m: FoundMedia }[] = [];
  for (const m of state.items.filter((i) => i.kind === 'file' && saveable(i)).slice(0, 8)) {
    const urls = m.qualities?.length
      ? m.qualities.filter((q) => q.size === undefined).map((q) => q.key)
      : m.size === undefined
        ? [m.url]
        : [];
    if (m.audio && m.audio.size === undefined) urls.push(m.audio.url);
    for (const url of urls) if (!state.sizes.has(url)) wanted.push({ url, m });
  }
  for (let i = 0; i < wanted.length; i += 4) {
    const batch = wanted.slice(i, i + 4);
    await Promise.all(
      batch.map(async ({ url, m }) => {
        await useHeaders([url], m.referer ?? m.pageUrl, m.download?.userAgent).catch(
          () => undefined,
        );
        state.sizes.set(url, (await fileSize(url).catch(() => undefined)) ?? null);
      }),
    );
    if (state.view === 'list') render();
  }
}

/**
 * Videos still allowed today on the shelf through the extension (Infinity on Pro): the server's
 * count, less those waiting in the queue, which it does not know of yet.
 */
function leftToday(): number {
  const c = state.context;
  if (!c || c.unlimited || c.limits.perDay === 0) return Infinity;
  const waiting = state.jobs.filter(
    (j) => targetOf(j) === 'shelf' && isActive(j) && !j.upload,
  ).length;
  return Math.max(0, c.limits.perDay - c.limits.usedToday - waiting);
}

/** The day's count again (a video started or finished), and the list with it. */
async function refreshContext(): Promise<void> {
  if (!state.account) return;
  const context = await api<ExtensionContext>(
    state.account,
    'GET',
    '/extension/context',
    undefined,
    state.lang,
  ).catch(() => undefined);
  if (!context) return;
  state.context = context;
  if (state.view === 'list') render();
}

function render(): void {
  replace(app, header(), updateBanner(), state.view === 'connect' ? connectView() : body());
}

/** A newer full build is out: where to get it and how to put it in place. */
function updateBanner(): Child {
  const u = state.update;
  if (!u) return null;
  return h(
    'aside',
    { class: 'update', 'data-testid': 'popup-update' },
    h(
      'p',
      null,
      h('span', { class: 'strong' }, t('update.available', { version: u.version })),
      ' ',
      h(
        'a',
        { href: u.url, target: '_blank', 'data-testid': 'popup-update-link' },
        t('update.download'),
      ),
    ),
    h('p', { class: 'label-mono' }, t(FIREFOX ? 'update.howToFirefox' : 'update.howTo')),
  );
}

function header(): HTMLElement {
  const a = state.account;
  return h(
    'header',
    { class: 'bar' },
    h('span', { class: 'brand' }, logo(26), h('span', { class: 'wordmark' }, 'tapeshelf')),
    h(
      'span',
      { class: 'bar-end' },
      a &&
        h(
          'span',
          { class: 'avatar', title: `@${a.user.username}`, 'data-testid': 'popup-account' },
          a.user.avatarUrl
            ? h('img', { src: a.user.avatarUrl, alt: '' })
            : a.user.displayName.charAt(0).toUpperCase(),
        ),
      // The popup kept open at the side; the panel itself, or a window, has no use for it.
      !PANEL &&
        !document.body.classList.contains('window') &&
        state.tab?.windowId !== undefined &&
        h(
          'button',
          {
            class: 'btn btn-ghost btn-sm icon-btn',
            title: t('popup.side'),
            'aria-label': t('popup.side'),
            'data-testid': 'popup-side',
            onclick: () => void openSide().then(() => window.close()),
          },
          icon(ICONS.side),
        ),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm icon-btn',
          title: t('popup.history'),
          'aria-label': t('popup.history'),
          'data-testid': 'popup-history',
          onclick: () => void chrome.tabs.create({ url: chrome.runtime.getURL('history.html') }),
        },
        icon(ICONS.history),
      ),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm icon-btn',
          title: t('popup.settings'),
          'aria-label': t('popup.settings'),
          onclick: () => chrome.runtime.openOptionsPage(),
        },
        icon(ICONS.settings),
      ),
    ),
  );
}

/** The browser's side panel with this page in it; Firefox's sidebar. */
function openSide(): Promise<unknown> {
  if (FIREFOX)
    return (
      globalThis as unknown as { browser: { sidebarAction: { open(): Promise<void> } } }
    ).browser.sidebarAction.open();
  return chrome.sidePanel.open({ windowId: state.tab!.windowId });
}

/** Asked for by "Save to My shelf" when not connected yet: downloading needs none of it. */
function connectView(): HTMLElement {
  const host = new URL(state.settings.server).host;
  return h(
    'main',
    { class: 'connect', 'data-testid': 'popup-connect' },
    h(
      'div',
      { class: 'form-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm icon-btn',
          'aria-label': t('form.back'),
          title: t('form.back'),
          'data-testid': 'popup-back',
          onclick: backToList,
        },
        icon(ICONS.back),
      ),
      h('h1', { class: 'title' }, t('connect.title')),
    ),
    h('p', { class: 'muted' }, t('connect.lead')),
    state.connecting
      ? h('p', { class: 'label-mono' }, t('connect.waiting'))
      : h(
          'button',
          {
            class: 'btn btn-primary btn-block',
            'data-testid': 'popup-connect-button',
            onclick: async () => {
              state.connecting = true;
              render();
              // The ticked videos go on to the shelf once connected.
              if (state.tab?.id !== undefined && state.selected.size) {
                const pending: PendingSave = {
                  tabId: state.tab.id,
                  shelf: [...state.selected],
                  // A post's video from the button on its page is in no list: it comes along.
                  media: state.extra?.id.startsWith('job:') ? undefined : state.extra,
                };
                await chrome.storage.session.set({ pending });
              }
              // The popup closes as the window opens; the service worker carries on.
              void send({ type: 'connect', reopen: true }).then(() => location.reload());
            },
          },
          t('connect.button'),
        ),
    h(
      'p',
      { class: 'label-mono' },
      t('connect.server', { host }),
      ' · ',
      h('a', { href: '#', onclick: openOptions }, t('connect.change')),
    ),
  );
}

function openOptions(e: Event): void {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
}

function body(): HTMLElement {
  return h(
    'main',
    null,
    state.view === 'form' ? formView() : listView(),
    h('section', { id: 'queue' }, queueView()),
  );
}

function notices(): Child[] {
  const c = state.context;
  const out: Child[] = [];
  if (state.contextError) out.push(h('p', { class: 'alert alert-error' }, state.contextError));
  if (c && !c.emailVerified)
    out.push(h('p', { class: 'alert', 'data-testid': 'popup-verify' }, t('limit.verify')));
  if (c && leftToday() === 0)
    out.push(
      h(
        'p',
        { class: 'alert', 'data-testid': 'popup-limit' },
        t('limit.reached', { limit: c.limits.perDay }),
        ' ',
        h('a', { href: `${state.settings.server}/pro`, target: '_blank' }, t('limit.pro')),
      ),
    );
  return out;
}

function listView(): HTMLElement {
  const url = state.tab?.url ?? '';
  const web = /^https?:/.test(url);
  const youtube = BUILD === 'store' && isYoutube(url);
  const blocked = web ? onSite(url, state.settings.blockedSites) : undefined;
  if (blocked) return blockedView(blocked);
  const items = state.items;
  const c = state.context;
  const left = leftToday();
  const shelfBlocked = !!c && (!c.emailVerified || left === 0);
  // One video, the likeliest; the others in a quiet section, closed.
  const first = state.main ? items[0] : undefined;
  const rest = state.main ? items.slice(1) : items;
  // "Download", "MP3" and the shelf only where there is something to download.
  const downloadable = items.some(saveable);
  // A video plays, or a player builds it itself: it is there, only not as a file.
  const playing = !!state.page?.videos.some((v) => v.playing || v.built);
  const card = web && !youtube ? captureCard(!downloadable && playing) : null;
  const list = youtube
    ? h('p', { class: 'empty' }, t('found.youtube'))
    : !web
      ? h('p', { class: 'empty' }, t('found.noPage'))
      : !items.length
        ? // A video that plays with nothing to download: the card below says so.
          !(card && playing) &&
          h('p', { class: 'empty', 'data-testid': 'popup-empty' }, t('found.empty'))
        : [
            first && h('ul', { class: 'items', 'data-testid': 'popup-items' }, itemRow(first)),
            rest.length > 0 &&
              h(
                'details',
                {
                  class: 'more',
                  'data-testid': 'popup-more',
                  open: state.moreOpen || !first,
                  ontoggle: (e: Event) => (state.moreOpen = (e.target as HTMLDetailsElement).open),
                },
                h('summary', { class: 'label-mono' }, t('found.more', { n: rest.length })),
                h(
                  'ul',
                  { class: 'items items-more' },
                  rest.map((m) => itemRow(m)),
                ),
              ),
          ];
  const count = state.selected.size;
  return h(
    'section',
    { class: 'list' },
    notices(),
    h('h2', { class: 'label-mono section-title' }, t('found.title')),
    list,
    downloadable &&
      !youtube &&
      h(
        'div',
        { class: 'actions' },
        h(
          'div',
          { class: 'download-row' },
          h(
            'button',
            {
              class: 'btn btn-primary btn-block',
              'data-testid': 'popup-download',
              disabled: count === 0,
              onclick: () => void onDownload(),
            },
            icon(ICONS.download),
            t('download.button'),
            count > 1 && h('span', { class: 'count' }, String(count)),
          ),
          // The sound as MP3: a button of its own.
          h(
            'button',
            {
              class: 'btn',
              title: t('download.mp3'),
              'aria-label': t('download.mp3'),
              'data-testid': 'popup-mp3',
              disabled: count === 0,
              onclick: () => void onDownload(true),
            },
            'MP3',
          ),
        ),
        h(
          'button',
          {
            class: 'btn btn-block',
            'data-testid': 'popup-save',
            disabled: count === 0 || shelfBlocked || count > left,
            onclick: () => onShelf(),
          },
          t('save.button'),
        ),
        c &&
          left !== Infinity &&
          h(
            'p',
            { class: 'label-mono', 'data-testid': 'popup-today' },
            t('limit.today', { used: c.limits.usedToday, limit: c.limits.perDay }),
          ),
      ),
    card,
  );
}

/**
 * The recording mode: a card with "Record what plays" on a page with a player — the
 * way when there is nothing to download — and, once pressed, the same card shows the recording
 * with "Stop and save" and "Cancel".
 */
function captureCard(nothingElse: boolean): Child {
  if (!state.page?.videos.length || state.tab?.id === undefined) return null;
  const job = state.jobs.find((j) => j.request.capture?.tabId === state.tab!.id && isActive(j));
  // A page on air: its stream's card records it, from its start if it keeps one.
  if (!job && state.main?.live) return null;
  return h(
    'div',
    { class: 'record-card', 'data-testid': 'popup-capture-card' },
    job
      ? recordingPanel(job)
      : [
          nothingElse && h('p', { class: 'record-lead' }, t('capture.nothing')),
          h(
            'button',
            {
              class: 'btn btn-block',
              'data-testid': 'popup-capture',
              onclick: () => void onCapture(),
            },
            icon(ICONS.record, 12),
            t('capture.button'),
          ),
          h('p', { class: 'label-mono' }, t(prebuffering() ? 'capture.fromStart' : 'capture.hint')),
        ],
  );
}

/**
 * Records without reloading here: the settings say so for this site, and its player builds the
 * video where the buffer sees it — not in a worker.
 */
function prebuffering(): boolean {
  return (
    bufferAhead(state.tab?.url ?? '', state.settings) > 0 &&
    !state.page?.videos.some((v) => v.worker)
  );
}

/** A recording under way, in the card it was started from: how far, "Stop and save", "Cancel". */
function recordingPanel(job: Job): Child[] {
  const recording = job.disk?.phase === 'download' && !job.stop;
  // What plays, before its player has sent anything: nothing is being recorded yet.
  const waiting = recording && !!job.request.capture && !job.bytes?.done;
  return [
    h(
      'p',
      { class: 'recording', 'data-testid': 'popup-recording' },
      h('span', { class: 'rec-dot' }),
      waiting
        ? t('capture.waiting')
        : recording
          ? [
              t('capture.recording', { time: formatDuration(job.recorded ?? 0) }),
              job.bytes?.done ? ` · ${formatBytes(job.bytes.done, state.lang)}` : '',
            ]
          : runningLabel(job),
    ),
    h(
      'div',
      { class: 'pair' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          'data-testid': 'popup-stop',
          disabled: !recording || waiting,
          onclick: (e: Event) => (
            e.preventDefault(),
            void send({ type: 'stop', id: job.id }).then(refreshJobs)
          ),
        },
        icon(ICONS.stop, 12),
        t('queue.stop'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-testid': 'popup-cancel-recording',
          onclick: (e: Event) => (
            e.preventDefault(),
            void send({ type: 'cancel', id: job.id }).then(refreshJobs)
          ),
        },
        t('queue.cancel'),
      ),
    ),
  ];
}

async function onCapture(): Promise<void> {
  const url = state.tab?.url ?? '';
  const media: FoundMedia = {
    id: `capture:${url}`,
    kind: 'file',
    url,
    pageUrl: url,
    foundAt: 0,
    title: state.page?.title,
  };
  const meta = defaultMeta(media, state.page, state.settings);
  const job = downloadJob(media, meta, state.settings, undefined, state.page?.image);
  job.request.capture = { tabId: state.tab!.id! };
  await send({ type: 'enqueue', jobs: [job] } satisfies BackgroundMessage);
  state.jobs = await listJobs();
  render();
}

/** A site the extension is off on: said so, with the way to turn it on here. */
function blockedView(site: string): HTMLElement {
  return h(
    'section',
    { class: 'list' },
    h('p', { class: 'empty', 'data-testid': 'popup-blocked' }, t('found.blocked', { site })),
    h(
      'button',
      {
        class: 'btn btn-block',
        'data-testid': 'popup-unblock',
        onclick: async () => {
          state.settings = await setSettings({
            blockedSites: state.settings.blockedSites.filter((s) => s !== site),
          });
          // What the page loads from now on is found; reloading it finds what it loaded before.
          if (state.tab?.id !== undefined) await chrome.tabs.reload(state.tab.id);
          window.close();
        },
      },
      t('found.unblock'),
    ),
  );
}

function itemRow(m: FoundMedia): HTMLElement {
  const checked = state.selected.has(m.id);
  const picture = m.thumbnail ?? (m === state.main ? state.page?.image : shownBy(m)?.poster);
  return h(
    'li',
    {
      class: `item${saveable(m) || recordable(m) ? '' : ' item-off'}`,
      'data-testid': 'popup-item',
    },
    h(
      'label',
      { class: recordable(m) ? 'item-label item-label-live' : 'item-label' },
      // A live stream is recorded with its own buttons, not ticked to download.
      !recordable(m) &&
        h('input', {
          type: 'checkbox',
          checked,
          disabled: !saveable(m),
          onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) state.selected.add(m.id);
            else state.selected.delete(m.id);
            render();
          },
        }),
      h(
        'span',
        { class: 'thumb' },
        picture
          ? h('img', { src: picture, alt: '', referrerpolicy: 'no-referrer' })
          : icon(ICONS.film, 18),
      ),
      h(
        'span',
        { class: 'item-text' },
        h('span', { class: 'item-name' }, nameOf(m)),
        h(
          'span',
          { class: 'label-mono' },
          m.drm
            ? h('span', { class: 'drm' }, icon(ICONS.lock, 11), ' ', t('found.drm'))
            : m.live
              ? [h('span', { class: 'rec-dot' }), `${t('found.live')} · ${kindLabel(m)}`]
              : details(m),
        ),
        saveable(m) &&
          h(
            'select',
            {
              class: 'control control-sm quality',
              'aria-label': t('form.quality'),
              'data-testid': 'popup-quality',
              onchange: (e: Event) => state.choice.set(m.id, (e.target as HTMLSelectElement).value),
            },
            videoChoices(m, state.sizes, t, state.lang, shownBy(m)?.height).map((c) =>
              h(
                'option',
                {
                  value: c.value,
                  selected: c.value
                    ? c.value === state.choice.get(m.id)
                    : state.choice.get(m.id) !== AUDIO,
                },
                c.label,
              ),
            ),
          ),
        saveable(m) && subtitlesSelect(m),
      ),
      // A live stream's quality and buttons: the card's full width.
      recordable(m) && liveControls(m),
    ),
  );
}

/**
 * A live stream: its quality, and two ways to record it — from the start of what the stream
 * keeps, or from now — until "Stop" in the list or the end of the stream.
 */
function liveControls(m: FoundMedia): HTMLElement {
  const qualities = m.qualities ?? [];
  const job = state.jobs.find(
    (j) => j.request.live && isActive(j) && j.request.media.url === m.url,
  );
  return h(
    'span',
    { class: 'live' },
    !job &&
      qualities.length > 1 &&
      h(
        'select',
        {
          class: 'control control-sm quality',
          'aria-label': t('form.quality'),
          'data-testid': 'popup-quality',
          onchange: (e: Event) => state.choice.set(m.id, (e.target as HTMLSelectElement).value),
        },
        qualities.map((q) =>
          h(
            'option',
            { value: q.key, selected: q.key === state.choice.get(m.id) },
            qualityLabel(q),
          ),
        ),
      ),
    job
      ? recordingPanel(job)
      : h(
          'span',
          { class: 'pair' },
          (['start', 'now'] as const).map((from) =>
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                'data-testid': `popup-live-${from}`,
                onclick: (e: Event) => (e.preventDefault(), void recordLive(m, from)),
              },
              h('span', { class: 'rec-dot' }),
              t(from === 'start' ? 'found.liveFromStart' : 'found.liveFromNow'),
            ),
          ),
        ),
  );
}

async function recordLive(m: FoundMedia, from: 'start' | 'now'): Promise<void> {
  const meta = defaultMeta(m, m === state.main ? state.page : undefined, state.settings);
  if (m !== state.main) meta.title = nameOf(m).slice(0, TITLE_MAX);
  const job = downloadJob(m, meta, state.settings, state.choice.get(m.id), state.page?.image);
  job.request.live = { from };
  await send({ type: 'enqueue', jobs: [job] } satisfies BackgroundMessage);
  state.jobs = await listJobs();
  render();
}

/** The page's videos, and a finished download headed for the shelf when there is one. */
const all = () => (state.extra ? [state.extra, ...state.items] : state.items);
const chosen = () => all().filter((m) => state.selected.has(m.id));

/** Under the quality, when the video has subtitles: none, or one language as .srt. */
function subtitlesSelect(m: FoundMedia): Child {
  const subs = subtitlesOf(m);
  if (!subs.length) return null;
  const picked = subsIndex(m, subs);
  return h(
    'select',
    {
      class: 'control control-sm quality',
      'aria-label': t('found.subtitles'),
      'data-testid': 'popup-subtitles',
      onchange: (e: Event) => state.subs.set(m.id, Number((e.target as HTMLSelectElement).value)),
    },
    h('option', { value: '-1', selected: picked < 0 }, t('found.noSubtitles')),
    subs.map((s, i) =>
      h(
        'option',
        { value: String(i), selected: i === picked },
        t('found.subtitlesOf', { name: subtitleName(s) }),
      ),
    ),
  );
}

/** Back to the page's list: a finished download that was headed for the shelf is let go. */
function backToList(): void {
  if (state.extra) {
    state.selected.delete(state.extra.id);
    state.drafts.delete(state.extra.id);
    state.extra = undefined;
  }
  state.view = 'list';
  render();
}

/**
 * The ticked videos to the computer, each in its picked quality or its sound alone
 * `mp3`: the sound of each as MP3.
 */
async function onDownload(mp3 = false): Promise<void> {
  const jobs: NewJob[] = chosen().map((m) => {
    const meta = defaultMeta(
      m,
      m === state.main ? state.page : undefined,
      state.settings,
      state.context?.categories,
    );
    if (m !== state.main) meta.title = nameOf(m).slice(0, TITLE_MAX);
    const picture = m === state.main ? state.page?.image : shownBy(m)?.poster;
    const choice = state.choice.get(m.id);
    const format = mp3 ? 'mp3' : choice === AUDIO ? 'audio' : 'video';
    const subs = subtitlesOf(m);
    const subtitles = subs[subsIndex(m, subs)];
    return downloadJob(m, meta, state.settings, choice || undefined, picture, format, subtitles);
  });
  await send({ type: 'enqueue', jobs } satisfies BackgroundMessage);
  state.selected.clear();
  state.jobs = await listJobs();
  render();
}

function prepareDrafts(): void {
  for (const id of state.selected) {
    if (state.drafts.has(id)) continue;
    const m = all().find((i) => i.id === id)!;
    const meta = defaultMeta(
      m,
      m === state.main ? state.page : undefined,
      state.settings,
      state.context?.categories,
    );
    if (m !== state.main) meta.title = nameOf(m).slice(0, TITLE_MAX);
    state.drafts.set(id, { meta, quality: shelfQuality(m) });
  }
}

/** The picked quality, unless it does not fit on the shelf: then the best that fits. */
function shelfQuality(m: FoundMedia): string | undefined {
  if (!m.qualities?.length) return undefined;
  const room = state.context ? roomFor(state.context.limits) : -1;
  // The sound alone is a download's choice: the shelf keeps the video.
  const picked = m.qualities.find((q) => q.key === state.choice.get(m.id));
  const bytes = picked && sizeOf(m, picked)?.bytes;
  if (picked && (room < 0 || bytes === undefined || bytes <= room)) return picked.key;
  return pickQuality(m.qualities, state.settings.quality, room)?.key;
}

/**
 * "Save to My shelf": connecting first when it is the first time; the form unless it is off. In
 * Firefox the first video sent asks the person's consent: in this click, or — opened
 * without one (after connecting) — in the form's.
 */
function onShelf(fromClick = true): void {
  if (!state.account) {
    state.view = 'connect';
    return render();
  }
  prepareDrafts();
  if (state.settings.showForm || (FIREFOX && !fromClick)) {
    state.view = 'form';
    return render();
  }
  void askToSend().then((allowed) => (allowed ? submit() : undefined));
}

async function submit(): Promise<void> {
  const videos = chosen();
  const jobs: NewJob[] = videos.map((m) => {
    const d = state.drafts.get(m.id)!;
    const picture = m === state.main ? state.page?.image : shownBy(m)?.poster;
    return {
      target: 'shelf',
      request: saveRequest(m, d.meta, state.settings, d.quality),
      thumbnail: m.thumbnail ?? picture,
      from: m.id.startsWith('job:') ? m.id.slice(4) : undefined,
    };
  });
  const first = state.drafts.get(videos[0]!.id)!.meta;
  // The form's choice is remembered: the next video goes to the same place.
  state.settings = await setSettings({
    categoryId: first.categoryId ?? null,
    visibility: first.visibility,
  });
  await send({ type: 'enqueue', jobs } satisfies BackgroundMessage);
  state.selected.clear();
  state.drafts.clear();
  state.extra = undefined;
  state.view = 'list';
  state.jobs = await listJobs();
  render();
}

function formView(): HTMLElement {
  const videos = chosen();
  const drafts = videos.map((m) => state.drafts.get(m.id)!);
  const shared = drafts[0]!.meta;
  const setAll = (patch: Partial<VideoMeta>) => drafts.forEach((d) => Object.assign(d.meta, patch));
  const categories = state.context?.categories ?? [];
  const form = h(
    'form',
    {
      class: 'form',
      'data-testid': 'popup-form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        if (drafts.some((d) => !d.meta.title.trim())) return;
        void askToSend().then((allowed) => (allowed ? submit() : undefined));
      },
    },
    h(
      'div',
      { class: 'form-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm icon-btn',
          'aria-label': t('form.back'),
          title: t('form.back'),
          'data-testid': 'popup-back',
          onclick: backToList,
        },
        icon(ICONS.back),
      ),
      h('h1', { class: 'title' }, t('form.heading')),
    ),
    videos.map((m, i) => videoFields(m, drafts[i]!, videos.length === 1)),
    categories.length > 0 &&
      h(
        'label',
        { class: 'field' },
        h('span', null, t('form.category')),
        h(
          'select',
          {
            class: 'control',
            'data-testid': 'popup-category',
            onchange: (e: Event) =>
              setAll({ categoryId: (e.target as HTMLSelectElement).value || undefined }),
          },
          h('option', { value: '' }, t('form.noCategory')),
          categories.map((c) =>
            h('option', { value: c.id, selected: c.id === shared.categoryId }, c.name),
          ),
        ),
      ),
    h(
      'div',
      { class: 'field' },
      h('span', null, t('form.visibility')),
      h(
        'div',
        { class: 'segmented', role: 'radiogroup' },
        (['PRIVATE', 'PUBLIC'] as Visibility[]).map((v) =>
          h(
            'label',
            null,
            h('input', {
              type: 'radio',
              name: 'visibility',
              value: v,
              checked: shared.visibility === v,
              'data-testid': `popup-visibility-${v.toLowerCase()}`,
              onchange: () => setAll({ visibility: v }),
            }),
            t(`form.${v.toLowerCase()}`),
          ),
        ),
      ),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: shared.sensitive,
        'data-testid': 'popup-sensitive',
        onchange: (e: Event) => setAll({ sensitive: (e.target as HTMLInputElement).checked }),
      }),
      h('span', null, t('form.sensitive')),
    ),
    h(
      'button',
      { type: 'submit', class: 'btn btn-primary btn-block', 'data-testid': 'popup-form-save' },
      t('save.button'),
    ),
  );
  return h('section', { class: 'list' }, notices(), form);
}

function videoFields(m: FoundMedia, draft: Draft, single: boolean): HTMLElement {
  const qualities = m.qualities ?? [];
  return h(
    'div',
    { class: single ? 'fields' : 'fields fields-card' },
    h(
      'label',
      { class: 'field' },
      h('span', null, t('form.title')),
      h('input', {
        class: 'control',
        required: true,
        maxLength: TITLE_MAX,
        value: draft.meta.title,
        'data-testid': 'popup-title',
        oninput: (e: Event) => (draft.meta.title = (e.target as HTMLInputElement).value),
      }),
    ),
    single &&
      h(
        'label',
        { class: 'field' },
        h('span', null, t('form.description')),
        h('textarea', {
          class: 'control',
          rows: 3,
          maxLength: DESCRIPTION_MAX,
          value: draft.meta.description ?? '',
          oninput: (e: Event) => (draft.meta.description = (e.target as HTMLTextAreaElement).value),
        }),
      ),
    qualities.length > 1 &&
      h(
        'label',
        { class: 'field' },
        h('span', null, t('form.quality')),
        h(
          'select',
          {
            class: 'control',
            'data-testid': 'popup-form-quality',
            onchange: (e: Event) => (draft.quality = (e.target as HTMLSelectElement).value),
          },
          qualities.map((q) =>
            h(
              'option',
              { value: q.key, selected: q.key === draft.quality },
              [qualityLabel(q), sizeLabel(sizeOf(m, q))].filter(Boolean).join(' · '),
            ),
          ),
        ),
      ),
  );
}

/**
 * Downloads and saves in the order they are worked: those under way, then every one waiting (the
 * list scrolls), then the latest finished — with the line about the shelf under the newest
 * download — and the way to the whole history.
 */
function queueView(): Child {
  const { jobs, waiting } = inQueueOrder(state.jobs);
  const finished = jobs.filter((j) => !isActive(j));
  if (!jobs.length) return null;
  const hinted = state.settings.shelfHint
    ? finished.find((j) => targetOf(j) === 'disk' && j.status === 'done')
    : undefined;
  return [
    h(
      'div',
      { class: 'queue-head' },
      h(
        'h2',
        { class: 'label-mono section-title' },
        t('queue.title'),
        waiting > 0 &&
          h(
            'span',
            { class: 'queue-count', 'data-testid': 'popup-waiting' },
            ' · ',
            t('queue.waitingCount', { n: waiting }),
          ),
      ),
      finished.length > 0 &&
        h(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            'data-testid': 'popup-clear',
            onclick: async () => {
              // Every finished one goes: downloaded, on the shelf, cancelled and failed alike.
              await send({ type: 'clear' });
              state.jobs = await listJobs();
              renderQueue();
            },
          },
          t('queue.clear'),
        ),
    ),
    h(
      'ul',
      { class: 'jobs', 'data-testid': 'popup-jobs' },
      jobs.map((j) => [jobRow(j), j === hinted && !j.shelved ? shelfHint(j) : null]),
    ),
    finished.length > 0 &&
      h(
        'a',
        {
          href: chrome.runtime.getURL('history.html'),
          target: '_blank',
          class: 'label-mono all-history',
          'data-testid': 'popup-all-history',
        },
        t('queue.allHistory'),
      ),
  ];
}

/** "Downloaded. Build your own video shelf…": once, under the newest download; closable for good. */
function shelfHint(job: Job): HTMLElement {
  return h(
    'li',
    { class: 'shelf-hint', 'data-testid': 'popup-shelf-hint' },
    h(
      'p',
      null,
      t('hint.text'),
      ' ',
      h(
        'button',
        {
          class: 'link-btn',
          'data-testid': 'popup-shelf-hint-save',
          onclick: () => void shelveDownload(job),
        },
        t('save.button'),
      ),
    ),
    h(
      'button',
      {
        class: 'btn btn-ghost btn-sm icon-btn',
        title: t('hint.dismiss'),
        'aria-label': t('hint.dismiss'),
        'data-testid': 'popup-shelf-hint-close',
        onclick: async () => {
          state.settings = await setSettings({ shelfHint: false });
          renderQueue();
        },
      },
      icon(ICONS.close),
    ),
  );
}

/** A finished download as a video of the list, for the form (its id says which job). */
function mediaOfJob(job: Job): FoundMedia {
  return {
    id: `job:${job.id}`,
    foundAt: 0,
    ...job.request.media,
    thumbnail: job.thumbnail,
    title: job.request.meta.title,
    description: job.request.meta.description,
    sensitive: job.request.meta.sensitive,
  };
}

/** A finished download to the shelf as well: the form for it, or straight to the queue. */
async function shelveDownload(job: Job): Promise<void> {
  // Asked in this click, before anything else; the form asks again in its own.
  const allowed = askToSend();
  const media = mediaOfJob(job);
  if (!state.account || state.settings.showForm) {
    // Not one of the page's videos: the form (or connecting) works on it alone.
    state.extra = media;
    state.selected = new Set([media.id]);
    if (job.request.quality) state.choice.set(media.id, job.request.quality);
    state.drafts.delete(media.id);
    return onShelf();
  }
  if (!(await allowed)) return;
  await send({ type: 'shelve', id: job.id });
  state.jobs = await listJobs();
  renderQueue();
}

/** A download of the sound alone, in words. */
function formatLabel(job: Job): string | undefined {
  if (job.request.format === 'mp3') return 'MP3';
  if (job.request.format === 'audio') return t('found.audioOnly');
  return undefined;
}

/** A download's state in words: its phase while running. */
function runningLabel(job: Job): string {
  if (job.request.capture && job.disk?.phase === 'download' && !job.bytes?.done)
    return t('capture.waiting');
  if ((job.request.live || job.request.capture) && job.disk?.phase === 'download')
    return [
      t('queue.recording', { time: formatDuration(job.recorded ?? 0) }),
      job.bytes?.done ? formatBytes(job.bytes.done, state.lang) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const percent = Math.round((job.progress ?? 0) * 100);
  if (targetOf(job) === 'disk' && job.disk?.phase === 'join') return t('queue.joining');
  if (targetOf(job) === 'disk' && job.disk?.phase === 'deliver') return t('queue.delivering');
  const what = job.plan?.quality ?? formatLabel(job);
  return `${percent}%${what ? ` · ${what}` : ''}`;
}

/** A recording this popup shows in a card of its page (the tab's, or a live stream of it). */
function inCard(job: Job): boolean {
  if (!isActive(job)) return false;
  if (job.request.capture) return job.request.capture.tabId === state.tab?.id;
  return !!job.request.live && state.items.some((m) => m.url === job.request.media.url);
}

function jobRow(job: Job): HTMLElement {
  const percent = Math.round((job.progress ?? 0) * 100);
  const disk = targetOf(job) === 'disk';
  const act = (type: 'cancel' | 'retry' | 'remove' | 'stop', label: string, paths: string) =>
    h(
      'button',
      {
        class: 'btn btn-ghost btn-sm icon-btn',
        title: label,
        'aria-label': label,
        'data-testid': `popup-${type}`,
        onclick: () => void send({ type, id: job.id } as BackgroundMessage).then(refreshJobs),
      },
      icon(paths),
    );
  const status: Child =
    job.status === 'running'
      ? [
          h('div', { class: 'progress' }, h('div', { style: `width:${percent}%` })),
          h(
            'span',
            { class: 'label-mono' },
            (job.request.live || job.request.capture) &&
              job.disk?.phase === 'download' &&
              h('span', { class: 'rec-dot' }),
            runningLabel(job),
          ),
        ]
      : job.status === 'queued'
        ? h('span', { class: 'label-mono' }, t('queue.waiting'))
        : job.status === 'done'
          ? disk
            ? h(
                'span',
                { class: 'label-mono done' },
                t('queue.downloaded'),
                job.disk?.downloadId !== undefined && [
                  ' · ',
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      'data-testid': 'popup-show-file',
                      onclick: () => chrome.downloads.show(job.disk!.downloadId!),
                    },
                    t('queue.showInFolder'),
                  ),
                ],
              )
            : h(
                'span',
                { class: 'label-mono done' },
                t('queue.done'),
                ' · ',
                h(
                  'a',
                  { href: `${job.server}/${job.video?.code ?? ''}`, target: '_blank' },
                  t('queue.open'),
                ),
              )
          : job.status === 'failed'
            ? h('span', { class: 'job-error' }, job.error?.message ?? t('queue.failed'))
            : h('span', { class: 'label-mono' }, t('queue.cancelled'));
  return h(
    'li',
    {
      class: 'job',
      'data-testid': 'popup-job',
      'data-status': job.status,
      'data-target': disk ? 'disk' : 'shelf',
    },
    h(
      'div',
      { class: 'job-text' },
      h(
        'span',
        { class: 'item-name' },
        !disk && h('span', { class: 'job-to', title: t('queue.toShelf') }, icon(ICONS.shelf, 12)),
        job.request.meta.title,
      ),
      status,
    ),
    h(
      'span',
      { class: 'job-actions' },
      // A recording of this page is stopped in its card above: here it is only shown.
      inCard(job)
        ? null
        : isActive(job)
          ? [
              // A recording elsewhere: "Stop" saves what it has; the cross throws it away.
              (job.request.live || job.request.capture) &&
                job.disk?.phase === 'download' &&
                !job.stop &&
                act('stop', t('queue.stop'), ICONS.stop),
              act('cancel', t('queue.cancel'), ICONS.close),
            ]
          : job.status === 'done'
            ? act('remove', t('queue.remove'), ICONS.close)
            : [
                act('retry', t('queue.retry'), ICONS.retry),
                act('remove', t('queue.remove'), ICONS.close),
              ],
    ),
  );
}

async function refreshJobs(): Promise<void> {
  state.jobs = await listJobs();
  renderQueue();
}

function renderQueue(): void {
  const section = document.getElementById('queue');
  if (section) replace(section, queueView());
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage) => {
  if (message.type !== 'job') return;
  const i = state.jobs.findIndex((j) => j.id === message.job.id);
  const before = i >= 0 ? state.jobs[i] : undefined;
  if (i >= 0) state.jobs[i] = message.job;
  else state.jobs.push(message.job);
  // A recording shown in a card above: the card follows it too; else the list alone.
  if (state.view === 'list' && (inCard(message.job) || (before && inCard(before)))) render();
  else renderQueue();
  // A video got its upload, finished or failed: the day's count changed on the server.
  const counted = (j: Job | undefined) => `${j?.status}:${!!j?.upload}`;
  if (targetOf(message.job) === 'shelf' && counted(before) !== counted(message.job))
    void refreshContext();
});

void init();
