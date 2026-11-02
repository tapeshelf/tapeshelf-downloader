import type { DownloadOptions, MediaKind, Quality, SubtitleTrack } from '../shared/media';

/**
 * A site adapter: for a site whose page does not simply play a file, it asks the
 * site what the video is — its title, description, picture and every quality — with the person's
 * own session there. What it finds replaces what the network showed for that page.
 */
export interface SiteVideo {
  kind: MediaKind;
  /** The file (its best quality) or the stream's manifest. */
  url: string;
  /** A file's exact bytes and type, when the site says (Telegram Web's address does). */
  size?: number;
  mimeType?: string;
  /** Files of a site that gives each quality as its own file: `key` is that file's address. */
  qualities?: Quality[];
  /** The sound as a file of its own, when the video files have none (muxed by the worker). */
  audio?: { url: string; size?: number; mimeType?: string };
  download?: DownloadOptions;
  title: string;
  description?: string;
  thumbnail?: string;
  /** Who posted it (a name or a handle). */
  author?: string;
  subtitles?: SubtitleTrack[];
  duration?: number;
  /** The video's own page: the source link. */
  pageUrl: string;
  sensitive?: boolean;
}

/**
 * A request from the extension to the site: the Referer (the video's page unless given) and the
 * adapter's User-Agent set on it first, the person's cookies of the site with it.
 */
export type SiteFetch = (url: string, init?: RequestInit, referer?: string) => Promise<Response>;

/** The text of an answer, or null when the site refused. */
export const textOf = async (res: Response) => (res.ok ? res.text() : null);

export interface SiteAdapter {
  id: string;
  /** The site's pages. */
  matches(url: URL): boolean;
  /** The video a page's address names, when it names one. */
  videoId(url: URL): string | undefined;
  /**
   * Asks the site from inside the page (its origin, its cookies, its own headers). It runs there
   * by itself, so it uses nothing from outside its body. Null: the page cannot, `ask` instead.
   */
  collect: (id: string) => Promise<unknown>;
  /**
   * The same question from the extension, with the person's cookies of the site: when the page
   * cannot answer, and again when a saved video's turn in the queue comes — a site's links expire.
   * `page` is the video's page; `fromPage`, what `collect` found (with `askAlways`), else null.
   */
  ask?: (id: string, page: URL, fetchSite: SiteFetch, fromPage: unknown) => Promise<unknown>;
  /** Asked from the extension even when the page answered: the page only lends what it knows. */
  askAlways?: boolean;
  /** The User-Agent of the client the site's links are made for (YouTube). */
  userAgent?: string;
  /** What the site answered, as videos to save (pure: tested on saved answers). */
  parse(answer: unknown, page: URL, id: string): SiteVideo[];
}
