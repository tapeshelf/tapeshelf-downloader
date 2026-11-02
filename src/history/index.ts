import { ICONS, h, icon, logo, replace, type Child } from '../shared/dom';
import { formatBytes } from '../shared/format';
import { browserLang, loadTranslate, type Lang, type Translate } from '../shared/i18n';
import { history, isActive, listJobs, targetOf, type Job } from '../shared/jobs';
import { send, type BackgroundMessage } from '../shared/messages';
import { getAccount, getSettings, setSettings, type Settings } from '../shared/settings';
import { siteOf } from '../shared/filename';

/**
 * The history: every finished video — downloaded, on the shelf, failed — kept in this
 * browser only, newest first, with search. A download can be shown in its folder, its page opened,
 * or sent to the shelf as well; the history can be switched off and cleared.
 */
const app = document.getElementById('app')!;
let t: Translate = (key) => key;
let lang: Lang = 'en';
let settings: Settings;
let jobs: Job[] = [];
let query = '';
let connected = false;

async function load(): Promise<void> {
  settings = await getSettings();
  lang = settings.language === 'auto' ? browserLang() : settings.language;
  t = await loadTranslate(lang);
  document.documentElement.lang = lang;
  document.title = t('history.title');
  connected = !!(await getAccount());
  jobs = history(await listJobs());
  render();
}

const matches = (job: Job, q: string) => {
  if (!q) return true;
  const hay = [job.request.meta.title, job.request.media.pageUrl, job.disk?.path ?? '']
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word));
};

const when = (ms: number) =>
  new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

function status(job: Job): Child {
  const disk = targetOf(job) === 'disk';
  if (job.status === 'done')
    return h('span', { class: 'done' }, t(disk ? 'queue.downloaded' : 'queue.done'));
  if (job.status === 'failed')
    return h('span', { class: 'error' }, job.error?.message ?? t('queue.failed'));
  return t('queue.cancelled');
}

function action(label: string, paths: string, testid: string, onclick: () => unknown): HTMLElement {
  return h(
    'button',
    {
      class: 'btn btn-ghost btn-sm icon-btn',
      title: label,
      'aria-label': label,
      'data-testid': testid,
      onclick,
    },
    icon(paths),
  );
}

async function act(message: BackgroundMessage): Promise<void> {
  await send(message);
  jobs = history(await listJobs());
  render();
}

function entry(job: Job): HTMLElement {
  const disk = targetOf(job) === 'disk';
  const shelfJob = job.shelved ? jobs.find((j) => j.id === job.shelved) : undefined;
  const size = job.disk?.size ?? job.bytes?.done;
  const line = [
    siteOf(job.request.media.pageUrl),
    when(job.updatedAt),
    job.plan?.quality ??
      (job.request.format === 'mp3'
        ? 'MP3'
        : job.request.format === 'audio'
          ? t('found.audioOnly')
          : undefined),
    size ? formatBytes(size, lang) : '',
  ].filter(Boolean);
  return h(
    'li',
    { class: 'entry', 'data-testid': 'history-entry', 'data-status': job.status },
    h(
      'span',
      { class: 'thumb' },
      job.thumbnail
        ? h('img', { src: job.thumbnail, alt: '', referrerpolicy: 'no-referrer' })
        : icon(ICONS.film, 18),
    ),
    h(
      'span',
      { class: 'entry-text' },
      h('span', { class: 'entry-name' }, job.request.meta.title),
      h('span', { class: 'label-mono' }, line.join(' · '), ' · ', status(job)),
    ),
    h(
      'span',
      { class: 'entry-actions' },
      disk &&
        job.status === 'done' &&
        job.disk?.downloadId !== undefined &&
        action(t('queue.showInFolder'), ICONS.folder, 'history-show', () =>
          chrome.downloads.show(job.disk!.downloadId!),
        ),
      action(t('history.openPage'), ICONS.link, 'history-page', () =>
        chrome.tabs.create({ url: job.request.media.pageUrl }),
      ),
      disk &&
        job.status === 'done' &&
        !shelfJob &&
        action(t('save.button'), ICONS.shelf, 'history-shelve', () => void shelve(job)),
      !disk &&
        job.status === 'done' &&
        job.video &&
        action(t('queue.open'), ICONS.shelf, 'history-open', () =>
          chrome.tabs.create({ url: `${job.server}/${job.video!.code}` }),
        ),
      job.status !== 'done' &&
        action(t('queue.retry'), ICONS.retry, 'history-retry', () =>
          act({ type: 'retry', id: job.id }),
        ),
      action(t('queue.remove'), ICONS.close, 'history-remove', () =>
        act({ type: 'remove', id: job.id }),
      ),
    ),
  );
}

/** To the shelf as well; connecting first when not connected (the sign-in window). */
async function shelve(job: Job): Promise<void> {
  if (!connected) {
    await send({ type: 'connect' });
    connected = !!(await getAccount());
    if (!connected) return;
  }
  await act({ type: 'shelve', id: job.id });
}

function list(): HTMLElement {
  const shown = jobs.filter((j) => !isActive(j) && matches(j, query));
  if (!jobs.length)
    return h(
      'p',
      { class: 'empty', 'data-testid': 'history-empty' },
      t(settings.history ? 'history.empty' : 'history.off'),
    );
  if (!shown.length) return h('p', { class: 'empty' }, t('history.nothingFound'));
  return h('ul', { class: 'entries', 'data-testid': 'history-list' }, shown.map(entry));
}

function render(): void {
  const results = h('div', { id: 'results' }, list());
  replace(
    app,
    h(
      'header',
      { class: 'head' },
      h('span', { class: 'brand' }, logo(30), h('span', { class: 'wordmark' }, 'tapeshelf')),
      h('h1', { class: 'title' }, t('history.title')),
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'tools' },
        h('input', {
          class: 'control',
          type: 'search',
          placeholder: t('history.search'),
          'aria-label': t('history.search'),
          value: query,
          'data-testid': 'history-search',
          oninput: (e: Event) => {
            query = (e.target as HTMLInputElement).value.trim();
            replace(results, list());
          },
        }),
        h(
          'button',
          {
            class: 'btn btn-sm',
            'data-testid': 'history-clear',
            disabled: !jobs.length,
            onclick: () => act({ type: 'clear' }),
          },
          t('history.clear'),
        ),
      ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: settings.history,
          'data-testid': 'history-toggle',
          onchange: async (e: Event) => {
            settings = await setSettings({ history: (e.target as HTMLInputElement).checked });
            render();
          },
        }),
        h('span', null, t('history.keep')),
      ),
      h('p', { class: 'hint' }, icon(ICONS.lock, 13), ' ', t('history.private')),
    ),
    results,
  );
}

// Something finished or was cleared from the popup meanwhile.
chrome.runtime.onMessage.addListener((message: BackgroundMessage) => {
  if (message.type === 'job' && !isActive(message.job)) void load();
});

void load();
