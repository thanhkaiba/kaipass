// Gets the desktop app ready to package: copies the web build in, takes the version from the web
// app's package.json, and writes the Google client for desktop (if the build was given one).
//   npm run build:desktop && cd desktop && npm install && npm run dist
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const web = path.join(root, 'dist-desktop');
if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.error('Chưa có dist-desktop/. Chạy "npm run build:desktop" ở thư mục gốc trước.');
  process.exit(1);
}
fs.rmSync(path.join(__dirname, 'app'), { recursive: true, force: true });
fs.cpSync(web, path.join(__dirname, 'app'), { recursive: true });
// The app icon; electron-builder makes the .icns and .ico from it.
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.copyFileSync(path.join(root, 'public', 'icon-512.png'), path.join(__dirname, 'build', 'icon.png'));

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// A "Desktop app" OAuth client. Google does not treat its secret as confidential (it ships inside
// every installed app), but it still stays out of git: CI passes it in, or the user picks the
// client's JSON file in the app.
const clientId = process.env.GOOGLE_DESKTOP_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_DESKTOP_CLIENT_SECRET || '';
fs.writeFileSync(path.join(__dirname, 'oauth.json'), JSON.stringify(clientId ? { clientId, clientSecret } : {}));
console.log(`KaiPass ${version}: web build copied${clientId ? ', Google client built in' : ''}`);

// `node prepare.cjs --dist [electron-builder options]` also packages the app.
if (process.argv[2] === '--dist') {
  const { spawnSync } = require('node:child_process');
  const cli = require.resolve('electron-builder/cli.js');
  const r = spawnSync(process.execPath, [cli, '--publish', 'never', `-c.extraMetadata.version=${version}`, ...process.argv.slice(3)], {
    cwd: __dirname,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}
