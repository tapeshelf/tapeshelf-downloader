import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sameQuality } from '../src/shared/quality';
import { asFound, refreshed } from '../src/sites';
import { tiktok } from '../src/sites/tiktok';
import { vk } from '../src/sites/vk';

/**
 * A site's links expire while a saved video waits in the queue:
 * as its turn comes, the site is asked again, without its tab.
 */
const VK = readFileSync(new URL('fixtures/vk-show.json', import.meta.url), 'utf8');
const TIKTOK = readFileSync(new URL('fixtures/tiktok-universal.json', import.meta.url), 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('fresh links for a saved video', () => {
  it('asks the site from the extension and keeps the same quality by height', async () => {
    const page = new URL('https://vk.com/video-100000001_456000001');
    const [old] = vk.parse(VK, page, '-100000001_456000001');
    const media = asFound('vk', '-100000001_456000001', old!, page.href);
    const headers: string[][] = [];
    const renewed = VK.replaceAll('sig=', 'sig=new-');
    vi.stubGlobal('fetch', async () => new Response(renewed));
    const fresh = await refreshed(media, async (urls, referer) => headers.push([...urls, referer]));
    expect(headers).toEqual([['https://vk.com/al_video.php?act=show', 'https://vk.com/']]);
    expect(fresh!.url).toContain('sig=new-');
    expect(fresh!.siteId).toBe('-100000001_456000001');
    const chosen = old!.qualities![2]!.key;
    expect(sameQuality(old!.qualities, chosen, fresh!.qualities)).toBe(fresh!.qualities![2]!.key);
    expect(sameQuality(old!.qualities, undefined, fresh!.qualities)).toBeUndefined();
  });

  it('a post’s n-th video, from the whole page fetched again; nothing from the site: none', async () => {
    const page = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${TIKTOK}</script></html>`;
    vi.stubGlobal('fetch', async () => new Response(page));
    const media = {
      site: 'tiktok',
      siteId: '7000000000000000001',
      pageUrl: 'https://www.tiktok.com/@seaside/video/7000000000000000001',
    };
    expect((await refreshed(media, async () => undefined))!.title).toBe('Sea at dawn #sea');
    expect(tiktok.parse(page, new URL(media.pageUrl), media.siteId)).toHaveLength(1);
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 403 }));
    expect(await refreshed(media, async () => undefined)).toBeUndefined();
    expect(await refreshed({ pageUrl: media.pageUrl }, async () => undefined)).toBeUndefined();
  });
});
