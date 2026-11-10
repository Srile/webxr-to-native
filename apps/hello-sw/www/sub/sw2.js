// A second service worker under /sub/ (hello-sw's scope checks): it does nothing but exist.
self.addEventListener('install', () => self.skipWaiting())
