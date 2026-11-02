declare const __BUILD__: 'store' | 'full';
declare const __FIREFOX__: boolean;

/**
 * Which build this is: `store` for the Chrome Web Store and Edge Add-ons, `full` from
 * tapeshelf.com. Only the full build saves from YouTube (its adapter comes in).
 */
export const BUILD: 'store' | 'full' = __BUILD__;

/**
 * The Firefox build: a full build whose queue works in the background page itself —
 * Firefox has no offscreen document — and whose side panel is Firefox's sidebar.
 */
export const FIREFOX: boolean = __FIREFOX__;

declare const __SELF_UPDATING__: boolean;

/**
 * A build from the site asks it for newer versions; one from a store is updated by the
 * store.
 */
export const SELF_UPDATING: boolean = __SELF_UPDATING__;

/** YouTube pages and its video servers, left alone by the store build. */
export const isYoutube = (url: string): boolean => {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
