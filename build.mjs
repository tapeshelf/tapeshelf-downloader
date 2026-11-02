// Builds the browser extension into dist/<target>: one code, four builds.
// `full` is for every Chromium browser (Chrome, Edge, Brave, Opera, Vivaldi, Yandex), `firefox`
// the same for Firefox (its queue in the background page, its sidebar); both from tapeshelf.com,
// with everything in, and each asks the site for its own updates. For the stores, which
// update what they publish: `store` leaves YouTube and sites of bought videos (ManyVids) alone,
// for the Chrome Web Store, Edge Add-ons and Opera; `amo` is the Firefox build for Firefox Add-ons.
//   node build.mjs [store|full|firefox|amo] [--zip]
//   node build.mjs --stores    `store` and `amo`, zipped, and the source archive Firefox Add-ons
//                              reviews, into dist/stores
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const builds = args.filter((a) => ['store', 'full', 'firefox', 'amo'].includes(a));
const stores = args.includes('--stores');
const zip =
  stores ||
  args.includes('--zip');
/** The Firefox builds: from the site, and for Firefox Add-ons. */
const isFirefox = (target) => target === 'firefox' || target === 'amo';

const FONTS = ['golos-text', 'unbounded', 'jetbrains-mono'];

/** YouTube's pages, where the store build's recording mode stays out. */
/** The sites whose pages get the button beside their own: those with an adapter. */
const BUTTON_SITES = [
  'vk.com',
  'vk.ru',
  'vkvideo.ru',
  'tiktok.com',
  'douyin.com',
  'bilibili.com',
  'xiaohongshu.com',
  'rednote.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  //
  'twitch.tv',
  'kick.com',
  'rutube.ru',
  'dailymotion.com',
  'vimeo.com',
  //
  'facebook.com',
  'web.telegram.org',
];
const FULL_BUTTON_SITES = ['youtube.com', 'manyvids.com'];

const YOUTUBE = [
  '*://youtube.com/*',
  '*://*.youtube.com/*',
  '*://youtu.be/*',
  '*://*.youtube-nocookie.com/*',
];

function manifest(target) {
  const firefox = isFirefox(target);
  // The recording mode's ears and relay: on every page from its start, idle until asked.
  const everywhere = {
    matches: ['<all_urls>'],
    run_at: 'document_start',
    all_frames: true,
    ...(target === 'store' ? { exclude_matches: YOUTUBE } : {}),
  };
  return {
    manifest_version: 3,
    name: '__MSG_name__',
    short_name: 'tapeshelf',
    description: '__MSG_description__',
    default_locale: 'en',
    version,
    ...(target === 'full' ? { version_name: `${version} full` } : {}),
    ...(firefox
      ? {
          // An id of its own, and nothing collected: Firefox asks both of an extension.
          browser_specific_settings: {
            gecko: {
              id: 'video-downloader@tapeshelf.com',
              // Firefox's own consent to send data (below) came in 140; content scripts in the
              // page's world (the recording mode), in 128.
              strict_min_version: '140.0',
              // Downloading sends nothing; "Save to My shelf" sends the video to the person's
              // account, asked the first time.
              data_collection_permissions: { required: ['none'], optional: ['websiteContent'] },
            },
          },
        }
      : { minimum_chrome_version: '116' }),
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_actionTitle__',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    // The popup kept open beside the page: Chromium's side panel, Firefox's sidebar.
    ...(firefox
      ? {
          sidebar_action: {
            default_panel: 'sidepanel.html',
            default_title: '__MSG_actionTitle__',
            default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
            open_at_install: false,
          },
          background: { scripts: ['background.js'], type: 'module' },
        }
      : {
          side_panel: { default_path: 'sidepanel.html' },
          background: { service_worker: 'background.js', type: 'module' },
        }),
    options_ui: { page: 'options.html', open_in_tab: true },
    // The MP3 encoder is WebAssembly; nothing is loaded from outside the extension.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    permissions: [
      'webRequest',
      'declarativeNetRequestWithHostAccess',
      ...(firefox ? [] : ['offscreen', 'sidePanel']),
      'contextMenus',
      'notifications',
      'storage',
      'unlimitedStorage',
      'identity',
      'scripting',
      'downloads',
    ],
    host_permissions: ['<all_urls>'],
    content_scripts: [
      { ...everywhere, js: ['capture-main.js'], world: 'MAIN' },
      { ...everywhere, js: ['capture-relay.js'] },
      {
        matches: [...BUTTON_SITES, ...(target === 'store' ? [] : FULL_BUTTON_SITES)].flatMap(
          (host) => [`*://${host}/*`, `*://*.${host}/*`],
        ),
        js: ['page-buttons.js'],
        run_at: 'document_idle',
      },
    ],
    commands: {
      'download-video': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: '__MSG_commandDownload__',
      },
      'save-video': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '__MSG_commandSave__',
      },
    },
  };
}

