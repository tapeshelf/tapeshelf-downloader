import type { Quality, SubtitleTrack } from '../shared/media';
import { textOf, type SiteAdapter } from './types';

/**
 * YouTube (only in the full build — the stores take down extensions that save
 * from YouTube). A watch page, a Short or a live recording names its video; the extension asks
 * YouTube's player API as a client whose links need no signature to decipher and no proof of
 * origin (visionOS today — YouTube changes this every few months; yt-dlp's list of clients is the
 * place to look), with the page's visitor id. Video and sound come as separate files with their
 * exact sizes, read in 10 MB ranges (YouTube slows whole-file reads) and muxed by the worker.
 */
export const YT_CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
};
const YT_CLIENT_ID = '101';
const CHUNK = 10 * 1024 * 1024;

interface YtFormat {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  contentLength?: string;
  type?: string;
  targetDurationSec?: number;
}

interface YtPlayer {
  playabilityStatus?: { status?: string };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    shortDescription?: string;
    lengthSeconds?: string;
    isLive?: boolean;
    thumbnail?: { thumbnails?: { url?: string }[] };
  };
  streamingData?: { formats?: YtFormat[]; adaptiveFormats?: YtFormat[] };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: {
        baseUrl?: string;
        languageCode?: string;
        name?: { simpleText?: string; runs?: { text?: string }[] };
      }[];
    };
  };
}

/** Its subtitles, as WebVTT from YouTube's own timed text. */
function captionsOf(player: YtPlayer): SubtitleTrack[] {
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return tracks
    .filter((t) => t.baseUrl && /^https:\/\/[^/]*youtube\.com\//.test(t.baseUrl))
    .map((t) => ({
      kind: 'vtt' as const,
      url: `${t.baseUrl}&fmt=vtt`,
      language: t.languageCode,
      label: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text ?? '').join(''),
    }));
}

/** A file to download as it is: a direct link, not a live or segmented (OTF) stream. */
const direct = (f: YtFormat) =>
  !!f.url && !f.signatureCipher && !f.targetDurationSec && f.type !== 'FORMAT_STREAM_TYPE_OTF';
const typeOf = (f: YtFormat) => (f.mimeType ?? '').split(';')[0]!.trim();
/** H.264 plays everywhere, then VP9, then AV1. */
const codecRank = (f: YtFormat) =>
  /avc1/.test(f.mimeType ?? '') ? 0 : /vp0?9/.test(f.mimeType ?? '') ? 1 : 2;
const side = (w?: number, h?: number) => (w && h ? Math.min(w, h) : h || w || 0);

export function youtubeQualities(formats: YtFormat[]): Quality[] {
  const best = new Map<number, YtFormat>();
  for (const f of formats) {
    const height = side(f.width, f.height);
    if (!height) continue;
    const known = best.get(height);
    if (
      !known ||
      codecRank(f) < codecRank(known) ||
      (codecRank(f) === codecRank(known) && (f.bitrate ?? 0) > (known.bitrate ?? 0))
    )
      best.set(height, f);
  }
  return [...best.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, f]) => ({
      key: f.url!,
      height,
      width: f.width,
      size: Number(f.contentLength) || undefined,
      mimeType: typeOf(f) === 'video/webm' ? 'video/webm' : undefined,
    }));
}

/** The player API's question for a video, as the device client, with what the page lent. */
export function playerRequest(id: string, fromPage: unknown): RequestInit {
  let page: { visitorData?: string; hl?: string; gl?: string } = {};
  try {
    // The page may have lent nothing ("null"): then the question goes without.
    page = (JSON.parse(String(fromPage)) as typeof page | null) ?? {};
  } catch {
    page = {};
  }
  return {
    method: 'POST',
    // As a device client, not the person's signed-in web session.
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': YT_CLIENT_ID,
      'X-YouTube-Client-Version': YT_CLIENT.clientVersion,
      ...(page.visitorData ? { 'X-Goog-Visitor-Id': page.visitorData } : {}),
    },
    body: JSON.stringify({
      context: {
        client: {
          ...YT_CLIENT,
          hl: page.hl ?? 'en',
          gl: page.gl ?? 'US',
          ...(page.visitorData ? { visitorData: page.visitorData } : {}),
        },
      },
      videoId: id,
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  };
}

export const youtube: SiteAdapter = {
  id: 'youtube',
  matches: (url) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(url.hostname),
  videoId(url) {
    const id =
      url.hostname === 'youtu.be'
        ? url.pathname.slice(1)
        : (url.searchParams.get('v') ??
          /^\/(?:shorts|live|embed|v)\/([\w-]+)/.exec(url.pathname)?.[1]);
    return id && /^[\w-]{11}$/.test(id) ? id : undefined;
  },
  // The page lends its visitor id and language; the question goes from the extension.
  collect: () => {
    const cfg = (window as unknown as { ytcfg?: { get?: (k: string) => unknown } }).ytcfg;
    const get = (k: string) => (typeof cfg?.get === 'function' ? cfg.get(k) : undefined);
    return Promise.resolve(
      JSON.stringify({ visitorData: get('VISITOR_DATA'), hl: get('HL'), gl: get('GL') }),
    );
  },
  askAlways: true,
  userAgent: YT_CLIENT.userAgent,
  ask: (id, _page, fetchSite, fromPage) =>
    fetchSite(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      playerRequest(id, fromPage),
      'https://www.youtube.com/',
    ).then(textOf),
  parse(answer, _page, id) {
    if (typeof answer !== 'string') return [];
    let player: YtPlayer;
    try {
      player = JSON.parse(answer) as YtPlayer;
    } catch {
      return [];
    }
    const details = player.videoDetails;
    if (player.playabilityStatus?.status !== 'OK' || details?.videoId !== id || details.isLive)
      return [];
    const adaptive = (player.streamingData?.adaptiveFormats ?? []).filter(direct);
    const video = adaptive.filter((f) => typeOf(f).startsWith('video/'));
    const sound = adaptive
      .filter((f) => typeOf(f).startsWith('audio/'))
      .sort(
        (a, b) =>
          Number(typeOf(b) === 'audio/mp4') - Number(typeOf(a) === 'audio/mp4') ||
          (b.bitrate ?? 0) - (a.bitrate ?? 0),
      )[0];
    // Separate picture and sound when both are there; else the files with both (360p at most).
    const pair = video.length > 0 && !!sound;
    const qualities = youtubeQualities(
      pair ? video : (player.streamingData?.formats ?? []).filter(direct),
    );
    if (!qualities[0]) return [];
    const thumbs = details.thumbnail?.thumbnails ?? [];
    return [
      {
        kind: 'file',
        url: qualities[0].key,
        qualities,
        audio: pair
          ? {
              url: sound.url!,
              size: Number(sound.contentLength) || undefined,
              mimeType: typeOf(sound) === 'audio/webm' ? 'audio/webm' : undefined,
            }
          : undefined,
        title: details.title?.trim() || id,
        author: details.author,
        subtitles: captionsOf(player),
        description: details.shortDescription?.trim() || undefined,
        thumbnail: thumbs[thumbs.length - 1]?.url,
        duration: Number(details.lengthSeconds) || undefined,
        pageUrl: `https://www.youtube.com/watch?v=${id}`,
        download: { userAgent: YT_CLIENT.userAgent, chunk: CHUNK },
      },
    ];
  },
};
