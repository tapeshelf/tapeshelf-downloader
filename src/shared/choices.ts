import { formatBytes } from './format';
import type { Lang, Translate } from './i18n';
import type { FoundMedia, Quality } from './media';
import { qualityLabel } from './streams';

/**
 * A video's choices in words, the same in the popup and in the menu of the button on
 * a site's page: each quality with what it takes on the disk, the sound alone last.
 */

/** File sizes asked of the sites' servers, by address (null: it did not say). */
export type Sizes = ReadonlyMap<string, number | null>;

/** The sound alone in a video's list. */
export const AUDIO = 'audio';

export interface Choice {
  value: string;
  label: string;
}

/** The sound's bytes, for a video whose sound is a file of its own; 0 when it has none. */
function soundBytes(m: FoundMedia, sizes: Sizes): number | undefined {
  if (!m.audio) return 0;
  return m.audio.size ?? sizes.get(m.audio.url) ?? undefined;
}

/**
 * What a quality takes on the disk: exact when the site or its server says, else "≈" from
 * the bit rate and the length; the sound apart counted in.
 */
export function sizeOf(
  m: FoundMedia,
  q: Quality | undefined,
  sizes: Sizes,
): { bytes: number; exact: boolean } | undefined {
  const sound = soundBytes(m, sizes);
  const exact = q ? (q.size ?? sizes.get(q.key)) : (m.size ?? sizes.get(m.url));
  if (exact) return { bytes: exact + (sound ?? 0), exact: sound !== undefined };
  if (q?.estimate) return { bytes: q.estimate + (sound ?? 0), exact: false };
  return undefined;
}

export function sizeLabel(size: { bytes: number; exact: boolean } | undefined, lang: Lang): string {
  if (!size) return '';
  const text = formatBytes(size.bytes, lang);
  return size.exact ? text : `≈ ${text}`;
}

/** What the sound comes as, when known: a site's sound apart says its type. */
export function soundContainer(m: FoundMedia): string {
  if (!m.audio) return '';
  return m.audio.mimeType === 'audio/webm' ? 'Opus' : 'M4A';
}

/** The sound's size, when it is a file of its own. */
export function soundSize(m: FoundMedia, sizes: Sizes, lang: Lang): string {
  const bytes = m.audio && (m.audio.size ?? sizes.get(m.audio.url));
  return bytes ? formatBytes(bytes, lang) : '';
}

/**
 * Each quality with its size — or, for a file of none, the video as it is (`''`, with the height
 * its player shows) — and the sound alone last.
 */
export function videoChoices(
  m: FoundMedia,
  sizes: Sizes,
  t: Translate,
  lang: Lang,
  height?: number,
): Choice[] {
  const qualities = m.qualities ?? [];
  const video = qualities.length
    ? qualities.map((q) => ({
        value: q.key,
        label: [qualityLabel(q), sizeLabel(sizeOf(m, q, sizes), lang)].filter(Boolean).join(' · '),
      }))
    : [
        {
          value: '',
          label: [
            t('found.video'),
            height ? `${height}p` : '',
            sizeLabel(sizeOf(m, undefined, sizes), lang),
          ]
            .filter(Boolean)
            .join(' · '),
        },
      ];
  return [
    ...video,
    {
      value: AUDIO,
      label: [t('found.audioOnly'), soundContainer(m), soundSize(m, sizes, lang)]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}