/** The app's fonts: fontsource's @font-face rules, their files beside them. */
function fonts(out) {
  mkdirSync(join(out, 'fonts'), { recursive: true });
  let css = '';
  for (const name of FONTS) {
    const dir = join(ROOT, 'node_modules/@fontsource-variable', name);
    const index = readFileSync(join(dir, 'index.css'), 'utf8');
    css += index.replaceAll('url(./files/', 'url(fonts/');
    for (const [, file] of index.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g))
      cpSync(join(dir, 'files', file), join(out, 'fonts', file));
    // The SIL Open Font License travels with the fonts.
    cpSync(join(dir, 'LICENSE'), join(out, 'fonts', `${name}-LICENSE.txt`));
  }
  writeFileSync(join(out, 'fonts.css'), css);
}

/**
 * The store build gets empty modules for the adapters the stores do not take: YouTube, and
 * ManyVids (bought videos). None of their code is bundled.
 */
const LEFT_OUT = { youtube: 'youtubei', manyvids: '/bff/store/video/' };
const withoutAdapters = {
  name: 'without-adapters',
  setup(b) {
    b.onResolve({ filter: /^\.\/(youtube|manyvids)$/ }, (args) => ({
      path: args.path.slice(2),
      namespace: 'left-out',
    }));
    b.onLoad({ filter: /.*/, namespace: 'left-out' }, (args) => ({
      contents: `export const ${args.path} = undefined;`,
      loader: 'js',
    }));
  },
};

/**
 * Mediabunny 1.62.1's MPEG-TS demuxer keeps every reference PES packet with its data for seeking,
 * so reading a TS file holds nearly the whole video in memory. Seeking needs only the
 * time and the position: only they are kept. The build stops if the line changed (a new version:
 * check whether it is fixed there, then drop this).
 */
const SEEK_INDEX = 'maybeInsertReferencePacket(this.elementaryStream, currentPesPacket);';
const tsSeekIndexWithoutData = {
  name: 'ts-seek-index-without-data',
  setup(b) {
    b.onLoad({ filter: /mediabunny[\\/].*mpeg-ts-demuxer\.js$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      if (!src.includes(SEEK_INDEX))
        throw new Error('mediabunny changed: the TS seek-index fix no longer applies');
      return {
        contents: src.replace(
          SEEK_INDEX,
          'maybeInsertReferencePacket(this.elementaryStream, { pts: currentPesPacket.pts, sectionStartPos: currentPesPacket.sectionStartPos });',
        ),
        loader: 'js',
      };
    });
  },
};

/**
 * The MP3 encoder's worker as a file of the extension: the package starts it from a blob:
 * address, which an extension page's policy blocks in Firefox. Its code is taken out at build time
 * into `mp3-worker.js`, and the worker started from there — in every build alike. The build fails
 * if the package changes the way it starts its worker.
 */
let mp3Worker = '';
const mp3WorkerFile = {
  name: 'mp3-worker-file',
  setup(b) {
    b.onLoad(
      { filter: /mp3-encoder[\\/]dist[\\/]bundles[\\/]mediabunny-mp3-encoder\.mjs$/ },
      (args) => {
        const src = readFileSync(args.path, 'utf8');
        const call = /return inlineWorker\(('(?:[^'\\]|\\.)*')\);/s.exec(src);
        if (!call) throw new Error('the MP3 encoder changed how it starts its worker');
        mp3Worker = new Function(`return ${call[1]}`)();
        return {
          contents: src.replace(
            call[0],
            "return new Worker(chrome.runtime.getURL('mp3-worker.js'));",
          ),
          loader: 'js',
        };
      },
    );
  },
};

