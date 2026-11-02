import { FIREFOX } from './build';

/**
 * Firefox's consent to send data: downloading sends nothing anywhere, but "Save to My
 * shelf" sends the video and its title to the person's tapeshelf account — website content, in
 * Firefox's words, declared optional in the manifest. Firefox asks the person once, in the click
 * that sends the first video; Chromium has no such consent: always allowed there.
 */
interface DataPermissions {
  request(p: { data_collection: string[] }): Promise<boolean>;
  contains(p: { data_collection: string[] }): Promise<boolean>;
}
const permissions = () =>
  (globalThis as unknown as { browser: { permissions: DataPermissions } }).browser.permissions;
const SHELF = { data_collection: ['websiteContent'] };

/** Asked in the click that sends a video to the shelf (only a click may ask). */
export const askToSend = (): Promise<boolean> =>
  FIREFOX
    ? permissions()
        .request(SHELF)
        .catch(() => false)
    : Promise.resolve(true);

/** Already allowed — without a click to ask in (the menu, a page's button, after connecting). */
export const allowedToSend = (): Promise<boolean> =>
  FIREFOX
    ? permissions()
        .contains(SHELF)
        .catch(() => false)
    : Promise.resolve(true);
