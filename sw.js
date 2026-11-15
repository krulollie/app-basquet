/* Service worker: l'app obre sense cobertura amb l'última versió vista.
   Xarxa primer per als fitxers propis (sempre frescos si n'hi ha), memòria cau si falla.
   Les crides a la federació no es toquen. */
const CACHE = 'granollers-live-v18';
const SHELL = ['./', './index.html', './styles.css?v=18', './app.js?v=18', './fcbq.js', './manifest.webmanifest', './icon.svg', './icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
