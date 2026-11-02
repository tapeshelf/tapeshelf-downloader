import { getJob, type DownloadPlan, type TrackPlan } from '../shared/jobs';
import { send } from '../shared/messages';
import { root, storedNames } from '../shared/storage';
import { report, saved } from './common';
import { SaveError } from './plan';
import { StagedFile, storedFile } from './stage';

/**
 * The recording mode: what the page's player appends to its buffers, copied as it
 * plays (`capture/main.ts` in the page, `capture/relay.ts` beside it) and written here into the
 * extension's storage — each buffer in parts, a new part where its init section changes (the
 * player switched quality). "Stop", the end of the video, or the tab gone ends it; the longest
 * part of the picture and of the sound go on to the join like a download's tracks.
 *
 * Where the settings say so, a tab's pieces are copied ahead from its page's start into a buffer
 * (pieces of 32 MB, the oldest gone past the limit, the init section kept apart); "Record" then
 * takes the buffer as the recording's start, and the page need not reload.
 */
const PIECE = 32 * 1024 * 1024;

interface Piece {
  name: string;
  bytes: number;
  file?: StagedFile;
  order: number;
}

interface Part {
  mime: string;
  /** The init section's signature: a new one starts a new part. */
  init: string;
  initBytes: Uint8Array;
  bytes: number;
  /** Recording: one file, open. */
  name: string;
  file?: StagedFile;
  /** Buffering: the pieces since the oldest kept. */
  pieces: Piece[];
}

interface Buffer {
  mime: string;
  parts: Part[];
  /** Writes in the order the pieces came, a new part's opening and the hand-over included. */
  queue: Promise<void>;
}

type Message = { type: string; id?: number; mime?: string; init?: boolean; b64?: string };

/** Ten seconds without a port (the tab closed or went elsewhere): the recording ends. */
const ORPHANED_MS = 10_000;
/** A page whose player has sent nothing this long after it connected: it cannot be recorded so. */
const NOTHING_MS = 60_000;

class Session {
  readonly buffers = new Map<string, Buffer>();
  ports = 0;
  hadPort = false;
  firstPortAt = 0;
  lastPortAt = Date.now();
  ended = false;
  firstDataAt = 0;
  private counter = 0;

  /** `jobId` set: recording for that job; not: buffering ahead for the tab, up to `limit` bytes. */
  constructor(
    public jobId: string | undefined,
    readonly prefix: string,
    readonly limit = Infinity,
  ) {}

  get recording(): boolean {
    return this.jobId !== undefined;
  }

  attach(port: chrome.runtime.Port, onGone?: () => void): void {
    this.ports++;
    this.hadPort = true;
    this.firstPortAt ||= Date.now();
    const frame = port.sender?.frameId ?? 0;
    port.onDisconnect.addListener(() => {
      this.ports--;
      this.lastPortAt = Date.now();
      if (this.ports === 0) onGone?.();
    });
    port.onMessage.addListener((m: Message) => this.take(frame, m));
  }

  private take(frame: number, m: Message): void {
    if (m.type === 'ended' && this.recording) this.ended = true;
    const key = `${frame}-${m.id}`;
    if (m.type === 'buffer' && !this.buffers.has(key))
      this.buffers.set(key, { mime: m.mime ?? '', parts: [], queue: Promise.resolve() });
    if (m.type === 'data' && m.b64) {
      const buffer = this.buffers.get(key);
      if (!buffer) return;
      const bytes = decode(m.b64);
      if (this.recording) this.firstDataAt ||= Date.now();
      buffer.queue = buffer.queue
        .then(() => this.write(key, buffer, bytes, !!m.init))
        .catch(() => undefined);
    }
  }

  /** A recording's files are named after its job (kept across a restart); a buffer's apart. */
  private name(key: string): string {
    const prefix = this.recording ? `${this.jobId}.cap` : this.prefix;
    return `${prefix}-${key}-${this.counter++}`;
  }

  private async write(
    key: string,
    buffer: Buffer,
    bytes: Uint8Array,
    init: boolean,
  ): Promise<void> {
    let part = buffer.parts.at(-1);
    if (init) {
      const sign = signature(bytes);
      if (part?.init === sign) return; // The same init again (a seek): the part goes on.
      part = { mime: buffer.mime, init: sign, initBytes: bytes, bytes: 0, name: '', pieces: [] };
      buffer.parts.push(part);
      if (this.recording) {
        part.name = this.name(key);
        part.file = (await StagedFile.open(part.name, 0)).file;
        part.file.write(bytes);
        part.bytes += bytes.length;
        return;
      }
      return;
    }
    // Pieces before any init section cannot be read: left out.
    if (!part) return;
    if (this.recording) {
      if (!part.file) return;
      part.file.write(bytes);
      part.bytes += bytes.length;
      return;
    }
    // Buffering: into the newest piece, a new one past 32 MB; the oldest go past the limit.
    let piece = part.pieces.at(-1);
    if (!piece?.file || piece.bytes >= PIECE) {
      await piece?.file?.close().catch(() => undefined);
      if (piece) piece.file = undefined;
      piece = { name: this.name(key), bytes: 0, order: this.counter };
      piece.file = (await StagedFile.open(piece.name, 0)).file;
      part.pieces.push(piece);
    }
    piece.file!.write(bytes);
    piece.bytes += bytes.length;
    part.bytes += bytes.length;
    await this.trim();
  }

