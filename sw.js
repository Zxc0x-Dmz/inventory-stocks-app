/* Keeps the app shell available offline.  Stock data always comes from the network. */
var CACHE = 'stocks-v38';   // app shell.  Part photos live in 'stocks-photos-v1' (kept across updates)
var SHELL = ['./', 'index.html', 'style.css', 'core.js', 'app.js', 'demo-seed.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })); self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return /^stocks-v\d+$/.test(k) && k !== CACHE; }).map(function (k) { return caches.delete(k); })); }));
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.indexOf('/__photo/') >= 0) return;
  // network first and never from the browser's HTTP cache, so a new version shows on the next open;
  // the saved copy is only used when offline
  e.respondWith(fetch(u.href, { cache: 'no-cache', credentials: 'same-origin' }).then(function (r) {
    if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
