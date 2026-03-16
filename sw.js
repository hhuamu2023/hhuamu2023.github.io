/* sw.js - 花沐 PWA Service Worker
   目標：
   - HTML（頁面導覽）採 Network First：盡量拿到最新版本
   - 靜態資源採 Stale-While-Revalidate：速度快，背景更新
   - Supabase API / functions / storage：Network Only（避免資料錯亂）
   - 支援自動更新：接到 SKIP_WAITING 訊息就立刻啟用新 SW
*/

const CACHE_PREFIX = "hanamu-pwa";
const STATIC_CACHE = `${CACHE_PREFIX}-static-v1`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-v1`;

// 你可以把「同源」且重要的檔案放進來做 precache
// 注意：如果你的網站不是 /index.html 這種路徑，請自行調整
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // 清舊 cache
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => {
        const isMine = k.startsWith(CACHE_PREFIX);
        const isCurrent = (k === STATIC_CACHE || k === RUNTIME_CACHE);
        if (isMine && !isCurrent) return caches.delete(k);
        return Promise.resolve();
      })
    );

    await self.clients.claim();
  })());
});

// 讓頁面可以呼叫：reg.waiting.postMessage({type:"SKIP_WAITING"})
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg && msg.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ---- cache strategies ----
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request);
    // 只快取成功回應
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then((fresh) => {
    if (fresh && (fresh.ok || fresh.type === "opaque")) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  }).catch(() => null);

  return cached || (await fetchPromise) || new Response("Offline", { status: 503 });
}

function isSupabaseOrApi(url) {
  // 你專案的 Supabase 網域（含 storage / functions / rest）
  if (url.origin === "https://yribgjhptlmbmtrlfube.supabase.co") return true;

  // 你也可以把其他 API 網域加進來（若未來有）
  return false;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // 只處理 GET
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Supabase / API 一律走網路（避免快取到舊資料或造成提交異常）
  if (isSupabaseOrApi(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // HTML 導覽（使用者進入頁面/切換頁面）→ network first 拿最新
  // request.mode === "navigate" 是 SPA/一般頁面導覽的標準判斷
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        // 優先拿新頁面
        return await networkFirst(request);
      } catch (e) {
        // 真的離線就回傳快取的首頁（至少能打開）
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match("/index.html");
        if (cached) return cached;
        return new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // 其他靜態資源（css/js/img/font 等）→ stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});