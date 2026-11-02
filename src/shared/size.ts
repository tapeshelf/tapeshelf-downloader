/**
 * A file's size from its server, without downloading it: HEAD, or the range of its first byte for
 * a server that answers no HEAD. The person's cookies of the site go with it; the Referer comes
 * from a session rule set first.
 */
export async function fileSize(url: string, signal?: AbortSignal): Promise<number | undefined> {
  const head = await fetch(url, { method: 'HEAD', credentials: 'include', signal }).catch(
    () => null,
  );
  const n = Number(head?.ok ? head.headers.get('content-length') : 0);
  if (n > 0) return n;
  const first = await fetch(url, {
    credentials: 'include',
    headers: { Range: 'bytes=0-0' },
    signal,
  }).catch(() => null);
  void first?.body?.cancel();
  const total = Number(/\/(\d+)\s*$/.exec(first?.headers.get('content-range') ?? '')?.[1]);
  return total > 0 ? total : undefined;
}
