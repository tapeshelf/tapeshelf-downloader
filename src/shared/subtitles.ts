import { parseHls, type HlsMedia } from './hls';

/**
 * Subtitles saved beside a download as .srt: a WebVTT file, an SRT file, or an HLS
 * playlist of WebVTT segments (each with its X-TIMESTAMP-MAP), turned into one SRT. The picture's
 * file starts at its first frame, and so do the cues.
 */
export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

/** "01:02:03.456", "02:03.456", "01:02:03,456" (SRT) as seconds. */
export function seconds(stamp: string): number {
  const parts = stamp.trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** Tags SRT does not know (WebVTT's <c.class>, <v Speaker>, <00:00:01.000>…) go; <i>, <b>, <u> stay. */
function cleanText(text: string): string {
  return text
    .replace(/<(?!\/?(?:i|b|u)>)[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

/** The cues of a WebVTT or SRT text, moved by `shift` seconds. */
export function parseCues(text: string, shift = 0): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue;
    const [, from, to] = TIMING.exec(lines[at]!)!;
    const body = cleanText(lines.slice(at + 1).join('\n'));
    if (!body) continue;
    cues.push({ start: seconds(from!) + shift, end: seconds(to!) + shift, text: body });
  }
  return cues;
}

/**
 * Where an HLS WebVTT segment's cues are on the stream's clock (RFC 8216): its
 * X-TIMESTAMP-MAP ties a local time to an MPEG-TS time (90 kHz). Null: none given.
 */
export function timestampMap(text: string): { mpegts: number; local: number } | null {
  const line = /X-TIMESTAMP-MAP=([^\n]+)/.exec(text)?.[1];
  if (!line) return null;
  const mpegts = Number(/MPEGTS:(\d+)/.exec(line)?.[1] ?? NaN);
  const local = /LOCAL:([\d:.]+)/.exec(line)?.[1];
  if (!Number.isFinite(mpegts) || !local) return null;
  return { mpegts, local: seconds(local) };
}

/**
 * The cues of an HLS subtitle playlist's segments, on the picture's clock: the first segment's
 * MPEG-TS time is the picture's start. A cue that runs over two segments, repeated in both, once.
 */
export function joinSegments(segments: string[]): Cue[] {
  let first: number | null = null;
  const cues: Cue[] = [];
  for (const text of segments) {
    const map = timestampMap(text);
    if (map && first === null) first = map.mpegts;
    const shift = map ? (map.mpegts - (first ?? map.mpegts)) / 90_000 - map.local : 0;
    cues.push(...parseCues(text, shift));
  }
  const seen = new Set<string>();
  return cues
    .sort((a, b) => a.start - b.start)
    .filter((c) => {
      const key = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60,
  )},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .filter((c) => c.end > 0)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

/** A subtitle track as SRT text, whatever it came as. `text` fetches with the site's headers. */
export async function subtitlesAsSrt(
  track: { kind: 'vtt' | 'srt' | 'hls'; url: string },
  text: (url: string) => Promise<string>,
): Promise<string> {
  if (track.kind !== 'hls') return toSrt(parseCues(await text(track.url)));
  const playlist = parseHls(await text(track.url), track.url) as HlsMedia;
  const segments: string[] = [];
  for (const s of playlist.segments ?? []) segments.push(await text(s.url));
  return toSrt(joinSegments(segments));
}
