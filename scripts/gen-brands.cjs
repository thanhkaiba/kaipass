#!/usr/bin/env node
/**
 * Builds src/icons/brands.ts: logos of well-known sites, so their items show the brand instead of a
 * letter. Logos come from Simple Icons (CC0). A few big brands asked Simple Icons to remove their
 * logos; those get a tile in the brand colour with a letter (COLOURS below) and never their logo.
 *
 * Each rule is space-separated: a word with a dot is a host (it matches the host and its
 * subdomains), a word without one is a site name (it matches that name under any suffix, e.g.
 * "shopee" matches shopee.vn and shopee.co.id). Later, more specific hosts win over site names.
 *
 *   node scripts/gen-brands.cjs
 */
const fs = require('fs');
const path = require('path');
const si = require('simple-icons');

const LOGOS = {
  google: 'google accounts.google.com myaccount.google.com',
  gmail: 'gmail mail.google.com',
  googledrive: 'drive.google.com',
  googledocs: 'docs.google.com',
  googlecloud: 'cloud.google.com console.cloud.google.com',
  googlemeet: 'meet.google.com',
  googlephotos: 'photos.google.com',
  googlemaps: 'maps.google.com',
  googleplay: 'play.google.com',
  googleads: 'ads.google.com',
  googleanalytics: 'analytics.google.com',
  googlecalendar: 'calendar.google.com',
  googlegemini: 'gemini.google.com',
  firebase: 'firebase firebase.google.com console.firebase.google.com',
  youtube: 'youtube youtu.be',
  github: 'github',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
  linear: 'linear.app',
  apple: 'apple',
  icloud: 'icloud',
  appstore: 'appstoreconnect.apple.com apps.apple.com',
  facebook: 'facebook fb.com',
  messenger: 'messenger',
  meta: 'meta.com',
  instagram: 'instagram',
  threads: 'threads.net threads.com',
  whatsapp: 'whatsapp',
  telegram: 'telegram t.me',
  zalo: 'zalo',
  tiktok: 'tiktok',
  x: 'x.com twitter.com',
  bluesky: 'bsky.app',
  mastodon: 'mastodon.social',
  discord: 'discord discord.gg',
  notion: 'notion.so notion.com',
  obsidian: 'obsidian.md',
  figma: 'figma',
  dropbox: 'dropbox',
  netflix: 'netflix',
  spotify: 'spotify',
  shopee: 'shopee',
  grab: 'grab.com',
  gojek: 'gojek',
  zoom: 'zoom.us zoom.com',
  cloudflare: 'cloudflare',
  vercel: 'vercel.com',
  netlify: 'netlify.com',
  digitalocean: 'digitalocean',
  hetzner: 'hetzner hetzner.cloud',
  ovh: 'ovh ovhcloud.com',
  vultr: 'vultr',
  render: 'render.com',
  railway: 'railway.app railway.com',
  flydotio: 'fly.io',
  docker: 'docker.com',
  npm: 'npmjs.com',
  pypi: 'pypi.org',
  jira: 'atlassian.net',
  atlassian: 'atlassian.com',
  trello: 'trello',
  asana: 'asana',
  clickup: 'clickup',
  miro: 'miro.com',
  airtable: 'airtable',
  todoist: 'todoist',
  evernote: 'evernote',
  calendly: 'calendly',
  anthropic: 'anthropic',
  claude: 'claude.ai claude.com',
  perplexity: 'perplexity.ai',
  mistralai: 'mistral.ai',
  deepseek: 'deepseek.com',
  huggingface: 'huggingface.co',
  replit: 'replit',
  cursor: 'cursor.com cursor.sh',
  jetbrains: 'jetbrains',
  postman: 'postman.com getpostman.com',
  sentry: 'sentry.io',
  datadog: 'datadoghq.com datadoghq.eu',
  supabase: 'supabase.com',
  mongodb: 'mongodb.com',
  circleci: 'circleci',
  expo: 'expo.dev',
  codeberg: 'codeberg.org',
  devdotto: 'dev.to',
  stackoverflow: 'stackoverflow.com',
  leetcode: 'leetcode',
  hackerrank: 'hackerrank',
  kaggle: 'kaggle',
  ngrok: 'ngrok',
  tailscale: 'tailscale',
  paypal: 'paypal',
  stripe: 'stripe',
  wise: 'wise.com',
  revolut: 'revolut',
  visa: 'visa.com',
  hsbc: 'hsbc',
  binance: 'binance',
  coinbase: 'coinbase',
  okx: 'okx.com',
  kucoin: 'kucoin',
  steam: 'steampowered.com steamcommunity.com',
  epicgames: 'epicgames.com',
  playstation: 'playstation.com',
  battledotnet: 'battle.net blizzard.com',
  ea: 'ea.com',
  ubisoft: 'ubisoft',
  roblox: 'roblox',
  unity: 'unity.com unity3d.com',
  reddit: 'reddit',
  pinterest: 'pinterest',
  twitch: 'twitch.tv',
  medium: 'medium.com',
  substack: 'substack.com',
  quora: 'quora',
  snapchat: 'snapchat',
  tumblr: 'tumblr',
  vimeo: 'vimeo',
  soundcloud: 'soundcloud',
  patreon: 'patreon',
  kofi: 'ko-fi.com',
  buymeacoffee: 'buymeacoffee.com',
  duolingo: 'duolingo',
  coursera: 'coursera',
  udemy: 'udemy',
  shopify: 'shopify',
  wordpress: 'wordpress.com wordpress.org',
  mailchimp: 'mailchimp',
  hubspot: 'hubspot',
  zendesk: 'zendesk',
  intercom: 'intercom.com',
  tinder: 'tinder',
  airbnb: 'airbnb',
  uber: 'uber.com',
  expedia: 'expedia',
  tripadvisor: 'tripadvisor',
  klook: 'klook',
  ebay: 'ebay',
  aliexpress: 'aliexpress',
  alibabadotcom: 'alibaba.com',
  taobao: 'taobao',
  samsung: 'samsung',
  xiaomi: 'xiaomi mi.com',
  huawei: 'huawei',
  proton: 'proton.me protonmail.com',
  line: 'line.me',
  kakaotalk: 'kakao.com kakaocorp.com',
  wechat: 'wechat.com weixin.qq.com',
  signal: 'signal.org',
  upwork: 'upwork',
  fiverr: 'fiverr',
  behance: 'behance',
  dribbble: 'dribbble',
  godaddy: 'godaddy',
  namecheap: 'namecheap',
  porkbun: 'porkbun',
  hostinger: 'hostinger',
  '1password': '1password',
  bitwarden: 'bitwarden',
  lastpass: 'lastpass',
  dashlane: 'dashlane',
  nordvpn: 'nordvpn',
  expressvpn: 'expressvpn',
  protonvpn: 'protonvpn.com',
  mullvad: 'mullvad.net',
  surfshark: 'surfshark',
};

