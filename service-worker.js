/* MOAQIB — FINAL SERVICE WORKER
   ------------------------------------------------------------------
   Responsibilities:
   - Cache the static app shell for fast startup/offline navigation.
   - NEVER cache Supabase REST/Auth traffic.
   - Receive Web Push notifications when the optional backend is enabled.
   - Ask open clients to retry cloud sync when Background Sync fires.
   ------------------------------------------------------------------ */
const CACHE_VERSION = 'moaqib-remediation-6-1-0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const APP_SHELL = [
  './index.html', './ui-foundation.css', './productivity.css', './ui-rebuild.css', './push-config.js', './productivity.js', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('moaqib-') && ![STATIC_CACHE, RUNTIME_CACHE].includes(k))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(async () => {
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clientsList.forEach(client => client.postMessage({ type: 'MQ_SW_UPDATED', version: CACHE_VERSION }));
      })
  );
});

function isSupabase(url) {
  return url.hostname.endsWith('.supabase.co') || url.hostname.includes('supabase.co');
}

function isStaticCdn(url) {
  return ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'].includes(url.hostname);
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);
  return cached || network || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Security/data rule: do not cache Supabase REST/Auth traffic.
  if (isSupabase(url)) return;

  if (request.mode === 'navigate') {
    // Installed-app startup should never wait on a slow network. Serve the cached
    // shell immediately, then refresh it in the background for the next launch.
    // waitUntil() is registered synchronously with the fetch event; this avoids
    // InvalidStateError on browsers that reject late waitUntil calls.
    const refresh = (async () => {
      try {
        const response = await fetch(request);
        if (response?.ok) {
          const cache = await caches.open(STATIC_CACHE);
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch (_) { return null; }
    })();
    event.waitUntil(refresh.then(() => undefined));
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      return (await refresh) || Response.error();
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  if (isStaticCdn(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});

/* Web Push: the backend sends a small JSON payload. Nothing in this handler
   reads transaction data or Supabase credentials. */
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; }
  catch (_) {
    try { payload = { body: event.data?.text?.() || '' }; } catch (_) { payload = {}; }
  }

  const title = payload.title || 'MOAQIB';
  const options = {
    body: payload.body || 'لديك تحديث جديد في مركز العمل.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    tag: payload.tag || 'moaqib-push',
    renotify: false,
    data: { url: payload.url || './index.html', ...(payload.data || {}) }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* Background Sync cannot read localStorage itself. Its job here is deliberately
   small: wake any controlled app window so the existing authenticated V6 sync
   bridge can flush the durable local snapshot. If no client is open, the next
   app launch performs the same flush automatically. */
self.addEventListener('sync', event => {
  if (event.tag !== 'moaqib-cloud-sync') return;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clientsList.forEach(client => client.postMessage({ type: 'MQ_RETRY_SYNC' }));
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'SHOW_NOTIFICATION') return;
  const { title, options } = event.data;
  event.waitUntil(self.registration.showNotification(title || 'MOAQIB', options || {}));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = new URL('./index.html', self.location.origin);
  try {
    const requested = new URL(event.notification.data?.url || './index.html', self.location.origin);
    if (requested.origin === self.location.origin) target = requested;
  } catch (_) {}
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        await client.navigate(target.href).catch(() => {});
        return client.focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(target.href) : null;
  })());
});
