import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEGMENTS_AT_ONCE, ivOf, readTrack, type Piece } from '../src/offscreen/download';
import { Overflow, PartWriter } from '../src/offscreen/upload';
import type { DonePart, TrackPlan } from '../src/shared/jobs';

afterEach(() => vi.unstubAllGlobals());

async function collect(track: TrackPlan, from = { segment: 0, offset: 0 }): Promise<Piece[]> {
  const out: Piece[] = [];
  for await (const p of readTrack(track, from, new AbortController().signal))
    out.push({ ...p, bytes: p.bytes.slice() });
  return out;
}
const bytes = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) % 251);
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const joined = (pieces: Piece[]) => concat(pieces.map((p) => p.bytes));

describe('downloading a track', () => {
  it('a file from where it stopped: a range when the server has them, skipping when not', async () => {
    const body = bytes(5000);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.['Range'];
      return range === 'bytes=3000-'
        ? new Response(body.slice(3000), { status: 206 })
        : new Response(body, { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const track = { url: 'https://x.com/a.mp4', ext: 'mp4', mimeType: 'video/mp4' };
    const all = await collect(track);
    expect(joined(all)).toEqual(body);
    const resumed = await collect(track, { segment: 0, offset: 3000 });
    expect(resumed[0]!.at).toEqual({ segment: 0, offset: 3000 });
    expect(joined(resumed)).toEqual(body.slice(3000));
    // No ranges: the whole file comes, the first 4000 bytes are skipped.
    const skipped = await collect(track, { segment: 0, offset: 4000 });
    expect(joined(skipped)).toEqual(body.slice(4000));
    expect(skipped[0]!.at.offset).toBe(4000);
  });

  it('segments in order, AES-128 decrypted with the sequence as IV, from the middle of one', async () => {
    const raw = await crypto.subtle.importKey('raw', new Uint8Array(16).fill(7), 'AES-CBC', false, [
      'encrypt',
    ]);
    const plain = [bytes(100), bytes(200, 50)];
    const cipher = await Promise.all(
      plain.map(
        async (p, i) =>
          new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ivOf(null, 10 + i) }, raw, p),
          ),
      ),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('key')) return new Response(new Uint8Array(16).fill(7));
        if (url.endsWith('init')) return new Response(bytes(10, 200));
        return new Response(cipher[Number(url.slice(-1))]!);
      }),
    );
    const track: TrackPlan = {
      ext: 'ts',
      mimeType: 'video/mp2t',
      segments: [
        { url: 'https://x.com/init' },
        { url: 'https://x.com/s0', key: { url: 'https://x.com/key', iv: null, sequence: 10 } },
        { url: 'https://x.com/s1', key: { url: 'https://x.com/key', iv: null, sequence: 11 } },
      ],
    };
    const all = await collect(track);
    expect(joined(all)).toEqual(concat([bytes(10, 200), ...plain]));
    const resumed = await collect(track, { segment: 2, offset: 150 });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.at).toEqual({ segment: 2, offset: 150 });
    expect(joined(resumed)).toEqual(plain[1]!.slice(150));
  });

  it('segments four at a time, the later ones answering first, still joined in order', async () => {
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        inFlight++;
        most = Math.max(most, inFlight);
        const n = Number(/(\d+)$/.exec(url)![1]);
        // The first segments answer last.
        await new Promise((r) => setTimeout(r, (10 - n) * 3));
        inFlight--;
        return new Response(new Uint8Array([n]), { status: 200 });
      }),
    );
    const segments = Array.from({ length: 10 }, (_, n) => ({ url: `https://x/s${n}` }));
    const pieces = await collect(
      { ext: 'ts', mimeType: 'video/mp2t', segments },
      { segment: 2, offset: 0 },
    );
    expect(pieces.map((p) => p.bytes[0])).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pieces.map((p) => p.at.segment)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(most).toBe(SEGMENTS_AT_ONCE);
  });

  it('the IV from a hex string or a sequence number', () => {
    expect([...ivOf('000102030405060708090a0b0c0d0e0f', 0)]).toEqual([...Array(16).keys()]);
    expect([...ivOf(null, 258)].slice(-2)).toEqual([1, 2]);
  });

  it('a refusal is the site’s answer, not retried', async () => {
    const fetch = vi.fn(async () => new Response('no', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      collect({ url: 'https://x.com/a.mp4', ext: 'mp4', mimeType: 'video/mp4' }),
    ).rejects.toMatchObject({
      code: 'source',
      status: 403,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('uploading in parts', () => {
  function setup(limit = Infinity, failFirst = false) {
    const puts: { url: string; size: number }[] = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls++;
        if (failFirst && calls === 1) return new Response('expired', { status: 403 });
        puts.push({ url, size: (init.body as Uint8Array).length });
        return new Response(null, { status: 200, headers: { ETag: `"e${puts.length}"` } });
      }),
    );
    const done: DonePart[] = [];
    const presigned: [number, boolean][] = [];
    const writer = new PartWriter({
      partSize: 10,
      firstPart: 1,
      uploaded: 0,
      limit,
      presign: async (n, fresh) => {
        presigned.push([n, fresh]);
        return `https://s3/${n}`;
      },
      onPart: async (p) => void done.push(p),
      signal: new AbortController().signal,
    });
    return { writer, done, puts, presigned };
  }

  it('cuts the bytes into parts, the last one shorter, each with where the source stands', async () => {
    const { writer, done, puts } = setup();
    await writer.write(bytes(14), { segment: 0, offset: 0 });
    await writer.write(bytes(13), { segment: 1, offset: 0 });
    await writer.finish();
    expect(puts.map((p) => p.size)).toEqual([10, 10, 7]);
    expect(done.map((p) => [p.partNumber, p.etag, p.cursor])).toEqual([
      [1, '"e1"', { segment: 0, offset: 10 }],
      [2, '"e2"', { segment: 1, offset: 6 }],
      [3, '"e3"', { segment: 1, offset: 13 }],
    ]);
    expect(writer.bytes).toBe(27);
  });

  it('a failed part goes again with a fresh URL', async () => {
    vi.useFakeTimers();
    const { writer, done, presigned } = setup(Infinity, true);
    const writing = writer.write(bytes(10), { segment: 0, offset: 0 }).then(() => writer.finish());
    await vi.runAllTimersAsync();
    await writing;
    vi.useRealTimers();
    expect(presigned).toEqual([
      [1, false],
      [1, true],
    ]);
    expect(done).toHaveLength(1);
  });

  it('a stream bigger than declared stops', async () => {
    const { writer } = setup(25);
    await expect(writer.write(bytes(30), { segment: 0, offset: 0 })).rejects.toBeInstanceOf(
      Overflow,
    );
  });
});
