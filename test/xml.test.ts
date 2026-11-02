import { describe, expect, it } from 'vitest';

import { childOf, childrenOf, parseXml } from '../src/shared/xml';

describe('parseXml', () => {
  it('reads elements, attributes, text, self-closing tags, comments, CDATA and entities', () => {
    const root = parseXml(`<?xml version="1.0"?>
      <!-- a comment -->
      <MPD xmlns:cenc="urn:mpeg:cenc:2013" type='static' title="a &amp; b">
        <BaseURL>https://cdn.example.com/v/</BaseURL>
        <Period><AdaptationSet mimeType="video/mp4"/><cenc:pssh>AAAA</cenc:pssh></Period>
        <Note><![CDATA[<raw> & text]]></Note>
      </MPD>`);
    expect(root.name).toBe('MPD');
    expect(root.attrs).toMatchObject({ type: 'static', title: 'a & b' });
    expect(childOf(root, 'BaseURL')?.text).toBe('https://cdn.example.com/v/');
    const period = childOf(root, 'Period');
    expect(childrenOf(period, 'AdaptationSet')).toHaveLength(1);
    expect(childOf(period, 'pssh')?.text).toBe('AAAA');
    expect(childOf(root, 'Note')?.text).toBe('<raw> & text');
  });

  it('refuses what is not XML', () => {
    expect(() => parseXml('just text')).toThrow();
  });
});
