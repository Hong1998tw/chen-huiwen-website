/** Behavioral regression: complete search, independent data, time boundaries, real service worker. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
let failOptional=false,failRequired=false,disconnected=false;
const server=createServer(async(req,res)=>{
  if(disconnected){req.socket.destroy();return;}
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if((failRequired&&pathname==='/offline.html')||(failOptional&&/\.(css|svg)$/.test(pathname))){res.writeHead(503);res.end('fixture unavailable');return;}
  const path=resolve(root,'.'+(pathname==='/'||pathname==='/without-markers.html'?'/index.html':pathname));
  if(!path.startsWith(root)){res.writeHead(403);res.end();return;}
  try{let data=await readFile(path);
    if(pathname==='/without-markers.html')data=Buffer.from(data.toString().replace(/ data-digital-civic="[^"]+"/g,''));
    // Reproduce an edge retaining the previous release under its old immutable URL.
    if(pathname==='/digital.js'&&req.url.includes('v=20260922-public-service-v11'))data=Buffer.from(data.toString().replace(/const SERVICE_WORKER_VERSION = '[^']+'/,"const SERVICE_WORKER_VERSION = '20260922-public-service-v11'"));
    if(pathname==='/sw.js'&&req.url.includes('v=20260922-public-service-v11'))data=Buffer.from("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}
  catch{res.writeHead(404,{'Content-Type':'text/html'});res.end('<h1>Not found</h1>');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch();
const report={checks:[],failures:[]};
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.failures.push({name,error:String(e)});}}
const records=JSON.parse(await readFile(resolve(root,'data/achievements-public.json'),'utf8'));
const expected=records.filter(x=>['持續追蹤','爭取規劃','政策實施'].includes(x.status)&&x.sources.length).length;
try{
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(8000);await page.clock.setFixedTime(new Date('2026-09-22T12:00:00+08:00'));
 await page.goto(base+'election.html');await page.waitForFunction(()=>window.HuiwenElection?.ready);
 await check('complete tracking search finds Wen-De beyond initial eight',async()=>{
  assert.equal(await page.locator('.campaign-tracking-card').count(),expected);
  assert.equal(await page.locator('.campaign-tracking-card:visible').count(),8);
  await page.locator('#campaign-search').fill('文德國小');assert((await page.locator('.campaign-tracking-card:visible').count())>0);
  assert.match(await page.locator('#campaign-search-count').innerText(),/搜尋涵蓋全部/);
  await page.locator('#campaign-search').fill('');await page.locator('#campaign-tracking-more').click();assert.equal(await page.locator('.campaign-tracking-card:visible').count(),expected);
 });
 await check('zero results delegates existing whole-site search event',async()=>{
  await page.evaluate(()=>document.addEventListener('huiwen:search',e=>window.searchQuery=e.detail.query,{once:true}));
  await page.locator('#campaign-search').fill('找不到的關鍵字987');await page.locator('#campaign-search-all').click();assert.equal(await page.evaluate(()=>window.searchQuery),'找不到的關鍵字987');
  assert(await page.locator('#global-search-dialog').isVisible());await page.keyboard.press('Escape');
 });
 await check('each source completes without waiting for slow unrelated source',async()=>{
  await page.route('**/data/platforms.json',async route=>{await new Promise(r=>setTimeout(r,6200));await route.abort().catch(()=>{});});
  await page.route('**/data/events.json',route=>route.fulfill({json:{events:[]}}));
  await page.goto(base+'election.html');await page.waitForFunction(()=>document.querySelector('#campaign-events').textContent.includes('目前沒有即將舉行'),{},{timeout:2500});
  await page.locator('#campaign-platform-error').waitFor({state:'visible',timeout:7000});
  assert.equal(await page.locator('#campaign-platforms li').count(),13);assert.equal(await page.locator('.campaign-tracking-card').count(),expected);
  await page.unroute('**/data/platforms.json');await page.unroute('**/data/events.json');
 });
 await check('tracking failure retains full static content and searchable fallback',async()=>{
  await page.route('**/data/achievements-public.json',r=>r.abort());await page.goto(base+'election.html');await page.locator('#campaign-tracking-error').waitFor({state:'visible'});
  await page.locator('#campaign-search').fill('文德國小');assert((await page.locator('.campaign-tracking-card:visible').count())>0);await page.unroute('**/data/achievements-public.json');
 });
 await check('cancelled and rescheduled event actions respect status',async()=>{
  // Fixture independent of published events (WP0.4): the check must still run when events.json is empty.
  const original={id:'fixture-base',name:'測試活動',start:'2026-10-08T16:00:00+08:00',end:'2026-10-08T16:50:00+08:00',content:'測試內容',registration:'無需報名',sourceUrl:'https://example.gov.tw/event',verifiedAt:'2026-09-11',status:'scheduled',updatedAt:'2026-09-11',previousSchedule:null,changeNote:null,reviewDueAt:'2026-10-01'};
  const events=[{...original,id:'fixture-cancelled',name:'取消測試',status:'cancelled',changeNote:'測試取消'}, {...original,id:'fixture-rescheduled',name:'改期測試',status:'rescheduled',changeNote:'測試改期',previousSchedule:{start:'2026-10-01T16:00:00+08:00',end:'2026-10-01T17:00:00+08:00'}}];
  await page.route('**/data/events.json',r=>r.fulfill({json:{events}}));await page.goto(base+'election.html');
  const cancelled=page.locator('#campaign-events article').filter({hasText:'取消測試'});await cancelled.waitFor();assert.equal(await cancelled.locator('a[href*="calendar.google"]').count(),0);
  const changed=page.locator('#campaign-events article').filter({hasText:'改期測試'});assert.match(await changed.innerText(),/原時間.*2026\/10\/01/);assert.match(await changed.innerText(),/不會自動更新/);
  await page.unroute('**/data/events.json');
 });
 for(const [clock,phase] of [['2026-11-27T12:00:00+08:00','before'],['2026-11-28T07:00:00+08:00','election-day'],['2026-11-28T09:00:00+08:00','voting'],['2026-11-28T16:00:00+08:00','ended'],['2026-11-29T12:00:00+08:00','ended'],['2027-01-01T00:00:00+08:00','historical']]){
  await check(`same election state on home and election at ${clock}`,async()=>{
   await page.clock.setFixedTime(new Date(clock));const seen=[];
   for(const path of ['index.html','election.html']){await page.goto(base+path);await page.waitForFunction(p=>document.querySelector('#campaign-countdown')?.dataset.phase===p,phase);seen.push(await page.locator('#campaign-countdown').innerText());assert(!/勝選/.test(await page.locator('#campaign-countdown').evaluate(el=>el.parentElement.innerText)));}
   assert.equal(seen[0],seen[1]);
  });
 }
 const nojs=await browser.newContext({javaScriptEnabled:false});const plain=await nojs.newPage();
 await check('JavaScript disabled retains platform tracking and event records',async()=>{await plain.goto(base+'election.html');assert.equal(await plain.locator('.campaign-tracking-card:visible').count(),expected);assert.equal(await plain.locator('#campaign-platforms li').count(),13);assert((await plain.locator('#campaign-events article').count())>0);});await nojs.close();await context.close();
 // Real secure-context SW tests, isolated storage; no production registration or mutation.
 const sw=await browser.newContext();const client=await sw.newPage();
 await check('partial optional shell failure still installs required offline document; upgrade purges old raw cache',async()=>{
  await client.goto(base+'offline.html');
  await client.evaluate(async()=>{const c=await caches.open('huiwen-digital-v11-fixture');await c.put('data/achievements.json',new Response('[{"id":"fixture-unpublished"}]'));});
  failOptional=true;
  await client.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready;});
  await client.waitForFunction(()=>!!navigator.serviceWorker.controller);failOptional=false;
  const keys=await client.evaluate(()=>caches.keys());assert.deepEqual(keys,['huiwen-digital-v12-20260922-maturity']);
  assert.equal(await client.evaluate(async()=>Boolean(await caches.match('data/achievements.json'))),false);
 });
 await check('cached navigation is explicit about time and non-live content',async()=>{
  await client.goto(base+'index.html');await client.waitForLoadState('load');await sw.setOffline(true);disconnected=true;await client.goto(base+'index.html');
  assert.match(await client.locator('[data-offline-cache]').innerText(),/非即時.*儲存時間/s);assert.match(await client.locator('[data-offline-cache]').innerText(),/\d{4}\/\d{2}\/\d{2}/);
 });
 await check('uncached detail offline shows dedicated document without masquerading as homepage',async()=>{
  await client.goto(base+'achievement-never-cached-fixture.html');assert.match(await client.locator('h1').innerText(),/這一頁尚未儲存/);assert.equal(await client.locator('.hero-portrait').count(),0);assert.match(client.url(),/achievement-never-cached-fixture\.html$/);
 });
 disconnected=false;await sw.setOffline(false);await sw.close();
 await check('required offline failure prevents installation; previous cache survives',async()=>{
  const broken=await browser.newContext(),p=await broken.newPage();await p.goto(base+'index.html');
  await p.evaluate(async()=>{const c=await caches.open('huiwen-digital-v11-fixture');await c.put('index.html',new Response('previous usable cache'));});
  failRequired=true;
  await p.evaluate(async()=>{const r=await navigator.serviceWorker.register('sw.js');const w=r.installing;if(!w)return;await new Promise(resolve=>{w.addEventListener('statechange',()=>{if(w.state==='redundant'||w.state==='activated')resolve();});});});
  assert.equal(await p.evaluate(()=>Boolean(navigator.serviceWorker.controller)),false);assert((await p.evaluate(()=>caches.keys())).includes('huiwen-digital-v11-fixture'));
  failRequired=false;await broken.close();
 });
 await check('explicit and injected digital assets agree across navigation without worker downgrade',async()=>{
  // *.localhost is a secure loopback context, while exercising the production registration path.
  const nativeBase=base.replace('127.0.0.1','huiwen.localhost');
  const native=await browser.newContext(),nativePage=await native.newPage();nativePage.setDefaultTimeout(12000);
  await native.route('**/*',route=>new URL(route.request().url()).origin===new URL(nativeBase).origin?route.continue():route.abort());
  await nativePage.addInitScript(()=>{window.registeredWorkerURLs=[];const original=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=(url,options)=>{window.registeredWorkerURLs.push(String(url));return original(url,options);};});
  const assets={};for(const asset of ['digital.js','digital.css'])assets[asset]=createHash('sha256').update(await readFile(resolve(root,asset))).digest('hex').slice(0,12);
  const source=await readFile(resolve(root,'digital.js'),'utf8'),version=source.match(/const SERVICE_WORKER_VERSION = '([^']+)'/)[1];
  for(const path of ['index.html','election.html','without-markers.html']){
   await nativePage.goto(nativeBase+path);
   await nativePage.waitForFunction(()=>window.registeredWorkerURLs.length>0);
   await nativePage.evaluate(async()=>{await navigator.serviceWorker.ready;});
   await nativePage.waitForFunction(()=>!!navigator.serviceWorker.controller);
   const state=await nativePage.evaluate(()=>({registered:window.registeredWorkerURLs,controller:navigator.serviceWorker.controller.scriptURL,scripts:[...document.scripts].map(s=>s.src).filter(src=>/\/digital\.js\?/.test(src)),styles:[...document.querySelectorAll('link[rel="stylesheet"]')].map(s=>s.href).filter(src=>/\/digital\.css\?/.test(src))}));
   assert.deepEqual(state.scripts,[nativeBase+'digital.js?v='+assets['digital.js']],path+' has exactly one current script');
   assert.deepEqual(state.styles,[nativeBase+'digital.css?v='+assets['digital.css']],path+' has exactly one current stylesheet');
   assert.deepEqual(state.registered,[nativeBase+'sw.js?v='+version],path+' never requests the legacy worker');
   assert.equal(state.controller,nativeBase+'sw.js?v='+version,path+' remains on the current worker');
  }
  await native.close();
 });
}finally{
 await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));
 const out=new URL('./results/runtime-maturity/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
}
