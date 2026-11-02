import { afterEach, describe, expect, it, vi } from 'vitest';

import { readTrack } from '../src/offscreen/download';
import { qualityLabel } from '../src/shared/streams';
import { adapterFor } from '../src/sites';
import { facebook, facebookFiles } from '../src/sites/facebook';
import { streamInfo, telegram } from '../src/sites/telegram';

/** Facebook, Telegram Web, and a file only its page can read. */
const idOf = (url: string) => adapterFor(url)?.id;

describe('Facebook', () => {
  it('a video’s page, a reel, the watch page and the old addresses', () => {
    expect(idOf('https://www.facebook.com/seaside/videos/1234567890123/')).toBe('1234567890123');
    expect(idOf('https://www.facebook.com/seaside/videos/sea-at-dawn/1234567890123/')).toBe(
      '1234567890123',
    );
    expect(idOf('https://www.facebook.com/watch/?v=1234567890123')).toBe('1234567890123');
    expect(idOf('https://www.facebook.com/watch/live/?v=1234567890123')).toBe('1234567890123');
    expect(idOf('https://www.facebook.com/reel/1234567890123')).toBe('1234567890123');
    expect(idOf('https://m.facebook.com/video.php?v=1234567890123')).toBe('1234567890123');
    expect(idOf('https://www.facebook.com/seaside')).toBeUndefined();
  });

  it('HD and SD files from the page’s data, best first; the older fields too', () => {
    const now = String.raw`{"video_id":"1","videoDeliveryResponseResult":{"progressive_urls":[{"progressive_url":"https:\/\/video.xx.fbcdn.net\/sd.mp4?a=1&2","failure_reason":null,"metadata":{"quality":"SD"}},{"progressive_url":"https:\/\/video.xx.fbcdn.net\/hd.mp4","failure_reason":null,"metadata":{"quality":"HD"}}]}}`;
    expect(facebookFiles(now)).toEqual([
      { url: 'https://video.xx.fbcdn.net/hd.mp4', label: 'HD' },
      { url: 'https://video.xx.fbcdn.net/sd.mp4?a=1&2', label: 'SD' },
    ]);
    const before = String.raw`"browser_native_sd_url":"https:\/\/v.fbcdn.net\/sd.mp4","browser_native_hd_url":null`;
    expect(facebookFiles(before)).toEqual([{ url: 'https://v.fbcdn.net/sd.mp4', label: 'SD' }]);
  });

  it('the page’s own data, or the watch page: title, author, picture, length; nothing without a file', () => {
    const page = new URL('https://www.facebook.com/seaside/videos/1234567890123/');
    const data = String.raw`{"id":"1234567890123","title":{"text":"Sea at dawn"},"owner":{"__typename":"Page","id":"9","name":"Seaside"},"preferred_thumbnail":{"image":{"uri":"https:\/\/scontent.xx.fbcdn.net\/t.jpg"}},"playable_duration_in_ms":61000,"progressive_urls":[{"progressive_url":"https:\/\/video.xx.fbcdn.net\/hd.mp4","metadata":{"quality":"HD"}}]}`;
    const [v] = facebook.parse(JSON.stringify({ text: data, title: 'x' }), page, '1234567890123');
    expect(v).toMatchObject({
      kind: 'file',
      url: 'https://video.xx.fbcdn.net/hd.mp4',
      title: 'Sea at dawn',
      author: 'Seaside',
      thumbnail: 'https://scontent.xx.fbcdn.net/t.jpg',
      duration: 61,
      qualities: [{ key: 'https://video.xx.fbcdn.net/hd.mp4', label: 'HD' }],
    });
    const html = `<meta property="og:title" content="Waves &amp; wind | Facebook"><script>${String.raw`"video_id":"1234567890123","browser_native_sd_url":"https:\/\/v.fbcdn.net\/sd.mp4"`}</script>`;
    expect(facebook.parse(html, page, '1234567890123')[0]).toMatchObject({ title: 'Waves & wind' });
    expect(facebook.parse('<html>log in</html>', page, '1234567890123')).toEqual([]);
  });

  it('a quality named by the site, without a height', () => {
    expect(qualityLabel({ label: 'HD' })).toBe('HD');
    expect(qualityLabel({ height: 720, label: 'HD' })).toBe('720p');
  });
});

