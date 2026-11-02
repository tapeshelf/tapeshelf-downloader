/**
 * HLS playlists (RFC 8216): a master lists the qualities, a media playlist lists the segments. The
 * extension saves an HLS video by downloading the segments in order and joining them: MPEG-TS one
 * after another, fMP4 the init section and then the fragments. Standard AES-128 is decrypted in the
 * browser; SAMPLE-AES and key systems (FairPlay, Widevine…) are DRM and not saved.
 */
export interface ByteRange {
  length: number;
  offset: number;
}

export interface HlsKey {
  url: string;
  /** From the playlist, or null: then the segment's media sequence number is the IV. */
  iv: Uint8Array | null;
}

export interface HlsInit {
  url: string;
  range?: ByteRange;
}

export interface HlsSegment {
  url: string;
  duration: number;
  range?: ByteRange;
  key: HlsKey | null;
  sequence: number;
  /** The fMP4 init section this segment needs. */
  init?: HlsInit;
  /** Part of an ad break: marked by the playlist, or a short stretch from another host. */
  ad?: boolean;
}

export interface HlsVariant {
  url: string;
  /** Peak bits per second. */
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  /** GROUP-ID of its audio renditions. */
  audio?: string;
}

export interface HlsRendition {
  group: string;
  /** None: the audio is inside the variant itself. */
  url?: string;
  name?: string;
  language?: string;
  isDefault: boolean;
}

export interface HlsMaster {
  type: 'master';
  variants: HlsVariant[];
  audio: HlsRendition[];
  /** Subtitles: playlists of WebVTT segments. */
  subtitles: HlsRendition[];
}

export interface HlsMedia {
  type: 'media';
  segments: HlsSegment[];
  /** Seconds. */
  duration: number;
  /** No #EXT-X-ENDLIST: a live stream, still growing. */
  live: boolean;
  /** Encrypted other than standard AES-128. */
  drm: boolean;
  /** Fragmented MP4 (an init section) rather than MPEG-TS. */
  fmp4: boolean;
  /** Seconds a segment lasts at most: how often a live playlist is worth asking again. */
  targetDuration?: number;
}

/** `KEY=value,KEY="quoted, with commas"` of a tag. */
export function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const value = line.slice(line.indexOf(':') + 1);
  for (const m of value.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    out[m[1]!] = m[2]!.startsWith('"') ? m[2]!.slice(1, -1) : m[2]!;
  return out;
}

function byteRange(value: string | undefined, next: number): ByteRange | undefined {
  if (!value) return undefined;
  const [length, offset] = value.split('@');
  return { length: Number(length), offset: offset === undefined ? next : Number(offset) };
}

function hexIv(value: string | undefined): Uint8Array | null {
  const hex = value?.replace(/^0x/i, '');
  if (!hex) return null;
  const padded = hex.padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return iv;
}

const resolve = (uri: string, base: string) => new URL(uri, base).href;

export function parseHls(text: string, baseUrl: string): HlsMaster | HlsMedia {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], base: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const audio: HlsRendition[] = [];
  const subtitles: HlsRendition[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (!uri) return;
      const a = attributes(line);
      const [width, height] = (a['RESOLUTION'] ?? '').split('x').map(Number);
      variants.push({
        url: resolve(uri, base),
        bandwidth: Number(a['BANDWIDTH'] ?? 0),
        averageBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : undefined,
        width: width || undefined,
        height: height || undefined,
        codecs: a['CODECS'],
        audio: a['AUDIO'],
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line);
      if (a['TYPE'] === 'SUBTITLES' && a['URI'])
        subtitles.push({
          group: a['GROUP-ID'] ?? '',
          url: resolve(a['URI'], base),
          name: a['NAME'],
          language: a['LANGUAGE'],
          isDefault: a['DEFAULT'] === 'YES',
        });
      if (a['TYPE'] !== 'AUDIO') return;
      audio.push({
        group: a['GROUP-ID'] ?? '',
        url: a['URI'] ? resolve(a['URI'], base) : undefined,
        name: a['NAME'],
        language: a['LANGUAGE'],
        isDefault: a['DEFAULT'] === 'YES',
      });
    }
  });
  return { type: 'master', variants, audio, subtitles };
}

