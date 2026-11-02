/**
 * The extension's own texts in the app's 20 languages. The language is the browser's
 * unless the settings name one; chrome.i18n cannot switch at runtime, so the dictionaries are
 * JSON files of the extension, read with fetch. Only the name and description in the store and
 * the menu of shortcuts come from _locales.
 */
export const LANGS = [
  'en',
  'ru',
  'uk',
  'es',
  'pt',
  'fr',
  'de',
  'it',
  'pl',
  'tr',
  'nl',
  'cs',
  'sv',
  'ja',
  'ko',
  'zh',
  'id',
  'vi',
  'th',
  'hi',
] as const;

export type Lang = (typeof LANGS)[number];

type Dict = { [key: string]: string | Dict };
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function supportedLang(tag: string | undefined): Lang {
  const short = tag?.toLowerCase().slice(0, 2);
  return (LANGS as readonly string[]).includes(short ?? '') ? (short as Lang) : 'en';
}

/** The language of the browser's interface, if the extension speaks it. */
export const browserLang = (): Lang => supportedLang(chrome.i18n.getUILanguage());

/** A language's name in itself: Deutsch, 日本語. */
export function langName(lang: Lang): string {
  const name = new Intl.DisplayNames([lang], { type: 'language' }).of(lang) ?? lang;
  return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
}

function lookup(dict: Dict | undefined, key: string): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

/** `{{name}}` filled from params; a key missing in the language falls back to English. */
export function translator(dict: Dict, fallback: Dict): Translate {
  return (key, params = {}) =>
    (lookup(dict, key) ?? lookup(fallback, key) ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
      String(params[name] ?? ''),
    );
}

const cache = new Map<Lang, Promise<Dict>>();

function dictionary(lang: Lang): Promise<Dict> {
  let dict = cache.get(lang);
  if (!dict) {
    dict = fetch(chrome.runtime.getURL(`i18n/${lang}.json`)).then((r) => r.json() as Promise<Dict>);
    cache.set(lang, dict);
  }
  return dict;
}

export async function loadTranslate(lang: Lang): Promise<Translate> {
  const [dict, fallback] = await Promise.all([dictionary(lang), dictionary('en')]);
  return translator(dict, fallback);
}
