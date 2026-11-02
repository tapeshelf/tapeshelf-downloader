import { parseDash, type DashTrack } from '../shared/dash';
import { parseHls, type ByteRange, type HlsMaster, type HlsMedia } from '../shared/hls';
import type { DownloadPlan, TrackPlan } from '../shared/jobs';
import type { Quality, SaveRequest } from '../shared/media';
import { estimateBytes, pickQuality } from '../shared/quality';
import {
  dashAudio,
  dashQualities,
  hlsQualities,
  inLanguage,
  qualityLabel,
} from '../shared/streams';

/**
 * What exactly to download for a video the person asked to save: the file, or for a
 * stream the quality that fits (the one chosen in the form, else the preferred one within the
 * room on the shelf) as segments in order, and its separate audio when it has one.
 */
export class SaveError extends Error {
  constructor(
    readonly code:
      | 'drm'
      | 'live'
      | 'source'
      | 'tooBig'
      | 'empty'
      | 'noVideo'
      | 'disk'
      | 'format'
      | 'noAudio'
      | 'deliver'
      | 'captureNothing'
      | 'pageGone',
    readonly status?: number,
    /** What went wrong underneath (the browser's reason a download stopped). */
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface Net {
  text(url: string): Promise<string>;
  /** Bytes of a URL from its headers, when it says. */
  size(url: string): Promise<number | undefined>;
}

export const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  ts: 'video/mp2t',
};

/** The types of what a download may end as: video, sound alone, subtitles. */
export const SAVED_MIME: Record<string, string> = {
  ...MIME,
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  mka: 'audio/x-matroska',
  srt: 'application/x-subrip',
};

/** A file's extension from its address or its type; mp4 when neither says. */
export function fileExt(url: string, mimeType?: string): string {
  const fromPath = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (fromPath && MIME[fromPath]) return fromPath;
  const fromType = Object.entries(MIME).find(([, m]) => m === mimeType)?.[0];
  return fromType ?? 'mp4';
}

const rangeOf = (r: ByteRange | undefined) =>
  r ? `${r.offset}-${r.offset + r.length - 1}` : undefined;

const hex = (bytes: Uint8Array | null) =>
  bytes ? [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') : null;

/** Audio of HLS without its own bit rate: 160 kbit/s is plenty for an estimate. */
const AUDIO_BANDWIDTH = 160_000;

function hlsTrack(
  media: HlsMedia,
  kind: 'video' | 'audio',
  estimate?: number,
  skipAds = false,
): TrackPlan {
  if (media.drm) throw new SaveError('drm');
  if (media.live) throw new SaveError('live');
  if (!media.segments.length) throw new SaveError('empty');
  const segments: NonNullable<TrackPlan['segments']> = [];
  let init: string | undefined;
  // Ad breaks left out — unless that would leave nothing: then the marks were wrong.
  const content = media.segments.filter((s) => !skipAds || !s.ad);
  for (const s of content.length ? content : media.segments) {
    // The init section goes first, and again where a stream switches to another one.
    if (s.init && `${s.init.url} ${rangeOf(s.init.range)}` !== init) {
      init = `${s.init.url} ${rangeOf(s.init.range)}`;
      segments.push({ url: s.init.url, range: rangeOf(s.init.range) });
    }
    segments.push({
      url: s.url,
      range: rangeOf(s.range),
      key: s.key ? { url: s.key.url, iv: hex(s.key.iv), sequence: s.sequence } : undefined,
      duration: s.duration,
    });
  }
  const aac = /\.aac$/i.test(new URL(media.segments[0]!.url).pathname);
  const [ext, mimeType] =
    kind === 'video'
      ? media.fmp4
        ? ['mp4', 'video/mp4']
        : ['ts', 'video/mp2t']
      : media.fmp4
        ? ['m4a', 'audio/mp4']
        : aac
          ? ['aac', 'audio/aac']
          : ['ts', 'audio/mp2t'];
  return { ext, mimeType, estimate, segments };
}

function choose(qualities: Quality[], req: SaveRequest, room: number): Quality | undefined {
  return qualities.find((q) => q.key === req.quality) ?? pickQuality(qualities, req.pref, room);
}

async function hlsPlan(req: SaveRequest, room: number, net: Net): Promise<DownloadPlan> {
  const url = req.media.url;
  const top = parseHls(await net.text(url), url);
  if (top.type === 'media') {
    // No bit rate without a master: the first segment's size, scaled to the whole length.
    const first = top.segments.find((s) => !s.init || s.url !== s.init.url);
    const bytes =
      first && !first.range ? await net.size(first.url).catch(() => undefined) : undefined;
    const estimate =
      bytes && first?.duration ? Math.ceil((bytes / first.duration) * top.duration) : undefined;
    return { video: hlsTrack(top, 'video', estimate, req.skipAds) };
  }
  return masterPlan(top, req, room, net);
}

async function masterPlan(
  master: HlsMaster,
  req: SaveRequest,
  room: number,
  net: Net,
): Promise<DownloadPlan> {
  if (!master.variants.length) throw new SaveError('noVideo');
  // Any variant tells the length; the best one is the likeliest to be saved.
  const probeUrl = hlsQualities(master, undefined)[0]!.key;
  const probe = parseHls(await net.text(probeUrl), probeUrl) as HlsMedia;
  const chosen = choose(hlsQualities(master, probe.duration), req, room)!;
  const variant = master.variants.find((v) => v.url === chosen.key)!;
  const media =
    variant.url === probeUrl
      ? probe
      : (parseHls(await net.text(variant.url), variant.url) as HlsMedia);
  const renditions = master.audio.filter((a) => a.group === variant.audio && a.url);
  const rendition = inLanguage(renditions, req.audioLanguage, (a) => a.isDefault);
  let audio: TrackPlan | undefined;
  if (rendition?.url) {
    const audioMedia = parseHls(await net.text(rendition.url), rendition.url) as HlsMedia;
    audio = hlsTrack(
      audioMedia,
      'audio',
      estimateBytes(AUDIO_BANDWIDTH, audioMedia.duration),
      req.skipAds,
    );
  }
  return {
    video: hlsTrack(media, 'video', chosen.estimate, req.skipAds),
    audio,
    quality: qualityLabel(chosen),
  };
}

function dashTrack(track: DashTrack, seconds: number): TrackPlan {
  const webm = track.mimeType.endsWith('webm');
  const ext = track.kind === 'video' ? (webm ? 'webm' : 'mp4') : webm ? 'webm' : 'm4a';
  const estimate = seconds ? estimateBytes(track.bandwidth, seconds) : undefined;
  const mimeType = track.mimeType;
  if (!track.segments.length) return { ext, mimeType, estimate, url: track.init?.url };
  return {
    ext,
    mimeType,
    estimate,
    segments: [...(track.init ? [track.init] : []), ...track.segments],
  };
}

async function dashPlan(req: SaveRequest, room: number, net: Net): Promise<DownloadPlan> {
  const m = parseDash(await net.text(req.media.url), req.media.url);
  if (m.live) throw new SaveError('live');
  if (m.drm) throw new SaveError('drm');
  const chosen = choose(dashQualities(m), req, room);
  const video = m.video.find((v) => v.id === chosen?.key);
  if (!video || !chosen) throw new SaveError('noVideo');
  const audio = dashAudio(m, req.audioLanguage);
  return {
    video: dashTrack(video, m.duration),
    audio: audio ? dashTrack(audio, m.duration) : undefined,
    quality: qualityLabel(chosen),
  };
}

/**
 * A site's video given as a file per quality: the one chosen in the form, else the best one not
 * above the preferred height whose size (asked of the server) fits the room; none fits — the
 * smallest, and the upload says why.
 */
async function qualityPlan(req: SaveRequest, room: number, net: Net): Promise<DownloadPlan> {
  const options = req.media.qualities!;
  const chosen = options.find((q) => q.key === req.quality);
  const pref = req.pref;
  const below = pref === 'best' ? options : options.filter((q) => (q.height ?? 0) <= pref);
  const candidates = chosen ? [chosen] : below.length ? below : options.slice(-1);
  // Sound apart (Bilibili): its own file, muxed by the worker; it takes its share of the room.
  const chunk = req.media.download?.chunk;
  const sound = req.media.audio;
  const audioSize = sound ? (sound.size ?? (await net.size(sound.url))) : undefined;
  const webmSound = sound?.mimeType === 'audio/webm';
  const audio: TrackPlan | undefined = sound
    ? {
        url: sound.url,
        ext: webmSound ? 'webm' : 'm4a',
        mimeType: webmSound ? 'audio/webm' : 'audio/mp4',
        size: audioSize,
        chunk,
      }
    : undefined;
  const plan = (q: Quality, size: number | undefined): DownloadPlan => {
    // A site's DASH pieces (.m4s) are MP4 files, unless the site says WebM.
    const webm = q.mimeType === 'video/webm';
    const ext = webm ? 'webm' : audio ? 'mp4' : fileExt(q.key, req.media.mimeType);
    return {
      video: {
        url: q.key,
        ext,
        mimeType: webm ? 'video/webm' : audio ? 'video/mp4' : (req.media.mimeType ?? MIME[ext]!),
        size,
        chunk,
      },
      audio,
      quality: qualityLabel(q),
    };
  };
  const left = room - (audioSize ?? 0);
  const sizeOf = async (q: Quality) => q.size ?? (await net.size(q.key));
  for (const q of candidates) {
    const size = await sizeOf(q);
    const bytes = size ?? q.estimate;
    if (chosen || room < 0 || bytes === undefined || bytes <= left) return plan(q, size);
  }
  const smallest = candidates[candidates.length - 1]!;
  return plan(smallest, await sizeOf(smallest));
}

/**
 * The sound alone: its own file when the video has one (a site's sound apart, a DASH audio
 * track, an HLS audio rendition — in the language wanted); else the smallest picture with it,
 * whose sound is taken out after.
 */
async function audioPlan(req: SaveRequest, net: Net): Promise<DownloadPlan> {
  const { kind, url, mimeType } = req.media;
  const sound = req.media.audio;
  if (sound) {
    const webm = sound.mimeType === 'audio/webm';
    return {
      video: {
        url: sound.url,
        ext: webm ? 'webm' : 'm4a',
        mimeType: webm ? 'audio/webm' : 'audio/mp4',
        size: sound.size ?? (await net.size(sound.url)),
        chunk: req.media.download?.chunk,
      },
      audioOnly: true,
    };
  }
  if (kind === 'dash') {
    const m = parseDash(await net.text(url), url);
    if (m.live) throw new SaveError('live');
    const track = dashAudio(m, req.audioLanguage);
    if (track) return { video: dashTrack(track, m.duration), audioOnly: true };
    // No track of its own: the smallest video, its sound taken out.
    const smallest = dashQualities(m).at(-1);
    return {
      ...(await dashPlan({ ...req, quality: smallest?.key }, -1, net)),
      audioOnly: true,
      quality: undefined,
    };
  }
  if (kind === 'hls') {
    const top = parseHls(await net.text(url), url);
    if (top.type === 'master') {
      const renditions = top.audio.filter((a) => a.url);
      const rendition = inLanguage(renditions, req.audioLanguage, (a) => a.isDefault);
      if (rendition?.url) {
        const media = parseHls(await net.text(rendition.url), rendition.url) as HlsMedia;
        return { video: hlsTrack(media, 'audio', undefined, req.skipAds), audioOnly: true };
      }
      const smallest = hlsQualities(top, undefined).at(-1);
      return {
        ...(await masterPlan(top, { ...req, quality: smallest?.key }, -1, net)),
        audioOnly: true,
        quality: undefined,
      };
    }
    return { video: hlsTrack(top, 'video', undefined, req.skipAds), audioOnly: true };
  }
  if (req.media.qualities?.length) {
    const smallest = req.media.qualities.at(-1)!;
    return {
      ...(await qualityPlan({ ...req, quality: smallest.key }, -1, net)),
      audioOnly: true,
      quality: undefined,
    };
  }
  const ext = fileExt(url, mimeType);
  return {
    video: {
      url,
      ext,
      mimeType: mimeType ?? MIME[ext]!,
      size: req.media.size ?? (req.media.download?.tab ? undefined : await net.size(url)),
      ...throughTab(req),
    },
    audioOnly: true,
  };
}

/** A file only its page can read: the tab, and ranges small enough to pass through it. */
const throughTab = (req: SaveRequest): Pick<TrackPlan, 'tab' | 'chunk'> =>
  req.media.download?.tab === undefined ? {} : { tab: req.media.download.tab, chunk: 2 << 20 };

export async function makePlan(req: SaveRequest, room: number, net: Net): Promise<DownloadPlan> {
  if (req.format === 'audio' || req.format === 'mp3') return audioPlan(req, net);
  const { kind, url, size, mimeType } = req.media;
  if (kind === 'hls') return hlsPlan(req, room, net);
  if (kind === 'dash') return dashPlan(req, room, net);
  if (req.media.qualities?.length) return qualityPlan(req, room, net);
  const ext = fileExt(url, mimeType);
  return {
    video: {
      url,
      ext,
      mimeType: mimeType ?? MIME[ext]!,
      size: size ?? (req.media.download?.tab ? undefined : await net.size(url)),
      ...throughTab(req),
    },
  };
}

/** Every address a plan downloads from: their hosts get the page's Referer. */
export function planUrls(plan: DownloadPlan): string[] {
  const of = (t: TrackPlan | undefined) =>
    t ? [t.url, ...(t.segments ?? []).flatMap((s) => [s.url, s.key?.url])] : [];
  return [...new Set([...of(plan.video), ...of(plan.audio)].filter((u): u is string => !!u))];
}
