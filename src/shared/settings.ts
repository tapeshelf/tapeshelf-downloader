import type { Lang } from './i18n';
import type { Visibility } from './media';
import type { QualityPref } from './quality';

/** The extension's settings, kept in the browser's extension storage. */
export interface Settings {
  /** The file's name: `{title}`, `{site}`, `{quality}`, `{date}`, `{author}`. */
  fileName: string;
  /** A folder in Downloads; empty: Downloads itself. */
  folder: string;
  /** Keep the finished videos in the history (this browser only). */
  history: boolean;
  /** After a download, a line offering the shelf. */
  shelfHint: boolean;
  /** The sound's language when a video has several: 'auto' — the browser's. */
  audioLanguage: string;
  /** Leave out the ad breaks a stream's playlist marks. */
  skipAds: boolean;
  /** Sites where the extension looks for no video: hosts, a site's subdomains with it. */
  blockedSites: string[];
  /** A file name of its own for a site's videos: its template instead of `fileName`. */
  siteNames: { site: string; template: string }[];
  /**
   * Recording what plays: the page reloads (`reload`), or what its player loads is copied
   * ahead into a buffer on every site (`all`) or on the sites listed (`sites`), and recording
   * starts without reloading, from the video's start.
   */
  captureMode: 'reload' | 'all' | 'sites';
  captureSites: string[];
  /** The buffer of a tab, MB: the oldest pieces go past it. */
  captureBufferMb: number;
  /** "Download" beside a site's own buttons, on the sites the extension knows. */
  pageButtons: boolean;
  /** The tapeshelf server: its origin, tapeshelf.com unless self-hosted. */
  server: string;
  /** Ask for the title, category… before saving; off: save at once with the defaults. */
  showForm: boolean;
  visibility: Visibility;
  categoryId: string | null;
  /** The quality a video is downloaded and saved in unless another is picked. */
  quality: QualityPref;
  /** Keep the page's address on the video (seen by its author alone). */
  saveSource: boolean;
  language: 'auto' | Lang;
}

export const DEFAULT_SERVER = 'https://tapeshelf.com';

export const DEFAULT_FILE_NAME = '{title}';
export const DEFAULT_FOLDER = 'tapeshelf';

export const DEFAULT_SETTINGS: Settings = {
  fileName: DEFAULT_FILE_NAME,
  folder: DEFAULT_FOLDER,
  history: true,
  shelfHint: true,
  audioLanguage: 'auto',
  skipAds: true,
  blockedSites: [],
  siteNames: [],
  captureMode: 'reload',
  captureSites: [],
  captureBufferMb: 2048,
  pageButtons: true,
  server: DEFAULT_SERVER,
  showForm: true,
  visibility: 'PRIVATE',
  categoryId: null,
  quality: 'best',
  saveSource: false,
  language: 'auto',
};

/** Who is connected, on which server, with the token the sign-in window gave. */
export interface Account {
  server: string;
  token: string;
  user: { username: string; displayName: string; avatarUrl: string | null };
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** The account of the server in the settings; one of another server does not count. */
export async function getAccount(): Promise<Account | null> {
  const [{ account }, settings] = await Promise.all([
    chrome.storage.local.get('account'),
    getSettings(),
  ]);
  const a = account as Account | undefined;
  return a && a.server === settings.server ? a : null;
}

export async function setAccount(account: Account | null): Promise<void> {
  if (account) await chrome.storage.local.set({ account });
  else await chrome.storage.local.remove('account');
}

/**
 * A server address as typed (tapeshelf.example.org, https://videos.example.org/some/page) as an
 * origin: https unless it is this computer. Null when it is no address.
 */
export function normalizeServer(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (!url.hostname.includes('.') && !local) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A host as typed in the settings: "https://www.VK.com/x" → "vk.com". */
export function siteKey(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return '';
  }
}

/** The page's host is one of the sites (or under one): vk.com covers m.vk.com. */
export function onSite(pageUrl: string, sites: string[]): string | undefined {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
  return sites.find((s) => s && (host === s || host.endsWith(`.${s}`)));
}

/**
 * How much a tab of the page buffers ahead to record without reloading: the settings, for
 * its site; 0 — a recording reloads the page.
 */
export function bufferAhead(pageUrl: string, s: Settings): number {
  const ahead =
    !onSite(pageUrl, s.blockedSites) &&
    (s.captureMode === 'all' || (s.captureMode === 'sites' && !!onSite(pageUrl, s.captureSites)));
  return ahead ? s.captureBufferMb * 1024 * 1024 : 0;
}
