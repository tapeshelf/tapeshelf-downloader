import { getJob, updateJob, type DownloadPlan, type Job, type TrackPlan } from '../shared/jobs';
import { send } from '../shared/messages';
import { sameQuality } from '../shared/quality';
import { fileSize } from '../shared/size';
import { refreshed } from '../sites';
import { SaveError, type Net } from './plan';

/** What both ways of saving share: the site's files, fresh links, the job's progress. */
export const net: Net = {
  async text(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new SaveError('source', res.status);
    return res.text();
  },
  size: (url) => fileSize(url),
};

export async function report(job: Job | undefined): Promise<void> {
  if (job) await send({ type: 'job', job }).catch(() => undefined);
}

/** A change to a job that was not cancelled meanwhile; undefined when it was (or is gone). */
export async function save(
  id: string,
  change: (job: Job) => Partial<Job>,
): Promise<Job | undefined> {
  return updateJob(id, (j) => (j.status === 'cancelled' ? undefined : { ...j, ...change(j) }));
}

/** The job as saved; throws the cancel when it was cancelled meanwhile. */
export async function saved(id: string, change: (job: Job) => Partial<Job>): Promise<Job> {
  const job = await save(id, change);
  if (!job) throw new DOMException('cancelled', 'AbortError');
  return job;
}

/** The site's own refusal of its link: worth asking the site for a new one. */
export function refusedByTheSite(err: unknown): boolean {
  return (
    err instanceof SaveError &&
    err.code === 'source' &&
    [401, 403, 404, 410].includes(err.status ?? 0)
  );
}

/**
 * A site's video asked of its site again as its turn comes: its links (signed, with an expiry)
 * may have run out while it waited. The same quality is kept; the plan is made anew.
 */
export async function freshLinks(id: string): Promise<Job> {
  const job = (await getJob(id))!;
  const media = job.request.media;
  if (!media.site) return job;
  const fresh = await refreshed(media, (urls, referer, userAgent) =>
    send({ type: 'headers', urls, referer, userAgent }),
  ).catch(() => undefined);
  if (!fresh) return job;
  const request = {
    ...job.request,
    quality: sameQuality(media.qualities, job.request.quality, fresh.qualities),
    media: {
      ...media,
      url: fresh.url,
      qualities: fresh.qualities,
      audio: fresh.audio,
      download: fresh.download,
    },
  };
  return saved(id, () => ({ request, plan: undefined }));
}

/** Two plans download the same files: the same sizes (or segments). */
export function sameFiles(a: DownloadPlan, b: DownloadPlan): boolean {
  const same = (x?: TrackPlan, y?: TrackPlan) =>
    (!x && !y) ||
    (!!x && !!y && x.size === y.size && (x.segments?.length ?? 0) === (y.segments?.length ?? 0));
  return same(a.video, b.video) && same(a.audio, b.audio);
}

/** How much of the progress bar each track takes: by size, video first. */
export function trackWeights(video: TrackPlan, audio?: TrackPlan): [number, number] {
  if (!audio) return [1, 0];
  const v = video.size ?? video.estimate ?? 9;
  const a = audio.size ?? audio.estimate ?? 1;
  return [v / (v + a), a / (v + a)];
}

/** Every address of a plan gets the page's Referer (and the site's User-Agent). */
export async function useHeadersFor(job: Job, urls: string[]): Promise<void> {
  const media = job.request.media;
  await send({
    type: 'headers',
    urls,
    referer: media.referer ?? media.pageUrl,
    userAgent: media.download?.userAgent,
  });
}
