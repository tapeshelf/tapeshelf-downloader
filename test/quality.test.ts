import { describe, expect, it } from 'vitest';

import {
  MAX_UPLOAD_BYTES,
  estimateBytes,
  pickQuality,
  roomFor,
  streamBound,
} from '../src/shared/quality';

const MB = 1024 * 1024;
const options = [
  { key: '1080', height: 1080, estimate: 900 * MB },
  { key: '720', height: 720, estimate: 400 * MB },
  { key: '480', height: 480, estimate: 150 * MB },
];

describe('quality and size', () => {
  it('estimates bytes from bits a second', () => {
    expect(estimateBytes(8_000_000, 10)).toBe(10_000_000);
  });

  it('the best one that fits the room, not above the preferred height', () => {
    expect(pickQuality(options, 'best', -1)?.key).toBe('1080');
    expect(pickQuality(options, 'best', 500 * MB)?.key).toBe('720');
    expect(pickQuality(options, 720, -1)?.key).toBe('720');
    expect(pickQuality(options, 480, 1000 * MB)?.key).toBe('480');
  });

  it('none fits: the smallest (the upload says why); all above the preference: the lowest', () => {
    expect(pickQuality(options, 'best', 10 * MB)?.key).toBe('480');
    expect(pickQuality(options, 360, -1)?.key).toBe('480');
    expect(pickQuality([], 'best', -1)).toBeUndefined();
  });

  it('a stream declares its estimate with a margin, never past the room', () => {
    expect(streamBound(100 * MB, -1)).toBe(Math.ceil(100 * MB * 1.3) + 4 * MB);
    expect(streamBound(100 * MB, -1, 2)).toBe(Math.ceil(100 * MB * 2.6) + 4 * MB);
    expect(streamBound(100 * MB, 50 * MB)).toBe(50 * MB);
    expect(streamBound(undefined, 70 * MB)).toBe(70 * MB);
    expect(streamBound(undefined, -1)).toBe(MAX_UPLOAD_BYTES);
  });

  it('the room is the file limit or the free space, whichever is smaller', () => {
    expect(roomFor({ maxFileBytes: 0, freeBytes: -1 })).toBe(-1);
    expect(roomFor({ maxFileBytes: 2000, freeBytes: -1 })).toBe(2000);
    expect(roomFor({ maxFileBytes: 2000, freeBytes: 500 })).toBe(500);
    expect(roomFor({ maxFileBytes: 0, freeBytes: 0 })).toBe(0);
  });
});
