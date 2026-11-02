# tapeshelf Video Downloader

A browser extension that saves the video on the page you're looking at to your computer, as one file with picture and sound. It can also send it straight to your private shelf on [tapeshelf](https://tapeshelf.com). No account needed for downloading, no ads, no telemetry.

Works in Chrome, Edge, Brave, Opera, Vivaldi, Yandex Browser and Firefox.

**Just want to use it?** Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/tapeshelf-video-downloade/pijnnlahcfdnnknpeimmdnofkegilbpf) or [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tapeshelf-video-downloader/). The code here is for people who want to read it, change it or build it themselves.

## What it does

- **Finds videos** on the open tab: plain files, HLS and DASH streams. The likeliest one comes first, with every quality and its size.
- **Saves one MP4 with sound.** Picture and sound are joined in your browser. Files of any size work, and a download cut off by closing the browser picks up where it stopped.
- **Sound only** as M4A, Opus or MP3, and **subtitles** as an `.srt` file.
- **Records live streams**, from the start of what the stream keeps or from now, until you press Stop.
- **Records what plays**, for players that build their video themselves and leave no file to download.
- **A Download button right on the page** on popular video sites, with every quality in its menu.
- **Save to My shelf** sends a video to your tapeshelf account, on tapeshelf.com or your own server. It connects once, and the token it gets can only upload.

Video protected with DRM isn't saved. Please save only what you have the right to keep.

## Build it yourself

You need Node 22 and npm 12.

```bash
npm ci
npm run build
```

Then load it into your browser:

- **Chrome and friends:** open `chrome://extensions`, turn on Developer mode, press Load unpacked and pick `dist/full`.
- **Firefox:** open `about:debugging`, choose This Firefox, press Load Temporary Add-on and pick `dist/firefox/manifest.json`.

`npm run build` makes the versions for each place: `full` for Chromium browsers, `firefox`, `amo` for Firefox Add-ons, and `store` for the Chrome Web Store, which leaves out what that store doesn't allow.

To point it at your own tapeshelf server, open the extension's settings and change the server address.

## Checks

```bash
npm run typecheck && npm run lint && npm test
```

Site adapters live in `src/sites/`, one file per site. If a site changed and an adapter broke, a fix there is the easiest way to help.

## Reporting problems

[Open an issue](https://github.com/tapeshelf/tapeshelf-downloader/issues) with the page address and what happened. Security problems: please write to contact@tapeshelf.com instead.

## License

[AGPL-3.0](LICENSE).
