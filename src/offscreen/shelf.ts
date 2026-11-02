import { api, type ExtensionContext, type SavedVideo, type UploadSession } from '../shared/api';
import { getJob, type DonePart, type Job, type TrackPlan, type UploadState } from '../shared/jobs';
import { MAX_UPLOAD_BYTES, roomFor, streamBound } from '../shared/quality';
import type { Account } from '../shared/settings';
import { freshLinks, net, report, save, sameFiles, trackWeights, useHeadersFor } from './common';
import { readTrack } from './download';
import { SaveError, makePlan, planUrls } from './plan';
import { Overflow, PartWriter } from './upload';

/**
 * A video to the person's shelf: plan the download within the room on the shelf, start
 * (or resume) the upload, download and upload part by part, finish.
 */
/** Each try a stream outgrew its declared size, the next declares twice as much (up to the room). */
const MAX_FACTOR = 8;

export async function saveVideo(
  id: string,
  account: Account,
  lang: string,
  signal: AbortSignal,
): Promise<{ id: string; code: string }> {
  const call = <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
    api<T>(account, method, path, body, lang, signal);
  const context = await call<ExtensionContext>('GET', '/extension/context');
  const room = roomFor(context.limits);
  const before = (await getJob(id))!.plan;
  let job = await freshLinks(id);
  if (!job.plan) {
    const first = [job.request.media.url, job.request.media.audio?.url].filter(
      (u): u is string => !!u,
    );
    await useHeadersFor(job, first);
    const plan = await makePlan(job.request, room, net);
    job = (await save(id, () => ({ plan })))!;
    // Fresh links to another file than the half-uploaded one: that upload is dropped.
    if (job.upload && before && !sameFiles(before, plan)) {
      await call('DELETE', `/uploads/${job.upload.id}`).catch(() => undefined);
      job = (await save(id, () => ({ upload: undefined })))!;
    }
  }
  const plan = job.plan!;
  await useHeadersFor(job, planUrls(plan));

  for (;;) {
    const upload = await openUpload(job, call, room);
    job = (await save(id, () => ({ upload })))!;
    try {
      const weights = trackWeights(plan.video, plan.audio);
      await uploadTrack(id, 'video', plan.video, upload, call, signal, (p) => p * weights[0]);
      if (plan.audio)
        await uploadTrack(
          id,
          'audio',
          plan.audio,
          upload,
          call,
          signal,
          (p) => weights[0] + p * weights[1],
        );
      break;
    } catch (err) {
      if (!(err instanceof Overflow)) throw err;
      // Bigger than declared: start this upload again, declaring more — unless it was the room.
      const factor = (job.boundFactor ?? 1) * 2;
      await call('DELETE', `/uploads/${upload.id}`).catch(() => undefined);
      if (factor > MAX_FACTOR || !upload.roomy) throw new SaveError('tooBig');
      job = (await save(id, () => ({ upload: undefined, boundFactor: factor })))!;
    }
  }

  const done = (await getJob(id))!;
  const up = done.upload!;
  const meta = done.request.meta;
  const known = context.categories.some((c) => c.id === meta.categoryId);
  const parts = (state: { parts: DonePart[] }) =>
    state.parts.map(({ partNumber, etag }) => ({ partNumber, etag }));
  const video = await call<SavedVideo>('POST', `/uploads/${up.id}/complete`, {
    title: meta.title,
    description: meta.description,
    visibility: meta.visibility,
    sensitive: meta.sensitive,
    categoryId: known ? meta.categoryId : undefined,
    parts: parts(up.video),
    audioParts: up.audio ? parts(up.audio) : undefined,
    sourceUrl: done.request.sourceUrl,
  });
  return { id: video.id, code: video.code };
}

/** The video's title as a file name: no path or reserved characters, no control codes. */
function fileName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|]|\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 200) || 'video';
}

/**
 * The upload this job goes to: its own, when the server still has it (a resume), with the parts
 * both sides agree on; a new one otherwise.
 */
