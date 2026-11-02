import { describe, expect, it } from 'vitest';

import {
  FINISHED_SHOWN,
  history,
  inQueueOrder,
  pastHistory,
  targetOf,
  type Job,
  type JobStatus,
} from '../src/shared/jobs';
import type { FoundMedia } from '../src/shared/media';
import { downloadJob } from '../src/shared/request';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const job = (n: number, status: JobStatus, updatedAt = n): Job => ({
  id: `j${n}`,
  createdAt: n,
  updatedAt,
  status,
  server: 'https://tapeshelf.com',
  request: {
    media: { kind: 'file', url: `https://x/${n}.mp4`, pageUrl: 'https://x/' },
    pref: 'best',
    meta: { title: `Video ${n}`, visibility: 'PRIVATE', sensitive: false },
  },
});

describe('the queue in the popup', () => {
  it('the video being saved, then every one waiting (oldest first), then the latest finished', () => {
    const jobs = [
      ...Array.from({ length: 20 }, (_, i) => job(i + 10, 'queued')),
      job(5, 'running'),
      ...Array.from({ length: 15 }, (_, i) => job(i, 'done', 100 + i)),
      job(40, 'failed', 200),
    ];
    const { jobs: list, waiting } = inQueueOrder(jobs);
    expect(waiting).toBe(20);
    expect(list[0]!.status).toBe('running');
    expect(list.slice(1, 21).map((j) => j.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `j${i + 10}`),
    );
    const finished = list.slice(21);
    expect(finished).toHaveLength(FINISHED_SHOWN);
    expect(finished[0]!.id).toBe('j40');
  });
});

describe('the history', () => {
  it('finished downloads and saves, newest first; the oldest past its length go', () => {
    const jobs = [
      job(1, 'done', 10),
      { ...job(2, 'done', 30), target: 'disk' as const },
      job(3, 'running'),
      job(4, 'failed', 20),
      job(5, 'cancelled', 5),
    ];
    expect(history(jobs).map((j) => j.id)).toEqual(['j2', 'j4', 'j1', 'j5']);
    expect(pastHistory(jobs, 2).map((j) => j.id)).toEqual(['j1', 'j5']);
    expect(targetOf(job(1, 'done'))).toBe('shelf');
  });
});

describe('a video to download', () => {
  const media: FoundMedia = {
    id: 'file:vk:1',
    kind: 'file',
    url: 'https://vk.com/v/1080.mp4',
    pageUrl: 'https://vk.com/video-1_2',
    foundAt: 0,
    site: 'vk',
    author: 'Anna',
    thumbnail: 'https://vk.com/p.jpg',
    qualities: [
      { key: 'https://vk.com/v/1080.mp4', height: 1080, size: 300 },
      { key: 'https://vk.com/v/720.mp4', height: 720, size: 200 },
      { key: 'https://vk.com/v/480.mp4', height: 480, size: 100 },
    ],
  };
  const meta = { title: 'Sea at dawn', visibility: 'PRIVATE' as const, sensitive: false };

  it('in the quality picked; else the settings’ one; named by the settings’ template', () => {
    const picked = downloadJob(media, meta, DEFAULT_SETTINGS, 'https://vk.com/v/480.mp4');
    expect(picked).toMatchObject({
      target: 'disk',
      thumbnail: 'https://vk.com/p.jpg',
      request: { quality: 'https://vk.com/v/480.mp4' },
      name: {
        template: '{title}',
        folder: 'tapeshelf',
        title: 'Sea at dawn',
        site: 'vk.com',
        author: 'Anna',
      },
    });
    expect(picked.name!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const byDefault = downloadJob(media, meta, {
      ...DEFAULT_SETTINGS,
      quality: 720,
      fileName: '{site} — {title}',
    });
    expect(byDefault.request.quality).toBe('https://vk.com/v/720.mp4');
    expect(byDefault.name!.template).toBe('{site} — {title}');
    // No room to fit for a download: the best is the best, whatever its size.
    expect(downloadJob(media, meta, DEFAULT_SETTINGS).request.quality).toBe(
      'https://vk.com/v/1080.mp4',
    );
  });
});
