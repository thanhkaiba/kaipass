import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

const stub = fileURLToPath(new URL('./src/lib/empty.ts', import.meta.url));

// The page may only talk to Google's sign-in and Drive endpoints, and may only run its own code.
// The Android and desktop apps sign in outside the page, so they need none of Google's web scripts.
const csp = (android: boolean) =>
  [
    "default-src 'self'",
    android ? "script-src 'self' 'wasm-unsafe-eval'" : "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
    android ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: blob: https:",
    android
      ? "connect-src 'self' https://www.googleapis.com https://api.anthropic.com"
      : "connect-src 'self' https://www.googleapis.com https://accounts.google.com https://api.anthropic.com",
    android ? 'frame-src blob:' : 'frame-src https://accounts.google.com blob:',
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

export default defineConfig(({ command, mode }) => ({
  base: './',
  // `vite build --mode android|desktop`: the copy those apps serve from their own files.
  build: mode === 'android' || mode === 'desktop' ? { outDir: `dist-${mode}`, emptyOutDir: true } : undefined,
  plugins: [
    react(),
    // The Android and desktop apps ship their files inside the app, so they need no offline cache.
    mode !== 'android' &&
    mode !== 'desktop' &&
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['icon.svg'],
      // Fonts are cached too, so the app looks the same offline.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
      manifest: {
        name: 'KaiPass',
        short_name: 'KaiPass',
        description: 'Trình quản lý mật khẩu cá nhân, lưu file mã hoá trên Google Drive',
        lang: 'vi',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        theme_color: '#175ddc',
        background_color: '#f3f5f9',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
    {
      name: 'csp',
      transformIndexHtml: (html: string) =>
        html.replace(
          '<!--CSP-->',
          command === 'build' ? `<meta http-equiv="Content-Security-Policy" content="${csp(mode === 'android' || mode === 'desktop')}" />` : '',
        ),
    },
  ],
  resolve: {
    // kdbxweb's bundle references these Node modules but only uses them outside a browser.
    alias: (mode === 'test' ? {} : { '@xmldom/xmldom': stub, crypto: stub }) as Record<string, string>,
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
