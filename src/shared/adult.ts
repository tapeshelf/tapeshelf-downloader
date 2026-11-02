/**
 * Sites for adults: a video saved from them is marked 18+ by itself, and
 * the form can take the mark off. Pages that label themselves (RTA, `rating: adult`) are marked
 * too, wherever they are; this list is for the sites that do not, and for their video hosts.
 */
export const ADULT_SITES = [
  '4tube.com',
  'beeg.com',
  'bongacams.com',
  'cam4.com',
  'camsoda.com',
  'chaturbate.com',
  'clips4sale.com',
  'drtuber.com',
  'eporner.com',
  'erome.com',
  'fansly.com',
  'faphouse.com',
  'fuq.com',
  'hclips.com',
  'hentaihaven.xxx',
  'hqporner.com',
  'iwara.tv',
  'justfor.fans',
  'manyvids.com',
  'motherless.com',
  'myfreecams.com',
  'nuvid.com',
  'onlyfans.com',
  'porn.com',
  'pornhub.com',
  'pornhubpremium.com',
  'porntrex.com',
  'pornone.com',
  'redgifs.com',
  'redtube.com',
  'rule34video.com',
  'spankbang.com',
  'stripchat.com',
  'sunporno.com',
  'tnaflix.com',
  'tube8.com',
  'txxx.com',
  'upornia.com',
  'xhamster.com',
  'xhamster.desi',
  'xnxx.com',
  'xvideos.com',
  'xvideos.red',
  'youjizz.com',
  'youporn.com',
];

/** The page is on one of those sites (or a subdomain of one). */
export function isAdultSite(pageUrl: string): boolean {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ADULT_SITES.some((site) => host === site || host.endsWith(`.${site}`));
}
