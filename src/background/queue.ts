import { loadTranslate, type Translate } from '../shared/i18n';
import {
  deleteJob,
  getJob,
  isActive,
  listJobs,
  pastHistory,
  putJob,
  targetOf,
  updateJob,
  type Job,
} from '../shared/jobs';
import { FIREFOX } from '../shared/build';
import { send, type DeliverAnswer, type NewJob, type OffscreenMessage } from '../shared/messages';
import { bufferAhead, getAccount, getSettings, setAccount } from '../shared/settings';
import { removeStored } from '../shared/storage';
import { currentLang } from './lang';

/**
 * The queue's service-worker side: adds videos, wakes the offscreen document that
 * downloads and saves them, hands finished files to Downloads, cancels, and tells the person when
 * a video is on the shelf or why it is not. Finished jobs are the history.
 */
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // Firefox: the queue's work lives in this very page.
  if (FIREFOX || (await chrome.offscreen.hasDocument())) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
      justification:
        'Downloads the videos the person asks for, joins their picture and sound into one file, and uploads the ones they save to their shelf.',
    })
    .finally(() => (creating = null));
  await creating;
}

const toOffscreen = (message: OffscreenMessage) => send(message).catch(() => undefined);

/** Starts the offscreen document when something waits; it looks for work itself as it opens. */
export async function kick(): Promise<void> {
  if (!(await listJobs()).some(isActive)) return;
  if (FIREFOX) return void (await toOffscreen({ target: 'offscreen', type: 'kick' }));
  const open = await chrome.offscreen.hasDocument();
  await ensureOffscreen();
  if (open) await toOffscreen({ target: 'offscreen', type: 'kick' });
}

/** The queue is empty: the offscreen document goes, and the memory a big video took with it. */
export async function idle(): Promise<void> {
  if ((await listJobs()).some(isActive)) {
    await kick();
    return;
  }
  // A tab's buffer is on its way to it: the document stays.
  const { bufferWantedAt } = (await chrome.storage.session.get('bufferWantedAt')) as {
    bufferWantedAt?: number;
  };
  if (Date.now() - (bufferWantedAt ?? 0) < 15_000) return;
  if (!FIREFOX && (await chrome.offscreen.hasDocument())) await chrome.offscreen.closeDocument();
}

/**
 * Videos into the queue. A download needs no account; the shelf does (asked for in the popup).
 * `notify`: asked from the menu or the shortcut, without the popup — a notification says so.
 */
export async function enqueue(items: NewJob[], notify = false): Promise<void> {
  const account = await getAccount();
  const now = Date.now();
  const jobs: Job[] = [];
  for (const [i, item] of items.entries()) {
    if (item.target === 'shelf' && !account) continue;
    jobs.push({
      id: crypto.randomUUID(),
      createdAt: now + i,
      updatedAt: now,
      status: 'queued',
      target: item.target,
      server: item.target === 'shelf' ? account!.server : '',
      request: item.request,
      thumbnail: item.thumbnail,
      disk:
        item.target === 'disk' && item.name ? { name: item.name, phase: 'download' } : undefined,
    });
  }
  for (const job of jobs) await putJob(job);
  for (const [i, item] of items.entries()) {
    const job = jobs.find((j) => j.createdAt === now + i);
    if (item.from && job) await updateJob(item.from, (j) => ({ ...j, shelved: job.id }));
  }
  if (notify) {
    const t = await translate();
    for (const job of jobs)
      await note(
        job.id,
        t(targetOf(job) === 'disk' ? 'notify.downloading' : 'notify.saving'),
        job.request.meta.title,
      );
  }
  await kick();
}

/** A finished download sent to the shelf as well: a shelf job of the same video. */
export async function shelve(id: string): Promise<string | undefined> {
  const job = await getJob(id);
  const account = await getAccount();
  if (!job || !account) return undefined;
  const settings = await getSettings();
  const shelfJob: Job = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued',
    target: 'shelf',
    server: account.server,
    thumbnail: job.thumbnail,
    request: {
      ...job.request,
      meta: {
        ...job.request.meta,
        visibility: settings.visibility,
        categoryId: settings.categoryId ?? undefined,
      },
      sourceUrl: settings.saveSource ? job.request.media.pageUrl : undefined,
    },
  };
  await putJob(shelfJob);
  await updateJob(id, (j) => ({ ...j, shelved: shelfJob.id }));
  await kick();
  return shelfJob.id;
}

