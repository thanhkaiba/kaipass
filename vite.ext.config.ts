// Builds the browser extension into dist-ext/. Run: npm run build:ext
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const stub = path('./src/lib/empty.ts');

export default defineConfig({
  base: './',
  build: { outDir: 'dist-ext', emptyOutDir: true },
  plugins: [
    react(),
    {
      name: 'extension-manifest',
      // The extension's Content-Security-Policy comes from the manifest, not from the page.
      transformIndexHtml: (html: string) => html.replace('<!--CSP-->', ''),
      generateBundle() {
        const manifest = JSON.parse(readFileSync(path('./extension/manifest.json'), 'utf8'));
        manifest.version = JSON.parse(readFileSync(path('./package.json'), 'utf8')).version;
        // Only for the automated test: lets it fill a local page without a real toolbar click.
        if (process.env.KAIPASS_TEST_HOSTS) manifest.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*');
        this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
      },
    },
  ],
  resolve: { alias: { '@xmldom/xmldom': stub, crypto: stub } },
});
