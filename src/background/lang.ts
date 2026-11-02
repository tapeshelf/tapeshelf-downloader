import { browserLang, type Lang } from '../shared/i18n';
import { getSettings } from '../shared/settings';

/** The language the extension speaks: the settings' choice, else the browser's. */
export async function currentLang(): Promise<Lang> {
  const { language } = await getSettings();
  return language === 'auto' ? browserLang() : language;
}
