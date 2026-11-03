// Hält die App offline verfügbar. Bei Änderungen an der App VERSION erhöhen.
const VERSION = 'lernpodcast-v6';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './vendor/lame.min.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' – nie eine ältere Kopie aus dem Browser-Zwischenspeicher übernehmen
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Aus dem Speicher antworten (schnell, auch ohne Netz) und im Hintergrund aktualisieren.
// Nur eigene Dateien – Anfragen an die KI-Dienste laufen nie über den Speicher.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      // req.url statt req: Seitenaufrufe (mode 'navigate') lassen sich nicht mit Optionen kopieren
      const fresh = fetch(req.url, { cache: 'no-cache' })
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