export async function cancel(id: string): Promise<void> {
  const job = await updateJob(id, (j) => (isActive(j) ? { ...j, status: 'cancelled' } : undefined));
  if (!job) return;
  await toOffscreen({ target: 'offscreen', type: 'cancel', id });
  const downloadId = job.disk?.downloadId;
  if (downloadId !== undefined) await chrome.downloads.cancel(downloadId).catch(() => undefined);
}

/** A recording (live, or what a tab plays) ends and is saved with what it has. */
export async function stop(id: string): Promise<void> {
  await updateJob(id, (j) =>
    isActive(j) && (j.request.live || j.request.capture) ? { ...j, stop: true } : undefined,
  );
}

/**
 * The recording mode. The offscreen document is ready for a tab's pieces: the tab is
 * marked as recording and reloaded, so its player's every piece — the first ones with the init
 * sections included — goes by the page's ears from the start.
 */
const armedKey = (tabId: number) => `capture:${tabId}`;

export async function captureReady(id: string, tabId: number): Promise<void> {
  await chrome.storage.session.set({ [armedKey(tabId)]: id });
  // The page's script reads it as the page starts again: a player's workers build the video where
  // the recording sees it (`capture/main.ts`).
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: (mark: string) => {
        try {
          sessionStorage.setItem(mark, '1');
        } catch {
          // A frame without storage.
        }
      },
      args: ['tapeshelf-capture'],
    })
    .catch(() => undefined);
  await chrome.tabs.reload(tabId).catch(() => undefined);
}

/**
 * A page of the tab asks as it starts: the job it records for, if any; else whether it buffers
 * ahead (the settings, for its site:) and how much.
 */
export async function captureArmed(
  tabId: number | undefined,
  pageUrl: string | undefined,
): Promise<{ job?: string; buffer?: number }> {
  if (tabId === undefined) return {};
  const id = (await chrome.storage.session.get(armedKey(tabId)))[armedKey(tabId)] as
    string | undefined;
  const job = id ? await getJob(id) : undefined;
  if (job && isActive(job) && !job.stop) return { job: id };
  const buffer = bufferAhead(pageUrl ?? '', await getSettings());
  return buffer ? { buffer } : {};
}

/** A tab's player made a buffer: the offscreen document is there to keep it. */
export async function bufferOpen(): Promise<boolean> {
  await chrome.storage.session.set({ bufferWantedAt: Date.now() });
  await ensureOffscreen();
  return true;
}

export async function captureStop(tabId: number): Promise<void> {
  await chrome.storage.session.remove(armedKey(tabId));
  await chrome.tabs.sendMessage(tabId, { type: 'capture-stop' }).catch(() => undefined);
}

export async function retry(id: string): Promise<void> {
  await updateJob(id, (j) =>
    j.status === 'failed' || j.status === 'cancelled'
      ? { ...j, status: 'queued', error: undefined }
      : undefined,
  );
  await kick();
}

export async function remove(id: string): Promise<void> {
  const job = await getJob(id);
  if (job && isActive(job)) await cancel(id);
  await deleteJob(id);
  await removeStored(id).catch(() => undefined);
}

/** Every finished job off the list and out of the history; a failed download's files with it. */
export async function clear(): Promise<void> {
  for (const job of await listJobs()) if (!isActive(job)) await remove(job.id);
}

/**
 * The history as the settings want it: off — the finished jobs go as the browser starts (the
 * popup still shows the session's); on — the oldest past its length go.
 */
export async function trimHistory(starting = false): Promise<void> {
  const settings = await getSettings();
  const all = await listJobs();
  const gone = !settings.history && starting ? all.filter((j) => !isActive(j)) : pastHistory(all);
  for (const job of gone) await remove(job.id);
}

async function translate(): Promise<Translate> {
  return loadTranslate(await currentLang());
}

/** Notifications carry the job's id; a click on one that finished opens the video. */
async function note(id: string, title: string, message: string): Promise<void> {
  await chrome.notifications
    .create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message,
      priority: 0,
    })
    .catch(() => undefined);
}

