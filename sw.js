'use strict';
const CACHE='huiwen-digital-v12-20260922-maturity';
const OFFLINE='./offline.html';
const SHELL=['./index.html','./civic.css','./civic.js','./styles.css','./mobile.css','./home.css','./layout.css','./digital.css','./digital.js','./assets/favicon.svg'];
const rawSource=url=>url.pathname.endsWith('/data/achievements.json');
async function remember(cache,request,response) {
  const headers=new Headers(response.headers);headers.set('X-Huiwen-Cached-At',new Date().toISOString());
  await cache.put(request,new Response(await response.clone().arrayBuffer(),{status:response.status,statusText:response.statusText,headers}));
}
async function boundedFetch(request,ms=6000) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);
  try {return await fetch(request,{signal:controller.signal});} finally {clearTimeout(timer);}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  // Without the core fallback the new worker must not activate over a working old version.
  const response=await boundedFetch(OFFLINE);if(!response.ok)throw new Error('Offline fallback unavailable');
  await remember(cache,OFFLINE,response);
  await Promise.allSettled(SHELL.map(async url=>{const r=await boundedFetch(url);if(r.ok)await remember(cache,url,r);}));
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('huiwen-digital-')&&key!==CACHE)await caches.delete(key);
  const cache=await caches.open(CACHE);
  for(const request of await cache.keys())if(rawSource(new URL(request.url)))await cache.delete(request);
  await self.clients.claim();
})()));
async function markedOffline(response) {
  const at=response.headers.get('X-Huiwen-Cached-At');
  const stamp=at?new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Taipei'}).format(new Date(at)):'時間未記錄';
  const banner=`<aside role="status" data-offline-cache style="position:relative;z-index:10000;background:#fff1c2;color:#3d3214;padding:12px 20px;font:16px/1.6 system-ui,sans-serif;border-bottom:1px solid #bcaa70">目前離線／連線異常，正在閱讀快取，內容非即時資訊。儲存時間：${stamp}（台灣時間）。恢復網路後請重新整理。</aside>`;
  const html=(await response.text()).replace(/(<body\b[^>]*>)/i,'$1'+banner);
  const headers=new Headers(response.headers);headers.delete('Content-Length');headers.delete('Content-Encoding');headers.set('X-Huiwen-Offline','true');
  return new Response(html,{status:response.status,headers});
}
async function networkFirst(request) {
  const cache=await caches.open(CACHE);
  try {
    const response=await boundedFetch(request);
    if(response.status>=500)throw new Error('Origin unavailable');
    if(response.ok&&!rawSource(new URL(request.url))){try{await remember(cache,request,response);}catch{/* Storage limits must not hide a fresh network response. */}}
    return response;
  }catch {
    const cached=await cache.match(request);
    if(cached)return request.mode==='navigate'?markedOffline(cached):cached;
    if(request.mode==='navigate')return (await cache.match(OFFLINE)) || new Response('目前離線，這一頁尚未儲存。',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
    return Response.error();
  }
}
async function asset(request,event) {
  const cache=await caches.open(CACHE),cached=await cache.match(request);
  const update=boundedFetch(request).then(async response=>{if(response.ok){try{await remember(cache,request,response);}catch{}}return response;}).catch(()=>null);
  event.waitUntil(update.then(()=>{}));
  return cached || (await update) || Response.error();
}
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);if(url.origin!==location.origin)return;
  if(request.mode==='navigate'||url.pathname.endsWith('.json')||request.destination==='style'||request.destination==='script')event.respondWith(networkFirst(request));
  else event.respondWith(asset(request,event));
});
