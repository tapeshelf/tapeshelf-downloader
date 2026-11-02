import { describe, expect, it } from 'vitest';

import {
  joinSegments,
  parseCues,
  seconds,
  subtitlesAsSrt,
  timestampMap,
  toSrt,
} from '../src/shared/subtitles';

/** Subtitles beside a download as .srt. */
const VTT = `WEBVTT
Kind: captions

NOTE a comment

1
00:00:01.000 --> 00:00:02.500 align:start position:0%
<c.yellow>Hello</c> <i>there</i> &amp; <v Ann>you</v>

00:03.000 --> 00:04.000
Second line
`;

describe('subtitles as SRT', () => {
  it('a WebVTT file: its cues, the tags SRT does not know dropped, numbered anew', () => {
    expect(seconds('01:02:03.456')).toBeCloseTo(3723.456);
    expect(seconds('02:03,5')).toBeCloseTo(123.5);
    const cues = parseCues(VTT);
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello <i>there</i> & you' },
      { start: 3, end: 4, text: 'Second line' },
    ]);
    expect(toSrt(cues)).toBe(
      '1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i> & you\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n',
    );
  });

  it('an SRT file reads the same way', () => {
    const srt = '1\r\n00:00:05,250 --> 00:00:06,000\r\nBonjour\r\n\r\n';
    expect(parseCues(srt)).toEqual([{ start: 5.25, end: 6, text: 'Bonjour' }]);
  });

  it('HLS segments: on the picture’s clock by their X-TIMESTAMP-MAP, a repeated cue once', () => {
    const segment = (mpegts: number, body: string) =>
      `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n\n${body}\n`;
    expect(timestampMap(segment(900000, ''))).toEqual({ mpegts: 900000, local: 0 });
    const cues = joinSegments([
      // The picture starts at 10 s of the stream's clock (MPEGTS 900000): its cues from 0.
      segment(900000, '00:00:01.000 --> 00:00:07.000\nFirst'),
      // The next segment's map says 6 s later; the cue running over both is repeated in it.
      segment(1440000, '00:00:-5.000 --> 00:00:01.000\nFirst'.replace('-5.000', '00.000')),
      segment(1440000, '00:00:02.000 --> 00:00:03.000\nThird'),
    ]);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 7, 'First'],
      [6, 7, 'First'],
      [8, 9, 'Third'],
    ]);
  });

  it('a track of any kind fetched and turned into SRT', async () => {
    const files: Record<string, string> = {
      'https://x/s.vtt': VTT,
      'https://x/subs.m3u8':
        '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.vtt\n#EXTINF:6,\nseg1.vtt\n#EXT-X-ENDLIST\n',
      'https://x/seg0.vtt': 'WEBVTT\n\n00:00:00.500 --> 00:00:01.000\nA\n',
      'https://x/seg1.vtt': 'WEBVTT\n\n00:00:06.500 --> 00:00:07.000\nB\n',
    };
    const text = async (url: string) => files[url]!;
    expect(await subtitlesAsSrt({ kind: 'vtt', url: 'https://x/s.vtt' }, text)).toContain(
      '2\n00:00:03,000 --> 00:00:04,000\nSecond line',
    );
    expect(await subtitlesAsSrt({ kind: 'hls', url: 'https://x/subs.m3u8' }, text)).toBe(
      '1\n00:00:00,500 --> 00:00:01,000\nA\n\n2\n00:00:06,500 --> 00:00:07,000\nB\n',
    );
  });
});
