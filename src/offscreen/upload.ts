import type { Cursor, DonePart } from '../shared/jobs';

/**
 * Uploading a track in parts: bytes go into a part buffer of the session's size; a full
 * part is PUT to its presigned URL while the next one fills (two buffers, so downloading and
 * uploading overlap); each finished part is recorded with where the source stands, to go on
 * from there after a restart.
 */
export class Overflow extends Error {
  constructor() {
    super('overflow');
  }
}

export class PartUploadError extends Error {
  constructor(readonly status: number) {
    super(`part upload failed: ${status}`);
  }
}

export interface PartWriterOptions {
  partSize: number;
  /** The number of the next part (after those already uploaded). */
  firstPart: number;
  /** Bytes already uploaded; with `limit`, the most the whole track may be. */
  uploaded: number;
  limit: number;
  presign(partNumber: number, fresh: boolean): Promise<string>;
  onPart(part: DonePart): Promise<void>;
  signal: AbortSignal;
}

const ATTEMPTS = 4;

export class PartWriter {
  private readonly buffers: Uint8Array<ArrayBuffer>[];
  private current = 0;
  private filled = 0;
  private next: number;
  private total: number;
  private position: Cursor = { segment: 0, offset: 0 };
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly o: PartWriterOptions) {
    this.buffers = [new Uint8Array(o.partSize), new Uint8Array(o.partSize)];
    this.next = o.firstPart;
    this.total = o.uploaded;
  }

  get bytes(): number {
    return this.total;
  }

  async write(bytes: Uint8Array, at: Cursor): Promise<void> {
    let used = 0;
    while (used < bytes.length) {
      const n = Math.min(this.o.partSize - this.filled, bytes.length - used);
      this.buffers[this.current]!.set(bytes.subarray(used, used + n), this.filled);
      this.filled += n;
      used += n;
      this.total += n;
      this.position = { segment: at.segment, offset: at.offset + used };
      if (this.total > this.o.limit) throw new Overflow();
      if (this.filled === this.o.partSize) await this.flush();
    }
  }

  /** The last, shorter part; resolves when every part is stored. */
  async finish(): Promise<void> {
    if (this.filled) await this.flush();
    await this.inFlight;
  }

  private async flush(): Promise<void> {
    const body = this.buffers[this.current]!.subarray(0, this.filled);
    const part = this.next++;
    const cursor = this.position;
    // One part in flight: the buffer about to fill is the one whose upload just finished.
    await this.inFlight;
    this.inFlight = this.put(part, body, cursor);
    this.inFlight.catch(() => undefined);
    this.current ^= 1;
    this.filled = 0;
  }

  private async put(partNumber: number, body: Uint8Array<ArrayBuffer>, cursor: Cursor) {
    for (let attempt = 1; ; attempt++) {
      try {
        const url = await this.o.presign(partNumber, attempt > 1);
        const res = await fetch(url, { method: 'PUT', body, signal: this.o.signal });
        const etag = res.headers.get('ETag');
        if (res.ok && etag) {
          await this.o.onPart({ partNumber, etag, size: body.length, cursor });
          return;
        }
        if (attempt === ATTEMPTS) throw new PartUploadError(res.status);
      } catch (err) {
        if (this.o.signal.aborted || attempt === ATTEMPTS) throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}
