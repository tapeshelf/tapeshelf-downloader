import { describe, expect, it } from 'vitest';

import { fillTemplate, isoSeconds, parseDash } from '../src/shared/dash';

const URL = 'https://cdn.example.com/v/manifest.mpd';

describe('DASH manifests', () => {
  it('reads ISO durations and fills templates', () => {
    expect(isoSeconds('PT1H2M3.5S')).toBe(3723.5);
    expect(isoSeconds('P1DT1S')).toBe(86401);
    expect(isoSeconds('PT12S')).toBe(12);
    expect(isoSeconds(undefined)).toBe(0);
    expect(
      fillTemplate('$RepresentationID$/seg-$Number%05d$-$Bandwidth$-$Time$-$$.m4s', {
        RepresentationID: 'v1',
        Number: 7,
        Bandwidth: 800,
        Time: 9000,
      }),
    ).toBe('v1/seg-00007-800-9000-$.m4s');
  });

  it('SegmentTemplate with a fixed duration: init and every segment, best video first, audio apart', () => {
    const m = parseDash(
      `<MPD type="static" mediaPresentationDuration="PT10S">
        <Period>
          <AdaptationSet contentType="video" mimeType="video/mp4">
            <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
              initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number%03d$.m4s"/>
            <Representation id="v360" bandwidth="500000" width="640" height="360" codecs="avc1.4d401e"/>
            <Representation id="v720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4">
            <SegmentTemplate timescale="48000" duration="192000" initialization="a/init.mp4" media="a/$Number$.m4s"/>
            <Representation id="a1" bandwidth="128000"/>
          </AdaptationSet>
          <AdaptationSet contentType="text" mimeType="text/vtt"><Representation id="t" bandwidth="1"/></AdaptationSet>
        </Period>
      </MPD>`,
      URL,
    );
    expect(m).toMatchObject({ duration: 10, live: false, drm: false });
    expect(m.video.map((v) => v.id)).toEqual(['v720', 'v360']);
    expect(m.video[0]!.init?.url).toBe('https://cdn.example.com/v/v720/init.mp4');
    expect(m.video[0]!.segments.map((s) => s.url.split('/v/')[1])).toEqual([
      'v720/001.m4s',
      'v720/002.m4s',
      'v720/003.m4s',
    ]);
    expect(m.audio[0]).toMatchObject({ id: 'a1', kind: 'audio', mimeType: 'audio/mp4' });
    expect(m.audio[0]!.segments).toHaveLength(3);
  });

  it('SegmentTimeline with repeats and $Time$; BaseURL down the tree', () => {
    const m = parseDash(
      `<MPD mediaPresentationDuration="PT6S"><BaseURL>https://media.example.com/root/</BaseURL>
        <Period><AdaptationSet mimeType="video/mp4"><BaseURL>video/</BaseURL>
          <Representation id="v" bandwidth="1000" height="480">
            <SegmentTemplate timescale="10" initialization="init.mp4" media="t$Time$.m4s">
              <SegmentTimeline><S t="0" d="20" r="1"/><S d="20"/></SegmentTimeline>
            </SegmentTemplate>
          </Representation>
        </AdaptationSet></Period></MPD>`,
      URL,
    );
    expect(m.video[0]!.segments.map((s) => s.url)).toEqual([
      'https://media.example.com/root/video/t0.m4s',
      'https://media.example.com/root/video/t20.m4s',
      'https://media.example.com/root/video/t40.m4s',
    ]);
  });

  it('SegmentList with byte ranges, and one whole file (SegmentBase)', () => {
    const m = parseDash(
      `<MPD mediaPresentationDuration="PT8S"><Period>
        <AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000" height="1080">
          <SegmentList><Initialization sourceURL="v.mp4" range="0-799"/>
            <SegmentURL media="v.mp4" mediaRange="800-1999"/><SegmentURL media="v.mp4" mediaRange="2000-2999"/>
          </SegmentList></Representation></AdaptationSet>
        <AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="64000">
          <BaseURL>audio.m4a</BaseURL><SegmentBase indexRange="0-100"/>
        </Representation></AdaptationSet>
      </Period></MPD>`,
      URL,
    );
    expect(m.video[0]!.init).toEqual({ url: 'https://cdn.example.com/v/v.mp4', range: '0-799' });
    expect(m.video[0]!.segments.map((s) => s.range)).toEqual(['800-1999', '2000-2999']);
    expect(m.audio[0]!.segments).toEqual([]);
    expect(m.audio[0]!.init).toEqual({ url: 'https://cdn.example.com/v/audio.m4a' });
  });

  it('protected video is DRM; a dynamic manifest is live; the longest period is the video', () => {
    const drm = parseDash(
      `<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
        <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`,
      URL,
    );
    expect(drm.drm).toBe(true);
    expect(drm.video).toEqual([]);
    expect(parseDash('<MPD type="dynamic"><Period/></MPD>', URL).live).toBe(true);
    const ads = parseDash(
      `<MPD mediaPresentationDuration="PT40S">
        <Period duration="PT5S"><AdaptationSet mimeType="video/mp4"><Representation id="ad" bandwidth="1"/></AdaptationSet></Period>
        <Period duration="PT35S"><AdaptationSet mimeType="video/mp4"><Representation id="film" bandwidth="1"/></AdaptationSet></Period>
      </MPD>`,
      URL,
    );
    expect(ads.duration).toBe(35);
    expect(ads.video.map((v) => v.id)).toEqual(['film']);
  });
});
