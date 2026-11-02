import { api, type ExtensionContext } from '../shared/api';
import { ICONS, h, icon, logo, replace } from '../shared/dom';
import {
  LANGS,
  browserLang,
  langName,
  loadTranslate,
  type Lang,
  type Translate,
} from '../shared/i18n';
import type { Visibility } from '../shared/media';
import { send } from '../shared/messages';
import { NAME_FIELDS, downloadPath, today } from '../shared/filename';
import { formatBytes } from '../shared/format';
import { QUALITY_PREFS, type QualityPref } from '../shared/quality';
import {
  DEFAULT_FILE_NAME,
  DEFAULT_FOLDER,
  DEFAULT_SERVER,
  siteKey,
  getAccount,
  getSettings,
  normalizeServer,
  setSettings,
  type Account,
  type Settings,
} from '../shared/settings';

/**
 * The extension's settings: downloading first — the quality, the file's name and
 * folder, the history, the line about the shelf — then the shelf: the account and the server,
 * whether to ask before saving and the defaults when not, keeping the page's address; the
 * shortcuts, the language. Every change is saved as it is made.
 */
const app = document.getElementById('app')!;
let t: Translate = (key) => key;
let lang: Lang = 'en';
let settings: Settings;
let account: Account | null = null;
let context: ExtensionContext | undefined;
let serverError = false;

async function load(): Promise<void> {
  settings = await getSettings();
  lang = settings.language === 'auto' ? browserLang() : settings.language;
  t = await loadTranslate(lang);
  document.documentElement.lang = lang;
  document.title = t('options.title');
  account = await getAccount();
  context = account
    ? await api<ExtensionContext>(account, 'GET', '/extension/context', undefined, lang).catch(
        () => undefined,
      )
    : undefined;
  render();
}

async function change(patch: Partial<Settings>): Promise<void> {
  settings = await setSettings(patch);
}

function section(title: string, ...children: (Node | false | null | undefined)[]) {
  return h(
    'section',
    { class: 'card' },
    h('h2', { class: 'label-mono section-title' }, title),
    children,
  );
}

function accountSection(): HTMLElement {
  const host = new URL(settings.server).host;
  return section(
    t('options.account'),
    account
      ? h(
          'div',
          { class: 'row', 'data-testid': 'options-account' },
          h(
            'span',
            { class: 'who' },
            h(
              'span',
              { class: 'avatar' },
              account.user.avatarUrl
                ? h('img', { src: account.user.avatarUrl, alt: '' })
                : account.user.displayName.charAt(0).toUpperCase(),
            ),
            h(
              'span',
              null,
              h('span', { class: 'strong' }, account.user.displayName),
              h('span', { class: 'label-mono' }, ` @${account.user.username} · ${host}`),
            ),
          ),
          h(
            'button',
            {
              class: 'btn btn-sm',
              'data-testid': 'options-disconnect',
              onclick: async () => {
                await send({ type: 'disconnect' });
                await load();
              },
            },
            t('options.disconnect'),
          ),
        )
      : h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted' }, t('options.notConnected', { host })),
          h(
            'button',
            {
              class: 'btn btn-primary btn-sm',
              'data-testid': 'options-connect',
              onclick: async () => {
                await send({ type: 'connect' });
                await load();
              },
            },
            t('connect.button'),
          ),
        ),
  );
}

function serverSection(): HTMLElement {
  const input = h('input', {
    class: 'control',
    value: settings.server,
    placeholder: DEFAULT_SERVER,
    'aria-invalid': serverError ? 'true' : undefined,
    'data-testid': 'options-server',
  });
  return section(
    t('options.server'),
    h(
      'form',
      {
        class: 'row',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const server = normalizeServer(input.value);
          serverError = !server;
          if (server && server !== settings.server) {
            // Another server, another account: the old connection is undone first.
            if (account) await send({ type: 'disconnect' });
            await change({ server, categoryId: null });
          }
          await load();
        },
      },
      input,
      h('button', { class: 'btn', type: 'submit' }, t('options.save')),
    ),
    h(
      'p',
      { class: serverError ? 'hint error' : 'hint' },
      serverError ? t('options.serverInvalid') : t('options.serverHint'),
    ),
  );
}

function qualitySelect(): HTMLElement {
  return h(
    'select',
    {
      class: 'control',
      'data-testid': 'options-quality',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        void change({ quality: (v === 'best' ? 'best' : Number(v)) as QualityPref });
      },
    },
    QUALITY_PREFS.map((q) =>
      h(
        'option',
        { value: String(q), selected: q === settings.quality },
        q === 'best' ? t('options.qualityBest') : t('options.qualityUpTo', { height: q }),
      ),
    ),
  );
}

