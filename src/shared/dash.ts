import { childOf, childrenOf, parseXml, type XmlNode } from './xml';
import type { SubtitleTrack } from './media';

/**
 * DASH manifests (MPD): video and audio come as separate tracks, each an init segment and media
 * segments (SegmentTemplate, SegmentList) or one whole file (SegmentBase). The extension downloads
 * the best video and audio it may and uploads them as two files; the server muxes them without
 * re-encoding. Sets under ContentProtection are DRM and not saved.
 */
export interface SegmentRef {
  url: string;
  /** Bytes `first-last` of the URL, inclusive (mediaRange). */
  range?: string;
}

export interface DashTrack {
  kind: 'video' | 'audio';
  id: string;
  /** Bits per second. */
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType: string;
  /** The language of a sound track. */
  lang?: string;
  init?: SegmentRef;
  /** Empty: the whole track is one file, `init` is then that file. */
  segments: SegmentRef[];
}

export interface DashManifest {
  /** Seconds. */
  duration: number;
  live: boolean;
  /** Every video set is under DRM. */
  drm: boolean;
  /** Best first. */
  video: DashTrack[];
  audio: DashTrack[];
  /** Subtitles as WebVTT files. */
  text: SubtitleTrack[];
}

/** ISO 8601 duration (PT1H2M3.5S, P1DT2H) in seconds. */
export function isoSeconds(value: string | undefined): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(value ?? '');
  if (!m) return 0;
  return (
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0)
  );
}

/** $RepresentationID$, $Number%05d$, $Bandwidth$, $Time$ and $$ in a template. */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(
    /\$(RepresentationID|Number|Bandwidth|Time)?(?:%0(\d+)d)?\$/g,
    (_, name: string | undefined, width: string | undefined) =>
      name === undefined ? '$' : String(vars[name] ?? '').padStart(Number(width ?? 0), '0'),
  );
}

function baseOf(node: XmlNode | undefined, base: string): string {
  const own = childOf(node, 'BaseURL')?.text.trim();
  return own ? new URL(own, base).href : base;
}

/** Attributes of a SegmentTemplate merged down the tree: the nearest one wins. */
function mergedTemplate(...levels: (XmlNode | undefined)[]): XmlNode | undefined {
  const found = levels.map((l) => childOf(l, 'SegmentTemplate')).filter((t) => t !== undefined);
  if (!found.length) return undefined;
  const timeline = [...found].reverse().find((t) => childOf(t, 'SegmentTimeline'));
  return {
    name: 'SegmentTemplate',
    attrs: Object.assign({}, ...found.map((t) => t.attrs)),
    children: timeline ? [childOf(timeline, 'SegmentTimeline')!] : [],
    text: '',
  };
}

function templateSegments(
  tpl: XmlNode,
  vars: { RepresentationID: string; Bandwidth: number },
  seconds: number,
  base: string,
): { init?: SegmentRef; segments: SegmentRef[] } {
  const a = tpl.attrs;
  const timescale = Number(a['timescale'] ?? 1);
  const startNumber = Number(a['startNumber'] ?? 1);
  const url = (template: string, extra: Record<string, number>) =>
    new URL(fillTemplate(template, { ...vars, ...extra }), base).href;
  const init = a['initialization'] ? { url: url(a['initialization'], {}) } : undefined;
  const media = a['media'];
  if (!media) return { init, segments: [] };
  const segments: SegmentRef[] = [];
  const timeline = childOf(tpl, 'SegmentTimeline');
  if (timeline) {
    let time = 0;
    let number = startNumber;
    const end = seconds * timescale;
    const items = childrenOf(timeline, 'S');
    items.forEach((s, i) => {
      if (s.attrs['t'] !== undefined) time = Number(s.attrs['t']);
      const d = Number(s.attrs['d']);
      let repeat = Number(s.attrs['r'] ?? 0);
      if (repeat < 0) {
        // Up to the next S's start, or the end of the period.
        const next = items[i + 1]?.attrs['t'];
        const until = next !== undefined ? Number(next) : end;
        repeat = Math.max(0, Math.ceil((until - time) / d) - 1);
      }
      for (let k = 0; k <= repeat; k++) {
        segments.push({ url: url(media, { Number: number++, Time: time }) });
        time += d;
      }
    });
  } else if (a['duration']) {
    const d = Number(a['duration']);
    const count = Math.ceil((seconds * timescale) / d);
    for (let k = 0; k < count; k++)
      segments.push({ url: url(media, { Number: startNumber + k, Time: k * d }) });
  }
  return { init, segments };
}