describe('Telegram Web', () => {
  const stream = (info: object) =>
    `https://web.telegram.org/k/stream/${encodeURIComponent(JSON.stringify(info))}`;

  it('both clients; the video on the screen, whatever chat the address names', () => {
    expect(idOf('https://web.telegram.org/k/#@seaside')).toBe('viewer');
    expect(idOf('https://web.telegram.org/a/#-100123')).toBe('viewer');
    expect(idOf('https://telegram.org/')).toBeUndefined();
  });

  it('the K client’s address says the size, the type and the name', () => {
    expect(
      streamInfo(stream({ dcId: 2, size: 1234567, mimeType: 'video/mp4', fileName: 'sea.mp4' })),
    ).toMatchObject({ size: 1234567, mimeType: 'video/mp4', fileName: 'sea.mp4' });
    expect(streamInfo('blob:https://web.telegram.org/1-2-3')).toEqual({});
  });

  it('the caption as the title, the sender as the author; read through the tab', () => {
    const src = stream({ size: 1234567, mimeType: 'video/mp4', fileName: 'sea.mp4' });
    const seen = { src, caption: 'Sea   from\nTelegram', sender: 'Seaside', duration: 4 };
    const page = new URL('https://web.telegram.org/k/#@seaside');
    expect(telegram.parse(JSON.stringify(seen), page, 'viewer')).toEqual([
      {
        kind: 'file',
        url: src,
        size: 1234567,
        mimeType: 'video/mp4',
        title: 'Sea from Telegram',
        description: undefined,
        author: 'Seaside',
        duration: 4,
        pageUrl: page.href,
        download: { page: true },
      },
    ]);
    // No caption: the file's name.
    expect(telegram.parse(JSON.stringify({ src }), page, 'viewer')[0]!.title).toBe('sea');
  });
});

describe('a file only its page can read', () => {
  afterEach(() => vi.unstubAllGlobals());
  const file = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const tabSending = (answer: (start: number, end: number) => unknown) => {
    const asked: [number, number][] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: (m: { start: number; end: number }) => {
          asked.push([m.start, m.end]);
          return Promise.resolve(answer(m.start, m.end));
        },
      },
    });
    return asked;
  };
  const read = async (size: number | undefined, from = 0) => {
    const parts: Uint8Array[] = [];
    const track = {
      url: 'https://web.telegram.org/k/stream/x',
      ext: 'mp4',
      mimeType: 'video/mp4',
      size,
      tab: 7,
      chunk: 2048,
    };
    for await (const p of readTrack(
      track,
      { segment: 0, offset: from },
      new AbortController().signal,
    ))
      parts.push(p.bytes);
    return Uint8Array.from(parts.flatMap((p) => [...p]));
  };

  it('in ranges through its tab, to the end its first answer says, from where it stopped', async () => {
    const asked = tabSending((start, end) => ({
      status: 206,
      total: file.length,
      b64: b64(file.subarray(start, end + 1)),
    }));
    expect(await read(undefined)).toEqual(file);
    expect(asked).toEqual([
      [0, 2047],
      [2048, 4095],
      [4096, 4999],
    ]);
    asked.length = 0;
    expect(await read(file.length, 3000)).toEqual(file.subarray(3000));
    expect(asked[0]).toEqual([3000, 4999]);
  });

  it('a page that ignores the range sends it whole; a closed tab is said so', async () => {
    tabSending(() => ({ status: 200, b64: b64(file) }));
    expect(await read(undefined, 1000)).toEqual(file.subarray(1000));
    tabSending(() => ({ error: 'No tab with id: 7' }));
    await expect(read(undefined)).rejects.toMatchObject({ code: 'pageGone' });
  });
});
