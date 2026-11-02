import { logo } from '../shared/dom';
import { onSite, type Settings } from '../shared/settings';
import { spots, type Spot } from './spots';

/**
 * The button on a site's page: "Download" beside the site's own buttons of each post with a
 * video, and — where its row is not found — in the video's corner while the pointer is on it. It
 * opens a menu of the post's video: each quality with its size, the sound alone, MP3, "Save to My
 * shelf". The service worker asks the site's adapter, and downloads; this script only shows.
 * Everything it draws lives in shadow roots: the site's styles do not reach it, nor it them.
 */
interface Menu {
  videos: { title: string; choices: { value: string; label: string }[]; picked: string }[];
  labels: { mp3: string; shelf: string; nothing: string; started: string; title: string };
}

const MARK = 'data-tapeshelf-button';
const ROW_STYLE = `
:host { display: inline-flex; align-items: center; }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 10px; border-radius: 999px; cursor: pointer; font: inherit;
  font-weight: 600; color: inherit; white-space: nowrap; background: var(--theirs, transparent); }
button:hover, button:focus-visible {
  background: color-mix(in srgb, currentColor 12%, var(--theirs, transparent)); }
`;

/**
 * Dressed as the row's own last button: its font, size, weight, colour, height, padding,
 * rounding and background, and the spacing the row keeps between its items — one of the site's
 * buttons to look at, told apart by tapeshelf's mark.
 */
function lookLike(b: HTMLButtonElement, host: HTMLElement, row: Element): void {
  const theirs = [...row.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .filter((e) => !host.contains(e) && e.getBoundingClientRect().height > 0)
    .at(-1);
  if (!theirs) return;
  const look = getComputedStyle(theirs);
  for (const p of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'color',
    'borderRadius',
  ] as const)
    b.style[p] = look[p];
  b.style.setProperty('--theirs', look.backgroundColor);
  const height = theirs.getBoundingClientRect().height;
  if (height >= 20) b.style.height = `${height}px`;
  b.style.padding = `0 ${Math.max(10, parseFloat(look.paddingLeft) || 0)}px`;
  let item: Element | null = theirs;
  while (item && item.parentElement !== row) item = item.parentElement;
  if (item) {
    const spacing = getComputedStyle(item);
    host.style.marginLeft = spacing.marginLeft;
    host.style.marginRight = spacing.marginRight;
  }
}

const CORNER_STYLE = `
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: 999px; cursor: pointer;
  font: 600 14px/1 system-ui, sans-serif; color: #fff; background: rgba(0, 0, 0, 0.72); }
button:hover, button:focus-visible { background: rgba(0, 0, 0, 0.88); }
`;

const MENU_STYLE = `
.menu { position: fixed; z-index: 2147483647; min-width: 240px; max-width: 340px; padding: 6px;
  box-sizing: border-box; border: 2px solid #1b1b1b; border-radius: 12px; background: #fbfaf7;
  color: #1b1b1b; box-shadow: 3px 3px 0 0 #1b1b1b; font: 14px/1.3 system-ui, sans-serif; }
.head { padding: 6px 10px 4px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.item { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 9px 10px;
  border-radius: 8px; cursor: pointer; }
.item:hover, .item:focus-visible { background: #ecebe6; }
.picked { font-weight: 600; }
.sep { height: 2px; margin: 4px 6px; background: #e2e0da; }
.note { padding: 9px 10px; color: #5c5a55; }
@media (prefers-color-scheme: dark) {
  .menu { border-color: #f3f1ec; background: #1f1f1f; color: #f3f1ec; box-shadow: 3px 3px 0 0 #000; }
  .item:hover, .item:focus-visible { background: #2e2e2e; }
  .sep { background: #333; }
  .note { color: #b5b2ab; }
}
`;

let label = '';
let here = false;
let lastUrl = '';

const ask = <T>(message: object) => chrome.runtime.sendMessage(message) as Promise<T>;

function button(style: string): { host: HTMLElement; button: HTMLButtonElement } {
  const host = document.createElement('span');
  host.setAttribute(MARK, '');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style');
  sheet.textContent = style;
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-haspopup', 'menu');
  const text = document.createElement('span');
  text.textContent = label;
  b.append(logo(18), text);
  b.title = `tapeshelf · ${label}`;
  root.append(sheet, b);
  return { host, button: b };
}

// The menu: one, over the page, beside the button that opened it.
const menuHost = document.createElement('span');
menuHost.setAttribute(MARK, '');
const menuRoot = menuHost.attachShadow({ mode: 'open' });
let menu: HTMLElement | null = null;

function closeMenu(): void {
  menu?.remove();
  menu = null;
}

function place(anchor: Element): void {
  if (!menu) return;
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const below = a.bottom + 6 + m.height <= innerHeight || a.top - 6 - m.height < 0;
  menu.style.top = `${Math.max(6, below ? a.bottom + 6 : a.top - 6 - m.height)}px`;
  menu.style.left = `${Math.min(Math.max(6, a.right - m.width), innerWidth - m.width - 6)}px`;
}

function item(text: string, onclick: () => void, picked = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = picked ? 'item picked' : 'item';
  b.setAttribute('role', 'menuitem');
  b.textContent = text;
  b.addEventListener('click', (e) => (e.stopPropagation(), onclick()));
  return b;
}

function note(text: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 'note';
  p.textContent = text;
  return p;
}

