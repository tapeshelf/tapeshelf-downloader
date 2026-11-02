import { ApiError, api } from '../shared/api';
import { loadTranslate, supportedLang, type Translate } from '../shared/i18n';
import { getJob, listJobs, targetOf, type Job, type JobTarget } from '../shared/jobs';
import { FIREFOX } from '../shared/build';
import {
  listenHere,
  send,
  type Auth,
  type BackgroundMessage,
  type OffscreenMessage,
} from '../shared/messages';
import { removeStored, storedNames } from '../shared/storage';
import { buffering, onBuffersGone, sweepBuffers } from './capture';
import { refusedByTheSite, report, save } from './common';
import { delivered, saveToDisk } from './disk';
import { SaveError } from './plan';
import { saveVideo } from './shelf';
import { PartUploadError } from './upload';

/**
 * The offscreen document: the long work lives here, because the service worker is
 * stopped after half a minute idle. Three lanes take the queue side by side, one job each at a
 * time — videos to the computer, videos to the shelf, and recordings (a live stream, what a tab
 * plays —), which last as long as they play and hold up no download — and report each step.
 * It closes when the queue is empty.
 */
type Lane = JobTarget | 'record';
const busy: Record<Lane, boolean> = { disk: false, shelf: false, record: false };
const laneOf = (j: Job): Lane => (j.request.live || j.request.capture ? 'record' : targetOf(j));
const current = new Map<string, AbortController>();

async function work(): Promise<void> {
  await Promise.all([lane('disk'), lane('shelf'), lane('record')]);
  await idleIfDone();
}

/** Nothing to do and no tab's buffer kept: the document may close. */
async function idleIfDone(): Promise<void> {
  if (!busy.disk && !busy.shelf && !busy.record && !buffering())
    await send({ type: 'idle' }).catch(() => undefined);
}
onBuffersGone(() => void idleIfDone());

async function lane(target: Lane): Promise<void> {
  if (busy[target]) return;
  busy[target] = true;
  try {
    for (;;) {
      const jobs = (await listJobs()).filter((j) => laneOf(j) === target);
      const next =
        jobs.find((j) => j.status === 'running') ?? jobs.find((j) => j.status === 'queued');
      if (!next) break;
      await run(next);
    }
  } finally {
    busy[target] = false;
  }
}

async function run(job: Job): Promise<void> {
  const abort = new AbortController();
  current.set(job.id, abort);
  const target = targetOf(job);
  const { account, lang } = await send<Auth>({ type: 'auth' }).catch(() => ({
    account: null,
    lang: 'en',
  }));
  const t = await loadTranslate(supportedLang(lang));
  try {
    await report(await save(job.id, () => ({ status: 'running', error: undefined })));
    // A site that refuses its own link (expired while the video waited, or on a timer): asked
    // again once, and the download goes on from its last part with the new link.
    for (let refreshes = 0; ; refreshes++) {
      try {
        if (target === 'disk') {
          await persist(() => saveToDisk(job.id, abort.signal), abort.signal);
          break;
        }
        if (!account || account.server !== job.server)
          throw new ApiError(401, 'appTokenInvalid', t('errors.disconnected'));
        const video = await persist(
          () => saveVideo(job.id, account, lang, abort.signal),
          abort.signal,
        );
        await report(await save(job.id, () => ({ status: 'done', progress: 1, video })));
        break;
      } catch (err) {
        if (refreshes > 0 || !refusedByTheSite(err) || !job.request.media.site) throw err;
      }
    }
  } catch (err) {
    const latest = await getJob(job.id);
    if (latest?.status === 'cancelled') {
      if (target === 'disk') await removeStored(job.id);
      else if (latest.upload && account)
        await api(account, 'DELETE', `/uploads/${latest.upload.id}`).catch(() => undefined);
      await report(latest);
    } else if (latest) {
      const error = describe(err, t);
      await report(await save(job.id, () => ({ status: 'failed', error })));
    }
  } finally {
    current.delete(job.id);
  }
}

/**
 * A dropped connection, the server busy, the site failing for a moment: tried again after a pause,
 * going on from the last part. Closing the browser drops connections too; then the job is still
 * running when the browser stops, and goes on when it starts again.
 */
const PAUSES = [2_000, 10_000, 30_000];

function transient(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof PartUploadError) return true;
  if (err instanceof ApiError) return err.status === 0 || err.status >= 500;
  if (err instanceof SaveError) return err.code === 'source' && (err.status ?? 0) >= 500;
  return false;
}

async function persist<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (signal.aborted || !transient(err) || attempt >= PAUSES.length) throw err;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, PAUSES[attempt]);
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), {
          once: true,
        });
      });
    }
  }
}

/** Why a video was not saved, in words for the person, with the cause beside them. */
function describe(err: unknown, t: Translate): { code: string; message: string; detail: string } {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof ApiError)
    return {
      code: err.code,
      message: err.status === 0 ? t('errors.network') : err.message,
      detail,
    };
  if (err instanceof SaveError)
    return {
      code: err.code,
      message:
        err.code === 'source'
          ? t('errors.source', { status: err.status ?? '' })
          : err.code === 'deliver'
            ? t('errors.deliver', { reason: err.detail ?? '' })
            : t(`errors.${err.code}`),
      detail,
    };
  if (err instanceof TypeError) return { code: 'network', message: t('errors.network'), detail };
  return { code: 'unknown', message: t('errors.unknown', { message: String(err) }), detail };
}

/**
 * Files of the extension's storage no download needs any more (finished, cancelled, gone from
 * the list): removed as the document opens. A failed download keeps its files for "Try again".
 */
async function sweep(): Promise<void> {
  const jobs = new Map((await listJobs()).map((j) => [j.id, j]));
  const ids = new Set((await storedNames()).map((n) => n.split('.')[0]!));
  for (const id of ids) {
    const job = jobs.get(id);
    if (!job || job.status === 'done' || job.status === 'cancelled') await removeStored(id);
  }
}

function onMessage(message: OffscreenMessage | BackgroundMessage): undefined {
  if (!('target' in message) || message.target !== 'offscreen') return;
  if (message.type === 'kick') void work();
  if (message.type === 'cancel') current.get(message.id)?.abort();
  if (message.type === 'delivered') delivered(message.id, message);
}
chrome.runtime.onMessage.addListener(onMessage);

if (FIREFOX) {
  // Firefox: this runs in the background page, beside the service worker's part.
  listenHere(onMessage);
  // Firefox lets a background page sleep after half a minute without an event of the extension's;
  // while a lane works or a tab's buffer is kept, a write to storage is such an event.
  setInterval(() => {
    if (busy.disk || busy.shelf || busy.record || buffering())
      void chrome.storage.local.set({ awake: Date.now() });
  }, 20_000);
  chrome.storage.onChanged.addListener(() => undefined);
}

// Opened by the service worker because something waits: start at once.
void sweepBuffers()
  .catch(() => undefined)
  .then(sweep)
  .catch(() => undefined)
  .then(() => work());
