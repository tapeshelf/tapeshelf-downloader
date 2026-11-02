import { BUILD, isYoutube } from '../shared/build';
import { allowedToSend } from '../shared/consent';
import { loadTranslate } from '../shared/i18n';
import type { PendingSave } from '../shared/messages';
import { pageInfo } from '../shared/page';
import { fromUrl, mainMedia } from '../shared/pick';
import type { JobTarget } from '../shared/jobs';
import { defaultMeta, downloadJob, saveRequest } from '../shared/request';
import { getAccount, getSettings } from '../shared/settings';
import { siteVideos } from '../sites';
import { useReferer } from './headers';
import { currentLang } from './lang';
import { enqueue } from './queue';
import { getTab } from './tabs';

/**
 * Without the popup: "Download video" and "Save to My shelf" in the menu of a video,
 * a link to a video file and a page, and their shortcuts (Alt+Shift+D, Alt+Shift+S). A download
 * goes at once, in the settings' quality. To the shelf: with the form on (or not connected
 * yet) the popup opens on it; with the form off, the video goes to the queue with the defaults.
 */
const VIDEO_LINKS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'm3u8', 'mpd'].flatMap((ext) => [
  `*://*/*.${ext}`,
  `*://*/*.${ext}?*`,
]);

export async function buildMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const t = await loadTranslate(await currentLang());
  for (const [target, title] of [
    ['disk', t('menu.download')],
    ['shelf', t('menu.save')],
  ] as const) {
    chrome.contextMenus.create({ id: `${target}:video`, title, contexts: ['video'] });
    chrome.contextMenus.create({
      id: `${target}:link`,
      title,
      contexts: ['link'],
      targetUrlPatterns: VIDEO_LINKS,
    });
    chrome.contextMenus.create({ id: `${target}:page`, title, contexts: ['page'] });
  }
}

/** The popup, or the same page in a small window where the browser cannot open the popup. */
export async function openPopup(): Promise<void> {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?window=1'),
      type: 'popup',
      width: 400,
      height: 620,
    });
  }
}

export async function saveFromTab(
  tab: chrome.tabs.Tab | undefined,
  url: string | undefined,
  to: JobTarget,
): Promise<void> {
  if (tab?.id === undefined) return;
  const target = url && /^https?:/.test(url) ? url : undefined;
  const settings = await getSettings();
  const youtube = BUILD === 'store' && isYoutube(tab.url ?? '');
  // Firefox's consent to send a video is asked in a click: the popup's, when not given yet.
  const ask =
    to === 'shelf' && (!(await getAccount()) || settings.showForm || !(await allowedToSend()));
  if (ask || youtube) {
    const pending: PendingSave = { tabId: tab.id, url: target };
    await chrome.storage.session.set({ pending });
    return openPopup();
  }
  const [state, page, site] = await Promise.all([
    getTab(tab.id),
    pageInfo(tab.id),
    target ? undefined : siteVideos(tab.id, tab.url ?? '', useReferer),
  ]);
  const items = state?.items ?? [];
  const pageUrl = state?.pageUrl ?? tab.url ?? '';
  const media = target
    ? fromUrl(target, pageUrl, items)
    : (site?.[0] ?? mainMedia(items, page?.videos));
  if (!media) {
    // Nothing to save at once: the popup says so and shows what there is.
    await chrome.storage.session.set({ pending: { tabId: tab.id } satisfies PendingSave });
    return openPopup();
  }
  const meta = defaultMeta(media, page, settings);
  const download = downloadJob(media, meta, settings, undefined, page?.image);
  // A live stream from the menu or the shortcut: recorded from now.
  if (media.live) download.request.live = { from: 'now' };
  await enqueue(
    [
      to === 'disk'
        ? download
        : {
            target: 'shelf',
            request: saveRequest(media, meta, settings),
            thumbnail: media.thumbnail ?? page?.image,
          },
    ],
    true,
  );
}

export function listenForMenus(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const [to, on] = String(info.menuItemId).split(':') as [JobTarget, string];
    const url = on === 'video' ? info.srcUrl : info.linkUrl;
    void saveFromTab(tab, on === 'page' ? undefined : url, to);
  });
  chrome.commands.onCommand.addListener((command, tab) => {
    const to: JobTarget | undefined =
      command === 'download-video' ? 'disk' : command === 'save-video' ? 'shelf' : undefined;
    if (!to) return;
    void (async () => {
      const active = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      await saveFromTab(active, undefined, to);
    })();
  });
}
