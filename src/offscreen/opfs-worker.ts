/// <reference lib="webworker" />
/**
 * Writes a download into a file of the extension's own storage (OPFS), in place, with a sync
 * access handle: what was flushed is on the disk even if the browser is killed, and a
 * download goes on from there. Only a dedicated worker gets such a handle; the offscreen document
 * sends it the bytes in order and asks for a flush at each part's end.
 */
export type WorkerRequest =
  | { type: 'open'; name: string; keep: number }
  | { type: 'write'; bytes: Uint8Array }
  | { type: 'flush' }
  | { type: 'close' };

export type WorkerReply = { size: number } | { error: { name: string; message: string } };

let access: FileSystemSyncAccessHandle | null = null;
let at = 0;
/** A write that failed (no room on the disk…): told at the next flush. */
let failed: unknown = null;

async function handle(req: WorkerRequest): Promise<WorkerReply | undefined> {
  switch (req.type) {
    case 'open': {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(req.name, { create: true });
      access = await file.createSyncAccessHandle();
      // What was flushed before is kept; anything after it (unflushed when the browser stopped) goes.
      at = Math.min(req.keep, access.getSize());
      access.truncate(at);
      return { size: at };
    }
    case 'write':
      if (failed || !access) return undefined;
      try {
        at += access.write(req.bytes, { at });
      } catch (err) {
        failed = err;
      }
      return undefined;
    case 'flush':
    case 'close':
      if (!access) return { size: at };
      if (failed) throw failed;
      access.flush();
      if (req.type === 'close') {
        access.close();
        access = null;
      }
      return { size: at };
  }
}

/** One request after another, in the order sent: a write never overtakes the opening. */
let queue = Promise.resolve();

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() =>
    handle(data).then(
      (reply) => reply && self.postMessage(reply),
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        self.postMessage({ error: { name: e.name, message: e.message } } satisfies WorkerReply);
      },
    ),
  );
};
