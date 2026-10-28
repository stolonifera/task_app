/* 静的ホスティング (GitHub Pages) 前提のシンプルな Service Worker。
   アプリシェルは cache-first、同期 API は常にネットワーク。 */

const VERSION = '1.1.0';   // app.js の APP_VERSION と揃える
const CACHE = `taskapp-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/store.js',
  'js/sync.js',
  'js/config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Supabase など外部 API は触らない
  if (url.origin !== self.location.origin && !url.host.includes('cdn.jsdelivr.net')) return;

  // ナビゲーションは network-first (更新を取り込みやすくする)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put('index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // アプリシェル (自分の HTML/CSS/JS) は network-first。
  // cache-first にすると更新後も 1 回は古い画面が出てしまうため。
  if (url.origin === self.location.origin && /\.(?:html|css|js)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // それ以外 (アイコン / manifest / CDN) は cache-first + バックグラウンド更新
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            caches.open(CACHE).then((c) => c.put(req, res.clone()));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
