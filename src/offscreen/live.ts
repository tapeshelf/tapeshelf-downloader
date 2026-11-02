import { parseHls, type HlsMedia, type HlsSegment } from '../shared/hls';
import { getJob, type DownloadPlan, type TrackPlan } from '../shared/jobs';
import { pickQuality } from '../shared/quality';
import { hlsQualities, inLanguage, qualityLabel } from '../shared/streams';
import { net, report, saved, useHeadersFor } from './common';
import { segment } from './download';
import { SaveError } from './plan';
import { StagedFile } from './stage';

/**
 * A live HLS stream recorded to the computer: its playlist asked again and again, each new
 * segment written as it appears — from the start of what the stream keeps, or from now — until
 * "Stop", the end of the stream, or a long silence. Then it is joined and saved like any download.
 * A recording cut by closing the browser is saved with what it has: the stream went on meanwhile.
 */
const PART = 16 * 1024 * 1024;
/** A stream with no new segment for this long has ended without saying so. */
const SILENCE_MS = 45_000;
/** Playlists that fail this many times in a row: the stream is gone. */
const FAILURES = 4;

interface LiveTrack {
  name: 'video' | 'audio';
  url: string;
  file?: StagedFile;
  /** The last segment written (its media sequence number). */
  last: number;
  bytes: number;
  unflushed: number;
  initWritten: string | null;
  fmp4: boolean;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), {
      once: true,
    });
  });

/** The variant to record (the quality picked, else the settings') and its sound in the language wanted. */
async function chooseTracks(
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>,
): Promise<{ video: string; audio?: string; quality?: string }> {
  const req = job.request;
  const top = parseHls(await net.text(req.media.url), req.media.url);
  if (top.type === 'media') return { video: req.media.url };
  const qualities = hlsQualities(top, undefined);
  const chosen =
    qualities.find((q) => q.key === req.quality) ?? pickQuality(qualities, req.pref, -1)!;
  const variant = top.variants.find((v) => v.url === chosen.key)!;
  const renditions = top.audio.filter((a) => a.group === variant.audio && a.url);
  const rendition = inLanguage(renditions, req.audioLanguage, (a) => a.isDefault);
  return { video: variant.url, audio: rendition?.url, quality: qualityLabel(chosen) };
}

/** Writes the segments of one round: those after the last written; the first round decides where to start. */
async function writeNew(
  track: LiveTrack,
  playlist: HlsMedia,
  from: 'start' | 'now',
  skipAds: boolean,
  signal: AbortSignal,
): Promise<{ written: number; seconds: number }> {
  let segments: HlsSegment[] = playlist.segments.filter((s) => s.sequence > track.last);
  if (track.last < 0 && from === 'now') segments = segments.slice(-1);
  let written = 0;
  let seconds = 0;
  for (const s of segments) {
    if (skipAds && s.ad) {
      track.last = s.sequence;
      continue;
    }
    const init = s.init ? `${s.init.url} ${s.init.range?.offset ?? ''}` : null;
    if (init && init !== track.initWritten) {
      const bytes = await segment(
        {
          url: s.init!.url,
          range: s.init!.range
            ? `${s.init!.range.offset}-${s.init!.range.offset + s.init!.range.length - 1}`
            : undefined,
        },
        signal,
      );
      track.file!.write(bytes);
      track.bytes += bytes.length;
      track.initWritten = init;
    }
    const bytes = await segment(
      {
        url: s.url,
        range: s.range ? `${s.range.offset}-${s.range.offset + s.range.length - 1}` : undefined,
        key: s.key
          ? {
              url: s.key.url,
              iv: s.key.iv
                ? [...s.key.iv].map((b) => b.toString(16).padStart(2, '0')).join('')
                : null,
              sequence: s.sequence,
            }
          : undefined,
      },
      signal,
    );
    track.file!.write(bytes);
    track.bytes += bytes.length;
    track.unflushed += bytes.length;
    track.last = s.sequence;
    written++;
    seconds += s.duration;
  }
  if (track.unflushed >= PART) {
    await track.file!.flush();
    track.unflushed = 0;
  }
  return { written, seconds };
}

