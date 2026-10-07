/** Verify real embedded Source Han TC rendering across target routes and five viewports. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {startStaticServer} from './static-server.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const root=resolve(process.env.ROOT_DIR||repo);
const out=resolve(process.env.EVIDENCE_DIR||'/tmp/huiwen-font-rendering');
const routes=[
 ['index.html','index','main h1'],
 ['about.html','about','main h1'],
 ['achievements.html','achievements','main h1'],
 ['vision.html','vision','main h1'],
 ['news.html','news','main h1'],
 ['news-20260915-special-education-nurse.html','news-detail','main h1'],
 ['political-donation.html','political-donation','main h1'],
 ['election.html','election','main h1']
];
const viewports=[
 {width:320,height:568},
 {width:390,height:844},
 {width:768,height:1024},
 {width:1024,height:768},
 {width:1440,height:960}
];
await mkdir(out,{recursive:true});
const server=await startStaticServer({root,compression:'auto',port:0});
const base=server.url;
const browser=await chromium.launch({headless:true});
const report={base,root,viewports,routes:[],dynamic:{},errors:[]};

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
 const {root}=await session.send('DOM.getDocument',{depth:-1});
 const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector});
 assert(nodeId,'missing rendered node: '+selector);
 return (await session.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
}
function assertCustomHan(fonts,label){
 assert(
  fonts.some(font=>font.isCustomFont&&(/Huiwen Sans TC|Huiwen Sans JP Support/.test(font.familyName))),
  label+' did not render with an embedded Source Han subset: '+JSON.stringify(fonts)
 );
}
async function visibleHanNodes(page,session){
 const rows=await page.evaluate(()=>{
  const pattern=/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u,found=[];
  for(const element of document.querySelectorAll('body *')){
   if(element.closest('[aria-hidden="true"]'))continue;
   const closedDetails=element.closest('details:not([open])');if(closedDetails&&!element.matches('summary'))continue;
   const text=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join(' ').trim();
   if(!text||!pattern.test(text))continue;
   const style=getComputedStyle(element),rect=element.getBoundingClientRect();
   if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||style.clipPath!=='none'||(style.clip!=='auto'&&style.clip!=='none')||rect.width<=2||rect.height<=2||rect.bottom<=0||rect.top>=innerHeight)continue;
   const index=String(found.length);element.setAttribute('data-font-render-check',index);
   found.push({index,text:text.slice(0,90),selector:element.tagName.toLowerCase()+(element.id?'#'+element.id:'')});
  }
  return found;
 });
 assert(rows.length>0,'no visible CJK text found in the initial viewport');
 for(const row of rows){
  const selector='[data-font-render-check="'+row.index+'"]';
  const fonts=await platformFonts(session,selector);
  assertCustomHan(fonts,row.selector+': '+row.text);
 }
 await page.evaluate(()=>document.querySelectorAll('[data-font-render-check]').forEach(el=>el.removeAttribute('data-font-render-check')));
 return rows.length;
}
function fontResources(page){
 return page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/\.woff2(?:\?|$)/.test(e.name)).map(e=>({url:e.name,transferSize:e.transferSize,decodedBodySize:e.decodedBodySize})));
}
try{
 for(const [route,slug,h1Selector] of routes){
  const context=await browser.newContext({viewport:viewports[0],reducedMotion:'reduce'});
  await context.route('**/*',request=>new URL(request.request().url()).origin===new URL(base).origin?request.continue():request.abort());
  const page=await context.newPage();page.setDefaultTimeout(15000);
  await page.addInitScript(()=>{window.__layoutShift=0;new PerformanceObserver(list=>{for(const item of list.getEntries())if(!item.hadRecentInput)window.__layoutShift+=item.value}).observe({type:'layout-shift',buffered:true});});
  page.on('pageerror',error=>report.errors.push(route+': '+String(error)));
  const routeReport={route,slug,viewports:[]};
  for(const viewport of viewports){
   await page.setViewportSize(viewport);
   await openIsolated(page,new URL(route,base).href);
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
   const visibleHanCount=await visibleHanNodes(page,session);
   if(route==='index.html')await page.screenshot({path:resolve(out,'home-'+viewport.width+'.png')});
   const beforeFonts=await fontResources(page);
   const preloadPath=new URL(await page.locator('link[rel~="preload"][as="font"]').getAttribute('href'),base).pathname;
   assert(beforeFonts.some(entry=>new URL(entry.url).pathname===preloadPath),route+' core preload did not load');
   assert(!beforeFonts.some(entry=>entry.url.includes('huiwen-'+slug+'-full-')),route+' full face loaded before interaction');
   assert(!beforeFonts.some(entry=>entry.url.includes('huiwen-site-sans-tc-20261007.woff2')),route+' loaded the 568 KB global face before interaction');
   const coreCls=await page.evaluate(()=>window.__layoutShift);
   await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';scrollTo(0,Math.min(1800,document.documentElement.scrollHeight));});
   await page.waitForFunction(()=>document.documentElement.dataset.huiwenFontFull==='1');
   await page.evaluate(()=>document.fonts.ready);
   const fullFamily='Huiwen Sans TC '+slug+' Full';
   const fullComputed=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'));
   assert(fullComputed.includes(fullFamily),route+' did not switch to its full face after interaction');
   assertCustomHan(await platformFonts(session,h1Selector),route+' full '+h1Selector);
   if(viewport.width===320){
    await page.locator('.menu-toggle').click();
    await page.waitForFunction(()=>document.querySelector('.menu-toggle')?.getAttribute('aria-expanded')==='true');
    assertCustomHan(await platformFonts(session,'.site-header nav summary'),route+' expanded mobile navigation');
   }
   const fontsAfter=await fontResources(page);
   assert(fontsAfter.some(entry=>entry.url.includes('huiwen-'+slug+'-full-')),route+' full face request missing');
   const afterCls=await page.evaluate(()=>window.__layoutShift);
   assert(afterCls-coreCls<=0.02,route+' font upgrade shifted layout by '+(afterCls-coreCls));
   routeReport.viewports.push({
    ...viewport,visibleHanNodes:visibleHanCount,coreFamily,fullFamily,
    initialFontPaths:beforeFonts.map(entry=>new URL(entry.url).pathname),
    finalFontPaths:fontsAfter.map(entry=>new URL(entry.url).pathname),
    clsBeforeUpgrade:coreCls,clsAfterUpgrade:afterCls,passed:true
   });
   await session.detach();
  }
  report.routes.push(routeReport);
  await context.close();
 }

 const dynamicContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await dynamicContext.route('**/*',request=>new URL(request.request().url()).origin===new URL(base).origin?request.continue():request.abort());
 const dynamicPage=await dynamicContext.newPage();dynamicPage.setDefaultTimeout(20000);
 dynamicPage.on('pageerror',error=>report.errors.push('dynamic: '+String(error)));
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

 await dynamicPage.goto(new URL('achievements.html',base).href,{waitUntil:'networkidle'});
 await dynamicPage.evaluate(()=>document.fonts.ready);
 await dynamicPage.locator('[data-view="both"]').click();
 await dynamicPage.locator('.leaflet-marker-icon').first().waitFor();
 await dynamicPage.locator('.leaflet-marker-icon').first().scrollIntoViewIfNeeded();
 await dynamicPage.locator('.leaflet-marker-icon').first().click({force:true});
 await dynamicPage.locator('.map-popup').first().waitFor({state:'visible'});
 await dynamicPage.evaluate(()=>document.fonts.ready);
 const mapSession=await cdpSession(dynamicPage);
 assertCustomHan(await platformFonts(mapSession,'.map-popup'),'dynamic map popup');
 report.dynamic.map={popup:(await dynamicPage.locator('.map-popup').first().innerText()).slice(0,160),family:await dynamicPage.locator('.map-popup').first().evaluate(el=>getComputedStyle(el).fontFamily),fontPaths:(await fontResources(dynamicPage)).map(entry=>new URL(entry.url).pathname)};

 await dynamicPage.goto(new URL('terms.html',base).href,{waitUntil:'networkidle'});
 await dynamicPage.evaluate(()=>document.fonts.ready);
 const legalSession=await cdpSession(dynamicPage);
 assertCustomHan(await platformFonts(legalSession,'.terms-content h2'),'legal text');
 report.dynamic.legal={heading:await dynamicPage.locator('.terms-content h2').first().innerText(),family:await dynamicPage.locator('.terms-content h2').first().evaluate(el=>getComputedStyle(el).fontFamily),fontPaths:(await fontResources(dynamicPage)).map(entry=>new URL(entry.url).pathname)};
 await searchSession.detach();await mapSession.detach();await legalSession.detach();await dynamicContext.close();
 assert.deepEqual(report.errors,[]);
 console.log(JSON.stringify({status:'PASS',routeCount:report.routes.length,viewportCount:viewports.length,checks:report.routes.map(item=>({route:item.route,viewports:item.viewports.length,visibleHan:item.viewports.map(v=>v.visibleHanNodes)})),dynamic:report.dynamic},null,2));
}finally{
 await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
 await browser.close();await server.close();
}
