# Dissertation browser extension

POC for a browser extension that censors images that have certain objects in them.

## Load the extension in Chrome or Edge

1. Run `npm run build`.
2. Open the browser's extension page.
3. Enable Developer mode.
4. Choose "Load unpacked" and select the `dist` folder.

## Project structure

- `public/manifest.json`: browser extension manifest
- `src/content.ts`: censoring logic
- `src/background.ts`: image loading
