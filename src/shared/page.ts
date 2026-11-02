import { readPage, type PageInfo } from './page-info';

/**
 * Reads the page of a tab: its title, description and picture from the top frame, the video
 * elements of every frame (an embedded player lives in its own). Undefined where the browser
 * lets no extension in (its own pages, the extension store).
 */
export async function pageInfo(tabId: number): Promise<PageInfo | undefined> {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: readPage,
    });
    const top = frames.find((f) => f.frameId === 0)?.result as PageInfo | undefined;
    if (!top) return undefined;
    return {
      ...top,
      videos: frames.flatMap((f) => (f.result as PageInfo | undefined)?.videos ?? []),
    };
  } catch {
    return undefined;
  }
}
