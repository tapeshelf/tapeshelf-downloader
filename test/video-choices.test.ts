import { describe, expect, it } from 'vitest';

import { AUDIO, videoChoices } from '../src/shared/choices';
import { formatBytes } from '../src/shared/format';
import type { FoundMedia } from '../src/shared/media';

/** The lines of a video's choices, the same in the popup and the page's menu. */
const t = (key: string) =>
  ({ 'found.video': 'Video', 'found.audioOnly': 'Sound only' })[key] ?? key;
const MB = 1024 * 1024;
const media = (over: Partial<FoundMedia>): FoundMedia => ({
  id: 'x',
  kind: 'file',
  url: 'https://cdn.x/720.mp4',
  pageUrl: 'https://site.x/post/1',
  foundAt: 1,
  ...over,
});

describe('a video’s choices', () => {
  it('each quality with its size — exact when the site or its server says, else “≈” — the sound last', () => {
    const m = media({
      qualities: [
        { key: 'https://cdn.x/1080.mp4', height: 1080, size: 240 * MB },
        { key: 'https://cdn.x/720.mp4', height: 720 },
        { key: 'https://cdn.x/360.mp4', height: 360, estimate: 30 * MB },
      ],
    });
    const sizes = new Map([['https://cdn.x/720.mp4', 120 * MB]]);
    expect(videoChoices(m, sizes, t, 'en')).toEqual([
      { value: 'https://cdn.x/1080.mp4', label: `1080p · ${formatBytes(240 * MB, 'en')}` },
      { value: 'https://cdn.x/720.mp4', label: `720p · ${formatBytes(120 * MB, 'en')}` },
      { value: 'https://cdn.x/360.mp4', label: `360p · ≈ ${formatBytes(30 * MB, 'en')}` },
      { value: AUDIO, label: 'Sound only' },
    ]);
  });

  it('a file of no qualities: the video as it is, with its player’s height; a sound apart counted in', () => {
    const m = media({ size: 10 * MB, audio: { url: 'https://cdn.x/a.m4a', size: 2 * MB } });
    expect(videoChoices(m, new Map(), t, 'en', 720)).toEqual([
      { value: '', label: `Video · 720p · ${formatBytes(12 * MB, 'en')}` },
      { value: AUDIO, label: `Sound only · M4A · ${formatBytes(2 * MB, 'en')}` },
    ]);
  });
});
