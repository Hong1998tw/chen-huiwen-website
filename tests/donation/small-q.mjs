import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=process.env.BASE_URL||'http://127.0.0.1:8788/';
const server=process.env.BASE_URL?null:spawn('python3',['-m','http.server','8788','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const out=new URL('./results/small-q/',import.meta.url);
await mkdir(out,{recursive:true});
const report={checks:[],failures:[],pageErrors:[]};
const browser=await chromium.launch();
async function check(name,fn){try{await fn();report.checks.push(name);}catch(e){report.failures.push({name,error:String(e)});}}
try{
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
for(const width of [320,390,768,1440]){
 const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'no-preference'});
 const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(String(e)));
 await page.goto(base);await page.locator('#small-q').waitFor({state:'visible'});
 await check(width+' fits viewport',async()=>{assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const b=await page.locator('#small-q').boundingBox();assert(b.x>=0&&b.x+b.width<=width);if(width>780)assert(b.y+b.height<=844);});
 await check(width+' all five poses and repeated click',async()=>{
  await page.locator('.small-q-toggle').click();
  for(const key of ['idle','wave','nod','happy','guide','guide']){
   await page.locator('[data-q-action="'+key+'"]').click();
   await page.waitForFunction(k=>document.querySelector('#small-q').dataset.action===k,key);
   assert.equal(await page.locator('[data-q-action][aria-pressed=true]').count(),1);
   assert((await page.locator('#small-q img').getAttribute('src')).endsWith('/'+key+'.webp'));
  }
 });
 await check(width+' pause resume and escape focus',async()=>{
  await page.locator('.small-q-pause').click();assert.equal(await page.locator('#small-q').getAttribute('data-paused'),'true');
  await page.locator('.small-q-pause').click();assert.equal(await page.locator('#small-q').getAttribute('data-paused'),'false');
  await page.keyboard.press('Escape');assert(await page.locator('#small-q-panel').isHidden());assert(await page.locator('.small-q-toggle').evaluate(e=>e===document.activeElement));
 });
 await check(width+' collapse and restore',async()=>{await page.locator('.small-q-hide').click();assert(await page.locator('.small-q-figure').isHidden());await page.locator('.small-q-toggle').click();assert(await page.locator('.small-q-figure').isVisible());});
 if(width<=620)await check(width+' service bar stays clear',async()=>{const a=await page.locator('#small-q').boundingBox(),b=await page.locator('.home-redesign .services').boundingBox();assert(a.y+a.height<=b.y);assert.equal(await page.locator('#small-q').evaluate(e=>getComputedStyle(e).position),'relative');});
 if(width<=780)await check(width+' navigation hides companion',async()=>{await page.locator('.menu-toggle').click();assert(await page.locator('#small-q').isHidden());await page.keyboard.press('Escape');assert(await page.locator('#small-q').isVisible());});
 await page.screenshot({path:fileURLToPath(new URL(width+'-home.png',out))});
 await context.close();
}
await check('reduced motion retains manual pose selection',async()=>{const c=await browser.newContext({reducedMotion:'reduce'}),p=await c.newPage();await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});await p.locator('.small-q-toggle').click();assert(await p.locator('.small-q-pause').isDisabled());await p.locator('[data-q-action=happy]').click();await p.waitForFunction(()=>document.querySelector('#small-q').dataset.action==='happy');assert.equal(await p.locator('#small-q img').evaluate(e=>getComputedStyle(e).animationName),'none');await c.close();});
await check('without JavaScript content works and companion is absent',async()=>{const c=await browser.newContext({javaScriptEnabled:false}),p=await c.newPage();await p.goto(base);assert(await p.locator('h1').isVisible());assert(await p.locator('#small-q').isHidden());await c.close();});
await check('other pages unchanged',async()=>{const p=await browser.newPage();await p.goto(new URL('about.html',base).href);assert.equal(await p.locator('#small-q').count(),0);assert.equal(await p.locator('script[src*="small-q"]').count(),0);await p.close();});
}finally{await browser.close();server?.kill();await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));if(report.failures.length||report.pageErrors.length)process.exitCode=1;