  /** Past the limit: the oldest closed piece of the tab goes (an init section stays). */
  private async trim(): Promise<void> {
    while (this.bytes > this.limit) {
      let oldest: { part: Part; piece: Piece } | undefined;
      for (const b of this.buffers.values())
        for (const part of b.parts)
          for (const piece of part.pieces)
            if (!piece.file && (!oldest || piece.order < oldest.piece.order))
              oldest = { part, piece };
      if (!oldest) return;
      oldest.part.pieces.splice(oldest.part.pieces.indexOf(oldest.piece), 1);
      oldest.part.bytes -= oldest.piece.bytes;
      await (await root()).removeEntry(oldest.piece.name).catch(() => undefined);
    }
  }

  /**
   * The buffer becomes a recording: each part one file — its init section, then its pieces
   * in order — kept open for what comes next. Done in each buffer's own order of writes.
   */
  record(jobId: string): void {
    this.jobId = jobId;
    this.firstDataAt = Date.now();
    for (const [key, buffer] of this.buffers)
      buffer.queue = buffer.queue
        .then(async () => {
          for (const part of buffer.parts) {
            part.name = this.name(key);
            part.file = (await StagedFile.open(part.name, 0)).file;
            part.file.write(part.initBytes);
            let bytes = part.initBytes.length;
            for (const piece of part.pieces) {
              await piece.file?.close().catch(() => undefined);
              const file = await storedFile(piece.name);
              if (file) {
                const reader = file.stream().getReader();
                for (let r = await reader.read(); !r.done; r = await reader.read()) {
                  part.file.write(r.value);
                  bytes += r.value.length;
                }
                await part.file.flush();
              }
              await (await root()).removeEntry(piece.name).catch(() => undefined);
            }
            part.pieces = [];
            part.bytes = bytes;
          }
        })
        .catch(() => undefined);
  }

  /** Every part, closed (a recording's). */
  async close(): Promise<Part[]> {
    const parts: Part[] = [];
    for (const buffer of this.buffers.values()) {
      await buffer.queue;
      for (const part of buffer.parts) {
        await part.file?.close().catch(() => undefined);
        part.file = undefined;
        if (part.name) parts.push(part);
      }
    }
    return parts;
  }

  /** A buffer no one recorded: its files go. */
  async discard(): Promise<void> {
    for (const buffer of this.buffers.values()) {
      await buffer.queue;
      for (const part of buffer.parts)
        for (const piece of part.pieces) {
          piece.file?.drop();
          await (await root()).removeEntry(piece.name).catch(() => undefined);
        }
    }
    this.buffers.clear();
  }

  get bytes(): number {
    let n = 0;
    for (const b of this.buffers.values()) for (const p of b.parts) n += p.bytes;
    return n;
  }
}

function decode(b64: string): Uint8Array {
  const text = atob(b64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Tells two init sections apart cheaply: their length and some of their bytes. */
function signature(bytes: Uint8Array): string {
  let hash = 0;
  for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 512)))
    hash = (hash * 31 + bytes[i]!) | 0;
  return `${bytes.length}:${hash}`;
}

/** Recordings by job, buffers by tab. */
const sessions = new Map<string, Session>();
const buffers = new Map<number, Session>();
let whenNoBuffers: (() => void) | undefined;

/** A tab's buffer is kept: the document stays open for it. */
export const buffering = () => buffers.size > 0;

/** Called when the last buffer goes (the document may close then). */
export function onBuffersGone(callback: () => void): void {
  whenNoBuffers = callback;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('buffer:')) {
    // A page of a tab that buffers ahead: a new page, a new buffer.
    const tabId = port.sender?.tab?.id;
    const limit = Number(port.name.slice('buffer:'.length)) || 2048 * 1024 * 1024;
    if (tabId === undefined) return port.disconnect();
    let session = buffers.get(tabId);
    if (!session || session.recording || (session.hadPort && session.ports === 0)) {
      if (session && !session.recording) void session.discard();
      session = new Session(undefined, `buffer-${tabId}-${Date.now()}`, limit);
      buffers.set(tabId, session);
    }
    const mine = session;
    mine.attach(port, () => {
      // The page went (closed, or another page): its buffer goes, unless it became a recording.
      if (mine.recording || buffers.get(tabId) !== mine) return;
      buffers.delete(tabId);
      void mine.discard();
      if (!buffers.size) whenNoBuffers?.();
    });
    return;
  }
  const id = /^capture:(.+)$/.exec(port.name)?.[1];
  const session = id ? sessions.get(id) : undefined;
  if (session) session.attach(port);
  else port.disconnect();
});

