// Service worker: офлайн-кэш и push-уведомления.
// При изменении файлов приложения увеличь VERSION — так все устройства получат обновление.
const VERSION = 'v1';
const CACHE = `podpiski-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/catalog.js', 'js/config.js', 'js/dates.js', 'js/rates.js', 'js/store.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Свои файлы и библиотеки с esm.sh: сначала сеть, при отсутствии — кэш.
// Запросы к Supabase и курсам не кэшируем.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = url.origin === self.location.origin;
  const lib = url.hostname === 'esm.sh';
  if (!own && !lib) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: own });
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Подписки', {
    body: data.body || '',
    tag: data.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data?.url || './');
  })());
});
