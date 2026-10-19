/** Verify real embedded Source Han TC rendering across target routes and five viewports. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {withTimeout} from './page-font-artifact-lifecycle.mjs';
import {visibleHanObservationInPage} from './font-rendering-observation.mjs';
import {startStaticServer} from './static-server.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const root=resolve(process.env.ROOT_DIR||repo);
const out=resolve(process.env.EVIDENCE_DIR||'tests/donation/results/font-rendering');
const routes=[
 ['index.html','index','main h1'],
 ['about.html','about','main h1'],
 ['achievements.html','achievements','main h1'],
 ['vision.html','vision','main h1'],
 ['news.html','news','main h1'],
 ['news-20260915-special-education-nurse.html','news-detail','main h1'],
 ['political-donation.html','political-donation','main h1'],
 ['election.html','election','main h1'],
 ['explore.html','explore','#explore-title']
];
const viewports=[
 {width:320,height:568},
 {width:390,height:844},
 {width:768,height:1024},
 {width:1024,height:768},
 {width:1440,height:960}
];
const OBSERVATION_ATTEMPTS=2;
const OBSERVATION_TIMEOUT_MS=15000;
const CLEANUP_TIMEOUT_MS=3000;
const FONT_QUERY_CONCURRENCY=16;
let nextObservationId=0;
let server;
let browser;
let base='';
let active={phase:'startup'};
let primaryError=null;
const report={status:'RUNNING',base:null,root,viewports,routes:[],dynamic:{},errors:[],observationBatches:[],current:null,cleanup:[],measurementConditions:{routeChecks:'Fresh Playwright contexts per route; each viewport waits for networkidle and document.fonts.ready before checking glyphs.',cache:'Same-origin context.route() is used for deterministic content and disables Chromium HTTP cache; those samples represent loaded fonts, not first paint or a warm-cache result.',device:'Viewport emulation only; no iOS or physical device is asserted.'}};

class FontObservationError extends Error{
 constructor(message,details={}){super(message);this.name='FontObservationError';this.details=details;}
}
class FontAssertionFailure extends Error{
 constructor(message,details={}){super(message);this.name='FontAssertionFailure';this.details=details;}
}
function safeDiagnostic(error){
 const name=String(error?.name||'Error').slice(0,80);
 const message=String(error?.message||error||'unknown error').slice(0,1200)
  .replace(/https?:\/\/[^\s"'<>]+/gi,url=>url.replace(/[?#].*$/,''))
  .replace(/\b(token|session|cookie|authorization|csrf|state|code|key)\s*[:=]\s*[^\s,;&]+/gi,'$1=[redacted]')
  .replace(/([?&](?:token|session|cookie|authorization|csrf|state|code|key)=)[^&#\s]*/gi,'$1[redacted]')
  .replace(/[\u0000-\u001f\u007f]/g,' ');
 return `${name}: ${message}`;
}
function diagnosticDetails(details){
 if(!details||typeof details!=='object')return null;
 try{return JSON.parse(JSON.stringify(details,(key,value)=>typeof value==='string'?value.slice(0,300):value));}
 catch{return {unavailable:true};}
}

