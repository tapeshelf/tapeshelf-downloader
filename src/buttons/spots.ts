/**
 * Where the button on a site's page stands: beside the site's own buttons of a post with a
 * video, in their row — and the post's own address, which the site's adapter asks about. Sites
 * change their markup; a post whose row is not found keeps its button in its video's corner, and a
 * video page whose post is not found at all gets one on its biggest video (`page.ts`).
 */
export interface Spot {
  /** The row of the site's buttons the button joins. */
  row?: Element;
  /** Else the video (or its player) whose corner it stands in. */
  video?: Element;
  /** The post's own address. */
  url: string;
}

const absolute = (href: string | null | undefined) => {
  try {
    return href ? new URL(href, location.href).href : undefined;
  } catch {
    return undefined;
  }
};

/** X: each post with a video, its row of buttons (reply, repost, like…) under it. */
function x(): Spot[] {
  return [...document.querySelectorAll('article[data-testid="tweet"]')].flatMap((post) => {
    const video = post.querySelector(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], video',
    );
    if (!video) return [];
    // The post's time links to it; a post's page may show it without one.
    const link = [...post.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].find((a) =>
      a.querySelector('time'),
    );
    const href = link?.href ?? (/\/status\/\d+/.test(location.pathname) ? location.href : '');
    const url = /^(.*\/status\/\d+)/.exec(absolute(href) ?? '')?.[1];
    if (!url) return [];
    const rows = post.querySelectorAll('[role="group"]');
    return [{ row: rows[rows.length - 1], video, url }];
  });
}

/** YouTube (the full build): a video's row of buttons under it, a Short's column beside it. */
function youtube(): Spot[] {
  if (location.pathname === '/watch')
    return [
      {
        row: document.querySelector('ytd-watch-metadata #top-level-buttons-computed') ?? undefined,
        video: document.querySelector('#movie_player video') ?? undefined,
        url: location.href,
      },
    ];
  if (location.pathname.startsWith('/shorts/'))
    return [
      {
        row: document.querySelector('ytd-reel-video-renderer[is-active] #actions') ?? undefined,
        video: document.querySelector('ytd-reel-video-renderer[is-active] video') ?? undefined,
        url: location.href,
      },
    ];
  return [];
}

/** TikTok: each video of a feed or a video's page, its column of buttons (like, comment, share). */
function tiktok(): Spot[] {
  const share = [...document.querySelectorAll('[data-e2e="share-icon"]')];
  return share.flatMap((icon) => {
    const row = icon.closest('button')?.parentElement ?? undefined;
    const item = icon.closest('article, [data-e2e="recommend-list-item-container"]');
    const link = item?.querySelector<HTMLAnchorElement>('a[href*="/video/"]');
    const url =
      absolute(link?.href) ?? (/\/video\/\d+/.test(location.pathname) ? location.href : '');
    if (!url) return [];
    return [{ row, video: item?.querySelector('video') ?? undefined, url }];
  });
}

/** Bilibili: a video's page, its toolbar (like, coin, favourite, share). */
function bilibili(): Spot[] {
  if (!location.pathname.startsWith('/video/')) return [];
  return [
    {
      row: document.querySelector('.video-toolbar-left-main, .video-toolbar-left') ?? undefined,
      video: document.querySelector('.bpx-player-video-wrap video, video') ?? undefined,
      url: location.href,
    },
  ];
}

/** RedNote: a note's page, its bar of buttons (like, collect, comment). */
function rednote(): Spot[] {
  if (!/^\/(explore|discovery\/item)\//.test(location.pathname)) return [];
  return [
    {
      row: document.querySelector('.interactions .engage-bar, .engage-bar') ?? undefined,
      video: document.querySelector('video') ?? undefined,
      url: location.href,
    },
  ];
}

/** Reddit: each post with a video — its player's corner (the post's buttons are its own world). */
function reddit(): Spot[] {
  return [...document.querySelectorAll('shreddit-post')].flatMap((post) => {
    const video = post.querySelector('shreddit-player, shreddit-player-2, video');
    const url = absolute(post.getAttribute('permalink'));
    return video && url ? [{ video, url }] : [];
  });
}

/** Instagram: each post or reel with a video — its corner (its buttons carry no names to find). */
function instagram(): Spot[] {
  return [...document.querySelectorAll('article')].flatMap((post) => {
    const video = post.querySelector('video');
    const link = [...post.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]')]
      .map((a) => a.href)
      .find(Boolean);
    const url =
      absolute(link) ?? (/^\/(p|reel|reels)\//.test(location.pathname) ? location.href : '');
    return video && url ? [{ video, url }] : [];
  });
}

/** The sites whose posts the button finds; the others: the video page's biggest video. */
const SITES: [RegExp, () => Spot[]][] = [
  [/(^|\.)(x\.com|twitter\.com)$/, x],
  [/(^|\.)youtube\.com$/, youtube],
  [/(^|\.)tiktok\.com$/, tiktok],
  [/(^|\.)bilibili\.com$/, bilibili],
  [/(^|\.)(xiaohongshu\.com|rednote\.com)$/, rednote],
  [/(^|\.)reddit\.com$/, reddit],
  [/(^|\.)instagram\.com$/, instagram],
];

export function spots(host: string): Spot[] {
  const find = SITES.find(([test]) => test.test(host))?.[1];
  try {
    return find ? find() : [];
  } catch {
    return [];
  }
}
