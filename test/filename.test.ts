import { describe, expect, it } from 'vitest';

import {
  downloadPath,
  renderName,
  safeFolder,
  safeSegment,
  siteOf,
  today,
} from '../src/shared/filename';
import type { FileName } from '../src/shared/jobs';

const NAME: FileName = {
  template: '{title}',
  folder: 'tapeshelf',
  title: 'Sea at dawn',
  site: 'vk.com',
  date: '2026-10-26',
};

describe('the downloaded file’s name', () => {
  it('“Title.mp4” in the tapeshelf folder by default', () => {
    expect(downloadPath(NAME, '1080p', 'mp4')).toBe('tapeshelf/Sea at dawn.mp4');
    expect(downloadPath({ ...NAME, folder: '' }, undefined, 'webm')).toBe('Sea at dawn.webm');
  });

  it('a template of the fields; an empty field takes its brackets and its dash along', () => {
    const values = { title: 'Sea at dawn', site: 'vk.com', quality: '1080p', date: '2026-10-26' };
    expect(renderName('{title} ({site})', values)).toBe('Sea at dawn (vk.com)');
    expect(renderName('{title} [{quality}]', values)).toBe('Sea at dawn [1080p]');
    expect(renderName('{site} — {title}', values)).toBe('vk.com — Sea at dawn');
    expect(renderName('{title} [{quality}]', { ...values, quality: '' })).toBe('Sea at dawn');
    expect(renderName('{author} — {title}', values)).toBe('Sea at dawn');
    expect(renderName('{site} — {author} — {title}', values)).toBe('vk.com — Sea at dawn');
    expect(renderName('{title} - {author}', values)).toBe('Sea at dawn');
    expect(renderName('{date} {title} ({author})', values)).toBe('2026-10-26 Sea at dawn');
    // Not a field: left as typed.
    expect(renderName('{title} {nope}', values)).toBe('Sea at dawn {nope}');
  });

  it('a name every system takes: no reserved characters, no dots at the ends, no device names', () => {
    expect(safeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeSegment('...hidden. ')).toBe('hidden');
    expect(safeSegment('CON')).toBe('_CON');
    expect(safeSegment('nul.txt')).toBe('_nul.txt');
    expect(safeSegment('line\nbreak​zero')).toBe('line break zero');
    expect(safeSegment('   ')).toBe('video');
    expect(safeSegment('', '')).toBe('');
  });

  it('a long title cut to 200 bytes between letters (Cyrillic is two bytes a letter)', () => {
    const long = 'Закат'.repeat(60);
    const cut = safeSegment(long);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(200);
    expect(cut.length).toBe(100);
    expect(safeSegment('🎬'.repeat(80)).length).toBe(100);
  });

  it('the folder: its parts made safe, “..” and empty parts dropped', () => {
    expect(safeFolder('videos/tapeshelf')).toBe('videos/tapeshelf');
    expect(safeFolder('../../etc')).toBe('etc');
    expect(safeFolder('/a//b/')).toBe('a/b');
    expect(downloadPath({ ...NAME, folder: 'x/../y' }, undefined, 'mp4')).toBe(
      'x/y/Sea at dawn.mp4',
    );
  });

  it('a template that leaves nothing falls back to the title', () => {
    expect(downloadPath({ ...NAME, template: '{author}' }, undefined, 'mp4')).toBe(
      'tapeshelf/Sea at dawn.mp4',
    );
    expect(downloadPath({ ...NAME, template: '{author}', title: '' }, undefined, 'mp4')).toBe(
      'tapeshelf/video.mp4',
    );
  });

  it('the date and the site as the fields say', () => {
    expect(today(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(siteOf('https://www.vk.com/video-1_2')).toBe('vk.com');
    expect(siteOf('not a url')).toBe('');
  });
});