/**
 * The offscreen document reports a job: a finished or failed one becomes a notification — but a
 * finished download, which the browser's own Downloads shows.
 */
export async function reported(job: Job): Promise<void> {
  if (job.status !== 'done' && job.status !== 'failed') return;
  // The token was revoked (Settings → Security on tapeshelf): the popup offers to connect again.
  if (job.error?.code === 'appTokenInvalid') await setAccount(null);
  await trimHistory();
  const t = await translate();
  const title = job.request.meta.title;
  const disk = targetOf(job) === 'disk';
  await chrome.notifications.clear(job.id).catch(() => undefined);
  if (job.status === 'done') {
    if (!disk && job.video) await note(job.id, t('notify.saved'), title);
  } else
    await note(
      job.id,
      t(disk ? 'notify.downloadFailed' : 'notify.failed'),
      `${title}\n${job.error?.message ?? ''}`.trim(),
    );
}

export function listenForNotificationClicks(): void {
  chrome.notifications.onClicked.addListener((id) => {
    void (async () => {
      const job = await getJob(id);
      if (job?.status === 'done' && job.video)
        await chrome.tabs.create({ url: `${job.server}/${job.video.code}` });
      await chrome.notifications.clear(id);
    })();
  });
}

/**
 * A finished file (a blob URL of the offscreen document) handed to Downloads. Asked again after a
 * restart, a download that finished meanwhile is told as done; one cut off starts again.
 */
export async function deliver(id: string, url: string, filename: string): Promise<DeliverAnswer> {
  const job = await getJob(id);
  if (!job || job.status !== 'running') return { error: 'cancelled' };
  const known = job.disk?.downloadId;
  if (known !== undefined) {
    const [item] = await chrome.downloads.search({ id: known });
    if (item?.state === 'complete' && item.exists)
      return { done: { path: item.filename, size: item.fileSize } };
    if (item?.state === 'in_progress') await chrome.downloads.cancel(known).catch(() => undefined);
  }
  const options = { url, conflictAction: 'uniquify' as const, saveAs: false };
  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({ ...options, filename });
  } catch {
    // A name the system refused after all: the plain one in the same folder.
    const ext = /\.[a-z0-9]+$/i.exec(filename)?.[0] ?? '.mp4';
    const folder = filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/') + 1) : '';
    try {
      downloadId = await chrome.downloads.download({
        ...options,
        filename: `${folder}video${ext}`,
      });
    } catch (err) {
      return { error: String(err) };
    }
  }
  delivering.set(downloadId, id);
  await updateJob(id, (j) => ({ ...j, disk: j.disk && { ...j.disk, downloadId } }));
  return { downloadId };
}

/** Downloads started for jobs, by their id: the browser's events name only the download. */
const delivering = new Map<number, string>();

async function jobOfDownload(downloadId: number): Promise<Job | undefined> {
  const id = delivering.get(downloadId);
  if (id) return getJob(id);
  return (await listJobs()).find((j) => j.disk?.downloadId === downloadId);
}

/** A download finished or stopped: the offscreen document is told, which finishes the job. */
export function listenForDownloads(): void {
  chrome.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    void (async () => {
      const job = await jobOfDownload(delta.id);
      if (!job) return;
      delivering.delete(delta.id);
      if (state === 'complete') {
        const [item] = await chrome.downloads.search({ id: delta.id });
        await toOffscreen({
          target: 'offscreen',
          type: 'delivered',
          id: job.id,
          path: item?.filename ?? '',
          size: item?.fileSize ?? 0,
        });
      } else
        await toOffscreen({
          target: 'offscreen',
          type: 'delivered',
          id: job.id,
          error: delta.error?.current ?? 'interrupted',
        });
    })();
  });
}

/**
 * A small file beside a download (subtitles) into Downloads; answered with its path once
 * saved, or an empty path when the browser did not save it within a minute.
 */
export async function deliverFile(url: string, filename: string): Promise<string> {
  const id = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  for (let waited = 0; waited < 60_000; waited += 250) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete') return item.filename;
    if (item?.state === 'interrupted') return '';
    await new Promise((r) => setTimeout(r, 250));
  }
  return '';
}