async function openMenu(anchor: Element, url: string): Promise<void> {
  closeMenu();
  if (!menuHost.isConnected) document.documentElement.append(menuHost);
  const sheet = document.createElement('style');
  sheet.textContent = MENU_STYLE;
  menuRoot.replaceChildren(sheet);
  const open = document.createElement('div');
  open.className = 'menu';
  open.setAttribute('role', 'menu');
  open.dataset['testid'] = 'page-menu';
  open.append(note('…'));
  menuRoot.append(open);
  menu = open;
  place(anchor);
  const answer = await ask<Menu | null>({ type: 'pageMenu', url }).catch(() => null);
  if (menu !== open) return;
  open.replaceChildren();
  const videos = answer?.videos ?? [];
  if (!answer || !videos.length) {
    open.append(note(answer?.labels.nothing ?? '—'));
    return place(anchor);
  }
  const save = (index: number, choice: string, to: 'disk' | 'mp3' | 'shelf') =>
    void ask<string>({ type: 'pageSave', url, index, choice, to }).then((done) => {
      if (menu !== open) return;
      if (done !== 'started') return closeMenu();
      open.replaceChildren(note(answer.labels.started));
      setTimeout(() => menu === open && closeMenu(), 1500);
    });
  videos.forEach((v, index) => {
    if (index) open.append(Object.assign(document.createElement('div'), { className: 'sep' }));
    if (videos.length > 1)
      open.append(
        Object.assign(document.createElement('div'), { className: 'head', textContent: v.title }),
      );
    for (const c of v.choices)
      open.append(item(c.label, () => save(index, c.value, 'disk'), c.value === v.picked));
    open.append(item(answer.labels.mp3, () => save(index, '', 'mp3')));
    open.append(Object.assign(document.createElement('div'), { className: 'sep' }));
    open.append(item(answer.labels.shelf, () => save(index, '', 'shelf')));
  });
  place(anchor);
  open.querySelector<HTMLElement>('.item')?.focus();
}

window.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener(
  'click',
  (e) => menu && !e.composedPath().includes(menuHost) && closeMenu(),
  true,
);
window.addEventListener('scroll', closeMenu, { passive: true });

// The corner button: one, shown over whichever video of a post the pointer is on.
const corner = button(CORNER_STYLE);
corner.host.style.cssText = 'position:fixed;z-index:2147483646;display:none';
let cornered: Spot[] = [];
let cornerSpot: Spot | undefined;
corner.button.dataset['testid'] = 'page-button-corner';
corner.button.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  if (cornerSpot) void openMenu(corner.button, cornerSpot.url);
});

function showCorner(spot: Spot | undefined): void {
  cornerSpot = spot;
  if (!spot?.video) return void (corner.host.style.display = 'none');
  if (!corner.host.isConnected) document.documentElement.append(corner.host);
  const r = spot.video.getBoundingClientRect();
  corner.host.style.display = 'block';
  corner.host.style.top = `${r.top + 10}px`;
  corner.host.style.left = `${r.right - corner.host.offsetWidth - 10}px`;
}

window.addEventListener(
  'pointermove',
  (e) => {
    if (!cornered.length || menu) return;
    const at = cornered.find((s) => {
      const r = s.video!.getBoundingClientRect();
      return (
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
    });
    if (at !== cornerSpot) showCorner(at);
  },
  { passive: true },
);

/** The biggest video of the page on screen, for a video page whose post was not found. */
function biggestVideo(): Element | undefined {
  let best: Element | undefined;
  let area = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width * r.height > area) [best, area] = [v, r.width * r.height];
  }
  return area > 0 ? best : undefined;
}

function scan(): void {
  const found = spots(location.hostname);
  const next: Spot[] = [];
  for (const spot of found) {
    if (spot.row) {
      if (spot.row.querySelector(`:scope > [${MARK}]`)) continue;
      const { host, button: b } = button(ROW_STYLE);
      b.dataset['testid'] = 'page-button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        void openMenu(b, spot.url);
      });
      spot.row.append(host);
      lookLike(b, host, spot.row);
    } else if (spot.video) next.push(spot);
  }
  // A video page whose post was not found: its biggest video, for the page's own address.
  if (!found.length && here) {
    const video = biggestVideo();
    if (video) next.push({ video, url: location.href });
  }
  cornered = next;
  if (cornerSpot && !next.includes(cornerSpot)) showCorner(undefined);
}

let pending: ReturnType<typeof setTimeout> | undefined;
function later(): void {
  clearTimeout(pending);
  pending = setTimeout(() => {
    // Another page of a site that never reloads: is this one a video's?
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      void ask<{ here: boolean } | null>({ type: 'pageSite', url: location.href })
        .then((a) => (here = !!a?.here))
        .catch(() => undefined)
        .finally(scan);
    } else scan();
  }, 400);
}

async function start(): Promise<void> {
  const { settings } = (await chrome.storage.local.get('settings')) as {
    settings?: Partial<Settings>;
  };
  if (settings?.pageButtons === false || onSite(location.href, settings?.blockedSites ?? []))
    return;
  const hello = await ask<{ here: boolean; label: string } | null>({
    type: 'pageSite',
    url: location.href,
  }).catch(() => null);
  if (!hello) return;
  [label, here, lastUrl] = [hello.label, hello.here, location.href];
  corner.button.querySelector('span')!.textContent = label;
  corner.button.title = `tapeshelf · ${label}`;
  scan();
  new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true });
}

if (window.top === window && /^https?:$/.test(location.protocol)) void start();
