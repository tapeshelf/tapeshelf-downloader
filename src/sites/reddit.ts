import { textOf, type SiteAdapter } from './types';

/**
 * Reddit: a post (`/r/<sub>/comments/<id>/…`) is asked of Reddit's own JSON (`/comments/<id>/.json`)
 * from the page: a video hosted by Reddit is an HLS stream with its sound (of the post, or of the
 * post it crossposts), the title, the text, the preview, and Reddit's 18+ mark.
 */
interface RedditVideo {
  hls_url?: string;
  dash_url?: string;
  duration?: number;
}

interface RedditPost {
  id?: string;
  title?: string;
  author?: string;
  selftext?: string;
  permalink?: string;
  over_18?: boolean;
  secure_media?: { reddit_video?: RedditVideo } | null;
  media?: { reddit_video?: RedditVideo } | null;
  preview?: { images?: { source?: { url?: string } }[]; reddit_video_preview?: RedditVideo };
  crosspost_parent_list?: RedditPost[];
}

const videoOf = (p: RedditPost | undefined) =>
  p?.secure_media?.reddit_video ?? p?.media?.reddit_video;

export const reddit: SiteAdapter = {
  id: 'reddit',
  matches: (url) => /(^|\.)reddit\.com$/.test(url.hostname),
  videoId: (url) => /\/comments\/([a-z0-9]{4,})/i.exec(url.pathname)?.[1],
  collect: async (id) => {
    const res = await fetch(`/comments/${id}/.json?raw_json=1`, { credentials: 'include' });
    return res.ok ? res.text() : null;
  },
  ask: (id, _page, fetchSite) =>
    fetchSite(`https://www.reddit.com/comments/${id}/.json?raw_json=1`).then(textOf),
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    let post: RedditPost | undefined;
    try {
      post = (JSON.parse(answer) as { data?: { children?: { data?: RedditPost }[] } }[])[0]?.data
        ?.children?.[0]?.data;
    } catch {
      return [];
    }
    if (!post || post.id !== id) return [];
    const video = videoOf(post) ?? videoOf(post.crosspost_parent_list?.[0]);
    const url = video?.hls_url ?? video?.dash_url;
    if (!url) return [];
    return [
      {
        kind: video?.hls_url ? 'hls' : 'dash',
        url,
        title: post.title?.trim() || 'Reddit',
        author: post.author && post.author !== '[deleted]' ? post.author : undefined,
        description: post.selftext?.trim() || undefined,
        thumbnail: post.preview?.images?.[0]?.source?.url,
        duration: video?.duration,
        pageUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : page.href,
        sensitive: post.over_18 || undefined,
      },
    ];
  },
};