// Brands without a logo in Simple Icons: their colour and initial only.
const COLOURS = {
  microsoft: ['Microsoft', '00A4EF', 'M', 'microsoft live.com office.com microsoftonline.com azure.com azure.microsoft.com'],
  outlook: ['Outlook', '0078D4', 'O', 'outlook.com outlook.live.com hotmail.com'],
  teams: ['Microsoft Teams', '6264A7', 'T', 'teams.microsoft.com teams.live.com'],
  xbox: ['Xbox', '107C10', 'X', 'xbox.com'],
  skype: ['Skype', '00AFF0', 'S', 'skype'],
  linkedin: ['LinkedIn', '0A66C2', 'in', 'linkedin'],
  amazon: ['Amazon', 'FF9900', 'a', 'amazon'],
  aws: ['AWS', '232F3E', 'aws', 'aws.amazon.com signin.aws.amazon.com console.aws.amazon.com awsapps.com'],
  openai: ['OpenAI', '10A37F', 'AI', 'openai platform.openai.com'],
  chatgpt: ['ChatGPT', '10A37F', 'G', 'chatgpt.com chat.openai.com'],
  slack: ['Slack', '4A154B', 'S', 'slack'],
  adobe: ['Adobe', 'FA0F00', 'A', 'adobe'],
  canva: ['Canva', '00C4CC', 'C', 'canva'],
  yahoo: ['Yahoo', '6001D2', 'Y!', 'yahoo'],
  salesforce: ['Salesforce', '00A1E0', 'S', 'salesforce force.com'],
  lazada: ['Lazada', '0F146D', 'L', 'lazada'],
  tiki: ['Tiki', '1A94FF', 'T', 'tiki.vn'],
  momo: ['MoMo', 'A50064', 'M', 'momo.vn'],
  vnpay: ['VNPAY', '005BAA', 'V', 'vnpay.vn'],
  vietcombank: ['Vietcombank', '00703C', 'V', 'vietcombank.com.vn'],
  techcombank: ['Techcombank', 'E31837', 'T', 'techcombank.com techcombank.com.vn'],
  vietinbank: ['VietinBank', '005993', 'V', 'vietinbank.vn'],
  bidv: ['BIDV', '006B68', 'B', 'bidv.com.vn'],
  mbbank: ['MB Bank', '141ED2', 'MB', 'mbbank.com.vn'],
  tpbank: ['TPBank', '5E2E86', 'TP', 'tpb.vn tpbank.vn'],
  vpbank: ['VPBank', '00A651', 'VP', 'vpbank.com.vn'],
  acb: ['ACB', '1F4E9C', 'A', 'acb.com.vn'],
  viettel: ['Viettel', 'EE0033', 'V', 'viettel.vn viettel.com.vn'],
  vnpt: ['VNPT', '0A64A4', 'V', 'vnpt.vn vnpt.com.vn'],
  fpt: ['FPT', 'F37021', 'F', 'fpt.vn fpt.com.vn fpt.com'],
  booking: ['Booking.com', '003580', 'B', 'booking.com'],
  agoda: ['Agoda', '5542F6', 'a', 'agoda'],
  traveloka: ['Traveloka', '0194F3', 'T', 'traveloka'],
  heroku: ['Heroku', '430098', 'H', 'heroku'],
  garena: ['Garena', 'EE4D2D', 'G', 'garena'],
  nintendo: ['Nintendo', 'E60012', 'N', 'nintendo'],
  metamask: ['MetaMask', 'F6851B', 'M', 'metamask.io'],
  bybit: ['Bybit', 'F7A600', 'B', 'bybit'],
};

