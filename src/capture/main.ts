/**
 * The recording mode's ears in the page, run in the page's own world before its scripts:
 * the player's MediaSource buffers are watched — their latest init section kept (a few kilobytes) —
 * and nothing is copied until the extension says this tab records. Then every piece the player
 * appends goes to the extension's relay (the content script beside this one), in order.
 * Self-contained: the build makes it a classic script of its own.
 */
declare global {
  interface Window {
    __tapeshelfCapture?: true;
  }
}

const OUT = 'tapeshelf-capture';
const IN = 'tapeshelf-capture-control';

interface Watched {
  id: number;
  mime: string;
  init: Uint8Array | null;
}

/** An init section: an MP4's ftyp/moov first, or a WebM's EBML header. */
function isInit(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  const box = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  return box === 'ftyp' || box === 'moov';
}

function bytesOf(data: BufferSource): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data.slice(0))
    : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

/** Left by the extension in the tab's session storage just before it reloads the page to record. */
const RECORDING_LOAD = 'tapeshelf-capture';

/**
 * A page reloaded to be recorded: a player that builds its video in a worker (MSE in
 * workers — Amazon IVS, Twitch's player, in Chrome) is out of these ears' reach. Its workers are
 * told they cannot, as Amazon's own workaround for IVS does, and the player builds the video here.
 * Only workers of a blob: script, read as the page made it; nothing else is touched.
 */
function playersBuildHere(): void {
  let marked = false;
  try {
    marked = sessionStorage.getItem(RECORDING_LOAD) !== null;
    sessionStorage.removeItem(RECORDING_LOAD);
  } catch {
    // A frame without storage: nothing marked.
  }
  if (!marked || typeof Worker === 'undefined') return;
  const first =
    "try{Object.defineProperty(self.MediaSource,'canConstructInDedicatedWorker',{value:false,configurable:true})}catch(e){}\n";
  window.Worker = new Proxy(Worker, {
    construct(target, args: [string | URL, WorkerOptions?], newTarget: NewableFunction) {
      const [url, options] = args;
      if (options?.type !== 'module' && String(url).startsWith('blob:'))
        try {
          // At once: the page may let its blob go as soon as the worker is made.
          const xhr = new XMLHttpRequest();
          xhr.open('GET', String(url), false);
          xhr.send();
          const script = new Blob([first, xhr.responseText], { type: 'text/javascript' });
          return Reflect.construct(target, [URL.createObjectURL(script), options], newTarget);
        } catch {
          // Unreadable: the worker as the page made it.
        }
      return Reflect.construct(target, args, newTarget);
    },
  });
}

(() => {
  if (window.__tapeshelfCapture || typeof MediaSource === 'undefined') return;
  window.__tapeshelfCapture = true;
  playersBuildHere();
  const watched = new WeakMap<SourceBuffer, Watched>();
  const all: Watched[] = [];
  let next = 0;
  let recording = false;
  const post = (message: object, transfer: Transferable[] = []) =>
    window.postMessage(
      { [OUT]: message },
      location.origin === 'null' ? '*' : location.origin,
      transfer,
    );

  // The original methods, called on their own objects (`.call(this)`): wrapped, not detached.
  // oxlint-disable-next-line typescript/unbound-method
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const buffer = add.call(this, mime);
    const w: Watched = { id: next++, mime, init: null };
    watched.set(buffer, w);
    all.push(w);
    if (recording) post({ type: 'buffer', id: w.id, mime });
    return buffer;
  };

  // oxlint-disable-next-line typescript/unbound-method
  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    const w = watched.get(this);
    if (w) {
      const bytes = bytesOf(data);
      const init = isInit(bytes);
      if (init) w.init = bytes.slice();
      if (recording) post({ type: 'data', id: w.id, init, bytes }, [bytes.buffer]);
    }
    return append.call(this, data);
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const control = (e.data as Record<string, unknown> | null)?.[IN];
    if (control === 'start') {
      // Again after a recording: a new buffer starts from what is known.
      recording = true;
      // What is known already: each buffer and its init section, then the pieces as they come.
      for (const w of all) {
        post({ type: 'buffer', id: w.id, mime: w.mime });
        if (w.init) post({ type: 'data', id: w.id, init: true, bytes: w.init.slice() });
      }
    } else if (control === 'stop') recording = false;
  });

  // The video ended: the recording is complete.
  document.addEventListener(
    'ended',
    (e) => {
      if (recording && e.target instanceof HTMLVideoElement) post({ type: 'ended' });
    },
    true,
  );
})();

export {};
