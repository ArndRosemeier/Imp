/* global self, fetch */
// Imp's service worker. It has one job: make sure an installed copy of Imp
// (for example on an iPad home screen) always opens the newest version.
//
// Opening the app asks the network for the page itself, past every cache, so
// the page always names the newest built files. Those files carry a hash in
// their name, so the browser may keep them as long as it likes. Without a
// network the browser's own copy of the page is used, as before.
self.addEventListener('install', () => {
  // A new version of this file takes over at once instead of waiting for every tab to close.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  event.respondWith(
    // By URL: a navigation request cannot be copied with different cache settings.
    fetch(request.url, { cache: 'no-store', credentials: 'same-origin' }).catch(() =>
      fetch(request),
    ),
  );
});
