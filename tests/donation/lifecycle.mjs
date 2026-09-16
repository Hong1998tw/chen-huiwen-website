/** Supplemental resilience and negative gates; no external provider calls. */
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const output=new URL('./results/lifecycle.json',import.meta.url);
const mime={'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{try{let p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+sep))throw Error();const data=await readFile(p);res.writeHead(200,{'Content-Type':mime[extname(p)]||'application/octet-stream'}).end(data);}catch{res.writeHead(404).end('Not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch();const report={browser:browser.version(),observed_at:new Date().toISOString(),method:'Local actual source; external requests blocked; synthetic negative fixtures',checks:[]};
async function localContext(options){const ctx=await browser.newContext(options);await ctx.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());return ctx;}
async function check(id,fn){console.log('start '+id);try{await fn();report.checks.push({id,status:'PASS'});}catch(e){report.checks.push({id,status:'FAIL',reason:String(e)});}}
async function geometry(page){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'MOBILE_OVERFLOW');}
async function a11y(page){const r=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();assert.equal(r.violations.length,0,'A11Y_VIOLATION');}
try{
 const ctx=await localContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 const page=await ctx.newPage();page.setDefaultTimeout(8000);
 await check('negative-mobile-overflow',async()=>{await page.setContent('<!doctype html><html lang="en"><title>Fixture</title><body><main style="width:1500px">Fixture</main></body></html>');await assert.rejects(()=>geometry(page),/MOBILE_OVERFLOW/);});
 await check('negative-accessible-name',async()=>{await page.setContent('<!doctype html><html lang="en"><title>Fixture</title><body><main><h1>Fixture</h1><button></button></main></body></html>');await assert.rejects(()=>a11y(page),/A11Y_VIOLATION/);});
 await check('reduced-motion-and-menu-cancellation',async()=>{
  await page.goto(base+'index.html');
  const toggle=page.locator('.menu-toggle');
  for(let i=0;i<3;i++){await toggle.click();await page.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('main').evaluate(x=>x.inert),false);}
  assert(await toggle.evaluate(x=>x===document.activeElement));await geometry(page);
 });
 await check('search-index-failure-fallback',async()=>{
  await page.route('**/data/search-index.json*',r=>r.abort());await page.reload();await page.keyboard.press('Control+k');await page.locator('#global-search-dialog input').fill('服務');
  await page.locator('.global-search-result').first().waitFor();assert((await page.locator('.global-search-result').count())>0);await page.keyboard.press('Escape');await page.unroute('**/data/search-index.json*');
 });
 await check('search-normalization-and-zero-state',async()=>{
  await page.reload();await page.keyboard.press('Control+k');const input=page.locator('#global-search-dialog input');await input.fill('臺');await page.waitForTimeout(300);const a=await page.locator('.global-search-result').allTextContents();await input.fill('台');await page.waitForTimeout(300);assert.deepEqual(await page.locator('.global-search-result').allTextContents(),a);
  await input.fill('不存在的資料'.repeat(80));await page.waitForTimeout(300);assert.equal(await page.locator('.global-search-result').count(),0);await geometry(page);await page.keyboard.press('Escape');
 });
 await check('timeline-visible-with-inactive-observer',async()=>{
  const c=await localContext({viewport:{width:390,height:844}});await c.addInitScript(()=>{window.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};});const p=await c.newPage();await p.goto(base+'achievement-wende-school-center.html');const items=p.locator('.case-timeline > li');assert((await items.count())>0);assert(await items.evaluateAll(xs=>xs.every(x=>getComputedStyle(x).opacity!=='0'&&getComputedStyle(x).visibility!=='hidden')));await c.close();
 });
 await check('image-failure-keeps-service-entry',async()=>{await page.route('**/assets/**',r=>r.abort());await page.goto(base+'index.html');assert((await page.locator('a[href="tel:+88678212536"]').count())>0);await geometry(page);await page.unroute('**/assets/**');});
 await ctx.close();
 for(const width of [320,390,768,1280,1440])await check('no-js-reflow-'+width,async()=>{
  const c=await localContext({javaScriptEnabled:false,viewport:{width,height:844}});const p=await c.newPage();for(const f of ['index.html','news.html','achievements.html','gallery.html','service.html','activities.html']){await p.goto(base+f);await geometry(p);assert((await p.locator('main').innerText()).trim().length>50);}await c.close();
 });
}finally{await browser.close();await new Promise(r=>server.close(r));}
await mkdir(new URL('./results/',import.meta.url),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.checks.some(x=>x.status==='FAIL'))process.exitCode=1;
