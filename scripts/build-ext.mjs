// Builds the browser extension into dist-ext/: the app page (popup and full tab), the background
// service worker and the content script. The last two must be single self-contained files.
// Run: npm run build:ext   (KAIPASS_TEST_HOSTS=1 makes the test build used by e2e/ext.cjs)
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const test = !!process.env.KAIPASS_TEST_HOSTS;

await build({ root, configFile: fileURLToPath(new URL('../vite.ext.config.ts', import.meta.url)), logLevel: 'warn' });

for (const [entry, file] of [
  ['src/ext/background.ts', 'background.js'],
  ['src/ext/content.ts', 'content.js'],
]) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    // The test build opens the content script's shadow root so the browser test can see inside.
    define: { __KAIPASS_TEST__: JSON.stringify(test) },
    build: {
      outDir: 'dist-ext',
      emptyOutDir: false,
      target: 'chrome120',
      lib: { entry, formats: ['iife'], name: 'kaipass', fileName: () => file },
    },
  });
}
console.log(`dist-ext built${test ? ' (test build)' : ''}`);
