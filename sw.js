'use strict';
/* BEGIN HUIWEN SW CACHE POLICY */
const cachePolicy = (() => {
  const privateQueryKey = /^(?:cms[a-z0-9_-]*|draft|private|preview[a-z0-9_-]*|[a-z0-9_-]*(?:token|session)[a-z0-9_-]*)$/i;
  const privateSegments = new Set(['admin', 'api', 'cms', 'draft', 'drafts', 'preview', 'previews', 'runtime']);

  function sensitivePath(url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      return true;
    }
    const segments = pathname.split('/').filter(Boolean);
    const basename = segments.at(-1) || '';
    if (segments.some(segment => privateSegments.has(segment) || segment.startsWith('cms-'))) return true;
    if (/^(?:cms|runtime)[-_.]/i.test(basename)) return true;
    if (pathname === '/sw.js'
        || pathname === '/data/achievements.json'
        || pathname === '/deployment.json'
        || pathname === '/publication-manifest.json') return true;
    return false;
  }

  function isCacheableRequest(request) {
    if (!request || !request.url || (request.method && request.method !== 'GET')) return false;
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(url.protocol) || sensitivePath(url)) return false;
    for (const key of url.searchParams.keys()) {
      if (privateQueryKey.test(key)) return false;
    }
    const headers = request.headers;
    return !(headers && (headers.has('authorization') || headers.has('cookie')));
  }

  function isCacheableResponse(response) {
    if (!response || response.ok !== true) return false;
    const cacheControl = response.headers?.get('Cache-Control') || '';
    return !cacheControl.split(',').some(directive => /^(?:private|no-store)(?:\s*=|$)/i.test(directive.trim()));
  }

  function canCache(request, response) {
    return isCacheableRequest(request) && isCacheableResponse(response);
  }

  return Object.freeze({isCacheableRequest, isCacheableResponse, canCache});
})();
/* END HUIWEN SW CACHE POLICY */
const CACHE='huiwen-digital-v15-20261008-route-font-subsets';
const OFFLINE='./offline.html';
const SHELL=['./index.html','./civic.css','./civic.js','./styles.css','./mobile.css','./home.css','./layout.css','./digital.css','./digital.js','./assets/favicon.svg','./assets/fonts/huiwen-site-sans/generated/huiwen-index-core-e398aa657806.woff2'];
const REQUIRED_SHELL=[];
const scopedRequest=url=>new Request(new URL(url,self.registration.scope));
async function remember(cache,request,response) {
  if(!cachePolicy.canCache(request,response))return false;
  const headers=new Headers(response.headers);headers.set('X-Huiwen-Cached-At',new Date().toISOString());
  await cache.put(request,new Response(await response.clone().arrayBuffer(),{status:response.status,statusText:response.statusText,headers}));
  return true;
}
async function boundedFetch(request,ms=6000) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);
  try {return await fetch(request,{signal:controller.signal});} finally {clearTimeout(timer);}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  // Keep the offline document and its validated font pair as one required install closure.
  const offlineRequest=scopedRequest(OFFLINE),response=await boundedFetch(offlineRequest);
  if(!cachePolicy.canCache(offlineRequest,response))throw new Error('Offline fallback unavailable');
  if(!await remember(cache,offlineRequest,response))throw new Error('Offline fallback unavailable');
  await Promise.all(REQUIRED_SHELL.map(async url=>{
    const request=scopedRequest(url);
    if(!cachePolicy.isCacheableRequest(request))throw new Error('Required offline shell asset is private: '+url);
    const asset=await boundedFetch(request);
    if(!cachePolicy.canCache(request,asset))throw new Error('Required offline shell asset unavailable: '+url);
    if(!await remember(cache,request,asset))throw new Error('Required offline shell asset unavailable: '+url);
  }));
  await Promise.allSettled(SHELL.filter(url=>url!==OFFLINE&&!REQUIRED_SHELL.includes(url)).map(async url=>{
    const request=scopedRequest(url);if(!cachePolicy.isCacheableRequest(request))return;
    const asset=await boundedFetch(request);if(cachePolicy.canCache(request,asset))await remember(cache,request,asset);
  }));
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('huiwen-digital-')&&key!==CACHE)await caches.delete(key);
  const cache=await caches.open(CACHE);
  for(const request of await cache.keys()){
    const response=await cache.match(request);
    if(!cachePolicy.canCache(request,response))await cache.delete(request);
  }
  await self.clients.claim();
})()));
async function markedOffline(response) {
  const at=response.headers.get('X-Huiwen-Cached-At');
  const stamp=at?new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Taipei'}).format(new Date(at)):'時間未記錄';
  const banner=`<aside role="status" data-offline-cache style="position:relative;z-index:10000;background:#fff1c2;color:#3d3214;padding:12px 20px;font:16px/1.6 'Huiwen Sans TC',sans-serif;border-bottom:1px solid #bcaa70">目前離線／連線異常，正在閱讀快取，內容非即時資訊。儲存時間：${stamp}（台灣時間）。恢復網路後請重新整理。</aside>`;
  const html=(await response.text()).replace(/(<body\b[^>]*>)/i,'$1'+banner);
  const headers=new Headers(response.headers);headers.delete('Content-Length');headers.delete('Content-Encoding');headers.set('X-Huiwen-Offline','true');
  return new Response(html,{status:response.status,headers});
}
async function networkFirst(request) {
  const cache=await caches.open(CACHE);
  try {
    const response=await boundedFetch(request);
    if(response.status>=500)throw new Error('Origin unavailable');
    if(cachePolicy.canCache(request,response)){try{await remember(cache,request,response);}catch{/* Storage limits must not hide a fresh network response. */}}
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
  const update=boundedFetch(request).then(async response=>{if(cachePolicy.canCache(request,response)){try{await remember(cache,request,response);}catch{}}return response;}).catch(()=>null);
  event.waitUntil(update.then(()=>{}));
  return cached || (await update) || Response.error();
}
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);if(url.origin!==location.origin||!cachePolicy.isCacheableRequest(request))return;
  if(request.mode==='navigate'||url.pathname.endsWith('.json')||request.destination==='style'||request.destination==='script')event.respondWith(networkFirst(request));
  else event.respondWith(asset(request,event));
});