/** Records the job's live stream; returns the plan the join and the save go on with. */
export async function recordLive(id: string, signal: AbortSignal): Promise<DownloadPlan> {
  let job = (await getJob(id))!;
  const req = job.request;
  await useHeadersFor(job, [req.media.url]);
  const urls = await chooseTracks(job);
  await useHeadersFor(job, [urls.video, ...(urls.audio ? [urls.audio] : [])]);
  const fresh = (name: LiveTrack['name'], url: string): LiveTrack => ({
    name,
    url,
    last: -1,
    bytes: 0,
    unflushed: 0,
    initWritten: null,
    fmp4: false,
  });
  const tracks = [fresh('video', urls.video), ...(urls.audio ? [fresh('audio', urls.audio)] : [])];
  // Recorded before the browser stopped: saved with what it has (the stream went on meanwhile).
  const resumed = !!job.disk?.video?.bytes;
  if (!resumed) {
    for (const t of tracks) t.file = (await StagedFile.open(`${id}.${t.name}`, 0)).file;
    let recorded = 0;
    let quietSince = Date.now();
    let failures = 0;
    try {
      for (let round = 0; ; round++) {
        job = (await getJob(id))!;
        if (job.status === 'cancelled') throw new DOMException('cancelled', 'AbortError');
        if (job.stop) break;
        let ended = false;
        let newSegments = 0;
        let interval = 4000;
        for (const t of tracks) {
          let playlist: HlsMedia;
          try {
            playlist = parseHls(await net.text(t.url), t.url) as HlsMedia;
            failures = t.name === 'video' ? 0 : failures;
          } catch (err) {
            if (signal.aborted) throw err;
            if (t.name === 'video' && ++failures >= FAILURES) ended = true;
            continue;
          }
          if (playlist.drm) throw new SaveError('drm');
          t.fmp4 = playlist.fmp4;
          const done = await writeNew(t, playlist, req.live?.from ?? 'now', !!req.skipAds, signal);
          if (t.name === 'video') {
            newSegments = done.written;
            recorded += done.seconds;
            if (!playlist.live) ended = true;
            if (playlist.targetDuration)
              interval = Math.min(10_000, Math.max(1000, (playlist.targetDuration * 1000) / 2));
          }
        }
        if (newSegments) quietSince = Date.now();
        await report(
          await saved(id, (j) => ({
            recorded,
            bytes: { done: tracks.reduce((n, t) => n + t.bytes, 0) },
            disk: {
              ...j.disk!,
              video: { bytes: tracks[0]!.bytes, cursor: { segment: tracks[0]!.last, offset: 0 } },
              audio: tracks[1]
                ? { bytes: tracks[1].bytes, cursor: { segment: tracks[1].last, offset: 0 } }
                : undefined,
            },
          })),
        );
        if (ended || Date.now() - quietSince > SILENCE_MS) break;
        await wait(interval, signal);
      }
      for (const t of tracks) await t.file!.close();
    } catch (err) {
      for (const t of tracks) t.file?.drop();
      throw err;
    }
    if (!tracks[0]!.bytes) throw new SaveError('empty');
  }
  // Joined as a stream's segments are: the plan only says what the files are.
  const track = (t: LiveTrack | undefined): TrackPlan | undefined =>
    t && {
      ext: t.fmp4 ? 'mp4' : 'ts',
      mimeType: t.fmp4 ? 'video/mp4' : 'video/mp2t',
      segments: [{ url: t.url }],
    };
  const plan: DownloadPlan = {
    video: track(tracks[0])!,
    audio: track(tracks[1]),
    quality: urls.quality,
  };
  await saved(id, (j) => ({ plan, disk: { ...j.disk!, phase: 'join' } }));
  return plan;
}
