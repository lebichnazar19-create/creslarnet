// Bump this on any release where cached *binary/vendor* assets changed
// (e.g. a new vendored three.js build) — it's the only thing that force-
// purges the cache-first bucket below. Everyday app files (html/css/js/json)
// no longer need a version bump to show up: they're served network-first,
// so a plain reload while online always gets the latest copy.
const CACHE_NAME = 'creslarnet-v18';

// Everything the installed app needs to run with no connection at all —
// the 2D sheet AND the whole 3D mode with its three.js files. All of it is
// fetched the moment the service worker installs (i.e. on the first visit
// while online), so "Встановити застосунок" on the phone gives a copy that
// works offline right away, not only for the pages that happened to be
// opened online before.
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './3d/index.html',
  './3d/style.css',
  './3d/app.js',
  './3d/csg.js',
  './3d/materials.js',
  './3d/gizmo-test.html',
  './3d/vendor/three/three.module.min.js',
  './3d/vendor/three/TransformControls.js',
  './3d/vendor/three/OrbitControls.js',
  './3d/vendor/three/RoomEnvironment.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // One file at a time rather than cache.addAll: with addAll a single
      // file that fails to download (a flaky connection mid-install) throws
      // the whole install away, and the app isn't installable at all until
      // the next try. Whatever did download is kept; a missing file is
      // fetched and cached the first time it's actually requested.
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()) // activate this version immediately, don't wait for old tabs to close
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()) // take control of already-open tabs right away
  );
});

// Anything that defines app BEHAVIOR (markup, styles, logic, the manifest)
// goes network-first: try the network so a reload always picks up the
// newest deploy, and only fall back to the cache when there's no connection.
// Large third-party/vendor files and images stay cache-first — they rarely
// change and aren't worth re-fetching on every load.
const NETWORK_FIRST = /\.(?:html|js|css|json)$/;

function isVendorAsset(url) {
  return url.pathname.includes('/vendor/');
}

function networkFirst(request) {
  // cache:'reload' bypasses the browser's own HTTP cache too — otherwise a
  // heuristically-fresh disk-cache hit can satisfy this fetch() before it
  // ever reaches the network, quietly serving stale content underneath us.
  const freshRequest = new Request(request, { cache: 'reload' });
  return fetch(freshRequest)
    .then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request));
}

function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => cached);
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isNavigation = event.request.mode === 'navigate';
  const wantsFreshCheck = isNavigation || (url.origin === location.origin && NETWORK_FIRST.test(url.pathname) && !isVendorAsset(url));

  event.respondWith(wantsFreshCheck ? networkFirst(event.request) : cacheFirst(event.request));
});