async function openUpload(
  job: Job,
  call: <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<T>,
  room: number,
): Promise<UploadState> {
  const plan = job.plan!;
  if (job.upload) {
    const session = await call<UploadSession>('GET', `/uploads/${job.upload.id}`).catch(() => null);
    if (session?.status === 'ACTIVE') {
      const agreed = (mine: DonePart[], theirs: { partNumber: number; etag: string }[]) => {
        const out: DonePart[] = [];
        for (const p of mine) {
          const there = theirs.find((s) => s.partNumber === p.partNumber);
          if (!there || there.etag.replace(/"/g, '') !== p.etag.replace(/"/g, '')) break;
          out.push(p);
        }
        return out;
      };
      return {
        ...job.upload,
        video: { parts: agreed(job.upload.video.parts, session.uploadedParts) },
        audio: job.upload.audio
          ? { parts: agreed(job.upload.audio.parts, session.audio?.uploadedParts ?? []) }
          : undefined,
      };
    }
  }
  const factor = job.boundFactor ?? 1;
  const exact = plan.video.size !== undefined && (!plan.audio || plan.audio.size !== undefined);
  // Two tracks share the room: each declares its estimate's share of it.
  const share = (t: TrackPlan) => {
    if (room < 0 || !plan.audio) return room;
    const weights = trackWeights(plan.video, plan.audio);
    return Math.floor(room * (t === plan.video ? weights[0] : weights[1]));
  };
  const declared = (t: TrackPlan) => t.size ?? streamBound(t.estimate, share(t), factor);
  // Declared all the room there is: a stream outgrowing it does not fit, whatever the next try.
  const full = (t: TrackPlan) =>
    t.size === undefined && share(t) >= 0 && declared(t) >= Math.min(share(t), MAX_UPLOAD_BYTES);
  const name = fileName(job.request.meta.title);
  const session = await call<UploadSession>('POST', '/uploads', {
    filename: `${name}.${plan.video.ext}`,
    size: declared(plan.video),
    mimeType: plan.video.mimeType,
    audio: plan.audio
      ? {
          filename: `${name}.${plan.audio.ext}`,
          size: declared(plan.audio),
          mimeType: plan.audio.mimeType,
        }
      : undefined,
    sizeIsMax: exact ? undefined : true,
  });
  return {
    id: session.id,
    partSize: session.partSize,
    sizeIsMax: !exact,
    roomy: !full(plan.video) && (!plan.audio || !full(plan.audio)),
    video: { parts: [] },
    audio: plan.audio ? { parts: [] } : undefined,
  };
}

async function uploadTrack(
  id: string,
  track: 'video' | 'audio',
  plan: TrackPlan,
  upload: UploadState,
  call: <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<T>,
  signal: AbortSignal,
  overall: (fraction: number) => number,
): Promise<void> {
  const done = upload[track]!.parts;
  const last = done[done.length - 1];
  const uploaded = done.reduce((n, p) => n + p.size, 0);
  const declared = await declaredSize(upload, track, call);
  const urls = new Map<number, { url: string; until: number }>();
  const presign = async (partNumber: number, fresh: boolean) => {
    const known = urls.get(partNumber);
    if (known && !fresh && known.until > Date.now()) return known.url;
    const numbers = Array.from({ length: 10 }, (_, i) => partNumber + i);
    const res = await call<{ parts: { partNumber: number; url: string }[]; expiresAt: string }>(
      'POST',
      `/uploads/${upload.id}/parts`,
      { partNumbers: numbers.filter((n) => n <= Math.ceil(declared / upload.partSize)), track },
    );
    const until = new Date(res.expiresAt).getTime() - 60_000;
    for (const p of res.parts) urls.set(p.partNumber, { url: p.url, until });
    return urls.get(partNumber)!.url;
  };
  const total = plan.size ?? plan.estimate;
  const segments = plan.segments?.length ?? 0;
  let reported = 0;
  const progress = async (writer: PartWriter, segment: number, force = false) => {
    if (!force && Date.now() - reported < 700) return;
    reported = Date.now();
    const fraction = segments
      ? segment / segments
      : total
        ? Math.min(writer.bytes / total, 0.99)
        : 0;
    await report(
      await save(id, () => ({
        progress: Math.min(overall(fraction), 0.99),
        bytes: { done: writer.bytes, total },
      })),
    );
  };
  const writer: PartWriter = new PartWriter({
    partSize: upload.partSize,
    firstPart: done.length + 1,
    uploaded,
    limit: declared,
    presign,
    signal,
    onPart: async (part) => {
      const saved = await save(id, (j) => ({
        upload: j.upload && {
          ...j.upload,
          [track]: { parts: [...(j.upload[track]?.parts ?? []), part] },
        },
      }));
      if (!saved) throw new DOMException('cancelled', 'AbortError');
      await progress(writer, part.cursor.segment, true);
    },
  });
  for await (const piece of readTrack(plan, last?.cursor ?? { segment: 0, offset: 0 }, signal)) {
    await writer.write(piece.bytes, piece.at);
    await progress(writer, piece.at.segment);
  }
  await writer.finish();
  if (!writer.bytes) throw new SaveError('empty');
}

/** What the session declared for a track: the most its file may be. */
async function declaredSize(
  upload: UploadState,
  track: 'video' | 'audio',
  call: <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<T>,
): Promise<number> {
  const session = await call<UploadSession>('GET', `/uploads/${upload.id}`);
  return track === 'video' ? session.size : (session.audio?.size ?? 0);
}
