'use strict';
const CACHE='huiwen-digital-v7-20260912-header3';
/* Keep SHELL to stable documents/data/icons. Volatile CSS/JS stay network-first via fetch handler
   and are intentionally not precached so normal reloads pick up ?v= cache-bust tokens. */
const SHELL=['./','./index.html','./explore.html','./election.html','./data/election-2026.json','./assets/favicon.svg'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>Promise.allSettled(SHELL.map(url=>cache.add(url)))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('huiwen-digital-')).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
async function networkFirst(request){try{const response=await fetch(request);if(response&&response.ok){const cache=await caches.open(CACHE);cache.put(request,response.clone());}return response;}catch(error){return (await caches.match(request)) || (request.mode==='navigate' ? await caches.match('./') : Response.error());}}
async function staleWhileRevalidate(request){const cache=await caches.open(CACHE);const cached=await cache.match(request);const network=fetch(request).then(response=>{if(response&&response.ok)cache.put(request,response.clone());return response;}).catch(()=>null);return cached || (await network) || Response.error();}
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==location.origin)return;const freshAsset=request.destination==='style'||request.destination==='script';if(request.mode==='navigate'||url.pathname.endsWith('.json')||freshAsset)event.respondWith(networkFirst(request));else event.respondWith(staleWhileRevalidate(request));});
