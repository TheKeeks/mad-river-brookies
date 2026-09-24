/* Service worker: caches the app shell + data so the Plan list and cards work with no signal.
 * Map tiles and live APIs are never cached (tile policy + freshness). */
var VERSION = 'mrb-v1';
var SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'exporters.js', 'cheatsheet.html',
  'data/spots.js', 'data/overlays.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/marker-icon.png',
  'vendor/qrcode/qrcode.min.js'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (url.indexOf(self.registration.scope) !== 0) return; // only our own origin + path
  var rel = url.slice(self.registration.scope.length).split('?')[0];
  var isShell = rel === '' || SHELL.indexOf(rel) >= 0;
  if (!isShell) return; // tiles, USGS, NWS, directions: straight to the network
  e.respondWith(caches.match(e.request).then(function (hit) {
    var net = fetch(e.request).then(function (res) {
      if (res && res.ok) caches.open(VERSION).then(function (c) { c.put(e.request, res.clone()); });
      return res;
    }).catch(function () { return hit; });
    return hit || net; // cache-first, refresh in the background
  }));
});
