import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { join, needsJoin } from '../src/offscreen/join';
import type { DownloadPlan, TrackPlan } from '../src/shared/jobs';

/**
 * Joining what was downloaded into one file that plays: picture and sound from two
 * files, a stream's TS or fMP4 repacked, VP9 and Opus into MP4 — packets copied, not re-encoded.
 * Fixtures: 1 s of 96×64 at 10 fps (H.264 or VP9) with AAC or Opus, made once with ffmpeg.
 */
const fixture = (name: string) =>
  new Blob([readFileSync(fileURLToPath(new URL(`fixtures/media/${name}`, import.meta.url)))]);

/** A file handle of the browser's storage, in memory: what the joined file is written into. */
function memoryFile() {
  let bytes = new Uint8Array(0);
  const handle = {
    createWritable: async () =>
      new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
        write({ data, position }) {
          const end = position + data.byteLength;
          if (end > bytes.length) {
            const grown = new Uint8Array(end);
            grown.set(bytes);
            bytes = grown;
          }
          bytes.set(data, position);
        },
      }),
  } as unknown as FileSystemFileHandle;
  return { handle, bytes: () => bytes };
}

async function tracksOf(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const tracks = await input.getTracks();
  const out = {
    format: (await input.getFormat()).name,
    codecs: tracks.map((t) => t.codec),
    duration: await input.computeDuration(),
  };
  input.dispose();
  return out;
}

const never = new AbortController().signal;

describe('joining downloads into one file', () => {
  it('a plain file is the video as it is; segments, TS or separate sound need joining', () => {
    const file: TrackPlan = { url: 'https://x/v.mp4', ext: 'mp4', mimeType: 'video/mp4' };
    const plan = (video: TrackPlan, audio?: TrackPlan): DownloadPlan => ({ video, audio });
    expect(needsJoin(plan(file))).toBe(false);
    expect(needsJoin(plan({ ...file, ext: 'webm' }))).toBe(false);
    expect(needsJoin(plan({ ...file, ext: 'ts' }))).toBe(true);
    expect(needsJoin(plan({ ...file, url: undefined, segments: [{ url: 'https://x/1' }] }))).toBe(
      true,
    );
    expect(
      needsJoin(plan(file, { url: 'https://x/a.m4a', ext: 'm4a', mimeType: 'audio/mp4' })),
    ).toBe(true);
  });

  it('picture and sound from two files: one MP4 with both, as long as the source', async () => {
    const out = memoryFile();
    const joined = await join(
      fixture('video.mp4'),
      fixture('audio.m4a'),
      out.handle,
      () => {},
      never,
    );
    expect(joined.ext).toBe('mp4');
    const result = await tracksOf(out.bytes());
    expect(result.format).toBe('MP4');
    expect(result.codecs).toEqual(expect.arrayContaining(['aac', 'avc']));
    expect(result.codecs).toHaveLength(2);
    expect(result.duration).toBeGreaterThan(0.9);
    expect(result.duration).toBeLessThan(1.2);
  });

  it('an HLS stream’s TS segments joined: repacked into MP4 with its picture and sound', async () => {
    const out = memoryFile();
    let progress = 0;
    await join(fixture('both.mpegts'), undefined, out.handle, (p) => (progress = p), never);
    const result = await tracksOf(out.bytes());
    expect(result.format).toBe('MP4');
    expect(result.codecs).toEqual(expect.arrayContaining(['aac', 'avc']));
    expect(result.codecs).toHaveLength(2);
    expect(result.duration).toBeGreaterThan(0.9);
    expect(progress).toBeGreaterThanOrEqual(0);
  });

  it('fragmented MP4 (an fMP4 stream) becomes a plain MP4', async () => {
    const out = memoryFile();
    await join(fixture('fragmented.mp4'), undefined, out.handle, () => {}, never);
    const result = await tracksOf(out.bytes());
    expect(result.codecs).toEqual(expect.arrayContaining(['aac', 'avc']));
    expect(result.codecs).toHaveLength(2);
    expect(result.duration).toBeGreaterThan(0.9);
  });

  it('VP9 and Opus (YouTube’s 4K) go into MP4 as well', async () => {
    const out = memoryFile();
    const joined = await join(
      fixture('vp9.webm'),
      fixture('opus.webm'),
      out.handle,
      () => {},
      never,
    );
    expect(joined.ext).toBe('mp4');
    const result = await tracksOf(out.bytes());
    expect(result.codecs).toEqual(expect.arrayContaining(['opus', 'vp9']));
    expect(result.codecs).toHaveLength(2);
  });

  it('files with no picture: said so, not a broken file', async () => {
    const out = memoryFile();
    await expect(
      join(fixture('audio.m4a'), undefined, out.handle, () => {}, never),
    ).rejects.toMatchObject({ code: 'format' });
  });

  it('cancelled midway: stops', async () => {
    const out = memoryFile();
    const abort = new AbortController();
    abort.abort();
    await expect(
      join(fixture('video.mp4'), fixture('audio.m4a'), out.handle, () => {}, abort.signal),
    ).rejects.toBeTruthy();
  });
});
