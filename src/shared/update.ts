import { FIREFOX } from './build';

/**
 * Updates of the full build: it is installed by hand, not from a store, so once
 * a day it asks its server for the latest version (`/extension/latest.json`, beside the archive)
 * and offers the new one. The store build is updated by its store.
 */
export interface Release {
  version: string;
  /** The archive, absolute. */
  url: string;
}

interface Checked {
  checkedAt: number;
  server: string;
  latest: Release | null;
}

const DAY = 24 * 3600 * 1000;

/** 0.10.0 is newer than 0.9.2. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The newer release, if there is one: asked of the server at most once a day. */
export async function availableUpdate(
  server: string,
  current: string,
  now = Date.now(),
): Promise<Release | null> {
  const { update } = (await chrome.storage.local.get('update')) as { update?: Checked };
  let latest =
    update && update.server === server && now - update.checkedAt < DAY ? update.latest : undefined;
  if (latest === undefined) {
    latest = await fetch(`${server}/extension/latest.json`, {
      credentials: 'omit',
      cache: 'no-store',
    })
      .then((r) =>
        r.ok ? (r.json() as Promise<{ version?: string; url?: string; firefox?: string }>) : null,
      )
      .then((j) => {
        // The Firefox build's own package.
        const url = FIREFOX ? j?.firefox : j?.url;
        return j?.version && url ? { version: j.version, url: new URL(url, server).href } : null;
      })
      .catch(() => null);
    await chrome.storage.local.set({
      update: { checkedAt: now, server, latest } satisfies Checked,
    });
  }
  return latest && newer(latest.version, current) ? latest : null;
}
