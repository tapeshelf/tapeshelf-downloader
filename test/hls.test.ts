import { describe, expect, it } from 'vitest';

import { attributes, parseHls, type HlsMaster, type HlsMedia } from '../src/shared/hls';

const BASE = 'https://cdn.example.com/show/master.m3u8';

describe('HLS playlists', () => {
  it('reads attributes, quoted values with commas included', () => {
    expect(attributes('#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2"')).toEqual(
      {
        BANDWIDTH: '800000',
        CODECS: 'avc1.4d401f,mp4a.40.2',
      },
    );
  });

  it('a master: the variants with their sizes, the audio renditions, addresses made absolute', () => {
    const m = parseHls(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="En",URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f",AUDIO="aud"
720/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
https://other.example.com/360.m3u8
`,
      BASE,
    ) as HlsMaster;
    expect(m.type).toBe('master');
    expect(m.variants).toEqual([
      {
        url: 'https://cdn.example.com/show/720/index.m3u8',
        bandwidth: 2_500_000,
        averageBandwidth: 2_000_000,
        width: 1280,
        height: 720,
        codecs: 'avc1.64001f',
        audio: 'aud',
      },
      {
        url: 'https://other.example.com/360.m3u8',
        bandwidth: 900_000,
        averageBandwidth: undefined,
        width: 640,
        height: 360,
        codecs: undefined,
        audio: undefined,
      },
    ]);
    expect(m.audio).toEqual([
      {
        group: 'aud',
        url: 'https://cdn.example.com/show/audio/en.m3u8',
        name: 'English',
        language: 'en',
        isDefault: true,
      },
    ]);
  });

  it('a media playlist: segments, length, AES-128 keys with and without an IV, the end', () => {
    const m = parseHls(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:6.0,
seg7.ts
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k2"
#EXTINF:6.0,
seg8.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:3.5,
seg9.ts
#EXT-X-ENDLIST
`,
      BASE,
    ) as HlsMedia;
    expect(m).toMatchObject({
      type: 'media',
      duration: 15.5,
      live: false,
      drm: false,
      fmp4: false,
    });
    expect(m.segments.map((s) => [s.url.split('/').pop(), s.sequence])).toEqual([
      ['seg7.ts', 7],
      ['seg8.ts', 8],
      ['seg9.ts', 9],
    ]);
    expect(m.segments[0]!.key?.url).toBe('https://cdn.example.com/show/key.bin');
    expect([...m.segments[0]!.key!.iv!]).toEqual([...Array(16).keys()]);
    expect(m.segments[1]!.key).toEqual({ url: 'https://keys.example.com/k2', iv: null });
    expect(m.segments[2]!.key).toBeNull();
  });

  it('fMP4 with an init section, byte ranges following one another in one file', () => {
    const m = parseHls(
      `#EXTM3U
#EXT-X-MAP:URI="main.mp4",BYTERANGE="800@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@800
main.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:1200
main.mp4
#EXT-X-PLAYLIST-TYPE:VOD
`,
      BASE,
    ) as HlsMedia;
    expect(m.fmp4).toBe(true);
    expect(m.live).toBe(false);
    expect(m.segments.map((s) => s.range)).toEqual([
      { length: 1000, offset: 800 },
      { length: 1200, offset: 1800 },
    ]);
    expect(m.segments[0]!.init).toEqual({
      url: 'https://cdn.example.com/show/main.mp4',
      range: { length: 800, offset: 0 },
    });
  });

  it('SAMPLE-AES or a key system is DRM; no end list is live', () => {
    const drm = parseHls(
      `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6,
a.ts
`,
      BASE,
    ) as HlsMedia;
    expect(drm.drm).toBe(true);
    expect(drm.live).toBe(true);
    const widevine = parseHls(
      `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
#EXTINF:6,
a.ts
#EXT-X-ENDLIST`,
      BASE,
    ) as HlsMedia;
    expect(widevine.drm).toBe(true);
  });
});
