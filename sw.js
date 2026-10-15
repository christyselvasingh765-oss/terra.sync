const CACHE_VERSION = "siteguard-shell-v1";

const APP_FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/manifest.json"
];

// Install: cache only the app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete outdated SiteGuard caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("siteguard-shell-") &&
                key !== CACHE_VERSION
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: never cache API requests or non-GET requests.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle requests from this app's origin.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Do not cache POST, PATCH, DELETE, or other write requests.
  if (request.method !== "GET") {
    return;
  }

  // Never cache API responses, including dashboard and health checks.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
    );
    return;
  }

  // Do not cache browser navigation outside the app shell.
  const isAppFile = APP_FILES.includes(url.pathname);

  if (!isAppFile) {
    return;
  }

  // App shell: cache first, then network fallback.
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();

            caches.open(CACHE_VERSION)
              .then((cache) => cache.put(request, copy))
              .catch(() => {});

          }

          return response;
        });
      })
      .catch(() =>
        caches.match("/index.html")
      )
  );
});
