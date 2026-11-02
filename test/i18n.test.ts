import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LANGS, supportedLang, translator } from '../src/shared/i18n';

/** Every language has every text, with the same {{params}} (the app's 20 languages). */
const DIR = fileURLToPath(new URL('../src', import.meta.url));
type Dict = { [key: string]: string | Dict };
const read = (path: string) => JSON.parse(readFileSync(join(DIR, path), 'utf8')) as Dict;
const flat = (d: Dict, prefix = ''): Record<string, string> =>
  Object.fromEntries(
    Object.entries(d).flatMap(([k, v]) =>
      typeof v === 'string' ? [[prefix + k, v]] : Object.entries(flat(v, `${prefix}${k}.`)),
    ),
  );
const params = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
/** Chrome's folder names for the store's texts. */
const LOCALE: Record<string, string> = { pt: 'pt_BR', zh: 'zh_CN' };

describe('dictionaries', () => {
  const en = flat(read('i18n/en.json'));

  it.each(LANGS)('%s has every text with its params', (lang) => {
    const dict = flat(read(`i18n/${lang}.json`));
    expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(dict[key]!.trim(), `${lang}: ${key}`).not.toBe('');
      expect(params(dict[key]!), `${lang}: ${key}`).toEqual(params(text));
    }
  });

  it('the store texts in every language, and no other dictionaries', () => {
    expect(readdirSync(join(DIR, 'i18n')).sort()).toEqual(LANGS.map((l) => `${l}.json`).sort());
    const keys = Object.keys(read('_locales/en/messages.json')).sort();
    for (const lang of LANGS) {
      const store = read(`_locales/${LOCALE[lang] ?? lang}/messages.json`) as Record<
        string,
        { message: string }
      >;
      expect(Object.keys(store).sort(), lang).toEqual(keys);
      expect(store['description']!.message.length, lang).toBeLessThanOrEqual(132);
    }
  });

  it('fills params and falls back to English', () => {
    const t = translator({ a: { b: 'Hello {{name}}' } }, { a: { b: 'x', c: 'Only English' } });
    expect(t('a.b', { name: 'Ann' })).toBe('Hello Ann');
    expect(t('a.c')).toBe('Only English');
    expect(t('a.missing')).toBe('a.missing');
    expect(supportedLang('pt-BR')).toBe('pt');
    expect(supportedLang('zh-CN')).toBe('zh');
    expect(supportedLang('xx')).toBe('en');
  });
});
