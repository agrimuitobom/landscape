/* 石庭 — オフライン対応の Service Worker
   現場(庭)は電波が弱いことが多いので、一度開いたら通信なしでも起動できるようにする。
   - アプリ本体・素材一覧: ネット優先(3秒で諦めてキャッシュ)。更新がすぐ反映される
   - 同梱の three.js(vendor)・フォント・presets の GLB: キャッシュを先に返し、裏で最新に更新 */
const VERSION = 'sekitei-v2';
const THREE_BASE = './vendor/three/';
const PRECACHE = [
  './',
  './index.html',
  './presets/manifest.json',
  THREE_BASE + 'three.module.js',
  THREE_BASE + 'three.core.js',
  THREE_BASE + 'addons/loaders/GLTFLoader.js',
  THREE_BASE + 'addons/loaders/DRACOLoader.js',
  THREE_BASE + 'addons/controls/OrbitControls.js',
  THREE_BASE + 'addons/libs/meshopt_decoder.module.js',
  THREE_BASE + 'addons/utils/BufferGeometryUtils.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 1つ失敗しても他は保存する(次回の通信時に取り直す)
    await Promise.all(PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for(const key of await caches.keys()) if(key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

function timeout(ms){ return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

async function networkFirst(req){
  const cache = await caches.open(VERSION);
  try{
    const res = await Promise.race([fetch(req), timeout(3000)]);
    if(res.ok) cache.put(req, res.clone());
    return res;
  }catch(err){
    const hit = await cache.match(req, { ignoreSearch: true });
    if(hit) return hit;
    throw err;
  }
}
async function cacheFirst(req){
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if(hit) return hit;
  const res = await fetch(req);
  if(res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
async function staleWhileRevalidate(req, event){
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const update = fetch(req).then(res => {
    if(res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  });
  if(hit){ event.waitUntil(update.catch(() => {})); return hit; }
  return update;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if(sameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/manifest.json'))){
    event.respondWith(networkFirst(req));
  }else if(url.hostname === 'fonts.gstatic.com'){
    event.respondWith(cacheFirst(req));   // フォント本体はURLごとに内容が固定
  }else if(url.hostname === 'fonts.googleapis.com'
        || (sameOrigin && (url.pathname.includes('/presets/') || url.pathname.includes('/vendor/')))){
    event.respondWith(staleWhileRevalidate(req, event));
  }
});
