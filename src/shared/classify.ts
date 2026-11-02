import type { MediaKind } from './media';

/**
 * Which responses of a page are videos the extension can save: HLS playlists, DASH
 * manifests and whole video files. Segments of a stream are its manifest's business, and pieces
 * a player fetches by script (MSE) are not files.
 */
export interface SeenResponse {
  url: string;
  /** webRequest's resource type: media, xmlhttprequest, other… */
  type: string;
  statusCode: number;
  responseHeaders?: { name: string; value?: string }[];
}

export interface Classified {
  kind: MediaKind;
  size?: number;
  mimeType?: string;
}

const FILE_PATH = /\.(mp4|m4v|webm|mov|mkv|ogv)$/;
const SEGMENT_PATH = /\.(ts|m4s|m4f|m4a|cmfv|cmfa|aac|mp3|vtt|key)$/;
const SEGMENT_TYPES = /^(video\/mp2t|video\/iso\.segment|video\/vnd\.dlna\.mpeg-tts)$/;
/** Ads and previews: a video file smaller than this is not offered. */
export const MIN_FILE_BYTES = 256 * 1024;
/** A whole file fetched by script (not a player's media request) must be at least this big. */
const MIN_SCRIPTED_FILE_BYTES = 1024 * 1024;
/** Hosts whose streams are not files at all (YouTube's video servers). */
const SKIP_HOST = /(^|\.)googlevideo\.com$/;

function header(r: SeenResponse, name: string): string | undefined {
  return r.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
}

/** Bytes of the whole file: a Content-Range's total, or the Content-Length of a 200. */
export function totalSize(r: SeenResponse): number | undefined {
  const range = /\/(\d+)\s*$/.exec(header(r, 'content-range') ?? '');
  if (range) return Number(range[1]);
  const length = Number(header(r, 'content-length'));
  return r.statusCode === 200 && length > 0 ? length : undefined;
}

export function classify(r: SeenResponse): Classified | null {
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || SKIP_HOST.test(url.hostname)) return null;
  if (r.statusCode >= 400) return null;
  const path = url.pathname.toLowerCase();
  const type = (header(r, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (path.endsWith('.m3u8') || /mpegurl/.test(type)) return { kind: 'hls' };
  if (path.endsWith('.mpd') || type === 'application/dash+xml') return { kind: 'dash' };
  if (SEGMENT_PATH.test(path) || SEGMENT_TYPES.test(type) || type.startsWith('audio/')) return null;
  const videoType = type.startsWith('video/');
  if (!videoType && !FILE_PATH.test(path)) return null;
  // Typed as a page's text or picture, a .mp4 address is not a video.
  if (!videoType && type && !/octet-stream|binary/.test(type)) return null;
  const size = totalSize(r);
  if (size !== undefined && size < MIN_FILE_BYTES) return null;
  if (r.type === 'xmlhttprequest' || r.type === 'fetch') {
    // A player that fetches by script takes a file in pieces: only a whole, big file counts.
    if (r.statusCode !== 200 || !FILE_PATH.test(path) || (size ?? 0) < MIN_SCRIPTED_FILE_BYTES)
      return null;
  }
  return { kind: 'file', size, mimeType: videoType ? type : undefined };
}