// Words too common to name a brand from an item's title alone ("Line", "Signal", "X", …).
const NOT_FROM_TITLE = new Set(['x', 'line', 'signal', 'medium', 'steam', 'render', 'railway', 'expo', 'unity', 'meta', 'visa', 'wise', 'miro', 'ea', 'threads', 'proton']);

// Short names people write in titles.
const ALIASES = { vcb: 'vietcombank', tcb: 'techcombank', ctg: 'vietinbank', mb: 'mbbank', tpb: 'tpbank', vpb: 'vpbank', fb: 'facebook', gg: 'google', yt: 'youtube', ig: 'instagram', gh: 'github', ms: 'microsoft', aws: 'aws', gpt: 'chatgpt', appleid: 'apple', gmail: 'gmail' };

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const bySlug = Object.fromEntries(Object.values(si).map((i) => [i.slug, i]));
const brands = {};
const hosts = {};
const names = {};
const titles = {};
const add = (id, rule, title) => {
  for (const w of rule.split(/\s+/).filter(Boolean)) {
    if (w.includes('.')) hosts[w] = id;
    else names[w] = id;
  }
  for (const t of [title, id]) {
    const n = norm(t);
    if (n.length >= 2 && !NOT_FROM_TITLE.has(n)) titles[n] ??= id;
  }
};
const missing = [];
for (const [slug, rule] of Object.entries(LOGOS)) {
  const i = bySlug[slug];
  if (!i) {
    missing.push(slug);
    continue;
  }
  brands[slug] = [i.title, i.hex, i.path];
  add(slug, rule, i.title);
}
for (const [id, [title, hex, letter, rule]] of Object.entries(COLOURS)) {
  brands[id] = [title, hex, '', letter];
  add(id, rule, title);
}
for (const [a, id] of Object.entries(ALIASES)) titles[a] = id;
if (missing.length) {
  console.error('Not in Simple Icons:', missing.join(' '));
  process.exit(1);
}

const out = `// Generated by scripts/gen-brands.cjs from simple-icons ${JSON.parse(fs.readFileSync(require.resolve('simple-icons').replace(/[^/]*$/, '') + 'package.json', 'utf8')).version} (CC0). Do not edit.
// Brand names and logos are trademarks of their owners; they are shown only to label the user's own items.
/** id → [title, hex colour, 24×24 SVG path ('' when there is no logo), letter shown instead] */
export const brands: Record<string, [string, string, string, string?]> = ${JSON.stringify(brands)};
/** host (also matches its subdomains) → id */
export const hosts: Record<string, string> = ${JSON.stringify(hosts)};
/** site name under any suffix (shopee → shopee.vn, shopee.co.id) → id */
export const names: Record<string, string> = ${JSON.stringify(names)};
/** an item title, lower-cased with only letters and digits → id */
export const titles: Record<string, string> = ${JSON.stringify(titles)};
`;
fs.writeFileSync(path.join(__dirname, '../src/icons/brands.ts'), out);
console.log(`brands.ts: ${Object.keys(brands).length} brands, ${(out.length / 1024).toFixed(0)} KiB`);
