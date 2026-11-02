import type { WorkerReply, WorkerRequest } from './opfs-worker';
import { root } from '../shared/storage';
import { SaveError } from './plan';

/**
 * A download's file in the extension's own storage (OPFS, `shared/storage`): written in place
 * by a worker, in order, flushed at each part's end so it survives the browser; then read whole to
 * join the tracks, and handed to Downloads.
 */
export class StagedFile {
  private replies: ((reply: WorkerReply) => void)[] = [];
  private broken: Error | null = null;

  private constructor(private readonly worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => this.replies.shift()?.(data);
    worker.onerror = (e) => {
      this.broken = new Error(e.message || 'worker');
      for (const r of this.replies.splice(0))
        r({ error: { name: 'Error', message: this.broken.message } });
    };
  }

  /** The file, cut to the `keep` bytes known to be flushed: what follows them is written anew. */
  static async open(name: string, keep: number): Promise<{ file: StagedFile; size: number }> {
    const file = new StagedFile(new Worker('opfs-worker.js', { type: 'module' }));
    const size = await file.ask({ type: 'open', name, keep });
    return { file, size };
  }

  private ask(req: WorkerRequest): Promise<number> {
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => {
      this.replies.push((reply) =>
        'error' in reply ? reject(storageError(reply.error)) : resolve(reply.size),
      );
      this.worker.postMessage(req);
    });
  }

  /** Bytes appended; their buffer is copied, the caller may reuse it at once. */
  write(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.worker.postMessage({ type: 'write', bytes: copy } satisfies WorkerRequest, [copy.buffer]);
  }

  /** Everything written so far is on the disk: its size. */
  flush(): Promise<number> {
    return this.ask({ type: 'flush' });
  }

  async close(): Promise<number> {
    try {
      return await this.ask({ type: 'close' });
    } finally {
      this.worker.terminate();
    }
  }

  /** Stopped midway (cancelled, failed): the worker goes, its handle with it. */
  drop(): void {
    this.worker.terminate();
  }
}

/** No room left on the disk: said so; anything else as it came. */
function storageError(e: { name: string; message: string }): Error {
  if (e.name === 'QuotaExceededError') return new SaveError('disk');
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}

/** A file of the extension's storage, to read; undefined when there is none. */
export async function storedFile(name: string): Promise<File | undefined> {
  try {
    return await (await (await root()).getFileHandle(name)).getFile();
  } catch {
    return undefined;
  }
}

export async function storedHandle(name: string): Promise<FileSystemFileHandle> {
  return (await root()).getFileHandle(name, { create: true });
}

/** Room the storage still has, when the browser says (bytes). */
export async function roomLeft(): Promise<number | undefined> {
  const { quota, usage } = await navigator.storage.estimate();
  return quota !== undefined && usage !== undefined ? quota - usage : undefined;
}