/** The file's name as it would be for an example video, under the template's field. */
function namePreview(): string {
  return downloadPath(
    {
      template: settings.fileName,
      folder: settings.folder,
      title: t('options.exampleTitle'),
      site: 'vk.com',
      author: t('options.exampleAuthor'),
      date: today(),
    },
    '1080p',
    'mp4',
  );
}

function downloadSection(): HTMLElement {
  const preview = h(
    'p',
    { class: 'label-mono', 'data-testid': 'options-name-preview' },
    namePreview(),
  );
  const template = h('input', {
    class: 'control',
    value: settings.fileName,
    placeholder: DEFAULT_FILE_NAME,
    'data-testid': 'options-file-name',
    oninput: (e: Event) => {
      settings.fileName = (e.target as HTMLInputElement).value;
      preview.textContent = namePreview();
    },
    onchange: (e: Event) =>
      void change({ fileName: (e.target as HTMLInputElement).value.trim() || DEFAULT_FILE_NAME }),
  });
  const insert = (field: string) => {
    const at = template.selectionStart ?? template.value.length;
    const value = `${template.value.slice(0, at)}{${field}}${template.value.slice(template.selectionEnd ?? at)}`;
    template.value = value;
    settings.fileName = value;
    preview.textContent = namePreview();
    void change({ fileName: value });
    template.focus();
  };
  return section(
    t('options.download'),
    h(
      'label',
      { class: 'field' },
      h('span', null, t('options.quality')),
      qualitySelect(),
      h('p', { class: 'hint' }, t('options.qualityHint')),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', null, t('options.audioLanguage')),
      h(
        'select',
        {
          class: 'control',
          'data-testid': 'options-audio-language',
          onchange: (e: Event) =>
            void change({ audioLanguage: (e.target as HTMLSelectElement).value }),
        },
        h(
          'option',
          { value: 'auto', selected: settings.audioLanguage === 'auto' },
          t('options.languageAuto'),
        ),
        LANGS.map((l) =>
          h('option', { value: l, selected: settings.audioLanguage === l }, langName(l)),
        ),
      ),
      h('p', { class: 'hint' }, t('options.audioLanguageHint')),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.skipAds,
        'data-testid': 'options-skip-ads',
        onchange: (e: Event) => void change({ skipAds: (e.target as HTMLInputElement).checked }),
      }),
      h(
        'span',
        null,
        h('span', { class: 'strong' }, t('options.skipAds')),
        h('span', { class: 'hint' }, t('options.skipAdsHint')),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', null, t('options.fileName')),
      template,
      h(
        'div',
        { class: 'chips' },
        NAME_FIELDS.map((f) =>
          h(
            'button',
            { type: 'button', class: 'btn btn-sm', onclick: () => insert(f) },
            t(`options.field.${f}`),
          ),
        ),
      ),
      preview,
    ),
    h(
      'label',
      { class: 'field' },
      h('span', null, t('options.folder')),
      h('input', {
        class: 'control',
        value: settings.folder,
        placeholder: DEFAULT_FOLDER,
        'data-testid': 'options-folder',
        oninput: (e: Event) => {
          settings.folder = (e.target as HTMLInputElement).value;
          preview.textContent = namePreview();
        },
        onchange: (e: Event) =>
          void change({ folder: (e.target as HTMLInputElement).value.trim() }),
      }),
      h('p', { class: 'hint' }, t('options.folderHint')),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.history,
        'data-testid': 'options-history',
        onchange: (e: Event) => void change({ history: (e.target as HTMLInputElement).checked }),
      }),
      h(
        'span',
        null,
        h('span', { class: 'strong' }, t('history.keep')),
        h('span', { class: 'hint' }, t('history.private')),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn-sm',
          'data-testid': 'options-open-history',
          onclick: () => void chrome.tabs.create({ url: chrome.runtime.getURL('history.html') }),
        },
        t('options.openHistory'),
      ),
      h(
        'button',
        {
          class: 'btn btn-sm',
          'data-testid': 'options-clear-history',
          onclick: async (e: Event) => {
            await send({ type: 'clear' });
            (e.target as HTMLButtonElement).textContent = t('options.historyCleared');
          },
        },
        t('history.clear'),
      ),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.shelfHint,
        'data-testid': 'options-shelf-hint',
        onchange: (e: Event) => void change({ shelfHint: (e.target as HTMLInputElement).checked }),
      }),
      h(
        'span',
        null,
        h('span', { class: 'strong' }, t('options.shelfHint')),
        h('span', { class: 'hint' }, t('options.shelfHintHint')),
      ),
    ),
    // "Download" beside a site's own buttons: on unless turned off here.
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.pageButtons,
        'data-testid': 'options-page-buttons',
        onchange: (e: Event) =>
          void change({ pageButtons: (e.target as HTMLInputElement).checked }),
      }),
      h(
        'span',
        null,
        h('span', { class: 'strong' }, t('options.pageButtons')),
        h('span', { class: 'hint' }, t('options.pageButtonsHint')),
      ),
    ),
  );
}

