/**
 * The recording mode's relay, a content script in the extension's own world beside
 * the page's ears (`capture/main.ts`). As the page starts it asks whether this tab records (it was
 * reloaded for it) or buffers ahead (the settings say so for its site); then it passes on what the
 * player appends to the offscreen document — messages between the extension's parts carry text,
 * so the bytes go as base64.
 */
const OUT = 'tapeshelf-capture';
const IN = 'tapeshelf-capture-control';

let port: chrome.runtime.Port | null = null;
/** Recording for a job, or buffering ahead where the settings say so. */
let mode: 'record' | 'buffer' | null = null;
let limit = 0;
let opening = false;
/** What the page sent while the buffer's port was being opened. */
let pending: object[] = [];

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const control = (what: 'start' | 'stop') =>
  window.postMessage({ [IN]: what }, location.origin === 'null' ? '*' : location.origin);

function connect(name: string): void {
  port = chrome.runtime.connect({ name });
  port.onDisconnect.addListener(() => {
    port = null;
    if (mode === 'record') control('stop');
  });
}

function start(job: string): void {
  if (port && mode === 'record') return;
  mode = 'record';
  connect(`capture:${job}`);
  control('start');
}

/**
 * Buffering ahead: the page sends from its start; the port opens only when its player
 * makes a buffer — a page without one wakes nothing.
 */
function buffer(bytes: number): void {
  mode = 'buffer';
  limit = bytes;
  control('start');
}

function open(): void {
  if (opening) return;
  opening = true;
  void chrome.runtime
    .sendMessage({ type: 'bufferOpen' })
    .then(() => {
      connect(`buffer:${limit}`);
      for (const m of pending) port!.postMessage(m);
    })
    .catch(() => undefined)
    .finally(() => {
      pending = [];
      opening = false;
    });
}

type FromPage =
  | { type: 'buffer'; id: number; mime: string }
  | { type: 'data'; id: number; init: boolean; bytes: Uint8Array }
  | { type: 'ended' };

const outgoing = (m: FromPage) =>
  m.type === 'data' ? { type: 'data', id: m.id, init: m.init, b64: base64(m.bytes) } : m;

window.addEventListener('message', (e) => {
  if (e.source !== window || !mode) return;
  const message = (e.data as Record<string, unknown> | null)?.[OUT] as FromPage | undefined;
  if (!message) return;
  if (port) port.postMessage(outgoing(message));
  else if (mode === 'buffer') {
    pending.push(outgoing(message));
    open();
  }
});

chrome.runtime.onMessage.addListener((message: { type?: string; job?: string }) => {
  if (message.type === 'capture-start' && message.job) start(message.job);
  if (message.type === 'capture-stop') {
    port?.disconnect();
    port = null;
    // Buffering: a new buffer starts at once, from what the page knows; else the page stops.
    if (mode === 'buffer') control('start');
    else {
      control('stop');
      mode = null;
    }
  }
});

// As the page starts: does this tab record (it was reloaded for it), or buffer ahead?
void chrome.runtime
  .sendMessage({ type: 'captureArmed' })
  .then((answer: { job?: string; buffer?: number } | undefined) => {
    if (answer?.job) start(answer.job);
    else if (answer?.buffer) buffer(answer.buffer);
  })
  .catch(() => undefined);
