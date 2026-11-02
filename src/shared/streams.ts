import { parseDash, type DashManifest, type DashTrack } from './dash';
import { parseHls, type HlsMaster, type HlsMedia, type HlsVariant } from './hls';
import type { MediaKind, Quality, SubtitleTrack } from './media';
import { estimateBytes } from './quality';

/** What a stream offers, for the list: its length, its qualities, whether it can be saved. */
export interface StreamSummary {
  duration?: number;
  live: boolean;
  drm: boolean;
  /** Best first. */
  qualities: Quality[];
  /** HLS: the variant and audio playlists the master lists (the master stands for them). */
  variants: string[];
  subtitles: SubtitleTrack[];
}

/** Two languages are the same for a person: "pt-BR" is "pt", "EN" is "en". */
export const sameLanguage = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase().split(/[-_]/)[0] === b.toLowerCase().split(/[-_]/)[0];

/** Of several, the one in the language wanted; else the first that says it is the default. */
export function inLanguage<T extends { language?: string; lang?: string }>(
  options: T[],
  language: string | undefined,
  isDefault: (t: T) => boolean = () => false,
): T | undefined {
  return (
    options.find((o) => sameLanguage(o.language ?? o.lang, language)) ??
    options.find(isDefault) ??
    options[0]
  );
}

export type FetchText = (url: string) => Promise<string>;

/** One quality per height (the higher bit rate of two), best first. */
function distinct<T extends { height?: number; bandwidth: number }>(items: T[]): T[] {
  const sorted = [...items].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth,
  );
  return sorted.filter(
    (v, i) =>
      i === 0 ||
      (v.height ? v.height !== sorted[i - 1]!.height : v.bandwidth !== sorted[i - 1]!.bandwidth),
  );
}

export function hlsQualities(master: HlsMaster, seconds: number | undefined): Quality[] {
  return distinct(master.variants).map((v: HlsVariant) => ({
    key: v.url,
    width: v.width,
    height: v.height,
    estimate: seconds ? estimateBytes(v.averageBandwidth ?? v.bandwidth, seconds) : undefined,
  }));
}

/** The audio a DASH video is saved with: the best track in the language wanted. */
export const dashAudio = (m: DashManifest, language?: string): DashTrack | undefined =>
  inLanguage(m.audio, language);

export function dashQualities(m: DashManifest): Quality[] {
  const audio = dashAudio(m)?.bandwidth ?? 0;
  return distinct(m.video).map((v) => ({
    key: v.id,
    width: v.width,
    height: v.height,
    estimate: m.duration ? estimateBytes(v.bandwidth + audio, m.duration) : undefined,
  }));
}

export async function summarize(
  kind: Exclude<MediaKind, 'file'>,
  url: string,
  fetchText: FetchText,
): Promise<StreamSummary> {
  if (kind === 'dash') {
    const m = parseDash(await fetchText(url), url);
    return {
      duration: m.duration || undefined,
      live: m.live,
      drm: m.drm,
      qualities: dashQualities(m),
      variants: [],
      subtitles: m.text,
    };
  }
  const playlist = parseHls(await fetchText(url), url);
  if (playlist.type === 'media')
    return {
      duration: playlist.duration,
      live: playlist.live,
      drm: playlist.drm,
      qualities: [],
      variants: [],
      subtitles: [],
    };
  const best = distinct(playlist.variants)[0];
  const media = best ? (parseHls(await fetchText(best.url), best.url) as HlsMedia) : undefined;
  return {
    duration: media?.duration,
    live: media?.live ?? false,
    drm: media?.drm ?? false,
    qualities: hlsQualities(playlist, media?.duration),
    variants: [
      ...playlist.variants.map((v) => v.url),
      ...playlist.audio.flatMap((a) => (a.url ? [a.url] : [])),
      ...playlist.subtitles.flatMap((s) => (s.url ? [s.url] : [])),
    ],
    subtitles: playlist.subtitles.map((s) => ({
      kind: 'hls' as const,
      url: s.url!,
      language: s.language,
      label: s.name,
    })),
  };
}

/** "1080p", or the width for a quality without a height. */
export const qualityLabel = (q: Pick<Quality, 'height' | 'width' | 'label'>) =>
  q.height ? `${q.height}p` : q.width ? `${q.width}w` : (q.label ?? '');
