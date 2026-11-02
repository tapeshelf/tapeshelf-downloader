import type { SiteAdapter, SiteVideo } from './types';

/**
 * Telegram Web: the video the viewer shows (or the one playing) in web.telegram.org's two
 * clients, /k/ and /a/. Their videos come from the page's own service worker (`/k/stream/<what>`,
 * `/a/progressive/…`), or from a blob of the page: nothing but the page can read them, so the file
 * is read through its tab (`download.page`). The K client's address says the file's size, type and
 * name; the viewer's caption is the title, its sender the author.
 */
interface Seen {
  src: string;
  caption?: string;
  sender?: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** What the K client's stream address carries: `/k/stream/<url-encoded JSON>`. */
interface StreamInfo {
  size?: number;
  mimeType?: string;
  fileName?: string;
}

export function streamInfo(src: string): StreamInfo {
  const at = src.indexOf('/stream/');
  if (at < 0) return {};
  try {
    return JSON.parse(decodeURIComponent(src.slice(at + 8).split(/[?#]/)[0]!)) as StreamInfo;
  } catch {
    return {};
  }
}

export const telegram: SiteAdapter = {
  id: 'telegram',
  matches: (url) => url.hostname === 'web.telegram.org',
  // The video on the screen, whatever chat the address names.
  videoId: (url) => (/^\/(k|a)(\/|$)/.test(url.pathname) ? 'viewer' : undefined),
  collect: () => {
    // Runs in the page by itself.
    const videos = [...document.querySelectorAll('video')].filter((v) => v.currentSrc || v.src);
    const viewer = videos.filter((v) =>
      v.closest('.media-viewer-whole, .MediaViewer, #MediaViewer, .media-viewer'),
    );
    const area = (v: HTMLVideoElement) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const pick = [...(viewer.length ? viewer : videos)].sort(
      (a, b) => Number(!b.paused) - Number(!a.paused) || area(b) - area(a),
    )[0];
    if (!pick) return Promise.resolve(null);
    const box = pick.closest('.media-viewer-whole, .MediaViewer, #MediaViewer, .media-viewer');
    const text = (selectors: string) =>
      (box?.querySelector(selectors)?.textContent ?? '').trim() || undefined;
    const seen = {
      src: pick.currentSrc || pick.src,
      caption: text(
        '.media-viewer-caption, .MediaViewerFooter, .media-viewer-footer, .media-caption',
      ),
      sender: text('.media-viewer-name, .SenderInfo .title, .media-viewer-author .title'),
      duration: Number.isFinite(pick.duration) ? pick.duration : undefined,
      width: pick.videoWidth || undefined,
      height: pick.videoHeight || undefined,
    };
    return Promise.resolve(JSON.stringify(seen));
  },
  parse(answer, page): SiteVideo[] {
    if (typeof answer !== 'string') return [];
    let seen: Seen;
    try {
      seen = JSON.parse(answer) as Seen;
    } catch {
      return [];
    }
    if (!seen.src) return [];
    const info = streamInfo(seen.src);
    const caption = seen.caption?.replace(/\s+/g, ' ').trim();
    const name = info.fileName?.replace(/\.[a-z0-9]{2,4}$/i, '');
    return [
      {
        kind: 'file',
        url: seen.src,
        // The size the K client's address says: exact.
        size: info.size,
        mimeType: info.mimeType,
        title: caption?.slice(0, 100) || name || 'Telegram',
        description: caption && caption.length > 100 ? caption : undefined,
        author: seen.sender,
        duration: seen.duration,
        pageUrl: page.href,
        download: { page: true },
      },
    ];
  },
};