async function openIsolated(page,url){
 await page.goto(url,{waitUntil:'networkidle'});
 await page.evaluate(()=>document.fonts.ready);
}
async function cdpSession(page){
 const session=await page.context().newCDPSession(page);
 await session.send('DOM.enable');await session.send('CSS.enable');
 return session;
}
async function platformFonts(session,selector){
 try{
  const {root}=await session.send('DOM.getDocument',{depth:1});
  const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector});
  if(!nodeId)throw new FontObservationError('CDP could not resolve the requested rendered node',{operation:'DOM.querySelector',selector});
  const response=await session.send('CSS.getPlatformFontsForNode',{nodeId});
  if(!Array.isArray(response?.fonts))throw new FontObservationError('CDP platform-font response did not include a font list',{operation:'CSS.getPlatformFontsForNode',selector});
  return response.fonts;
 }catch(error){
  if(error instanceof FontObservationError)throw error;
  throw new FontObservationError('CDP platform-font observation failed',{selector,cause:safeDiagnostic(error)});
 }
}
function assertCustomHan(fonts,label){
 if(!Array.isArray(fonts))throw new FontObservationError(label+' returned no platform-font observation',{label});
 if(!fonts.some(font=>font.isCustomFont&&(/Huiwen Sans TC|Huiwen Sans JP Support/.test(font.familyName)))){
  throw new FontAssertionFailure(label+' did not render with an embedded Source Han subset: '+JSON.stringify(fonts),{label,fonts});
 }
}
async function assertEveryHanGlyphCustom(page,session,selector,label){
 const fullFamily=await page.evaluate(()=>{
  const family=document.documentElement.dataset.huiwenFontFullFamily;
  delete document.documentElement.dataset.huiwenFontFullFamily;
  return family||'';
 });
 const glyphs=await page.evaluate(selector=>{
  const han=/\p{Script=Han}/u;
  const matches=[...document.querySelectorAll(selector)],found=[];
  let index=0;
  for(const target of matches){
   const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);
   const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
   for(const node of nodes){
    const text=node.data;
    const positions=[];
    for(let offset=0;offset<text.length;){
     const codepoint=text.codePointAt(offset),character=String.fromCodePoint(codepoint);
     const width=character.length;
     if(han.test(character))positions.push({offset,width,character});
     offset+=width;
    }
    for(const position of positions.reverse()){
     const range=document.createRange();range.setStart(node,position.offset);range.setEnd(node,position.offset+position.width);
     const span=document.createElement('span');span.dataset.pr159FontHan=String(index++);
     range.surroundContents(span);found.push(position.character);
    }
   }
  }
  return found;
 },selector);
 assert(glyphs.length>0,label+' contains no Han glyphs to verify');
 try{
  for(let index=0;index<glyphs.length;index++){
   const selector='[data-pr159-font-han="'+index+'"]';
   await page.locator(selector).scrollIntoViewIfNeeded();
   const fonts=await platformFonts(session,selector);
   assertCustomHan(fonts,label+' Han glyph #'+index);
  }
 }finally{
  await page.evaluate(()=>{
   document.querySelectorAll('[data-pr159-font-han]').forEach(span=>span.replaceWith(document.createTextNode(span.textContent||'')));
  });
  if(fullFamily)await page.evaluate(family=>document.documentElement.dataset.huiwenFontFullFamily=family,fullFamily);
 }
 return glyphs.length;
}
async function platformFontsForNodeIds(session,nodeIds){
 const fonts=new Array(nodeIds.length);
 try{
  for(let start=0;start<nodeIds.length;start+=FONT_QUERY_CONCURRENCY){
   const chunk=nodeIds.slice(start,start+FONT_QUERY_CONCURRENCY);
   const results=await Promise.all(chunk.map(nodeId=>session.send('CSS.getPlatformFontsForNode',{nodeId})));
   results.forEach((result,index)=>{
    if(!Array.isArray(result?.fonts))throw new FontObservationError('CDP batch response did not include a font list',{nodeIndex:start+index});
    fonts[start+index]=result.fonts;
   });
  }
 }catch(error){
  if(error instanceof FontObservationError)throw error;
  throw new FontObservationError('CDP platform-font batch read failed',{cause:safeDiagnostic(error)});
 }
 return fonts;
}
async function visibleHanNodes(page,session,{route,viewport}){
 const attemptDiagnostics=[];
 for(let attempt=1;attempt<=OBSERVATION_ATTEMPTS;attempt++){
  const markerPrefix='font-observation-'+(++nextObservationId)+'-';
  let captured=null;
  let outcome=null;
  let timedOut=false;
  let cleanup=null;
  let validationOnError=null;
  try{
   outcome=await withTimeout((async()=>{
    captured=await page.evaluate(visibleHanObservationInPage,{action:'capture',markerPrefix});
    if(!captured.ok)throw new FontObservationError('visible Han batch could not be captured',{reason:captured.reason});
    if(captured.visibleHanCount===0)throw new FontObservationError('no visible Han text found in the initial viewport',{visibleHanCount:0});
    const selector='[data-font-render-check^="'+markerPrefix+'"]';
    let nodeIds;
    try{
     const {root:documentRoot}=await session.send('DOM.getDocument',{depth:1});
     ({nodeIds}=await session.send('DOM.querySelectorAll',{nodeId:documentRoot.nodeId,selector}));
    }catch(error){throw new FontObservationError('CDP could not query the marked font-observation batch',{operation:'DOM.querySelectorAll',cause:safeDiagnostic(error)});}
    if(!Array.isArray(nodeIds))throw new FontObservationError('CDP batch query did not return node IDs',{operation:'DOM.querySelectorAll'});
    const before=await page.evaluate(visibleHanObservationInPage,{action:'validate',markerPrefix,expectedRows:captured.rows});
    if(!before.stable||nodeIds.length!==captured.rows.length){
     return {stable:false,reason:'batch changed before CDP font reads',nodeCount:nodeIds.length,before};
    }
    const fonts=await platformFontsForNodeIds(session,nodeIds);
    const after=await page.evaluate(visibleHanObservationInPage,{action:'validate',markerPrefix,expectedRows:captured.rows});
    if(!after.stable){
     return {stable:false,reason:'batch changed during CDP font reads',nodeCount:nodeIds.length,before,after};
    }
    return {stable:true,nodeCount:nodeIds.length,before,after,fonts};
   })(),OBSERVATION_TIMEOUT_MS,`visible Han font observation ${route} ${viewport.width}x${viewport.height}`);
  }catch(error){
   timedOut=/exceeded 15000ms/.test(String(error?.message||''));
   if(captured?.rows?.length){
    try{
     validationOnError=await withTimeout(page.evaluate(visibleHanObservationInPage,{action:'validate',markerPrefix,expectedRows:captured.rows}),1500,'visible Han failure diagnostics');
    }catch(validationError){validationOnError={stable:false,diagnosticError:safeDiagnostic(validationError)};}
   }
   outcome={stable:false,reason:timedOut?'host-deadline':error instanceof FontObservationError?'observation-error':'CDP-operation-error',error:safeDiagnostic(error),details:diagnosticDetails(error?.details)};
  }finally{
   try{
    cleanup=await withTimeout(page.evaluate(visibleHanObservationInPage,{action:'cleanup',markerPrefix}),CLEANUP_TIMEOUT_MS,'visible Han marker cleanup');
   }catch(error){cleanup={clean:false,error:safeDiagnostic(error)};}
  }
  const diagnostic={
   route,viewport,attempt,attemptLimit:OBSERVATION_ATTEMPTS,
   status:outcome?.stable?'stable':attempt===OBSERVATION_ATTEMPTS||timedOut?'failed':'retry',
   reason:outcome?.reason||null,
   candidateCount:captured?.visibleHanCount??null,
   candidateElementCount:captured?.candidateElementCount??null,
   cdpNodeCount:outcome?.nodeCount??null,
   before:outcome?.before||null,
   after:outcome?.after||null,
   validationOnError,
   error:outcome?.error||null,
   errorDetails:outcome?.details||null,
   cleanup,
  };
  attemptDiagnostics.push(diagnostic);
  report.observationBatches.push(diagnostic);
  if(!cleanup?.clean){
   throw new FontObservationError('visible Han observation cleanup failed',{route,viewport,attempt,cleanup});
  }
  if(outcome?.stable){
   for(let index=0;index<captured.rows.length;index++){
    const row=captured.rows[index];
    assertCustomHan(outcome.fonts[index],`${route} ${viewport.width}x${viewport.height} visible Han node #${row.index} (${row.tagName})`);
   }
   return captured.visibleHanCount;
  }
  if(attempt===OBSERVATION_ATTEMPTS||timedOut){
   throw new FontObservationError('visible Han observation remained incomplete after bounded sampling',{route,viewport,attempts:attemptDiagnostics});
  }
 }
 throw new FontObservationError('visible Han observation exhausted its bounded samples',{route,viewport,attempts:attemptDiagnostics});
}
function fontResources(page){
 return page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/\.woff2(?:\?|$)/.test(e.name)).map(e=>({url:e.name,transferSize:e.transferSize,decodedBodySize:e.decodedBodySize})));
}
try{
 await mkdir(out,{recursive:true});
 server=await startStaticServer({root,compression:'auto',port:0});
 base=server.url;
 report.base=base;
 browser=await chromium.launch({headless:true});
 for(const [route,slug,h1Selector] of routes){
  active={phase:'route setup',route,slug,viewport:viewports[0]};report.current={...active};
  const routeReport={route,slug,status:'RUNNING',viewports:[]};
  report.routes.push(routeReport);
  const context=await browser.newContext({viewport:viewports[0],reducedMotion:'reduce'});
  await context.route('**/*',request=>new URL(request.request().url()).origin===new URL(base).origin?request.continue():request.abort());
  const page=await context.newPage();page.setDefaultTimeout(15000);
  await page.addInitScript(()=>{window.__layoutShift=0;new PerformanceObserver(list=>{for(const item of list.getEntries())if(!item.hadRecentInput)window.__layoutShift+=item.value}).observe({type:'layout-shift',buffered:true});});
  page.on('pageerror',error=>report.errors.push({route,error:safeDiagnostic(error)}));
  for(const viewport of viewports){
   active={phase:'route viewport setup',route,slug,viewport};report.current={...active};
   await page.setViewportSize(viewport);
   await openIsolated(page,new URL(route,base).href);
   if(!report.environment){report.environment={hostPlatform:process.platform,chromium:browser.version(),headless:true,...await page.evaluate(()=>({navigatorPlatform:navigator.platform,userAgent:navigator.userAgent,devicePixelRatio}))};}
   assert.equal(await page.locator('html').getAttribute('data-huiwen-font-page'),slug);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route+' overflows at '+viewport.width+'px');
   const coreFamily='Huiwen Sans TC '+slug+' Core';
   const family=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'));
   assert(family.includes(coreFamily),route+' did not select its core face at '+viewport.width+'px: '+family);
   const rootFull=await page.evaluate(()=>document.documentElement.dataset.huiwenFontFull);
   assert.equal(rootFull,undefined,route+' upgraded before the first user interaction');
   const session=await cdpSession(page);
   const navSelector=await page.locator('.site-header nav summary').first().isVisible()?'.site-header nav summary':'.menu-toggle';
   for(const selector of ['.brand-name',navSelector,h1Selector]){
    assertCustomHan(await platformFonts(session,selector),route+' '+selector);
   }
   active={phase:'visible Han text font sample',route,slug,viewport};report.current={...active};
   const visibleHanCount=await visibleHanNodes(page,session,{route,viewport});
   active={phase:'font preload and layout checks',route,slug,viewport};report.current={...active};
   if(route==='index.html')await page.screenshot({path:resolve(out,'home-'+viewport.width+'.png')});
   const beforeFonts=await fontResources(page);
   const preloadPath=new URL(await page.locator('link[rel~="preload"][as="font"]').getAttribute('href'),base).pathname;
   assert(beforeFonts.some(entry=>new URL(entry.url).pathname===preloadPath),route+' core preload did not load');
   assert(!beforeFonts.some(entry=>entry.url.includes('huiwen-'+slug+'-full-')),route+' full face loaded before interaction');
   assert(!beforeFonts.some(entry=>entry.url.includes('huiwen-site-sans-tc-20261007.woff2')),route+' loaded the 568 KB global face before interaction');
   const coreCls=await page.evaluate(()=>window.__layoutShift);
   if(route==='explore.html'&&viewport.width===390){
    const relationCount=await page.locator('.explore-related-item strong').count();
    assert(relationCount>0,'explore did not render initial related news/platform links');
    const relationGlyphCount=await assertEveryHanGlyphCustom(page,session,'.explore-related-item strong',route+' initial related links');
    const cardGlyphCount=await assertEveryHanGlyphCustom(page,session,'.explore-result-card:first-child h3',route+' initial default card');

    const village=await page.evaluate(async()=>{
     const records=await(await fetch('data/achievements-public.json')).json();
     return records.find(record=>record.status!=='待核驗'&&record.villages?.length)?.villages[0]||'';
    });
    assert(village,'could not find a public village for a direct-query font check');
    const queryURL=new URL('explore.html',base);queryURL.searchParams.set('type','village');queryURL.searchParams.set('value',village);
    const queryPage=await context.newPage();queryPage.setDefaultTimeout(15000);
    let releaseRecords;const recordsGate=new Promise(resolve=>releaseRecords=resolve);
    await queryPage.route('**/data/achievements-public.json',async route=>{await recordsGate;await route.continue();});
    await queryPage.addInitScript(()=>{
     window.__layoutShift=0;
     new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.__layoutShift+=entry.value}).observe({type:'layout-shift',buffered:true});
    });
    await queryPage.goto(queryURL.href,{waitUntil:'domcontentloaded'});
    try{
     assert.equal(await queryPage.locator('html').getAttribute('data-huiwen-font-page'),'explore');
     assert.equal(await queryPage.locator('html').getAttribute('data-huiwen-font-full'),null,'query-selected Explore view upgraded before interaction');
     assert((await queryPage.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'))).includes('Huiwen Sans TC explore Core'),'query-selected Explore view did not retain its core face');
     assert.equal(await queryPage.locator('#explore-title').innerText(),'探索 '+village,'query-selected title flashed the default topic before data loaded');
     assert.equal(await queryPage.locator('#explore-subtitle').innerText(),'查看 '+village+' 收錄的建設與服務，並延伸到共同主題內容。','query-selected subtitle was not bootstrapped before data loaded');
     assert((await queryPage.locator('#explore-reading-note').innerText()).includes('從 '+village+' 收錄'),'query-selected reading note was not bootstrapped before data loaded');
    }finally{releaseRecords();}
    await queryPage.waitForLoadState('networkidle');
    await queryPage.evaluate(()=>document.fonts.ready);
    const queryCls=await queryPage.evaluate(()=>window.__layoutShift);
    assert(queryCls<0.02,'query-selected Explore initial state shifted by '+queryCls);
    assert.equal(await queryPage.locator('html').getAttribute('data-huiwen-font-page'),'explore');
    assert.equal(await queryPage.locator('html').getAttribute('data-huiwen-font-full'),null,'query-selected Explore view upgraded before interaction');
    assert.equal(await queryPage.locator('#explore-title').innerText(),'探索 '+village,'query-selected village did not remain rendered');
    assert(await queryPage.locator('.explore-result-card h3').count()>0,'query-selected village has no result card to verify');
    const querySession=await cdpSession(queryPage);
    const queryTitleGlyphCount=await assertEveryHanGlyphCustom(queryPage,querySession,'#explore-title','query-selected Explore title');
    const queryCardGlyphCount=await assertEveryHanGlyphCustom(queryPage,querySession,'.explore-result-card:first-child h3','query-selected Explore result card');
    report.dynamic.explore={village,relationLinks:relationCount,relationGlyphCount,defaultCardGlyphCount:cardGlyphCount,queryTitleGlyphCount,queryCardGlyphCount,queryCLS:queryCls,queryURL:queryURL.href};
    await querySession.detach();await queryPage.close();
   }
   await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';scrollTo(0,Math.min(1800,document.documentElement.scrollHeight));});
   await page.waitForFunction(()=>document.documentElement.dataset.huiwenFontFull==='1');
   await page.evaluate(()=>document.fonts.ready);
   const fullFamily='Huiwen Sans TC '+slug+' Full';
   const fullComputed=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'));
   assert(fullComputed.includes(fullFamily),route+' did not switch to its full face after interaction');
   assertCustomHan(await platformFonts(session,h1Selector),route+' full '+h1Selector);
   if(route==='explore.html'){
    assert(await page.locator('.explore-result-card h3').count()>0,'explore did not render its default topic results');
    assertCustomHan(await platformFonts(session,'.explore-result-card h3'),route+' dynamic result card');
   }
   if(viewport.width===320){
    await page.locator('.menu-toggle').click();
    await page.waitForFunction(()=>document.querySelector('.menu-toggle')?.getAttribute('aria-expanded')==='true');
    assertCustomHan(await platformFonts(session,'.site-header nav summary'),route+' expanded mobile navigation');
   }
   const fontsAfter=await fontResources(page);
   assert(fontsAfter.some(entry=>entry.url.includes('huiwen-'+slug+'-full-')),route+' full face request missing');
   const afterCls=await page.evaluate(()=>window.__layoutShift);
   assert(afterCls-coreCls<=0.02,route+' font upgrade shifted layout by '+(afterCls-coreCls));
   if(route==='explore.html'){
    await page.locator('#explore-type').selectOption('village');
    await page.locator('#explore-value').selectOption({index:1});
    await page.locator('.explore-result-card h3').first().waitFor();
    assertCustomHan(await platformFonts(session,'.explore-result-card h3'),route+' village-filtered dynamic result card');
   }
   routeReport.viewports.push({
    ...viewport,visibleHanNodes:visibleHanCount,coreFamily,fullFamily,
    initialFontPaths:beforeFonts.map(entry=>new URL(entry.url).pathname),
    finalFontPaths:fontsAfter.map(entry=>new URL(entry.url).pathname),
    clsBeforeUpgrade:coreCls,clsAfterUpgrade:afterCls,passed:true
   });
   await session.detach();
  }
  await context.close();
  routeReport.status='PASS';
 }

 // A separate cache-preserving probe records first paint before fonts.ready.
 // It uses a fresh context and no Playwright request routing; the optional local
 // throttle only slows transport and does not disable the browser cache.
 active={phase:'cold font first-paint probe',route:'explore.html',viewport:{width:390,height:844}};report.current={...active};
 const coldContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
 const coldPage=await coldContext.newPage();coldPage.setDefaultTimeout(20000);
 await coldPage.addInitScript(()=>{window.__layoutShift=0;new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.__layoutShift+=entry.value}).observe({type:'layout-shift',buffered:true});});
 const coldSession=await cdpSession(coldPage);
 await coldSession.send('Network.enable');
 await coldSession.send('Network.emulateNetworkConditions',{offline:false,latency:120,downloadThroughput:350*1024,uploadThroughput:128*1024,connectionType:'cellular3g'});
 const networkResponses=[];
 coldSession.on('Network.responseReceived',event=>{if(event.response.url.includes('huiwen-explore-core-'))networkResponses.push({url:new URL(event.response.url).pathname,status:event.response.status,fromDiskCache:event.response.fromDiskCache||false,fromServiceWorker:event.response.fromServiceWorker||false,encodedDataLength:event.response.encodedDataLength});});
 const coldURL=new URL('explore.html?type=topic&value='+encodeURIComponent('交通與基建'),base).href;
 await coldPage.goto(coldURL,{waitUntil:'domcontentloaded'});
 await coldPage.waitForFunction(()=>performance.getEntriesByName('first-contentful-paint').length>0,null,{timeout:15000});
 const firstPaint=await coldPage.evaluate(()=>({fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime||null,fontStatus:document.fonts.status,faces:[...document.fonts].filter(face=>face.family.includes('explore Core')).map(face=>({family:face.family,status:face.status,display:face.display})),resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('huiwen-explore-core-')).map(entry=>({name:new URL(entry.name).pathname,transferSize:entry.transferSize,decodedBodySize:entry.decodedBodySize,duration:entry.duration,startTime:entry.startTime}))}));
 const firstPaintFonts=await platformFonts(coldSession,'#explore-title');
 await coldPage.screenshot({path:resolve(out,'explore-cold-first-paint.png')});
 await coldPage.evaluate(()=>document.fonts.ready);
 const loadedFonts=await platformFonts(coldSession,'#explore-title');
 assertCustomHan(loadedFonts,'cold-load Explore title after document.fonts.ready');
 const loaded=await coldPage.evaluate(()=>({fontStatus:document.fonts.status,faces:[...document.fonts].filter(face=>face.family.includes('explore Core')).map(face=>({family:face.family,status:face.status,display:face.display})),resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('huiwen-explore-core-')).map(entry=>({name:new URL(entry.name).pathname,transferSize:entry.transferSize,decodedBodySize:entry.decodedBodySize,duration:entry.duration,startTime:entry.startTime})),cls:window.__layoutShift}));
 assert(loaded.resources.some(entry=>entry.decodedBodySize>0),'cold-load route Core font did not complete a measurable transfer');
 assert(loaded.cls<0.1,'cold font swap caused CLS '+loaded.cls);
 await coldPage.screenshot({path:resolve(out,'explore-cold-font-loaded.png')});
 const coldNetwork=[...networkResponses];
 networkResponses.length=0;
 await coldPage.reload({waitUntil:'domcontentloaded'});
 await coldPage.waitForFunction(()=>performance.getEntriesByName('first-contentful-paint').length>0,null,{timeout:15000});
 const warmFirstPaint=await platformFonts(coldSession,'#explore-title');
 await coldPage.evaluate(()=>document.fonts.ready);
 const warmLoadedFonts=await platformFonts(coldSession,'#explore-title');
 assertCustomHan(warmLoadedFonts,'same-context Explore reload after document.fonts.ready');
 const warm=await coldPage.evaluate(()=>({fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime||null,fontStatus:document.fonts.status,resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('huiwen-explore-core-')).map(entry=>({name:new URL(entry.name).pathname,transferSize:entry.transferSize,decodedBodySize:entry.decodedBodySize,duration:entry.duration,startTime:entry.startTime})),cls:window.__layoutShift}));
 report.coldCacheProbe={route:new URL(coldURL).pathname,conditions:{context:'fresh browser context on initial navigation; no route interception; separate same-context reload; resource throttling configured through CDP',throttle:{latencyMs:120,downloadBytesPerSecond:350*1024,uploadBytesPerSecond:128*1024},firstPaintCapture:'Immediately after first-contentful-paint, before document.fonts.ready',loadedCapture:'After document.fonts.ready; checks the actual platform font for the Explore heading',serverCachePolicy:'public, max-age=0, must-revalidate; the reload is reported as observed and is not presumed to be a cache hit'},firstPaint:{...firstPaint,platformFonts:firstPaintFonts},loaded:{...loaded,platformFonts:loadedFonts,networkResponses:coldNetwork},warmReload:{...warm,firstPaintFonts:warmFirstPaint,loadedFonts:warmLoadedFonts,networkResponses:[...networkResponses]},platform:{hostPlatform:process.platform,chromium:browser.version(),...await coldPage.evaluate(()=>({navigatorPlatform:navigator.platform,userAgent:navigator.userAgent}))}};
 await coldSession.detach();await coldContext.close();

 active={phase:'dynamic search font probe',route:'index.html',viewport:{width:390,height:844}};report.current={...active};
 const dynamicContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await dynamicContext.route('**/*',request=>new URL(request.request().url()).origin===new URL(base).origin?request.continue():request.abort());
 const dynamicPage=await dynamicContext.newPage();dynamicPage.setDefaultTimeout(20000);
 dynamicPage.on('pageerror',error=>report.errors.push({route:'dynamic',error:safeDiagnostic(error)}));
 await openIsolated(dynamicPage,new URL('index.html',base).href);
 await dynamicPage.locator('.menu-toggle').click();
 await dynamicPage.waitForFunction(()=>document.querySelector('.menu-toggle')?.getAttribute('aria-expanded')==='true');
 await dynamicPage.locator('.global-search-trigger').click();
 await dynamicPage.locator('#global-search-dialog').waitFor({state:'visible'});
 await dynamicPage.locator('#global-search-dialog input[type="search"]').fill('文德國小');
 await dynamicPage.locator('.global-search-result').first().waitFor();
 await dynamicPage.evaluate(()=>document.fonts.ready);
 const searchSession=await cdpSession(dynamicPage);
 assertCustomHan(await platformFonts(searchSession,'.global-search-result strong'),'dynamic search result');
 const searchFontPaths=await fontResources(dynamicPage);
 assert(searchFontPaths.some(entry=>entry.url.includes('huiwen-site-sans-tc-20261007.woff2')),'dynamic search did not load the full site face');
 report.dynamic.search={result:await dynamicPage.locator('.global-search-result').first().innerText(),family:await dynamicPage.locator('.global-search-dialog').evaluate(el=>getComputedStyle(el).fontFamily),fontPaths:searchFontPaths.map(entry=>new URL(entry.url).pathname)};

 active={phase:'dynamic map font probe',route:'achievements.html',viewport:{width:390,height:844}};report.current={...active};
 await dynamicPage.goto(new URL('achievements.html?case=wende-school-center',base).href,{waitUntil:'networkidle'});
 await dynamicPage.evaluate(()=>document.fonts.ready);
 await dynamicPage.locator('.map-popup').first().waitFor({state:'visible'});
 await dynamicPage.evaluate(()=>document.fonts.ready);
 const mapSession=await cdpSession(dynamicPage);
 assertCustomHan(await platformFonts(mapSession,'.map-popup'),'dynamic map popup');
 report.dynamic.map={popup:(await dynamicPage.locator('.map-popup').first().innerText()).slice(0,160),family:await dynamicPage.locator('.map-popup').first().evaluate(el=>getComputedStyle(el).fontFamily),fontPaths:(await fontResources(dynamicPage)).map(entry=>new URL(entry.url).pathname)};

 active={phase:'legal page font probe',route:'terms.html',viewport:{width:390,height:844}};report.current={...active};
 await dynamicPage.goto(new URL('terms.html',base).href,{waitUntil:'networkidle'});
 await dynamicPage.evaluate(()=>document.fonts.ready);
 const legalSession=await cdpSession(dynamicPage);
 assertCustomHan(await platformFonts(legalSession,'.terms-content h2'),'legal text');
 report.dynamic.legal={heading:await dynamicPage.locator('.terms-content h2').first().innerText(),family:await dynamicPage.locator('.terms-content h2').first().evaluate(el=>getComputedStyle(el).fontFamily),fontPaths:(await fontResources(dynamicPage)).map(entry=>new URL(entry.url).pathname)};
 await searchSession.detach();await mapSession.detach();await legalSession.detach();await dynamicContext.close();
 assert.deepEqual(report.errors,[]);
}catch(error){
 primaryError=error;
 report.status='FAIL';
 const trusted=error instanceof FontObservationError||error instanceof FontAssertionFailure;
 report.failure={
  name:String(error?.name||'Error').slice(0,80),
  message:trusted?safeDiagnostic(error):`failure during ${active.phase}`,
  context:{...active},
  details:trusted?diagnosticDetails(error?.details):null,
 };
 const currentRouteReport=[...report.routes].reverse().find(item=>item.route===active.route&&item.status==='RUNNING');
 if(currentRouteReport){currentRouteReport.status='FAIL';currentRouteReport.failure=report.failure.message;}
}finally{
 for(const [resource,value] of [['browser',browser],['staticServer',server]]){
  if(!value){report.cleanup.push({resource,status:'not-started'});continue;}
  try{
   await withTimeout(value.close(),5000,`${resource} cleanup`);
   report.cleanup.push({resource,status:'closed'});
  }catch(error){
   report.cleanup.push({resource,status:'failed',error:safeDiagnostic(error)});
   if(!primaryError)primaryError=new FontObservationError('font-rendering cleanup failed',{resource,error:safeDiagnostic(error)});
  }
 }
 if(primaryError){
  report.status='FAIL';
  if(!report.failure){
   report.failure={name:String(primaryError?.name||'Error').slice(0,80),message:safeDiagnostic(primaryError),context:{...active},details:diagnosticDetails(primaryError?.details)};
  }
 }else{
  report.status='PASS';
  report.current=null;
 }
 try{
  await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
 }catch(error){
  if(!primaryError)primaryError=new FontObservationError('font-rendering report could not be saved',{path:'report.json',error:safeDiagnostic(error)});
 }
}
if(primaryError)throw primaryError;
console.log(JSON.stringify({status:'PASS',routeCount:report.routes.length,viewportCount:viewports.length,checks:report.routes.map(item=>({route:item.route,viewports:item.viewports.length,visibleHan:item.viewports.map(v=>v.visibleHanNodes)})),dynamic:report.dynamic},null,2));
