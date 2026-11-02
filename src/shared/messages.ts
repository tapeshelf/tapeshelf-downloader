import type { FileName, Job, JobTarget } from './jobs';
import type { FoundMedia, SaveRequest } from './media';
import type { Account } from './settings';

/**
 * Messages between the parts of the extension. The service worker answers the popup, the options
 * page and the offscreen document; the offscreen document takes only `target: 'offscreen'`.
 */
export type BackgroundMessage =
  /** `reopen`: from the popup, which closes as the window opens: show it again after. */
  | { type: 'connect'; reopen?: boolean }
  | { type: 'disconnect' }
  | { type: 'tab-media'; tabId: number }
  | { type: 'enqueue'; jobs: NewJob[] }
  /** A finished download sent to the shelf as well. */
  | { type: 'shelve'; id: string }
  | { type: 'cancel'; id: string }
  /** A live recording ends, saved with what it has. */
  | { type: 'stop'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'auth' }
  | { type: 'headers'; urls: string[]; referer: string; userAgent?: string }
  | { type: 'job'; job: Job }
  | { type: 'idle' }
  /** From the offscreen document: hand this finished file (a blob URL) to Downloads. */
  | { type: 'deliver'; id: string; url: string; filename: string }
  /** A small file beside a download (subtitles): saved, its path answered. */
  | { type: 'deliverFile'; url: string; filename: string }
  /** The recording mode: the offscreen document is ready — the tab is reloaded to record. */
  | { type: 'captureReady'; id: string; tabId: number }
  /** …it ended: the tab stops sending. */
  | { type: 'captureStop'; id: string; tabId: number }
  /** From the tab's relay as its page starts: does this tab record, or buffer ahead? */
  | { type: 'captureArmed' }
  /** From a relay whose page's player made a buffer: the offscreen document to buffer in. */
  | { type: 'bufferOpen' }
  /** From the button on a site's page: does this address name a post an adapter knows? */
  | { type: 'pageSite'; url: string }
  /** …the post's videos, each quality with its size, as the menu shows them. */
  | { type: 'pageMenu'; url: string }
  /** …one of them, to the computer (in a quality, its sound, MP3) or to the shelf. */
  | { type: 'pageSave'; url: string; index: number; choice: string; to: 'disk' | 'mp3' | 'shelf' }
  /** From the offscreen document: these bytes of a file only its page can read. */
  | { type: 'pageFetch'; tabId: number; url: string; start: number; end: number };

/** The answer to `pageFetch`: the bytes as base64, with the file's whole size when it says. */
export type PageBytes = { status: number; total?: number; b64: string } | { error: string };

/** The service worker's answer to `deliver`. */
export type DeliverAnswer =
  /** Started: `delivered` follows when it is in Downloads. */
  | { downloadId: number }
  /** In Downloads already (asked again after a restart). */
  | { done: Delivered }
  | { error: string };

export interface Delivered {
  path: string;
  size: number;
}

export type OffscreenMessage =
  | { target: 'offscreen'; type: 'kick' }
  | { target: 'offscreen'; type: 'cancel'; id: string }
  | ({ target: 'offscreen'; type: 'delivered'; id: string } & (Delivered | { error: string }));

/** A video to download or to save, as the popup or the menu asks for it. */
export interface NewJob {
  target: JobTarget;
  request: SaveRequest;
  thumbnail?: string;
  /** A download's file name (the settings' template, the video's fields). */
  name?: FileName;
  /** To the shelf from a finished download: that job's id, which then says so. */
  from?: string;
}

export interface TabMedia {
  pageUrl: string;
  items: FoundMedia[];
}

export interface Auth {
  account: Account | null;
  lang: string;
}

/**
 * Popup's wish when it opens: the form for this video (right-click menu, shortcut), or the shelf
 * for the videos ticked before connecting (connecting is asked for by "To My shelf").
 */
export interface PendingSave {
  tabId: number;
  /** A media id from the tab's list, or a URL the menu was opened on. */
  mediaId?: string;
  url?: string;
  /** Media ids ticked when "To My shelf" asked to connect first. */
  shelf?: string[];
  /** A post's video from the button on its site's page, for the form or connecting. */
  media?: FoundMedia;
}

/**
 * Firefox has no offscreen document: the queue's work runs in the background page beside
 * the service worker's part, and a page does not hear its own messages. There both parts listen
 * here too, and a message between them is handed over in the page; other pages (the popup, the
 * panel) still hear it from the browser.
 */
type Here = (message: BackgroundMessage | OffscreenMessage) => Promise<unknown> | undefined;
const here: Here[] = [];
export const listenHere = (listener: Here) => void here.push(listener);

export const send = <T = unknown>(message: BackgroundMessage | OffscreenMessage): Promise<T> => {
  if (!here.length) return chrome.runtime.sendMessage(message) as Promise<T>;
  const answers = here.map((listener) => listener(message)).filter((a) => a !== undefined);
  if (!('target' in message)) void chrome.runtime.sendMessage(message).catch(() => undefined);
  return (answers[0] ?? Promise.resolve(undefined)) as Promise<T>;
};
