import type { FileName } from './jobs';

/**
 * The downloaded file's name: the settings' template — "{title}" unless the person built
 * another from the fields below — made safe for every system's file names, in the Downloads
 * folder the settings name.
 */
export const NAME_FIELDS = ['title', 'site', 'quality', 'date', 'author'] as const;
export type NameField = (typeof NAME_FIELDS)[number];

/** Most systems take 255 bytes for a name: room is left for " (1)" and the extension. */
const MAX_BYTES = 200;
/** Names Windows keeps for devices. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const SEPARATOR = '[-–—|·,_]';

/** The template with its fields filled; a field with nothing to say takes its brackets and dash along. */
export function renderName(
  template: string,
  values: Partial<Record<NameField, string | undefined>>,
): string {
  const filled = template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    (NAME_FIELDS as readonly string[]).includes(key)
      ? (values[key as NameField] ?? '').trim()
      : whole,
  );
  return filled
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
    .replace(new RegExp(`\\s*(${SEPARATOR})(\\s*${SEPARATOR})+\\s*`, 'g'), ' $1 ')
    .replace(new RegExp(`^[\\s.]*(${SEPARATOR}[\\s.]*)*|([\\s.]*${SEPARATOR})*[\\s.]*$`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `max` bytes of a text in UTF-8, cut between characters. */
function cutBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out.trim();
}

/** One part of a path that every system takes: no reserved characters, dots or spaces at its ends. */
export function safeSegment(name: string, fallback = 'video'): string {
  let s = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|]|\p{Cc}|\p{Cf}/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (RESERVED.test(s)) s = `_${s}`;
  s = cutBytes(s, MAX_BYTES).replace(/[.\s]+$/, '');
  return s || fallback;
}

/** The folder in Downloads as the settings have it: its parts made safe, empty ones dropped. */
export const safeFolder = (folder: string) =>
  folder
    .split(/[\\/]+/)
    .map((part) => safeSegment(part, ''))
    .filter(Boolean)
    .join('/');

/** Where in Downloads the file goes: "tapeshelf/Sea at dawn.mp4". */
export function downloadPath(name: FileName, quality: string | undefined, ext: string): string {
  const base = safeSegment(
    renderName(name.template, { ...name, quality }),
    safeSegment(name.title),
  );
  const folder = safeFolder(name.folder);
  return `${folder ? `${folder}/` : ''}${base}.${ext}`;
}

/** Today in the person's time zone, as the name's `{date}`: 2026-10-26. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The site of a page, as the name's `{site}`: vk.com, not www.vk.com. */
export function siteOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
