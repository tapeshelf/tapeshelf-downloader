import { describe, expect, it } from 'vitest';

import { classify, type SeenResponse } from '../src/shared/classify';

const res = (
  url: string,
  headers: Record<string, string> = {},
  type = 'media',
  statusCode = 200,
): SeenResponse => ({
  url,
  type,
  statusCode,
  responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
});

describe('which responses are videos to save', () => {
  it('stream manifests, by address or by type', () => {
    expect(classify(res('https://x.com/v/index.m3u8?t=1', {}, 'xmlhttprequest'))).toEqual({
      kind: 'hls',
    });
    expect(
      classify(
        res(
          'https://x.com/play',
          { 'Content-Type': 'application/vnd.apple.mpegurl' },
          'xmlhttprequest',
        ),
      ),
    ).toEqual({ kind: 'hls' });
    expect(classify(res('https://x.com/v/manifest.mpd', {}, 'xmlhttprequest'))).toEqual({
      kind: 'dash',
    });
    expect(
      classify(
        res('https://x.com/m', { 'content-type': 'application/dash+xml' }, 'xmlhttprequest'),
      ),
    ).toEqual({ kind: 'dash' });
  });

  it('a file a player reads in ranges: the size is the range total', () => {
    expect(
      classify(
        res(
          'https://cdn.x.com/clip.mp4',
          {
            'Content-Type': 'video/mp4',
            'Content-Range': 'bytes 0-1023/52428800',
            'Content-Length': '1024',
          },
          'media',
          206,
        ),
      ),
    ).toEqual({ kind: 'file', size: 52_428_800, mimeType: 'video/mp4' });
    expect(
      classify(
        res('https://cdn.x.com/get?id=5', {
          'Content-Type': 'video/webm',
          'Content-Length': '9000000',
        }),
      ),
    ).toEqual({ kind: 'file', size: 9_000_000, mimeType: 'video/webm' });
  });

  it('not stream segments, audio, small files, refusals or YouTube’s video servers', () => {
    expect(
      classify(res('https://x.com/seg001.ts', { 'Content-Type': 'video/mp2t' }, 'xmlhttprequest')),
    ).toBeNull();
    expect(
      classify(res('https://x.com/chunk-5.m4s', { 'Content-Type': 'video/mp4' }, 'xmlhttprequest')),
    ).toBeNull();
    expect(classify(res('https://x.com/song.mp3', { 'Content-Type': 'audio/mpeg' }))).toBeNull();
    expect(
      classify(
        res('https://x.com/ad.mp4', { 'Content-Type': 'video/mp4', 'Content-Length': '90000' }),
      ),
    ).toBeNull();
    expect(classify(res('https://x.com/clip.mp4', {}, 'media', 403))).toBeNull();
    expect(
      classify(
        res('https://rr1---sn-abc.googlevideo.com/videoplayback?itag=22', {
          'Content-Type': 'video/mp4',
        }),
      ),
    ).toBeNull();
    expect(classify(res('https://x.com/page.mp4', { 'Content-Type': 'text/html' }))).toBeNull();
    expect(classify(res('blob:https://x.com/1234', { 'Content-Type': 'video/mp4' }))).toBeNull();
  });

  it('a file fetched by script counts only whole and big (a player’s pieces do not)', () => {
    const piece = res(
      'https://cdn.x.com/v.mp4',
      { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-99999/52428800' },
      'xmlhttprequest',
      206,
    );
    expect(classify(piece)).toBeNull();
    const whole = res(
      'https://cdn.x.com/v.mp4',
      { 'Content-Type': 'video/mp4', 'Content-Length': '5000000' },
      'xmlhttprequest',
    );
    expect(classify(whole)).toEqual({ kind: 'file', size: 5_000_000, mimeType: 'video/mp4' });
  });
});
