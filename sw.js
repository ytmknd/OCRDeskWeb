// クロスオリジン分離（COOP/COEP）を有効にするサービスワーカー。
// WebAssembly の複数スレッド（SharedArrayBuffer）は crossOriginIsolated のときだけ使えるが、
// GitHub Pages などヘッダーを設定できない場所もあるので、ここでレスポンスにヘッダーを付ける。
// ヘッダーを設定できるサーバー（_headers を読む Netlify / Cloudflare Pages など）では不要だが、害もない。
// このワーカーは通信の中身を読んだり送ったりしない（ヘッダーを足すだけ）。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // only-if-cached は同一オリジン以外で使うと失敗するので触らない
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const response = await fetch(request);
    if (response.status === 0 || response.type === 'opaque') return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  })());
});
