/** Behavioral regression: complete search, independent data, time boundaries, real service worker. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {waitForWorkerState} from './runtime-maturity-worker.mjs';
import {resolveRuntimeMaturityFixtureResponse} from './runtime-maturity-fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
let failOptional=false,failRequired=false,disconnected=false;
const report={checks:[],failures:[],stages:[],stageDiagnostics:[],timeoutDiagnostics:[],cleanupFailures:[],startedAt:new Date().toISOString()};
// The run used 8m40s before this script; cap it at 7m to leave time for report and artifact cleanup inside the existing 18m job.
const suiteStartedAt=Date.now(),MAX_SUITE_MS=7*60*1000,CHECK_TIMEOUT_MS=30_000,WORKER_TIMEOUT_MS=15_000;
let activeStage='initialization',base=null,browser=null,activeDiagnosticPage=null;
const diagnosticPages=new Map();
const pageDiagnostics=new Map(),contextDiagnostics=new WeakMap();
const LEGACY_WORKER_VERSION='20260922-public-service-v11';
function timeoutError(name,ms){const error=new Error(`Timed out after ${ms}ms at ${name}`);error.code='RUNTIME_MATURITY_TIMEOUT';error.stageName=name;error.timeoutMs=ms;return error;}
async function raceTimeout(operation,name,ms){let timer;try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError(name,ms)),ms);})]);}finally{clearTimeout(timer);}}
function safeURL(value){try{return new URL(value).origin;}catch{return '[unavailable]';}}
function safeResourceURL(value){try{const url=new URL(value);return url.origin+url.pathname;}catch{return '[unavailable]';}}
function safeText(value){
 return String(value)
  .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|session(?:id)?|csrf|secret|password)=)[^&\s,;]+/gi,'$1[REDACTED]')
  .replace(/https?:\/\/[^\s"'`<>]+/g,raw=>{const tail=raw.match(/[),.;]+$/)?.[0]??'',candidate=tail?raw.slice(0,-tail.length):raw;return safeURL(candidate)+tail;});
}
function safeDiagnosticText(value){
 return String(value)
  .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|session(?:id)?|csrf|secret|password)=)[^&\s,;]+/gi,'$1[REDACTED]')
  .replace(/https?:\/\/[^\s"'`<>]+/g,raw=>{const tail=raw.match(/[),.;]+$/)?.[0]??'',candidate=tail?raw.slice(0,-tail.length):raw;return safeResourceURL(candidate)+tail;});
}
function installWorkerStateWaiter(page){return page.addInitScript(`window.__runtimeMaturityWaitForWorkerState=${waitForWorkerState.toString()};`);}
function observeWorkerRegistrations(page){return page.addInitScript(()=>{
 const scrub=value=>{try{const url=new URL(value,location.href);return url.origin+url.pathname;}catch{return null;}};
 const snapshot=registration=>{
  if(!registration)return null;
  const worker=value=>value?{scriptURL:scrub(value.scriptURL),state:value.state}:null;
  return{scope:scrub(registration.scope),installing:worker(registration.installing),waiting:worker(registration.waiting),active:worker(registration.active)};
 };
 window.__runtimeMaturityRegistrationCalls=[];
 const original=navigator.serviceWorker.register.bind(navigator.serviceWorker);
 navigator.serviceWorker.register=function(url,options){
  const call={url:String(url),status:'pending',startedAt:performance.now(),stateHistory:[]};
  window.__runtimeMaturityRegistrationCalls.push(call);
  let pending;
  try{pending=original(url,options);}catch(error){call.status='rejected';call.error={name:error?.name??'Error',message:String(error?.message??error).slice(0,240)};call.elapsedMs=performance.now()-call.startedAt;throw error;}
  call.pending=Promise.resolve(pending).then(registration=>{
   call.status='resolved';call.elapsedMs=performance.now()-call.startedAt;call.registration=registration;
   const seen=new WeakSet();
   const record=()=>{call.stateHistory.push({elapsedMs:Math.round(performance.now()-call.startedAt),registration:snapshot(registration)});if(call.stateHistory.length>12)call.stateHistory.shift();};
   const watch=worker=>{if(worker&&!seen.has(worker)){seen.add(worker);worker.addEventListener('statechange',record);}};
   const watchCurrent=()=>{watch(registration.installing);watch(registration.waiting);watch(registration.active);record();};
   registration.addEventListener('updatefound',watchCurrent);watchCurrent();
   return registration;
  },error=>{call.status='rejected';call.error={name:error?.name??'Error',message:String(error?.message??error).slice(0,240)};call.elapsedMs=performance.now()-call.startedAt;throw error;});
  return call.pending;
 };
});}
async function stage(name,operation,timeoutMs=CHECK_TIMEOUT_MS,enforceSuite=true){
 const previous=activeStage,started=Date.now(),startedAt=new Date().toISOString(),record={name,startedAt};report.stages.push(record);activeStage=name;
 const remaining=MAX_SUITE_MS-(started-suiteStartedAt),limit=enforceSuite?Math.min(timeoutMs,remaining):timeoutMs;
 console.log(JSON.stringify({event:'stage-start',name,at:startedAt,timeoutMs:limit}));
 try{if(limit<=0)throw timeoutError(name,Math.max(0,limit));const value=await raceTimeout(operation,name,limit);record.status='PASS';return value;}
 catch(value){const error=value instanceof Error?value:new Error(String(value));error.stageName??=name;record.status=error.code==='RUNTIME_MATURITY_TIMEOUT'?'TIMEOUT':'ERROR';record.error=safeText(error);if(!error.diagnosticsCaptured){error.diagnosticsCaptured=true;await captureStageDiagnosticsSafely(error);}throw error;}
 finally{record.endedAt=new Date().toISOString();record.durationMs=Date.now()-started;console.log(JSON.stringify({event:'stage-end',name,at:record.endedAt,durationMs:record.durationMs,status:record.status??'ERROR',error:record.error}));activeStage=previous;}
}
function appendBounded(list,value,limit=40){list.push(value);if(list.length>limit)list.splice(0,list.length-limit);}
function isFixtureURL(value){
 try{const url=new URL(value),fixture=new URL(base);return url.port===fixture.port&&(url.hostname==='127.0.0.1'||url.hostname==='localhost'||url.hostname.endsWith('.localhost'));}catch{return false;}
}
function fixtureRequestDetails(request){return{url:safeResourceURL(request.url()),method:request.method(),resourceType:request.resourceType()};}
function attachPageDiagnostics(page){
 const diagnostics={consoleErrors:[],pageErrors:[]};pageDiagnostics.set(page,diagnostics);
 page.on('console',message=>{if(message.type()==='error')appendBounded(diagnostics.consoleErrors,safeText(message.text()));});
 page.on('pageerror',error=>appendBounded(diagnostics.pageErrors,safeText(error?.stack??error?.message??error)));
 const context=page.context();let contextInfo=contextDiagnostics.get(context);
 if(!contextInfo){
  contextInfo={responses:[],requestFailures:[],inflight:new Map(),serviceWorkers:[]};contextDiagnostics.set(context,contextInfo);
  context.on('request',request=>{if(isFixtureURL(request.url()))contextInfo.inflight.set(request,fixtureRequestDetails(request));});
  context.on('response',response=>{
   const request=response.request();if(!isFixtureURL(request.url()))return;
   const entry={...fixtureRequestDetails(request),status:response.status(),cacheControl:null,contentType:null};appendBounded(contextInfo.responses,entry);
   void response.allHeaders().then(headers=>{entry.cacheControl=headers['cache-control']??null;entry.contentType=headers['content-type']??null;}).catch(()=>{});
  });
  context.on('requestfinished',request=>contextInfo.inflight.delete(request));
  context.on('requestfailed',request=>{
   contextInfo.inflight.delete(request);if(!isFixtureURL(request.url()))return;
   appendBounded(contextInfo.requestFailures,{...fixtureRequestDetails(request),failure:safeText(request.failure()?.errorText??'request failed')});
  });
  context.on('serviceworker',worker=>{
   const info={url:safeResourceURL(worker.url()),console:[]};appendBounded(contextInfo.serviceWorkers,info,12);
   if(typeof worker.on==='function')worker.on('console',message=>appendBounded(info.console,safeText(message.text()),20));
  });
 }
}
function trackPage(name,page,defaultTimeout=8000){page.setDefaultTimeout(defaultTimeout);page.setDefaultNavigationTimeout(15_000);diagnosticPages.set(name,page);activeDiagnosticPage=name;attachPageDiagnostics(page);return page;}
async function captureStageDiagnostics(error){
 const recent=report.stages.at(-1),snapshot={at:new Date().toISOString(),stage:error.stageName??activeStage,recentStage:recent?{name:recent.name,status:recent.status??null,startedAt:recent.startedAt,endedAt:recent.endedAt??null,error:recent.error??null}:null,timeoutMs:error.timeoutMs??null,elapsedMs:Date.now()-suiteStartedAt,page:null,pages:[]};
 try{
  for(const [name,page] of diagnosticPages){
   let closed=true;try{closed=page.isClosed();}catch{}
   const item={name,closed};
   if(!closed){
    try{item.url=safeURL(page.url());}catch{item.url=null;}
    try{
     item.runtime=await raceTimeout(()=>page.evaluate(async()=>{
     const scrub=value=>{try{const url=new URL(value,location.href);return url.origin+url.pathname;}catch{return null;}};
     const registration=value=>{if(!value)return null;const worker=item=>item?{scriptURL:scrub(item.scriptURL),state:item.state}:null;return{scope:scrub(value.scope),installing:worker(value.installing),waiting:worker(value.waiting),active:worker(value.active)};};
     const calls=(window.__runtimeMaturityRegistrationCalls??[]).slice(-8).map(call=>({url:scrub(call.url),status:call.status,elapsedMs:Math.round(call.elapsedMs??(performance.now()-call.startedAt)),error:call.error??null,registration:registration(call.registration),stateHistory:(call.stateHistory??[]).slice(-8)}));
     const probe=window.__runtimeMaturityOfflineProbe;
     let currentRegistrations=[];try{currentRegistrations=await navigator.serviceWorker?.getRegistrations()??[];}catch{}
     const controller=navigator.serviceWorker?.controller??null;
     return{readyState:document.readyState,serviceWorkerController:controller?{scriptURL:scrub(controller.scriptURL),state:controller.state}:null,digitalAssets:performance.getEntriesByType('resource').map(entry=>scrub(entry.name)).filter(url=>url&&/digital\.(js|css)|sw\.js/.test(url)).slice(-8),registrationCalls:calls,registrations:currentRegistrations.map(registration),offlineProbe:probe?{registerStatus:probe.registerStatus,readyStatus:probe.readyStatus,registerError:probe.registerError??null,readyError:probe.readyError??null,registration:registration(probe.registration)}:null};
    }),`${name} stage snapshot`,1500);
     for(const call of item.runtime.registrationCalls??[])if(call.error?.message)call.error.message=safeDiagnosticText(call.error.message);
     for(const key of ['registerError','readyError'])if(item.runtime.offlineProbe?.[key]?.message)item.runtime.offlineProbe[key].message=safeDiagnosticText(item.runtime.offlineProbe[key].message);
    }catch(snapshotError){item.runtimeError=safeText(snapshotError);}
    const observed=pageDiagnostics.get(page),contextInfo=contextDiagnostics.get(page.context());
    if(observed||contextInfo)item.network={responses:contextInfo?.responses.slice(-40)??[],requestFailures:contextInfo?.requestFailures.slice(-20)??[],inflight:[...(contextInfo?.inflight.values()??[])].slice(-20),consoleErrors:observed?.consoleErrors.slice(-20)??[],pageErrors:observed?.pageErrors.slice(-10)??[]};
    if(contextInfo)item.serviceWorkerConsole=contextInfo.serviceWorkers.slice(-12);
   }
   snapshot.pages.push(item);
  }
  const current=snapshot.pages.find(item=>item.name===activeDiagnosticPage&&!item.closed)??[...snapshot.pages].reverse().find(item=>!item.closed);
  snapshot.page=current??null;
 }catch(snapshotError){snapshot.snapshotError=safeText(snapshotError);}
 report.stageDiagnostics.push(snapshot);
 if(error.code==='RUNTIME_MATURITY_TIMEOUT')report.timeoutDiagnostics.push(snapshot);
 console.error(JSON.stringify({event:error.code==='RUNTIME_MATURITY_TIMEOUT'?'timeout-diagnostic':'stage-diagnostic',...snapshot}));
}
async function captureStageDiagnosticsSafely(error){
 try{await captureStageDiagnostics(error);}catch(snapshotError){
  const snapshot={at:new Date().toISOString(),stage:error.stageName??activeStage,recentStage:report.stages.at(-1)?.name??null,timeoutMs:error.timeoutMs??null,elapsedMs:Date.now()-suiteStartedAt,page:null,pages:[],snapshotError:safeText(snapshotError)};
  report.stageDiagnostics.push(snapshot);if(error.code==='RUNTIME_MATURITY_TIMEOUT')report.timeoutDiagnostics.push(snapshot);
  console.error(JSON.stringify({event:'stage-diagnostic-error',...snapshot}));
 }
}
const server=createServer(async(req,res)=>{
  if(disconnected){req.socket.destroy();return;}
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const fixture=await resolveRuntimeMaturityFixtureResponse({root,pathname,requestURL:req.url,failOptional,failRequired,legacyWorkerVersion:LEGACY_WORKER_VERSION});
  const respond=()=>{if(!res.destroyed){res.writeHead(fixture.status,fixture.headers);res.end(fixture.body);}};
  if(fixture.delayMs)setTimeout(respond,fixture.delayMs);else respond();
});
async function check(name,fn){try{await stage(name,fn,CHECK_TIMEOUT_MS);report.checks.push({name,status:'PASS'});}catch(value){const error=value instanceof Error?value:new Error(String(value));report.failures.push({name,error:safeText(error)});if(error.code==='RUNTIME_MATURITY_TIMEOUT'){error.failureRecorded=true;throw error;}}}
try{
 await stage('fixture server listen',()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}),10_000);
 base=`http://127.0.0.1:${server.address().port}/`;
 browser=await stage('launch Chromium',()=>chromium.launch({timeout:20_000}),30_000);
 const records=JSON.parse(await stage('read expected public records',()=>readFile(resolve(root,'data/achievements-public.json'),'utf8'),5000));
 const expected=records.filter(x=>['持續追蹤','爭取規劃','政策實施'].includes(x.status)&&x.sources.length).length;
 const initial=await stage('initial election page setup',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=trackPage('election',await context.newPage());await page.clock.setFixedTime(new Date('2026-09-22T12:00:00+08:00'));
  await page.goto(base+'election.html');await page.waitForFunction(()=>window.HuiwenElection?.ready);return{context,page};
 },45_000);
 const {context,page}=initial;
 await check('complete tracking search finds Wen-De beyond initial eight',async()=>{
  assert.equal(await page.locator('.campaign-tracking-card').count(),expected);
  assert.equal(await page.locator('.campaign-tracking-card:visible').count(),8);
  await page.locator('#campaign-search').fill('文德國小');assert((await page.locator('.campaign-tracking-card:visible').count())>0);
  assert.match(await page.locator('#campaign-search-count').innerText(),/搜尋涵蓋全部/);
  await page.locator('#campaign-search').fill('');await page.locator('#campaign-tracking-more').click();assert.equal(await page.locator('.campaign-tracking-card:visible').count(),expected);
 });
 await check('dated history outranks session labels after client refresh without losing date ranges',async()=>{
  await page.waitForFunction(()=>document.querySelector('#campaign-tracking')?.dataset.total);
  await page.locator('#campaign-search').fill('博愛卡');
  const boai=page.locator('.campaign-tracking-card').filter({has:page.locator('h3 a[href="achievement-boai-card-rehab-bus-points.html"]')});
  assert.equal(await boai.locator('.campaign-record time').innerText(),'2026-09-22');
  await page.locator('#campaign-search').fill('過埤');
  const guopi=page.locator('.campaign-tracking-card').filter({has:page.locator('h3 a[href="achievement-guopi-retaining-wall.html"]')});
  assert.equal(await guopi.locator('.campaign-record time').innerText(),'2026-07-29 至 08-06');
  await page.locator('#campaign-search').fill('');
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
  await check(`election center retains accurate phase at ${clock}`,async()=>{
   await page.clock.setFixedTime(new Date(clock));
   await page.goto(base+'election.html');
   await page.waitForFunction(p=>document.querySelector('#campaign-countdown')?.dataset.phase===p,phase);
   assert(!/勝選/.test(await page.locator('#campaign-countdown').evaluate(el=>el.parentElement.innerText)));
   await page.goto(base+'index.html');
   assert.equal(await page.locator('#campaign-countdown').count(),0);
   assert.equal(await page.locator('#navigation a[href="election.html"]').count(),1);
  });
 }
 const nojs=await stage('create JavaScript-disabled context',()=>browser.newContext({javaScriptEnabled:false}),10_000);const plain=trackPage('javascript-disabled',await stage('create JavaScript-disabled page',()=>nojs.newPage(),10_000));
 await check('JavaScript disabled retains platform tracking and event records',async()=>{await plain.goto(base+'election.html');assert.equal(await plain.locator('.campaign-tracking-card:visible').count(),expected);assert.equal(await plain.locator('#campaign-platforms li').count(),13);assert((await plain.locator('#campaign-events article').count())>0);});await stage('close JavaScript-disabled context',()=>nojs.close(),8000,false);await stage('close election context',()=>context.close(),8000,false);
 await check('legacy immutable worker fixture is reachable at its old URL',async()=>{
  const fetchText=async path=>{const response=await fetch(new URL(path,base),{signal:AbortSignal.timeout(10_000)});assert.equal(response.status,200);return response.text();};
  const [legacyScript,legacyWorker]=await Promise.all([fetchText(`digital.js?v=${LEGACY_WORKER_VERSION}`),fetchText(`sw.js?v=${LEGACY_WORKER_VERSION}`)]);
  const productionSource=await readFile(resolve(root,'digital.js'),'utf8'),expectedLegacySource=productionSource.replace(/const SERVICE_WORKER_VERSION = '[^']+'/,`const SERVICE_WORKER_VERSION = '${LEGACY_WORKER_VERSION}'`);
  assert.equal(legacyScript,expectedLegacySource,'v11 keeps the production client source with only its service worker URL version changed');
  assert.equal(legacyWorker,"self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",'the old worker remains the install/activate fixture stub');
 });
 await check('legacy v11 worker activates and controls before the production v14 worker upgrade',async()=>{
  const nativeBase=base.replace('127.0.0.1','huiwen.localhost');
  const digitalSource=await readFile(resolve(root,'digital.js'),'utf8'),digitalHash=createHash('sha256').update(digitalSource).digest('hex').slice(0,12),currentVersion=digitalSource.match(/const SERVICE_WORKER_VERSION = '([^']+)'/)?.[1];
  assert.equal(currentVersion,'20261008-font-route-v14');
  const currentWorkerURL=nativeBase+'sw.js?v='+currentVersion,legacyWorkerURL=nativeBase+'sw.js?v='+LEGACY_WORKER_VERSION;
  const upgrade=await stage('create v11 to v14 upgrade context',()=>browser.newContext(),10_000);
  const upgradePage=trackPage('legacy-worker-upgrade',await stage('create v11 to v14 upgrade page',()=>upgrade.newPage(),10_000),12_000);
  let primaryError=null,closeError=null;
  try{
   await upgrade.route('**/*',route=>new URL(route.request().url()).origin===new URL(nativeBase).origin?route.continue():route.abort());
   await installWorkerStateWaiter(upgradePage);await observeWorkerRegistrations(upgradePage);
   await upgradePage.goto(nativeBase+'worker-upgrade-legacy.html');
   const legacy=await stage('observe v11 install and activation',()=>upgradePage.evaluate(async({version,timeoutMs})=>{
    const call=window.__runtimeMaturityRegistrationCalls.find(item=>item.url.endsWith(`sw.js?v=${version}`));
    if(!call)throw new Error('Legacy digital.js did not request the v11 worker URL');
    const registration=await call.pending,state=await window.__runtimeMaturityWaitForWorkerState(registration,['activated'],timeoutMs,call.url),ready=await navigator.serviceWorker.ready;
    return{requested:call.url,state,active:registration.active?.scriptURL??null,activeState:registration.active?.state??null,ready:ready.active?.scriptURL??null};
   },{version:LEGACY_WORKER_VERSION,timeoutMs:WORKER_TIMEOUT_MS}),WORKER_TIMEOUT_MS);
   await stage('confirm v11 controls its browser page',()=>upgradePage.waitForFunction(version=>navigator.serviceWorker.controller?.scriptURL.endsWith(`sw.js?v=${version}`),LEGACY_WORKER_VERSION),WORKER_TIMEOUT_MS);
   assert.equal(legacy.requested,legacyWorkerURL);assert.equal(legacy.state,'activated');assert.equal(legacy.active,legacyWorkerURL);assert.equal(legacy.activeState,'activated');assert.equal(legacy.ready,legacyWorkerURL);
   assert.equal(await upgradePage.evaluate(()=>navigator.serviceWorker.controller?.scriptURL??null),legacyWorkerURL);
   await upgradePage.evaluate(async()=>{const cache=await caches.open('huiwen-digital-v11-fixture');await cache.put('index.html',new Response('legacy worker cache fixture'));});

   await upgradePage.goto(nativeBase+'worker-upgrade-current.html');
   const production=await stage('observe production v14 upgrade activation and ready',()=>upgradePage.evaluate(async({workerURL,timeoutMs})=>{
    const call=window.__runtimeMaturityRegistrationCalls.find(item=>item.url===workerURL);
    if(!call)throw new Error('Hashed production digital.js did not request the current worker URL');
    const registration=await call.pending,state=await window.__runtimeMaturityWaitForWorkerState(registration,['activated'],timeoutMs,workerURL),ready=await navigator.serviceWorker.ready;
    return{requested:call.url,state,active:registration.active?.scriptURL??null,activeState:registration.active?.state??null,ready:ready.active?.scriptURL??null,scripts:[...document.scripts].map(script=>script.src).filter(src=>/\/digital\.js\?/.test(src))};
   },{workerURL:currentWorkerURL,timeoutMs:WORKER_TIMEOUT_MS}),WORKER_TIMEOUT_MS);
   await stage('confirm v14 controls the upgraded browser page',()=>upgradePage.waitForFunction(workerURL=>navigator.serviceWorker.controller?.scriptURL===workerURL,currentWorkerURL),WORKER_TIMEOUT_MS);
   assert.equal(production.requested,currentWorkerURL);assert.equal(production.state,'activated');assert.equal(production.active,currentWorkerURL);assert.equal(production.activeState,'activated');assert.equal(production.ready,currentWorkerURL);
   assert.deepEqual(production.scripts,[nativeBase+'digital.js?v='+digitalHash]);
   const currentCache=(await readFile(resolve(root,'sw.js'),'utf8')).match(/const CACHE='([^']+)'/)?.[1];assert(currentCache);
   const cacheKeys=await upgradePage.evaluate(()=>caches.keys());assert.deepEqual(cacheKeys,[currentCache]);

   await upgradePage.goto(nativeBase+'index.html');await upgradePage.waitForLoadState('load');
   await upgrade.setOffline(true);disconnected=true;await upgradePage.goto(nativeBase+'index.html');
   assert.match(await upgradePage.locator('[data-offline-cache]').innerText(),/非即時.*儲存時間/s);
  }catch(error){primaryError=error;}
  finally{
   disconnected=false;
   try{await stage('restore network and close v11 to v14 upgrade context',async()=>{let restoreError=null;try{await upgrade.setOffline(false);}catch(error){restoreError=error;}await upgrade.close();if(restoreError)throw restoreError;},8000,false);}catch(error){closeError=error;report.cleanupFailures.push({name:'close v11 to v14 upgrade context',error:safeText(error)});}
  }
  if(primaryError)throw primaryError;if(closeError)throw closeError;
 });
 // Remaining service worker cases use isolated browser contexts and storage.
 const sw=await stage('create offline worker context',()=>browser.newContext(),10_000);const client=trackPage('offline-worker',await stage('create offline worker page',()=>sw.newPage(),10_000));await observeWorkerRegistrations(client);
 await check('partial optional shell failure still installs required offline document; upgrade purges old raw cache',async()=>{
  await client.goto(base+'offline.html');
  await client.evaluate(async()=>{const c=await caches.open('huiwen-digital-v11-fixture');await c.put('data/achievements.json',new Response('[{"id":"fixture-unpublished"}]'));});
  failOptional=true;
  try{
   await stage('offline worker registration and ready',()=>client.evaluate(async()=>{
    const probe=window.__runtimeMaturityOfflineProbe={registerStatus:'pending',readyStatus:'not-started',startedAt:performance.now(),registration:null};
    try{probe.registration=await navigator.serviceWorker.register('sw.js');probe.registerStatus='resolved';probe.registerElapsedMs=Math.round(performance.now()-probe.startedAt);}
    catch(error){probe.registerStatus='rejected';probe.registerElapsedMs=Math.round(performance.now()-probe.startedAt);probe.registerError={name:error?.name??'Error',message:String(error?.message??error).slice(0,240)};throw error;}
    probe.readyStatus='pending';probe.readyStartedAt=performance.now();
    try{await navigator.serviceWorker.ready;probe.readyStatus='resolved';probe.readyElapsedMs=Math.round(performance.now()-probe.readyStartedAt);}
    catch(error){probe.readyStatus='rejected';probe.readyElapsedMs=Math.round(performance.now()-probe.readyStartedAt);probe.readyError={name:error?.name??'Error',message:String(error?.message??error).slice(0,240)};throw error;}
   }),WORKER_TIMEOUT_MS);
   await client.waitForFunction(()=>!!navigator.serviceWorker.controller);
   const expectedCache=(await readFile(resolve(root,'sw.js'),'utf8')).match(/const CACHE='([^']+)'/)[1];
   const keys=await client.evaluate(()=>caches.keys());assert.deepEqual(keys,[expectedCache]);
   assert.equal(await client.evaluate(async()=>Boolean(await caches.match('data/achievements.json'))),false);
  }finally{failOptional=false;}
 });
 await check('cached navigation is explicit about time and non-live content',async()=>{
  await client.goto(base+'index.html');await client.waitForLoadState('load');await sw.setOffline(true);disconnected=true;await client.goto(base+'index.html');
  assert.match(await client.locator('[data-offline-cache]').innerText(),/非即時.*儲存時間/s);assert.match(await client.locator('[data-offline-cache]').innerText(),/\d{4}\/\d{2}\/\d{2}/);
 });
 await check('uncached detail offline shows dedicated document without masquerading as homepage',async()=>{
  await client.goto(base+'achievement-never-cached-fixture.html');assert.match(await client.locator('h1').innerText(),/這一頁尚未儲存/);assert.equal(await client.locator('.hero-portrait').count(),0);assert.match(client.url(),/achievement-never-cached-fixture\.html$/);
 });
 disconnected=false;await stage('restore online and close offline worker context',async()=>{await sw.setOffline(false);await sw.close();},8000,false);
 await check('required offline failure prevents installation; previous cache survives',async()=>{
  failRequired=false;
  const broken=await stage('create required failure context',()=>browser.newContext(),10_000),p=trackPage('required-offline-failure',await stage('create required failure page',()=>broken.newPage(),10_000));
  let primaryError=null,closeError=null;
  try{
   await installWorkerStateWaiter(p);await p.goto(base+'index.html');
   await p.evaluate(async()=>{const c=await caches.open('huiwen-digital-v11-fixture');await c.put('index.html',new Response('previous usable cache'));});
   const source=await readFile(resolve(root,'digital.js'),'utf8'),version=source.match(/const SERVICE_WORKER_VERSION = '([^']+)'/)?.[1];assert(version);
   failRequired=true;
   const failureWorkerURL=base+'sw.js?v='+version;
   const failure=await stage('required failure worker becomes redundant',()=>p.evaluate(async({workerURL,timeoutMs})=>{
    const registration=await navigator.serviceWorker.register(workerURL);
    const state=await window.__runtimeMaturityWaitForWorkerState(registration,['redundant'],timeoutMs,workerURL);
    return{state,active:registration.active?.scriptURL??null,requested:workerURL};
   },{workerURL:failureWorkerURL,timeoutMs:WORKER_TIMEOUT_MS}),WORKER_TIMEOUT_MS);
   assert.equal(failure.state,'redundant');assert.equal(failure.requested,failureWorkerURL);assert.equal(failure.active,null);
   assert.equal(await p.evaluate(()=>Boolean(navigator.serviceWorker.controller)),false);
   assert((await p.evaluate(()=>caches.keys())).includes('huiwen-digital-v11-fixture'));
  }catch(error){primaryError=error;}
  finally{
   failRequired=false;
   try{await stage('close required failure context',()=>broken.close(),8000,false);}catch(error){closeError=error;report.cleanupFailures.push({name:'close required failure context',error:safeText(error)});}
  }
  if(primaryError)throw primaryError;if(closeError)throw closeError;
 });
 await check('explicit and injected digital assets agree across navigation without worker downgrade',async()=>{
  // *.localhost is a secure loopback context, while exercising the production registration path.
  const nativeBase=base.replace('127.0.0.1','huiwen.localhost');
  const native=await browser.newContext(),nativePage=trackPage('native-hash-route',await native.newPage(),12_000);
  await native.route('**/*',route=>new URL(route.request().url()).origin===new URL(nativeBase).origin?route.continue():route.abort());
  await nativePage.addInitScript(()=>{window.registeredWorkerURLs=[];const original=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=(url,options)=>{window.registeredWorkerURLs.push(String(url));return original(url,options);};});
  const assets={};for(const asset of ['digital.js','digital.css'])assets[asset]=createHash('sha256').update(await readFile(resolve(root,asset))).digest('hex').slice(0,12);
  const source=await readFile(resolve(root,'digital.js'),'utf8'),version=source.match(/const SERVICE_WORKER_VERSION = '([^']+)'/)[1];
  for(const path of ['index.html','election.html','without-markers.html']){
   await nativePage.goto(nativeBase+path);
   await nativePage.waitForFunction(()=>window.registeredWorkerURLs.length>0);
   await stage(`${path} serviceWorker.ready`,()=>nativePage.evaluate(async()=>{await navigator.serviceWorker.ready;}),WORKER_TIMEOUT_MS);
   await nativePage.waitForFunction(()=>!!navigator.serviceWorker.controller);
   const state=await nativePage.evaluate(()=>({registered:window.registeredWorkerURLs,controller:navigator.serviceWorker.controller.scriptURL,scripts:[...document.scripts].map(s=>s.src).filter(src=>/\/digital\.js\?/.test(src)),styles:[...document.querySelectorAll('link[rel="stylesheet"]')].map(s=>s.href).filter(src=>/\/digital\.css\?/.test(src))}));
   assert.deepEqual(state.scripts,[nativeBase+'digital.js?v='+assets['digital.js']],path+' has exactly one current script');
   assert.deepEqual(state.styles,[nativeBase+'digital.css?v='+assets['digital.css']],path+' has exactly one current stylesheet');
   assert.deepEqual(state.registered,[nativeBase+'sw.js?v='+version],path+' never requests the legacy worker');
   assert.equal(state.controller,nativeBase+'sw.js?v='+version,path+' remains on the current worker');
  }
  await native.close();
 });
}catch(value){const error=value instanceof Error?value:new Error(String(value));report.primaryError={stage:error.stageName??activeStage,error:safeText(error)};if(!error.failureRecorded)report.failures.push({name:error.stageName??activeStage,error:safeText(error)});}
finally{
 if(browser){try{await stage('cleanup Chromium',()=>browser.close(),8000,false);}catch(error){report.cleanupFailures.push({name:'cleanup Chromium',error:safeText(error)});}}
 server.closeAllConnections();
 if(server.listening){try{await stage('cleanup fixture server',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),8000,false);}catch(error){report.cleanupFailures.push({name:'cleanup fixture server',error:safeText(error)});}}
 report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-suiteStartedAt;
 const reportPath=new URL('./results/runtime-maturity/report.json',import.meta.url);
 try{await raceTimeout(async()=>{await mkdir(new URL('./results/runtime-maturity/',import.meta.url),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2));},'persist final report',5000);}catch(error){report.cleanupFailures.push({name:'persist final report',error:safeText(error)});}
 console.log(JSON.stringify(report,null,2));if(report.failures.length||report.cleanupFailures.length)process.exitCode=1;
}
