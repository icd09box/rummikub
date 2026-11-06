// 앱 껍데기 캐시: 네트워크 우선, 실패하면 캐시(같은 기기 모드는 오프라인도 됨). 버전 바꾸면 옛 캐시 정리.
const VERSION = 'rummi-v17';
const SHELL = ['./', './index.html', './style.css', './manifest.json', './js/app.js', './js/game.js', './js/rules.js', './js/cpu.js', './js/view.js', './js/host.js', './js/net.js', './icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // CDN(PeerJS·QR)은 브라우저 기본 처리
  e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