/** Sites: where to look for no video, and a file name of a site's own. */
function sitesSection(): HTMLElement {
  const rules = h('div', { class: 'rules' });
  const drawRules = () =>
    replace(
      rules,
      settings.siteNames.map((rule, i) =>
        h(
          'div',
          { class: 'rule', 'data-testid': 'options-site-name' },
          h('input', {
            class: 'control',
            value: rule.site,
            placeholder: 'vk.com',
            'aria-label': t('options.site'),
            onchange: (e: Event) => {
              settings.siteNames[i] = {
                ...rule,
                site: siteKey((e.target as HTMLInputElement).value),
              };
              void change({ siteNames: settings.siteNames });
            },
          }),
          h('input', {
            class: 'control',
            value: rule.template,
            placeholder: '{author} — {title}',
            'aria-label': t('options.fileName'),
            onchange: (e: Event) => {
              settings.siteNames[i] = {
                ...rule,
                template: (e.target as HTMLInputElement).value.trim(),
              };
              void change({ siteNames: settings.siteNames });
            },
          }),
          h(
            'button',
            {
              class: 'btn btn-ghost btn-sm icon-btn',
              title: t('queue.remove'),
              'aria-label': t('queue.remove'),
              onclick: async () => {
                await change({ siteNames: settings.siteNames.filter((_, j) => j !== i) });
                drawRules();
              },
            },
            icon(ICONS.close),
          ),
        ),
      ),
    );
  drawRules();
  return section(
    t('options.sites'),
    h(
      'label',
      { class: 'field' },
      h('span', null, t('options.blocked')),
      h('textarea', {
        class: 'control',
        rows: 3,
        placeholder: 'example.com',
        value: settings.blockedSites.join('\n'),
        'data-testid': 'options-blocked',
        onchange: (e: Event) =>
          void change({
            blockedSites: [
              ...new Set(
                (e.target as HTMLTextAreaElement).value.split(/\s+/).map(siteKey).filter(Boolean),
              ),
            ],
          }),
      }),
      h('p', { class: 'hint' }, t('options.blockedHint')),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', null, t('options.siteNames')),
      rules,
      h(
        'button',
        {
          class: 'btn btn-sm add-rule',
          'data-testid': 'options-add-site-name',
          onclick: async () => {
            await change({ siteNames: [...settings.siteNames, { site: '', template: '' }] });
            drawRules();
          },
        },
        t('options.addSiteName'),
      ),
      h('p', { class: 'hint' }, t('options.siteNamesHint')),
    ),
  );
}

/** Recording what plays: reload the page, or copy ahead into a buffer — everywhere or on sites. */
function captureSection(): HTMLElement {
  const sites = h('textarea', {
    class: 'control',
    rows: 2,
    placeholder: 'twitch.tv',
    value: settings.captureSites.join('\n'),
    disabled: settings.captureMode !== 'sites',
    'data-testid': 'options-capture-sites',
    onchange: (e: Event) =>
      void change({
        captureSites: [
          ...new Set(
            (e.target as HTMLTextAreaElement).value.split(/\s+/).map(siteKey).filter(Boolean),
          ),
        ],
      }),
  });
  const mode = (value: Settings['captureMode'], label: string) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'radio',
        name: 'capture-mode',
        checked: settings.captureMode === value,
        'data-testid': `options-capture-${value}`,
        onchange: async () => {
          await change({ captureMode: value });
          sites.disabled = value !== 'sites';
        },
      }),
      h('span', null, label),
    );
  return section(
    t('options.capture'),
    mode('reload', t('options.captureReload')),
    mode('all', t('options.captureAll')),
    mode('sites', t('options.captureSites')),
    sites,
    h(
      'label',
      { class: 'field' },
      h('span', null, t('options.captureBuffer')),
      h(
        'select',
        {
          class: 'control',
          'data-testid': 'options-capture-buffer',
          onchange: (e: Event) =>
            void change({ captureBufferMb: Number((e.target as HTMLSelectElement).value) }),
        },
        [512, 1024, 2048, 4096, 8192].map((mb) =>
          h(
            'option',
            { value: String(mb), selected: settings.captureBufferMb === mb },
            formatBytes(mb * 1024 * 1024, lang),
          ),
        ),
      ),
      h('p', { class: 'hint' }, t('options.captureHint')),
    ),
  );
}

