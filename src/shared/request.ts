import { isAdultSite } from './adult';
import { siteOf, today } from './filename';
import type { DownloadFormat, FoundMedia, SaveRequest, SubtitleTrack, VideoMeta } from './media';
import type { NewJob } from './messages';
import type { PageInfo } from './page-info';
import { pickQuality } from './quality';
import { onSite, siteKey, type Settings } from './settings';

/** The server's limits on a video's texts (uploads.dto: TITLE_MAX, DESCRIPTION_MAX). */
export const TITLE_MAX = 150;
export const DESCRIPTION_MAX = 2000;

/** A file's name from its address, without the extension: "Holiday clip" from /holiday%20clip.mp4. */
export function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last)
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[_+]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/** What the page says, as a video's title and description; the settings' defaults for the rest. */
export function defaultMeta(
  media: FoundMedia,
  page: PageInfo | undefined,
  settings: Settings,
  /** The person's categories, when known: a remembered one that is gone is left out. */
  categories?: { id: string }[],
): VideoMeta {
  const fromPage = page && page.url.split('#')[0] === media.pageUrl.split('#')[0];
  const title =
    media.title ||
    (fromPage ? page.title : '') ||
    nameFromUrl(media.url) ||
    new URL(media.pageUrl).hostname.replace(/^www\./, '');
  const known = !categories || categories.some((c) => c.id === settings.categoryId);
  return {
    title: title.slice(0, TITLE_MAX),
    description: (media.site ? media.description : fromPage ? page.description : undefined)?.slice(
      0,
      DESCRIPTION_MAX,
    ),
    categoryId: known ? (settings.categoryId ?? undefined) : undefined,
    visibility: settings.visibility,
    sensitive: media.sensitive ?? ((fromPage && page.adult) || isAdultSite(media.pageUrl)),
  };
}

/** The sound's language wanted: the settings', or the browser's. */
export const audioLanguageOf = (settings: Settings) =>
  settings.audioLanguage === 'auto' ? navigator.language : settings.audioLanguage;

export function saveRequest(
  media: FoundMedia,
  meta: VideoMeta,
  settings: Settings,
  quality?: string,
): SaveRequest {
  return {
    media: {
      kind: media.kind,
      url: media.url,
      pageUrl: media.pageUrl,
      referer: media.referer,
      size: media.size,
      mimeType: media.mimeType,
      qualities: media.kind === 'file' ? media.qualities : undefined,
      audio: media.audio,
      download: media.download,
      site: media.site,
      siteId: media.siteId,
    },
    quality,
    pref: settings.quality,
    audioLanguage: audioLanguageOf(settings),
    skipAds: settings.skipAds,
    meta: {
      ...meta,
      title: meta.title.trim().slice(0, TITLE_MAX),
      description: meta.description?.trim().slice(0, DESCRIPTION_MAX) || undefined,
    },
    sourceUrl: settings.saveSource ? media.pageUrl : undefined,
  };
}

/**
 * A video to download: in the quality picked (else the settings' one), named by the
 * settings' template from its title, its site and who posted it.
 */
export function downloadJob(
  media: FoundMedia,
  meta: VideoMeta,
  settings: Settings,
  quality?: string,
  thumbnail?: string,
  format: DownloadFormat = 'video',
  subtitles?: SubtitleTrack,
): NewJob {
  const key =
    format !== 'video'
      ? undefined
      : (quality ??
        (media.qualities?.length
          ? pickQuality(media.qualities, settings.quality, -1)?.key
          : undefined));
  return {
    target: 'disk',
    // Subtitles go with the picture, not with the sound alone.
    request: {
      ...saveRequest(media, meta, settings, key),
      format,
      subtitles: format === 'video' ? subtitles : undefined,
    },
    thumbnail: media.thumbnail ?? thumbnail,
    name: {
      // A site's own name rule first.
      template:
        settings.siteNames.find((r) => onSite(media.pageUrl, [siteKey(r.site)]))?.template ||
        settings.fileName,
      folder: settings.folder,
      title: meta.title.trim(),
      site: siteOf(media.pageUrl),
      author: media.author,
      date: today(),
    },
  };
}
