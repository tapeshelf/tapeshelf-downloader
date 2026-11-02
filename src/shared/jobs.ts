import type { SaveRequest } from './media';

/**
 * The queue of videos being downloaded or saved, in IndexedDB: the service worker
 * adds to it, the offscreen document works through it — a video to the computer and one to the
 * shelf at a time, side by side — the popup shows it. It outlives the browser: a download stopped
 * by closing the browser goes on from its last finished part. Finished jobs are the history.
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Where a video goes: a file in Downloads (the main action) or the person's shelf. */
export type JobTarget = 'disk' | 'shelf';

/** Where a source is: a segment and a byte within it (a file is one segment). */
export interface Cursor {
  segment: number;
  offset: number;
}

export interface DonePart {
  partNumber: number;
  etag: string;
  size: number;
  /** Where the source stands at the end of this part: the next one starts reading here. */
  cursor: Cursor;
}

/** A source to download: one file, or segments joined in order. */
export interface TrackPlan {
  /** For the upload's name: mp4, ts, m4a, aac… */
  ext: string;
  mimeType: string;
  /** Exact bytes, when known before downloading. */
  size?: number;
  /** Bytes from the bit rate, when the size is not known. */
  estimate?: number;
  /** One file. */
  url?: string;
  /** Read the file in ranges of this many bytes. */
  chunk?: number;
  /** Read through this tab: only its page can fetch the file (Telegram Web). */
  tab?: number;
  /** Or segments: an init section to put first, AES-128 keys. */
  segments?: {
    url: string;
    range?: string;
    key?: { url: string; iv: string | null; sequence: number };
    /** Seconds, to show how far it got. */
    duration?: number;
  }[];
  init?: { url: string; range?: string };
}

export interface DownloadPlan {
  /** The source: the video, or for the sound alone, its own file when it has one. */
  video: TrackPlan;
  /** The sound alone is wanted: taken out of `video` when it has a picture too. */
  audioOnly?: boolean;
  /** Separate audio (DASH, HLS with an audio rendition): uploaded as the second track. */
  audio?: TrackPlan;
  /** "1080p", for the list. */
  quality?: string;
}

export interface TrackState {
  parts: DonePart[];
}

export interface UploadState {
  id: string;
  partSize: number;
  /** The declared size of a stream whose length is known only at its end. */
  sizeIsMax: boolean;
  /** Declared less than the room there is: a stream that outgrows it may try again, bigger. */
  roomy?: boolean;
  video: TrackState;
  audio?: TrackState;
}

/** A track being downloaded into the extension's own storage (OPFS) before it becomes a file. */
export interface StagedTrack {
  /** Bytes in the file, all of them flushed to disk. */
  bytes: number;
  /** Where the source stands at that point: the download goes on from here. */
  cursor: Cursor;
  /** All of it is there: after a restart, the next track goes on. */
  complete?: boolean;
}

/** What the file in Downloads is called: fixed when the video was asked for. */
export interface FileName {
  /** `{title}`, `{site}`, `{quality}`, `{date}`, `{author}` (settings). */
  template: string;
  /** A folder in Downloads; empty: Downloads itself. */
  folder: string;
  title: string;
  site: string;
  author?: string;
  /** The day it was asked for, YYYY-MM-DD. */
  date: string;
}

/** A video on its way to the computer. */
export interface DiskState {
  name: FileName;
  /** Downloading the tracks, joining them into one file, handing it to Downloads. */
  phase: 'download' | 'join' | 'deliver';
  video?: StagedTrack;
  audio?: StagedTrack;
  /** The finished file's type (mp4, mkv, webm…), once known. */
  ext?: string;
  /** The browser's download of the finished file. */
  downloadId?: number;
  /** The file as saved, in Downloads. */
  path?: string;
  /** Its bytes, for the history. */
  size?: number;
  /** The subtitles saved beside it. */
  subtitles?: string;
  /** A recording's parts so far, in the extension's storage. */
  capture?: { name: string; mime: string; bytes: number }[];
}

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  /** Undefined: the shelf (jobs from before). */
  target?: JobTarget;
  /** The server and account it goes to, fixed when it was asked for; empty for a download. */
  server: string;
  request: SaveRequest;
  /** The video's picture, for the list and the history. */
  thumbnail?: string;
  disk?: DiskState;
  /** A download sent to the shelf afterwards: that job's id. */
  shelved?: string;
  /** "Stop" pressed on a live recording: it ends and is saved with what it has. */
  stop?: boolean;
  /** Seconds of a live stream recorded so far. */
  recorded?: number;
  plan?: DownloadPlan;
  /** Grows when a stream outgrew what was declared for it (the upload starts again, bigger). */
  boundFactor?: number;
  upload?: UploadState;
  /** 0–1. */
  progress?: number;
  /** Bytes done and expected, for the list. */
  bytes?: { done: number; total?: number };
  video?: { id: string; code: string };
  /** Why it failed: in words for the person, and the technical cause for a bug report. */
  error?: { code: string; message: string; detail?: string };
}

const DB = 'tapeshelf';
const STORE = 'jobs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listJobs(): Promise<Job[]> {
  const all = (await run<Job[]>('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export const getJob = (id: string) => run<Job>('readonly', (s) => s.get(id));

export async function putJob(job: Job): Promise<void> {
  await run('readwrite', (s) => s.put({ ...job, updatedAt: Date.now() }));
}

/**
 * Changes a job in one transaction, so a cancel from the popup and progress from the download
 * never overwrite each other. Returns the job as saved, or undefined when it is gone.
 */
export async function updateJob(
  id: string,
  change: (job: Job) => Job | undefined,
): Promise<Job | undefined> {
  let saved: Job | undefined;
  await run('readwrite', (s) => {
    const req = s.get(id);
    req.onsuccess = () => {
      const job = req.result as Job | undefined;
      const next = job && change(job);
      if (!next) return;
      saved = { ...next, updatedAt: Date.now() };
      s.put(saved);
    };
  });
  return saved;
}

export async function deleteJob(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

export const isActive = (j: Job) => j.status === 'queued' || j.status === 'running';

export const targetOf = (j: Job): JobTarget => j.target ?? 'shelf';

/** Finished videos the popup shows (the newest); the history page has them all. */
export const FINISHED_SHOWN = 10;

/** The history keeps this many finished videos; older ones go as new ones finish. */
export const HISTORY_MAX = 1000;

/** The newest finished jobs first: the history. */
export function history(all: Job[]): Job[] {
  return all.filter((j) => !isActive(j)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Finished jobs past the history's length, the oldest: to be deleted. */
export const pastHistory = (all: Job[], max = HISTORY_MAX) => history(all).slice(max);

/**
 * The popup's list in the order the queue is worked: the video being saved, every one waiting
 * (oldest first: the next to go), then the latest finished; and how many wait.
 */
export function inQueueOrder(all: Job[]): { jobs: Job[]; waiting: number } {
  const byAge = [...all].sort((a, b) => a.createdAt - b.createdAt);
  const running = byAge.filter((j) => j.status === 'running');
  const waiting = byAge.filter((j) => j.status === 'queued');
  const finished = history(all).slice(0, FINISHED_SHOWN);
  return { jobs: [...running, ...waiting, ...finished], waiting: waiting.length };
}