function savingSection(): HTMLElement {
  const categories = context?.categories ?? [];
  return section(
    t('options.saving'),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.showForm,
        'data-testid': 'options-form',
        onchange: (e: Event) => void change({ showForm: (e.target as HTMLInputElement).checked }),
      }),
      h(
        'span',
        null,
        h('span', { class: 'strong' }, t('options.form')),
        h('span', { class: 'hint' }, t('options.formHint')),
      ),
    ),
    h('h3', { class: 'sub' }, t('options.defaults')),
    h(
      'div',
      { class: 'grid' },
      h(
        'label',
        { class: 'field' },
        h('span', null, t('form.category')),
        h(
          'select',
          {
            class: 'control',
            disabled: !categories.length,
            onchange: (e: Event) =>
              void change({ categoryId: (e.target as HTMLSelectElement).value || null }),
          },
          h('option', { value: '' }, t('form.noCategory')),
          categories.map((c) =>
            h('option', { value: c.id, selected: c.id === settings.categoryId }, c.name),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', null, t('form.visibility')),
      h(
        'div',
        { class: 'segmented', role: 'radiogroup' },
        (['PRIVATE', 'PUBLIC'] as Visibility[]).map((v) =>
          h(
            'label',
            null,
            h('input', {
              type: 'radio',
              name: 'visibility',
              checked: settings.visibility === v,
              onchange: () => void change({ visibility: v }),
            }),
            t(`form.${v.toLowerCase()}`),
          ),
        ),
      ),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.saveSource,
        'data-testid': 'options-source',
        onchange: (e: Event) => void change({ saveSource: (e.target as HTMLInputElement).checked }),
      }),
      h(
        'span',
        null,
        h('span', { class: 'strong' }, t('options.source')),
        h('span', { class: 'hint' }, t('options.sourceHint')),
      ),
    ),
  );
}

async function shortcutSection(): Promise<HTMLElement> {
  const commands = await chrome.commands.getAll();
  const keys = (name: string) => commands.find((c) => c.name === name)?.shortcut;
  const line = (name: string, label: string) =>
    h(
      'div',
      { class: 'row' },
      h('span', null, label),
      keys(name)
        ? h('kbd', null, keys(name))
        : h('span', { class: 'muted' }, t('options.shortcutNone')),
    );
  return section(
    t('options.shortcut'),
    line('download-video', t('menu.download')),
    line('save-video', t('menu.save')),
    h(
      'div',
      { class: 'row' },
      h('p', { class: 'hint' }, t('options.shortcutHint')),
      h(
        'button',
        {
          class: 'btn btn-sm',
          onclick: () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
        },
        t('options.shortcutChange'),
      ),
    ),
  );
}

function languageSection(): HTMLElement {
  return section(
    t('options.language'),
    h(
      'select',
      {
        class: 'control',
        'data-testid': 'options-language',
        onchange: async (e: Event) => {
          await change({ language: (e.target as HTMLSelectElement).value as Settings['language'] });
          await load();
        },
      },
      h(
        'option',
        { value: 'auto', selected: settings.language === 'auto' },
        t('options.languageAuto'),
      ),
      LANGS.map((l) => h('option', { value: l, selected: settings.language === l }, langName(l))),
    ),
  );
}

function render(): void {
  void shortcutSection().then((shortcut) =>
    replace(
      app,
      h(
        'header',
        { class: 'head' },
        h('span', { class: 'brand' }, logo(30), h('span', { class: 'wordmark' }, 'tapeshelf')),
        h('h1', { class: 'title' }, t('options.title')),
      ),
      downloadSection(),
      captureSection(),
      sitesSection(),
      h('h2', { class: 'label-mono section-title part' }, t('options.shelf')),
      accountSection(),
      serverSection(),
      savingSection(),
      shortcut,
      languageSection(),
      h('p', { class: 'hint privacy' }, icon(ICONS.lock, 13), ' ', t('options.privacy')),
    ),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  // Connected or disconnected from the popup meanwhile.
  if (area === 'local' && changes['account']) void load();
});

void load();