/** Buffers of tabs gone while the document was closed: their files go as it opens. */
export async function sweepBuffers(): Promise<void> {
  const dir = await root();
  const held = [...buffers.values()].map((s) => s.prefix);
  for (const name of await storedNames())
    if (name.startsWith('buffer-') && !held.some((p) => name.startsWith(p)))
      await dir.removeEntry(name).catch(() => undefined);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), {
      once: true,
    });
  });

/** The longest part among those of a kind: the picture's, the sound's. */
const longest = (parts: { mime: string; bytes: number; name: string }[], kind: 'video' | 'audio') =>
  parts
    .filter((p) => p.mime.startsWith(`${kind}/`) && p.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)[0];

/** Records what the tab's player plays; returns the plan the join and the save go on with. */
export async function captureRecording(id: string, signal: AbortSignal): Promise<DownloadPlan> {
  let job = (await getJob(id))!;
  const tabId = job.request.capture!.tabId;
  const known = job.disk?.capture;
  let parts: { mime: string; bytes: number; name: string }[];
  if (known?.length) {
    // Recorded before the browser stopped: saved with what it has.
    parts = known;
  } else {
    // The tab's buffer, if it keeps the player's pieces, is the recording's start; else the tab
    // reloads (a player building its video in a worker leaves the buffer empty:).
    const kept = buffers.get(tabId);
    const ahead = kept?.buffers.size ? kept : undefined;
    if (kept) {
      buffers.delete(tabId);
      if (ahead) ahead.record(id);
      else void kept.discard();
      if (!buffers.size) whenNoBuffers?.();
    }
    const session = ahead ?? new Session(id, '');
    sessions.set(id, session);
    try {
      if (!ahead) await send({ type: 'captureReady', id, tabId });
      const started = Date.now();
      for (;;) {
        await wait(1000, signal);
        job = (await getJob(id))!;
        if (job.status === 'cancelled') throw new DOMException('cancelled', 'AbortError');
        const orphaned =
          session.hadPort && session.ports === 0 && Date.now() - session.lastPortAt > ORPHANED_MS;
        // A tab that never connected (closed at once, or a page without the relay).
        const neverCame = !session.hadPort && Date.now() - started > 30_000;
        // A page whose player gives nothing (it does not build its video where it is heard).
        const nothing =
          !session.firstDataAt && session.hadPort && Date.now() - session.firstPortAt > NOTHING_MS;
        const recorded = session.firstDataAt ? (Date.now() - session.firstDataAt) / 1000 : 0;
        await report(
          await saved(id, (j) => ({
            recorded,
            bytes: { done: session.bytes },
            disk: {
              ...j.disk!,
              capture: [...session.buffers.values()].flatMap((b) =>
                b.parts
                  .filter((p) => p.name)
                  .map((p) => ({ name: p.name, mime: p.mime, bytes: p.bytes })),
              ),
            },
          })),
        );
        if (job.stop || session.ended || orphaned || neverCame || nothing) break;
      }
    } finally {
      await send({ type: 'captureStop', id, tabId }).catch(() => undefined);
      parts = await session.close();
      sessions.delete(id);
    }
  }
  const video = longest(parts, 'video');
  const audio = longest(parts, 'audio');
  if (!video && !audio) {
    for (const p of parts) await (await root()).removeEntry(p.name).catch(() => undefined);
    throw new SaveError('captureNothing');
  }
  // The chosen parts become the job's tracks; the rest go.
  const dir = await root();
  const picture = video ?? audio!;
  const keep = new Map<string, string>([[picture.name, `${id}.video`]]);
  if (video && audio) keep.set(audio.name, `${id}.audio`);
  for (const p of parts) {
    const handle = await dir.getFileHandle(p.name).catch(() => null);
    if (!handle) continue;
    const to = keep.get(p.name);
    if (to) await (handle as FileSystemFileHandle & { move(name: string): Promise<void> }).move(to);
    else await dir.removeEntry(p.name).catch(() => undefined);
  }
  const track = (p: { mime: string } | undefined): TrackPlan | undefined =>
    p && {
      ext: p.mime.includes('webm') ? 'webm' : 'mp4',
      mimeType: p.mime.split(';')[0]!,
      segments: [{ url: 'capture' }],
    };
  const plan: DownloadPlan = {
    video: track(picture)!,
    audio: video && audio ? track(audio) : undefined,
    // A player of sound alone: its sound, as it is.
    audioOnly: !video,
  };
  await saved(id, (j) => ({ plan, disk: { ...j.disk!, phase: 'join', capture: undefined } }));
  return plan;
}
