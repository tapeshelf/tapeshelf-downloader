import type { Cursor, TrackPlan } from '../shared/jobs';
import { send, type PageBytes } from '../shared/messages';
import { SaveError } from './plan';

/**
 * Downloading a track: a file read as it arrives, or segments one after another, each
 * piece with its place in the source, so an upload can stop after any part and go on from there.
 * Requests carry the person's cookies of the site; the Referer comes from a session rule.
 */
export interface Piece {
  bytes: Uint8Array;
  /** Where bytes[0] is in the source. */
  at: Cursor;
}

const ATTEMPTS = 4;
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), {
      once: true,
    });
  });

/** A GET that tries again on a dropped connection or a server error, not on a refusal. */
async function get(url: string, range: string | undefined, signal: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: range ? { Range: `bytes=${range}` } : {},
        signal,
      });
      if (res.ok) return res;
      if (res.status < 500 || attempt === ATTEMPTS) throw new SaveError('source', res.status);
    } catch (err) {
      if (signal.aborted || err instanceof SaveError || attempt === ATTEMPTS) throw err;
    }
    await wait(1000 * 2 ** (attempt - 1), signal);
  }
}

/**
 * The body read in 1 MB steps into one buffer the stream hands back (BYOB): the download never
 * piles up in memory (the JS heap stays at 20–40 MB for 2 GB).
 */
async function* body(res: Response): AsyncGenerator<Uint8Array> {
  const stream = res.body;
  if (!stream) return;
  let reader: ReadableStreamBYOBReader | undefined;
  try {
    reader = stream.getReader({ mode: 'byob' });
  } catch {
    reader = undefined;
  }
  if (!reader) {
    const plain = stream.getReader();
    for (let r = await plain.read(); !r.done; r = await plain.read()) yield r.value;
    return;
  }
  let buffer = new ArrayBuffer(1 << 20);
  for (;;) {
    const { done, value } = await reader.read(new Uint8Array(buffer));
    if (done || !value) return;
    buffer = value.buffer as ArrayBuffer;
    yield value;
  }
}

async function* readFile(url: string, from: number, signal: AbortSignal): AsyncGenerator<Piece> {
  const res = await get(url, from ? `${from}-` : undefined, signal);
  // A server without ranges sends the file from its start: the bytes already uploaded are skipped.
  let skip = from && res.status !== 206 ? from : 0;
  let offset = from && res.status === 206 ? from : 0;
  for await (let bytes of body(res)) {
    if (skip) {
      const n = Math.min(skip, bytes.length);
      skip -= n;
      offset += n;
      bytes = bytes.subarray(n);
      if (!bytes.length) continue;
    }
    yield { bytes, at: { segment: 0, offset } };
    offset += bytes.length;
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

function aesKey(url: string, signal: AbortSignal): Promise<CryptoKey> {
  let key = keys.get(url);
  if (!key) {
    key = get(url, undefined, signal)
      .then((r) => r.arrayBuffer())
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
    key.catch(() => keys.delete(url));
    keys.set(url, key);
  }
  return key;
}

/** HLS AES-128: the IV from the playlist, else the segment's sequence number (RFC 8216). */
export function ivOf(hex: string | null, sequence: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  if (hex) for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  else {
    const view = new DataView(iv.buffer);
    view.setUint32(8, Math.floor(sequence / 2 ** 32));
    view.setUint32(12, sequence >>> 0);
  }
  return iv;
}

export async function segment(
  s: NonNullable<TrackPlan['segments']>[number],
  signal: AbortSignal,
): Promise<Uint8Array> {
  const res = await get(s.url, s.range, signal);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (s.range && res.status === 200) {
    // The server ignored the range and sent the whole file: cut the segment out of it.
    const [first, last] = s.range.split('-').map(Number) as [number, number];
    bytes = bytes.subarray(first, last + 1);
  }
  if (!s.key) return bytes;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivOf(s.key.iv, s.key.sequence) },
    await aesKey(s.key.url, signal),
    bytes,
  );
  return new Uint8Array(plain);
}

