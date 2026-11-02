import { htmlToText } from '../shared/html';
import type { SiteAdapter } from './types';

/**
 * ManyVids: a video's page (`/Video/<id>/…`) asks ManyVids' own store API from the page, with the
 * person's session: `…/private` gives the files a buyer may have (the original upload, else the
 * transcoded one), the other the title, description, cover and length. With only the teaser on
 * offer (not bought), nothing is saved here and the page's own player stays the list.
 */
interface MvPrivate {
  data?: { filepath?: string; transcodedFilepath?: string; teaser?: { filepath?: string } };
}

interface MvMeta {
  data?: {
    title?: string;
    description?: string;
    screenshot?: string;
    thumbnail?: string;
    videoDuration?: string;
  };
}

/** "00:12:30" or "12:30" in seconds. */
const seconds = (text: string | undefined) =>
  text ? text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) || undefined : undefined;

export const manyvids: SiteAdapter = {
  id: 'manyvids',
  matches: (url) => /(^|\.)manyvids\.com$/.test(url.hostname),
  videoId: (url) => /^\/video\/(\d+)/i.exec(url.pathname)?.[1],
  collect: async (id) => {
    const get = async (path: string) => {
      const res = await fetch(`/bff/store/video/${id}${path}`, { credentials: 'include' });
      return res.ok ? res.json() : null;
    };
    const [files, meta] = await Promise.all([get('/private'), get('')]);
    return JSON.stringify({ files, meta });
  },
  ask: async (id, page, fetchSite) => {
    const get = (path: string) =>
      fetchSite(`${page.origin}/bff/store/video/${id}${path}`).then((r) =>
        r.ok ? (r.json() as Promise<unknown>) : null,
      );
    const [files, meta] = await Promise.all([get('/private'), get('')]);
    return JSON.stringify({ files, meta });
  },
  parse(answer, page, id) {
    if (typeof answer !== 'string') return [];
    let files: MvPrivate | null;
    let meta: MvMeta | null;
    try {
      ({ files, meta } = JSON.parse(answer) as { files: MvPrivate | null; meta: MvMeta | null });
    } catch {
      return [];
    }
    const url = files?.data?.filepath ?? files?.data?.transcodedFilepath;
    if (!url || !/^https?:/.test(url)) return [];
    const m = meta?.data ?? {};
    return [
      {
        kind: /\.m3u8(\?|$)/.test(url) ? 'hls' : 'file',
        url,
        title: htmlToText(m.title) ?? `ManyVids ${id}`,
        description: htmlToText(m.description),
        thumbnail: m.screenshot ?? m.thumbnail,
        duration: seconds(m.videoDuration),
        pageUrl: `${page.origin}/Video/${id}`,
        sensitive: true,
      },
    ];
  },
};