function listSegments(list: XmlNode, base: string): { init?: SegmentRef; segments: SegmentRef[] } {
  const initNode = childOf(list, 'Initialization');
  const init = initNode
    ? {
        url: new URL(initNode.attrs['sourceURL'] ?? '', base).href,
        range: initNode.attrs['range'],
      }
    : undefined;
  const segments = childrenOf(list, 'SegmentURL').map((s) => ({
    url: new URL(s.attrs['media'] ?? '', base).href,
    range: s.attrs['mediaRange'],
  }));
  return { init, segments };
}

export function parseDash(text: string, manifestUrl: string): DashManifest {
  const mpd = parseXml(text);
  if (mpd.name !== 'MPD') throw new Error('not a DASH manifest');
  const live = mpd.attrs['type'] === 'dynamic';
  const total = isoSeconds(mpd.attrs['mediaPresentationDuration']);
  const periods = childrenOf(mpd, 'Period');
  // Several periods are mostly ads stitched in: the longest one is the video.
  const lengths = periods.map((p) => isoSeconds(p.attrs['duration']) || total);
  const index = lengths.indexOf(Math.max(...lengths, 0));
  const period = periods[index];
  const seconds = lengths[index] ?? total;
  const out: DashManifest = {
    duration: seconds,
    live,
    drm: false,
    video: [],
    audio: [],
    text: [],
  };
  if (!period) return out;
  const mpdBase = baseOf(mpd, manifestUrl);
  const periodBase = baseOf(period, mpdBase);
  let protectedVideo = 0;
  for (const set of childrenOf(period, 'AdaptationSet')) {
    const setBase = baseOf(set, periodBase);
    const setProtected = childrenOf(set, 'ContentProtection').length > 0;
    for (const rep of childrenOf(set, 'Representation')) {
      const attr = (name: string) => rep.attrs[name] ?? set.attrs[name];
      const mimeType = attr('mimeType') ?? '';
      const kind = (set.attrs['contentType'] ?? mimeType.split('/')[0]) as string;
      // Subtitles as one WebVTT file; segmented text (TTML in MP4) is not taken.
      if (kind === 'text' || mimeType === 'text/vtt') {
        const tpl = mergedTemplate(period, set, rep);
        if (mimeType === 'text/vtt' && !tpl)
          out.text.push({
            kind: 'vtt',
            url: baseOf(rep, setBase),
            language: attr('lang'),
            label: set.attrs['label'] ?? rep.attrs['id'],
          });
        continue;
      }
      if (kind !== 'video' && kind !== 'audio') continue;
      if (setProtected || childrenOf(rep, 'ContentProtection').length) {
        if (kind === 'video') protectedVideo++;
        continue;
      }
      const base = baseOf(rep, setBase);
      const id = rep.attrs['id'] ?? '';
      const bandwidth = Number(rep.attrs['bandwidth'] ?? 0);
      const tpl = mergedTemplate(period, set, rep);
      const list = childOf(rep, 'SegmentList') ?? childOf(set, 'SegmentList');
      const parts = tpl
        ? templateSegments(tpl, { RepresentationID: id, Bandwidth: bandwidth }, seconds, base)
        : list
          ? listSegments(list, base)
          : { init: { url: base }, segments: [] };
      const width = Number(attr('width') ?? 0) || undefined;
      const height = Number(attr('height') ?? 0) || undefined;
      out[kind].push({
        kind,
        id,
        bandwidth,
        width,
        height,
        codecs: attr('codecs'),
        mimeType: mimeType || `${kind}/mp4`,
        lang: attr('lang'),
        ...parts,
      });
    }
  }
  out.drm = out.video.length === 0 && protectedVideo > 0;
  const best = (a: DashTrack, b: DashTrack) =>
    (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth;
  out.video.sort(best);
  out.audio.sort(best);
  return out;
}
