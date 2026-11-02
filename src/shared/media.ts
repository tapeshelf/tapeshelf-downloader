import type { QualityPref } from './quality';

/**
 * What the extension finds on a tab and what it is asked to save. A video is a file (mp4, webm…)
 * or a stream: an HLS playlist or a DASH manifest, saved by joining its segments.
 */
export type MediaKind = 'file' | 'hls' | 'dash';

/** One quality: an HLS variant, a DASH video representation, or a site's file of that size. */
export interface Quality {
  /** The variant's URL (HLS), the representation's id (DASH), the file's URL (a site's file). */
  key: string;
  /** Its name, for a site that names its qualities without saying their size ("HD"). */
  label?: string;
  width?: number;
  height?: number;
  /** Bytes, from the bit rate and the length. */
  estimate?: number;
  /** Exact bytes, when the site says (no need to ask its server). */
  size?: number;
  /** A site's file of another type than MP4 (WebM). */
  mimeType?: string;
}

/** Subtitles a video has: saved as an .srt beside the video when picked. */
export interface SubtitleTrack {
  /** BCP 47: en, ru, pt-BR… */
  language?: string;
  /** Its name on the site: "English (auto-generated)". */
  label?: string;
  /** A WebVTT file, an SRT file, an HLS playlist of WebVTT segments. */
  kind: 'vtt' | 'srt' | 'hls';
  url: string;
}

/** How a site wants its files fetched (YouTube). */
export interface DownloadOptions {
  /** The User-Agent its links were made for (set on the extension's own requests only). */
  userAgent?: string;
  /** Read the file in ranges of this many bytes (a site that slows down whole-file reads). */
  chunk?: number;
  /**
   * Only its page can read the file (Telegram Web's own service worker answers its
   * addresses): the adapter says so, and the tab it was found in is filled in.
   */
  page?: boolean;
  tab?: number;
}

export interface FoundMedia {
  /** Kind and URL without its fragment: the same video found twice is one. */
  id: string;
  kind: MediaKind;
  url: string;
  /** The page the tab showed: the source link. */
  pageUrl: string;
  /** What its downloads send as Referer: the page, or the frame that played it. */
  referer?: string;
  foundAt: number;
  /** Bytes, when the response said (Content-Length, or the total of a Content-Range). */
  size?: number;
  mimeType?: string;
  /** Seconds, for streams (from the playlist). */
  duration?: number;
  live?: boolean;
  drm?: boolean;
  /** Streams: best first. */
  qualities?: Quality[];
  /** An HLS variant whose master playlist is on the same tab: the master stands for it. */
  hidden?: boolean;
  /** Found by a site's adapter (its id): the site's own title, description and picture. */
  site?: string;
  /** The video's id on its site (`#n` for a post's n-th): to ask the site again later. */
  siteId?: string;
  /** The sound as a file of its own (a site's video files without sound). */
  audio?: { url: string; size?: number; mimeType?: string };
  download?: DownloadOptions;
  title?: string;
  description?: string;
  thumbnail?: string;
  /** Who posted it, when the site says: the file name's `{author}`. */
  author?: string;
  sensitive?: boolean;
  subtitles?: SubtitleTrack[];
}

export type Visibility = 'PRIVATE' | 'PUBLIC';

/**
 * What a download keeps: the video; its sound only, as it is (M4A, Opus…); or its sound
 * as MP3. The shelf always takes the video.
 */
export type DownloadFormat = 'video' | 'audio' | 'mp3';

/** What the video is called on the shelf and where it goes. */
export interface VideoMeta {
  title: string;
  description?: string;
  categoryId?: string;
  visibility: Visibility;
  /** 18+ (the app's "sensitive"). */
  sensitive: boolean;
}

/** A video the person asked to save: what to download, in which quality, and how to file it. */
export interface SaveRequest {
  media: Pick<
    FoundMedia,
    | 'kind'
    | 'url'
    | 'pageUrl'
    | 'referer'
    | 'size'
    | 'mimeType'
    | 'qualities'
    | 'site'
    | 'siteId'
    | 'audio'
    | 'download'
  >;
  /** A stream's quality key chosen in the form; none: `pref`. */
  quality?: string;
  /** A download's: the video unless said. */
  format?: DownloadFormat;
  /** The sound's language the settings prefer, when a video has several. */
  audioLanguage?: string;
  /** Leave out a stream's marked ad breaks. */
  skipAds?: boolean;
  /** Subtitles picked, saved beside a download as .srt. */
  subtitles?: SubtitleTrack;
  /** A live stream recorded to the computer: from its start (as far back as it keeps) or now. */
  live?: { from: 'start' | 'now' };
  /** What the tab's player plays, recorded as it plays. */
  capture?: { tabId: number };
  pref: QualityPref;
  meta: VideoMeta;
  /** The page, kept on the video for its author when the settings say so. */
  sourceUrl?: string;
}

export const mediaId = (kind: MediaKind, url: string) => `${kind}:${url.split('#')[0]}`;