function parseMedia(lines: string[], base: string): HlsMedia {
  const segments: HlsSegment[] = [];
  let sequence = 0;
  let duration = 0;
  let pending: number | null = null;
  let range: string | undefined;
  let nextOffset = 0;
  let key: HlsKey | null = null;
  let init: HlsInit | undefined;
  let drm = false;
  let live = true;
  let inAd = false;
  let run = 0;
  let targetDuration: number | undefined;
  const runs: number[] = [];
  // Twitch's live playlists: its own segments are titled "live", ads stitched in are not.
  const titles: string[] = [];
  let title = '';
  let twitchAds = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-DATERANGE:') && line.includes('twitch-stitched-ad'))
      twitchAds = true;
    // Ad breaks as playlists mark them: SCTE-35 cues (CUE-OUT … CUE-IN) or their DATERANGEs.
    if (/^#EXT-X-CUE-OUT(?!-CONT)/.test(line)) inAd = true;
    else if (line.startsWith('#EXT-X-CUE-IN')) inAd = false;
    else if (line.startsWith('#EXT-X-DATERANGE:') && /SCTE35-OUT=/.test(line)) inAd = true;
    else if (line.startsWith('#EXT-X-DATERANGE:') && /SCTE35-IN=/.test(line)) inAd = false;
    else if (line === '#EXT-X-DISCONTINUITY') run++;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.split(':')[1]);
    else if (line.startsWith('#EXTINF:')) {
      pending = parseFloat(line.slice(8));
      const comma = line.indexOf(',');
      title = comma < 0 ? '' : line.slice(comma + 1).trim();
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line === '#EXT-X-ENDLIST' || line === '#EXT-X-PLAYLIST-TYPE:VOD') live = false;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line);
      const format = a['KEYFORMAT'] ?? 'identity';
      if (a['METHOD'] === 'NONE') key = null;
      else if (a['METHOD'] === 'AES-128' && format === 'identity' && a['URI'])
        key = { url: resolve(a['URI'], base), iv: hexIv(a['IV']) };
      else drm = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line);
      if (a['URI']) init = { url: resolve(a['URI'], base), range: byteRange(a['BYTERANGE'], 0) };
    } else if (!line.startsWith('#') && pending !== null) {
      const url = resolve(line, base);
      const r = byteRange(range, url === segments[segments.length - 1]?.url ? nextOffset : 0);
      if (r) nextOffset = r.offset + r.length;
      segments.push({
        url,
        duration: pending,
        range: r,
        key,
        sequence: sequence++,
        init,
        ad: inAd,
      });
      runs.push(run);
      titles.push(title);
      duration += pending;
      pending = null;
      range = undefined;
    }
  }
  markUnmarkedAds(segments, runs);
  if (twitchAds && titles.includes('live'))
    segments.forEach((s, i) => titles[i] !== 'live' && (s.ad = true));
  return { type: 'media', segments, duration, live, drm, fmp4: !!init, targetDuration };
}

/**
 * Ads stitched in without marks: a stretch between discontinuities, under two and a half minutes,
 * from another host than most of the video.
 */
function markUnmarkedAds(segments: HlsSegment[], runs: number[]): void {
  if (new Set(runs).size < 2) return;
  const hostOf = (url: string) => new URL(url).host;
  const byHost = new Map<string, number>();
  for (const s of segments)
    byHost.set(hostOf(s.url), (byHost.get(hostOf(s.url)) ?? 0) + s.duration);
  const main = [...byHost.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const lengths = new Map<number, number>();
  segments.forEach((s, i) => lengths.set(runs[i]!, (lengths.get(runs[i]!) ?? 0) + s.duration));
  segments.forEach((s, i) => {
    if (hostOf(s.url) !== main && (lengths.get(runs[i]!) ?? 0) <= 150) s.ad = true;
  });
}
