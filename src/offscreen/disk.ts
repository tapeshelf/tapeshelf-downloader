import { downloadPath, safeFolder } from '../shared/filename';
import { getJob, type Cursor, type Job, type TrackPlan } from '../shared/jobs';
import { send, type DeliverAnswer, type Delivered } from '../shared/messages';
import {
  freshLinks,
  net,
  report,
  save,
  saved,
  sameFiles,
  trackWeights,
  useHeadersFor,
} from './common';
import { readTrack } from './download';
import { extractAudio, join, needsJoin } from './join';
import { captureRecording } from './capture';
import { recordLive } from './live';
import { SAVED_MIME, SaveError, makePlan, planUrls } from './plan';
import { removeStored } from '../shared/storage';
import { subtitlesAsSrt } from '../shared/subtitles';
import { StagedFile, roomLeft, storedFile, storedHandle } from './stage';

/**
 * A video to the computer: each track downloaded into the
 * extension's own storage — flushed every 16 MB, the place noted on the job, so a stopped browser
 * goes on from there — then joined into one file that plays, and handed to Downloads.
 */
const PART = 16 * 1024 * 1024;
/** Of the progress bar: downloading, then joining. */
const DOWNLOAD_SHARE = 0.9;

export async function saveToDisk(id: string, signal: AbortSignal): Promise<void> {
  let before = (await getJob(id))!;
  // A live stream, or what a tab plays, is recorded first; it goes on to the join with
  // what it got.
  if ((before.request.live || before.request.capture) && before.disk?.phase === 'download') {
    await (before.request.live ? recordLive(id, signal) : captureRecording(id, signal));
    before = (await getJob(id))!;
  }
  let job = before.disk?.phase === 'download' ? await freshLinks(id) : before;
  if (!job.plan) {
    const media = job.request.media;
    await useHeadersFor(job, [media.url, ...(media.audio ? [media.audio.url] : [])]);
    const plan = await makePlan(job.request, -1, net);
    // Fresh links to other files than the half-downloaded ones: the download starts again.
    const keep = !!before.plan && sameFiles(before.plan, plan);
    if (!keep) await removeStored(id);
    job = await saved(id, (j) => ({
      plan,
      disk: {
        ...j.disk!,
        phase: 'download',
        video: keep ? j.disk?.video : undefined,
        audio: keep ? j.disk?.audio : undefined,
      },
    }));
  }
  const plan = job.plan!;
  const joining = needsJoin(plan);
  const downloadShare = joining ? DOWNLOAD_SHARE : 0.99;

  if (job.disk!.phase === 'download') {
    await useHeadersFor(job, planUrls(plan));
    await checkRoom(job, joining);
    const [v, a] = trackWeights(plan.video, plan.audio);
    await stageTrack(id, 'video', plan.video, signal, (p) => p * v * downloadShare);
    if (plan.audio)
      await stageTrack(id, 'audio', plan.audio, signal, (p) => (v + p * a) * downloadShare);
    job = await saved(id, (j) => ({
      disk: {
        ...j.disk!,
        phase: joining ? 'join' : 'deliver',
        ext: joining ? undefined : plan.video.ext,
      },
    }));
  }

  if (job.disk!.phase === 'join') {
    const video = await storedFile(`${id}.video`);
    const audio = plan.audio ? await storedFile(`${id}.audio`) : undefined;
    if (!video?.size || (plan.audio && !audio?.size)) {
      // The downloaded files are gone (storage cleared): downloaded again.
      await saved(id, (j) => ({
        disk: { ...j.disk!, phase: 'download', video: undefined, audio: undefined },
      }));
      return saveToDisk(id, signal);
    }
    await report(await save(id, () => ({ progress: downloadShare })));
    let told = 0;
    const onProgress = (p: number) => {
      if (Date.now() - told < 700) return;
      told = Date.now();
      const progress = downloadShare + p * (0.99 - downloadShare);
      void save(id, () => ({ progress })).then(report);
    };
    const out = await storedHandle(`${id}.out`);
    // The sound alone is taken out (as it is, or as MP3); else picture and sound joined.
    const joined = plan.audioOnly
      ? await extractAudio(video, out, job.request.format === 'mp3', onProgress, signal)
      : await join(video, audio, out, onProgress, signal);
    job = await saved(id, (j) => ({ disk: { ...j.disk!, phase: 'deliver', ext: joined.ext } }));
  }

  // The joined file, or the one file downloaded as it is.
  const file =
    (joining ? await storedFile(`${id}.out`) : undefined) ?? (await storedFile(`${id}.video`));
  if (!file?.size) {
    await saved(id, (j) => ({
      disk: { ...j.disk!, phase: 'download', video: undefined, audio: undefined },
    }));
    return saveToDisk(id, signal);
  }
  if (joining) {
    // The tracks are in the joined file: their room goes back before Downloads copies it.
    const dir = await navigator.storage.getDirectory();
    for (const track of ['video', 'audio'])
      await dir.removeEntry(`${id}.${track}`).catch(() => undefined);
  }
  const ext = job.disk!.ext ?? plan.video.ext;
  const filename = downloadPath(job.disk!.name, plan.quality, ext);
  // A file of the storage has no type, and Chrome saves a blob with none as text: "video.txt"
  // (seen in 0.5.0). The same bytes (a slice, not a copy) with the video's type keep the name.
  const url = URL.createObjectURL(
    file.slice(0, file.size, SAVED_MIME[ext] ?? 'application/octet-stream'),
  );
  try {
    const done = await deliver(id, url, filename, signal);
    // The subtitles picked, beside the video under its name; the video stands without them.
    const subtitles = job.request.subtitles
      ? await saveSubtitles(job, done.path).catch(() => undefined)
      : undefined;
    await report(
      await save(id, (j) => ({
        status: 'done',
        progress: 1,
        disk: { ...j.disk!, path: done.path, size: done.size, subtitles },
      })),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
  await removeStored(id);
}

/**
 * The storage has room for the video (twice, when it is joined), as far as the browser tells:
 * otherwise it stops now, not at 90%.
 */
async function checkRoom(job: Job, joining: boolean): Promise<void> {
  const plan = job.plan!;
  const bytes = (t?: TrackPlan) => (t ? (t.size ?? t.estimate ?? 0) : 0);
  const have = (job.disk?.video?.bytes ?? 0) + (job.disk?.audio?.bytes ?? 0);
  const need = (bytes(plan.video) + bytes(plan.audio)) * (joining ? 2 : 1) - have;
  const room = await roomLeft().catch(() => undefined);
  if (room !== undefined && need > room) throw new SaveError('disk');
}

/** Where a source stands after a piece: a segment is read whole, so the next one is next. */
const after = (track: TrackPlan, at: Cursor, length: number): Cursor =>
  track.segments?.length
    ? { segment: at.segment + 1, offset: 0 }
    : { segment: 0, offset: at.offset + length };

async function stageTrack(
  id: string,
  track: 'video' | 'audio',
  plan: TrackPlan,
  signal: AbortSignal,
  overall: (fraction: number) => number,
): Promise<void> {
  const was = (await getJob(id))!.disk?.[track];
  // Downloaded whole before the browser stopped (the next track was under way): nothing to read.
  if (was?.complete && (await storedFile(`${id}.${track}`))?.size === was.bytes) return;
  let { file, size } = await StagedFile.open(`${id}.${track}`, was?.bytes ?? 0);
  if (size !== (was?.bytes ?? 0)) {
    // The file holds less than was noted: this track starts again.
    file.drop();
    ({ file, size } = await StagedFile.open(`${id}.${track}`, 0));
  }
  const resumed = was && size === was.bytes;
  let cursor: Cursor = resumed ? was.cursor : { segment: 0, offset: 0 };
  let written = resumed ? was.bytes : 0;
  let flushed = written;
  const total = plan.size ?? plan.estimate;
  const segments = plan.segments?.length ?? 0;
  let reported = 0;
  let flushedCursor = cursor;
  const fraction = () =>
    segments ? cursor.segment / segments : total ? Math.min(written / total, 0.99) : 0;
  const note = async (force: boolean, complete = false) => {
    if (!force && Date.now() - reported < 700) return;
    reported = Date.now();
    const staged = { bytes: flushed, cursor: flushedCursor, complete };
    await report(
      await saved(id, (j) => ({
        disk: force ? { ...j.disk!, [track]: staged } : j.disk,
        progress: Math.min(overall(fraction()), 0.99),
        bytes: { done: written, total },
      })),
    );
  };
  try {
    for await (const piece of readTrack(plan, cursor, signal)) {
      file.write(piece.bytes);
      written += piece.bytes.length;
      cursor = after(plan, piece.at, piece.bytes.length);
      if (written - flushed >= PART) {
        flushed = await file.flush();
        flushedCursor = cursor;
        await note(true);
      } else await note(false);
    }
    flushed = await file.close();
    flushedCursor = cursor;
  } catch (err) {
    file.drop();
    throw err;
  }
  if (!written) throw new SaveError('empty');
  await note(true, true);
}

/** Deliveries waiting for the service worker to say the file is in Downloads. */
const waiting = new Map<string, { resolve: (d: Delivered) => void; reject: (e: Error) => void }>();

export function delivered(id: string, answer: Delivered | { error: string }): void {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  if ('error' in answer) w.reject(new SaveError('deliver', undefined, answer.error));
  else w.resolve(answer);
}

/** The file handed to Downloads (by the service worker: it has the downloads API) and saved there. */
function deliver(
  id: string,
  url: string,
  filename: string,
  signal: AbortSignal,
): Promise<Delivered> {
  return new Promise<Delivered>((resolve, reject) => {
    // Waiting before asking: a small file may be in Downloads before the answer comes.
    waiting.set(id, { resolve, reject });
    signal.addEventListener('abort', () => (waiting.delete(id), reject(signal.reason as Error)), {
      once: true,
    });
    send<DeliverAnswer>({ type: 'deliver', id, url, filename }).then(
      (answer) => {
        if ('done' in answer) delivered(id, answer.done);
        else if ('error' in answer) delivered(id, answer);
      },
      (err: unknown) => delivered(id, { error: String(err) }),
    );
  });
}

/** The picked subtitles as .srt beside the video, named as the video turned out. */
async function saveSubtitles(job: Job, videoPath: string): Promise<string | undefined> {
  const track = job.request.subtitles!;
  await useHeadersFor(job, [track.url]);
  const srt = await subtitlesAsSrt(track, (u) => net.text(u));
  if (!srt.trim()) return undefined;
  const base = videoPath
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '');
  const folder = safeFolder(job.disk!.name.folder);
  const url = URL.createObjectURL(new Blob([srt], { type: SAVED_MIME['srt'] }));
  try {
    const path = await send<string>({
      type: 'deliverFile',
      url,
      filename: `${folder ? `${folder}/` : ''}${base}.srt`,
    });
    return path || undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}