async function one(target) {
  const out = join(ROOT, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const define = {
    __BUILD__: JSON.stringify(target === 'store' ? 'store' : 'full'),
    __FIREFOX__: JSON.stringify(isFirefox(target)),
    // A store updates what it publishes; the site's builds ask the site.
    __SELF_UPDATING__: JSON.stringify(target === 'full' || target === 'firefox'),
  };
  await build({
    entryPoints: {
      // Firefox: the offscreen document's work in the background page too.
      background: join(ROOT, `src/background/${isFirefox(target) ? 'firefox' : 'index'}.ts`),
      ...(isFirefox(target) ? {} : { offscreen: join(ROOT, 'src/offscreen/index.ts') }),
      popup: join(ROOT, 'src/popup/index.ts'),
      options: join(ROOT, 'src/options/index.ts'),
      history: join(ROOT, 'src/history/index.ts'),
      'opfs-worker': join(ROOT, 'src/offscreen/opfs-worker.ts'),
    },
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome116',
    define,
    plugins: [
      tsSeekIndexWithoutData,
      mp3WorkerFile,
      ...(target === 'store' ? [withoutAdapters] : []),
    ],
    legalComments: 'none',
    logLevel: 'warning',
  });
  // Content scripts are classic scripts, not modules: built on their own.
  await build({
    entryPoints: {
      'capture-main': join(ROOT, 'src/capture/main.ts'),
      'capture-relay': join(ROOT, 'src/capture/relay.ts'),
      'page-buttons': join(ROOT, 'src/buttons/page.ts'),
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome116',
    define,
    legalComments: 'none',
    logLevel: 'warning',
  });
  for (const file of readdirSync(join(ROOT, 'src/static')))
    if (!(isFirefox(target) && file === 'offscreen.html'))
      cpSync(join(ROOT, 'src/static', file), join(out, file), { recursive: true });
  cpSync(join(ROOT, 'src/_locales'), join(out, '_locales'), { recursive: true });
  mkdirSync(join(out, 'i18n'));
  for (const file of readdirSync(join(ROOT, 'src/i18n'))) {
    // Compact copies: the popup reads its language on every opening.
    const dict = JSON.parse(readFileSync(join(ROOT, 'src/i18n', file), 'utf8'));
    writeFileSync(join(out, 'i18n', file), JSON.stringify(dict));
  }
  fonts(out);
  if (!mp3Worker) throw new Error('the MP3 encoder’s worker was not found');
  writeFileSync(join(out, 'mp3-worker.js'), mp3Worker);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
  // The store build carries nothing of YouTube or ManyVids: the stores take such
  // extensions down.
  if (target === 'store')
    for (const file of readdirSync(out).filter((f) => f.endsWith('.js')))
      for (const [adapter, mark] of Object.entries(LEFT_OUT))
        if (readFileSync(join(out, file), 'utf8').includes(mark))
          throw new Error(`dist/store/${file} carries the ${adapter} adapter`);
  // The TS fix is in: the offscreen document (Firefox: the background page) reads TS
  // through it.
  const reader = isFirefox(target) ? 'background.js' : 'offscreen.js';
  if (
    !readFileSync(join(out, reader), 'utf8').includes(
      'sectionStartPos: currentPesPacket.sectionStartPos',
    )
  )
    throw new Error(`the TS seek-index fix is not in ${reader}`);
  if (zip) {
    const archive = join(ROOT, 'dist', `tapeshelf-${target}-${version}.zip`);
    if (existsSync(archive)) rmSync(archive);
    execFileSync('zip', ['-r', '-X', '-q', archive, '.'], { cwd: out });
    console.log(`${archive}`);
  }
  console.log(`dist/${target} (${version})`);
}

const targets = builds.length
  ? builds
    : stores
      ? ['store', 'amo']
      : ['store', 'full', 'firefox', 'amo'];
for (const target of targets) await one(target);

if (stores) {
  // What the stores take: the store build for the Chrome Web Store, Edge Add-ons and Opera,
  // the Firefox build for Firefox Add-ons, and its source as its reviewers rebuild it
  // (`npm ci && node build.mjs amo` gives the same files).
  const out = join(ROOT, 'dist', 'stores');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(
    join(ROOT, 'dist', `tapeshelf-store-${version}.zip`),
    join(out, `tapeshelf-chromium-store-${version}.zip`),
  );
  cpSync(
    join(ROOT, 'dist', `tapeshelf-amo-${version}.zip`),
    join(out, `tapeshelf-firefox-amo-${version}.zip`),
  );
  const source = join(out, `tapeshelf-source-${version}.zip`);
  const files = [
    'package.json',
    'package-lock.json',
    'build.mjs',
    'tsconfig.json',
    'README.md',
    'src',
  ];
  execFileSync('zip', ['-r', '-X', '-q', source, ...files], { cwd: ROOT });
  execFileSync('zip', ['-X', '-q', '-j', source, join(ROOT, 'LICENSE')]);
  console.log(`dist/stores: the store and Firefox Add-ons packages, and the source (${version})`);
}

