import { afterEach, describe, expect, it, vi } from 'vitest';

import { availableUpdate, newer } from '../src/shared/update';

/** The full build asks its server for a newer version once a day. */
afterEach(() => vi.unstubAllGlobals());

function chromeWithStorage() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: Record<string, unknown>) => Object.assign(store, items),
      },
    },
  });
  return store;
}

describe('updates of the full build', () => {
  it('compares versions by their numbers', () => {
    expect(newer('0.10.0', '0.9.2')).toBe(true);
    expect(newer('1.0', '0.99.99')).toBe(true);
    expect(newer('0.4.0', '0.4.0')).toBe(false);
    expect(newer('0.3.9', '0.4.0')).toBe(false);
  });

  it('asks the server once a day; a newer version comes with its archive’s full address', async () => {
    chromeWithStorage();
    const fetch = vi.fn(async () =>
      Response.json({ version: '0.5.0', url: '/extension/tapeshelf-full.zip' }),
    );
    vi.stubGlobal('fetch', fetch);
    const now = Date.UTC(2026, 9, 26, 12);
    expect(await availableUpdate('https://tapeshelf.com', '0.4.0', now)).toEqual({
      version: '0.5.0',
      url: 'https://tapeshelf.com/extension/tapeshelf-full.zip',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://tapeshelf.com/extension/latest.json',
      expect.anything(),
    );
    await availableUpdate('https://tapeshelf.com', '0.4.0', now + 3600_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The same version, or another server's answer: nothing to offer, the other server asked.
    expect(await availableUpdate('https://tapeshelf.com', '0.5.0', now)).toBeNull();
    await availableUpdate('https://videos.example.org', '0.4.0', now);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('no answer from the server: nothing, asked again the next day', async () => {
    chromeWithStorage();
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const now = Date.UTC(2026, 9, 26, 12);
    expect(await availableUpdate('https://tapeshelf.com', '0.4.0', now)).toBeNull();
    expect(await availableUpdate('https://tapeshelf.com', '0.4.0', now + 3600_000)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await availableUpdate('https://tapeshelf.com', '0.4.0', now + 25 * 3600_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
