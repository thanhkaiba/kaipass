// Renders public/icon.svg to the PNG sizes the web app manifest needs.
// Needs Playwright with Chromium available. Run: node scripts/make-icons.cjs
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const dir = join(__dirname, '..', 'public');
  const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  for (const size of [16, 48, 128, 192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(dir, `icon-${size}.png`) });
    await page.close();
  }
  await browser.close();
})();