/**
 * A file read in ranges of `chunk` bytes, one request each (YouTube slows down a whole-file read):
 * from where the upload stopped to the file's end.
 */
async function* readChunks(
  url: string,
  size: number,
  chunk: number,
  from: number,
  signal: AbortSignal,
): AsyncGenerator<Piece> {
  for (let start = from; start < size; start += chunk) {
    const end = Math.min(start + chunk, size) - 1;
    const res = await get(url, `${start}-${end}`, signal);
    let offset = start;
    let skip = res.status === 206 ? 0 : start;
    for await (let bytes of body(res)) {
      if (skip) {
        const n = Math.min(skip, bytes.length);
        skip -= n;
        bytes = bytes.subarray(n);
        if (!bytes.length) continue;
      }
      // A server that ignored the range sends the rest too: only this range is taken.
      if (offset + bytes.length > end + 1) bytes = bytes.subarray(0, end + 1 - offset);
      if (bytes.length) yield { bytes, at: { segment: 0, offset } };
      offset += bytes.length;
      if (offset > end) break;
    }
    if (offset <= end) throw new SaveError('source', res.status);
  }
}

/**
 * A file only its page can read: ranges fetched through its tab, `chunk` bytes each, from
 * where the download stopped to the end its first answer says. A page that ignores the range sends
 * the whole file at once.
 */
async function* readThroughTab(
  url: string,
  tab: number,
  size: number | undefined,
  chunk: number,
  from: number,
  signal: AbortSignal,
): AsyncGenerator<Piece> {
  let total = size;
  for (let start = from; total === undefined || start < total; start += chunk) {
    if (signal.aborted) throw signal.reason;
    const end = (total === undefined ? start + chunk : Math.min(start + chunk, total)) - 1;
    const answer = await send<PageBytes>({ type: 'pageFetch', tabId: tab, url, start, end });
    if (!answer || 'error' in answer) throw new SaveError('pageGone', undefined, answer?.error);
    if (answer.status >= 400) throw new SaveError('source', answer.status);
    const text = atob(answer.b64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    if (answer.status === 200) {
      if (start < bytes.length)
        yield { bytes: bytes.subarray(start), at: { segment: 0, offset: start } };
      return;
    }
    total ??= answer.total;
    if (bytes.length) yield { bytes, at: { segment: 0, offset: start } };
    if (bytes.length < end - start + 1) return;
  }
}

export async function* readTrack(
  track: TrackPlan,
  from: Cursor,
  signal: AbortSignal,
): AsyncGenerator<Piece> {
  if (track.url && track.tab !== undefined) {
    yield* readThroughTab(
      track.url,
      track.tab,
      track.size,
      track.chunk ?? 2 << 20,
      from.offset,
      signal,
    );
    return;
  }
  if (track.url && track.chunk && track.size) {
    yield* readChunks(track.url, track.size, track.chunk, from.offset, signal);
    return;
  }
  if (track.url) {
    yield* readFile(track.url, from.offset, signal);
    return;
  }
  // Segments come several at a time (as a player fetches ahead, and go out in order.
  const segments = track.segments ?? [];
  const ahead: Promise<Uint8Array>[] = [];
  let next = from.segment;
  const fill = () => {
    while (ahead.length < SEGMENTS_AT_ONCE && next < segments.length) {
      const fetching = segment(segments[next++]!, signal);
      // One failing while another is awaited is not an unhandled rejection: it is awaited in turn.
      fetching.catch(() => undefined);
      ahead.push(fetching);
    }
  };
  fill();
  for (let i = from.segment; i < segments.length; i++) {
    const bytes = await ahead.shift()!;
    fill();
    const start = i === from.segment ? from.offset : 0;
    if (start < bytes.length)
      yield { bytes: bytes.subarray(start), at: { segment: i, offset: start } };
  }
}

/** Segments downloaded at once: faster than one by one, gentle enough on a site's servers. */
export const SEGMENTS_AT_ONCE = 4;
