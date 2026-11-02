/**
 * The extension's own storage (OPFS): downloads on their way to the computer, a job's files
 * named after it — `<job>.video`, `<job>.audio`, `<job>.out`. The offscreen document writes them;
 * the service worker removes them with the job.
 */
export const root = () => navigator.storage.getDirectory();

/** Every file of the storage, by name. */
export async function storedNames(): Promise<string[]> {
  const names: string[] = [];
  const dir = (await root()) as FileSystemDirectoryHandle & {
    keys(): AsyncIterableIterator<string>;
  };
  for await (const name of dir.keys()) names.push(name);
  return names;
}

/** A job's files gone: its download is in Downloads, cancelled, or off the list. */
export async function removeStored(jobId: string): Promise<void> {
  const dir = await root();
  for (const name of await storedNames())
    if (name.startsWith(`${jobId}.`)) await dir.removeEntry(name).catch(() => undefined);
}
