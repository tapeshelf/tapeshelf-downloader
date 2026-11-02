/** What a page says about itself and its videos: read in the page when the popup opens. */
export interface PageVideo {
  src?: string;
  poster?: string;
  duration?: number;
  width: number;
  height: number;
  playing: boolean;
  /** Its source is the page's own (blob:): a player that builds the video itself. */
  built?: boolean;
  /** Built in a worker (MSE in workers): out of a buffer's reach, a recording reloads. */
  worker?: boolean;
  /** Square pixels it takes on the screen: the biggest one is the page's video. */
  area: number;
  /** Its subtitles (<track kind="subtitles|captions">). */
  tracks?: { src: string; language?: string; label?: string }[];
}

export interface PageInfo {
  url: string;
  title: string;
  description?: string;
  image?: string;
  /** The page labels itself for adults (RTA label, rating meta): the video is marked 18+. */
  adult: boolean;
  videos: PageVideo[];
}

/**
 * Runs inside the page (chrome.scripting.executeScript serialises it): self-contained, no
 * imports and nothing from outside its body.
 */
export function readPage(): PageInfo {
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute('content')?.trim() || undefined;
  const absolute = (url: string | undefined) => {
    try {
      return url ? new URL(url, location.href).href : undefined;
    } catch {
      return undefined;
    }
  };
  const rating = [...document.querySelectorAll('meta[name="rating" i], meta[name="RATING"]')]
    .map((m) => (m.getAttribute('content') ?? '').toLowerCase())
    .join(' ');
  const videos = [...document.querySelectorAll('video')].map((v) => {
    const box = v.getBoundingClientRect();
    const src = v.currentSrc || v.src || v.querySelector('source')?.src || undefined;
    const worker =
      typeof MediaSourceHandle !== 'undefined' && v.srcObject instanceof MediaSourceHandle;
    return {
      src: src && /^https?:/.test(src) ? src : undefined,
      poster: absolute(v.poster || undefined),
      duration: Number.isFinite(v.duration) ? v.duration : undefined,
      width: v.videoWidth,
      height: v.videoHeight,
      playing: !v.paused,
      worker,
      built: worker || (!!src && src.startsWith('blob:')),
      area: Math.round(box.width * box.height),
      tracks: [...v.querySelectorAll('track')]
        .filter((t) => ['subtitles', 'captions', ''].includes(t.kind) && /^https?:/.test(t.src))
        .map((t) => ({
          src: t.src,
          language: t.srclang || undefined,
          label: t.label || undefined,
        })),
    };
  });
  return {
    url: location.href,
    title: meta('meta[property="og:title"]') ?? document.title.trim(),
    description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    image: absolute(meta('meta[property="og:image"]')),
    adult: /\badult\b|rta-5042|\bmature\b/.test(rating),
    videos,
  };
}
