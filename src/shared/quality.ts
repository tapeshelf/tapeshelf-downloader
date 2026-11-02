/** Which quality to save, and how big a stream may turn out. */
export type QualityPref = 'best' | 2160 | 1440 | 1080 | 720 | 480 | 360;

export const QUALITY_PREFS: QualityPref[] = ['best', 2160, 1440, 1080, 720, 480, 360];

/** What one multipart upload carries at most: 10 000 parts of 16 MB (the server's limit). */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 10_000;

/** Bytes of `seconds` at `bandwidth` bits a second. */
export const estimateBytes = (bandwidth: number, seconds: number) =>
  Math.ceil((bandwidth * seconds) / 8);

/**
 * The quality to save from `options` (best first): the best one not above the preferred height
 * whose estimate fits in `room` bytes (-1: no limit). None fits: the smallest, which the upload
 * will refuse with the reason. All above the preference: the lowest of them.
 */
export function pickQuality<T extends { height?: number; estimate?: number }>(
  options: T[],
  pref: QualityPref,
  room: number,
): T | undefined {
  const allowed = pref === 'best' ? options : options.filter((o) => (o.height ?? 0) <= pref);
  if (!allowed.length) return options[options.length - 1];
  const fits = (o: T) => room < 0 || o.estimate === undefined || o.estimate <= room;
  return (
    allowed.find(fits) ??
    allowed.reduce((a, b) => ((b.estimate ?? Infinity) < (a.estimate ?? Infinity) ? b : a))
  );
}

/**
 * What to declare for a stream, whose length is known only at its end: the estimate with a margin
 * (`factor` grows it after a stream outgrew its first guess), never past the room left (-1: none)
 * or what an upload can carry.
 */
export function streamBound(estimate: number | undefined, room: number, factor = 1): number {
  const cap = Math.min(room < 0 ? Infinity : room, MAX_UPLOAD_BYTES);
  if (!estimate) return cap === Infinity ? MAX_UPLOAD_BYTES : cap;
  return Math.max(1, Math.min(Math.ceil(estimate * 1.3 * factor) + 4 * 1024 * 1024, cap));
}

/** Room for one video: the file size limit and the free space, whichever is smaller (-1: none). */
export function roomFor(limits: { maxFileBytes: number; freeBytes: number }): number {
  const caps = [
    limits.maxFileBytes > 0 ? limits.maxFileBytes : Infinity,
    limits.freeBytes >= 0 ? limits.freeBytes : Infinity,
  ];
  const room = Math.min(...caps);
  return room === Infinity ? -1 : room;
}

/**
 * The chosen quality among a site's fresh links: the one of the same height as the key chosen
 * before (links change, heights stay); none chosen, or gone: none (the preference decides).
 */
export function sameQuality(
  before: { key: string; height?: number }[] | undefined,
  key: string | undefined,
  fresh: { key: string; height?: number }[] | undefined,
): string | undefined {
  const was = key ? before?.find((q) => q.key === key) : undefined;
  return was ? fresh?.find((q) => q.height === was.height)?.key : undefined;
}
