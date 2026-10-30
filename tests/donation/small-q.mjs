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
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.failures.push({name,error:String(e)});}}
const state=(page,key)=>page.waitForFunction(k=>document.querySelector('#small-q')?.dataset.action===k,key,{timeout:8000});
const waitReady=async page=>page.locator('#small-q-toggle').waitFor({state:'visible'});
try{
 for(let i=0;i<50;i++){try{if((await fetch(base,{method:"HEAD"})).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [320,390,768,1440]){
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'no-preference'});
  const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(String(e)));
  await page.goto(base);await page.locator('#small-q').waitFor({state:'visible'});await waitReady(page);
  const launcher=page.locator('#small-q-toggle'),panel=page.locator('#small-q-panel');
  await check(width+' hidden character until explicit open',async()=>{
   assert.equal(await launcher.getAttribute('aria-expanded'),'false');
   assert.equal(await launcher.getAttribute('aria-label'),'展開小 Q 卡通角色');
   assert(await panel.isHidden());
   assert.equal(await page.locator('#small-q-figure').getAttribute('src'),null);
   const box=await launcher.boundingBox();assert.equal(box.width,56);assert.equal(box.height,56);
  });
  await check(width+' fixed position and no content reflow',async()=>{
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.equal(await page.locator('#small-q').evaluate(el=>getComputedStyle(el).position),'fixed');
   const box=await launcher.boundingBox();assert(box.x>=0&&box.x+box.width<=width);assert(box.y>=0&&box.y+box.height<=844);
  });
  await launcher.focus();await page.keyboard.press('Enter');await panel.waitFor({state:'visible'});
  await page.locator('#small-q-figure').evaluate(el=>el.decode());
  await check(width+' keyboard open shows labelled character and wave',async()=>{
   assert.equal(await launcher.getAttribute('aria-expanded'),'true');
   assert.equal(await launcher.getAttribute('aria-label'),'收合小 Q 卡通角色');
   assert.equal(await page.locator('#small-q-panel').getAttribute('role'),'region');
   assert.equal(await page.locator('#small-q-figure').getAttribute('alt'),'陳慧文的小 Q AI 卡通形象');
   assert.equal(await launcher.evaluate(el=>el===document.activeElement),true,'focus stays on the launcher after opening');
   await state(page,'wave');await state(page,'idle');
   assert.equal(await page.locator('#small-q-figure').evaluate(el=>getComputedStyle(el).animationName),'none');
  });
  if(width===390||width===1440)await page.screenshot({path:fileURLToPath(new URL(width+'-open.png',out))});
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  await check(width+' Escape closes and restores focus',async()=>{
   assert.equal(await launcher.getAttribute('aria-expanded'),'false');
   assert.equal(await launcher.evaluate(el=>el===document.activeElement),true);
  });
  await launcher.click();await panel.waitFor({state:'visible'});
  await page.locator('.small-q-close').click();await panel.waitFor({state:'hidden'});
  await check(width+' close control returns focus to launcher',async()=>{
   assert.equal(await launcher.getAttribute('aria-expanded'),'false');
   assert.equal(await launcher.evaluate(el=>el===document.activeElement),true);
   assert.equal(await page.locator('#small-q-panel button').count(),1);
   assert.equal(await page.locator('#small-q form, #small-q [data-q-action]').count(),0);
  });
  if(width===390||width===1440)await page.screenshot({path:fileURLToPath(new URL(width+'-closed.png',out))});
  await context.close();
 }

 await check('mobile menu and search Escape keep their focus return when Small Q is already open',async()=>{
  const c=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),p=await c.newPage();
  await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});await waitReady(p);
  const qToggle=p.locator('#small-q-toggle'),panel=p.locator('#small-q-panel'),menu=p.locator('.menu-toggle');
  await qToggle.click();await panel.waitFor({state:'visible'});
  await menu.click();await p.locator('#navigation.is-open').waitFor();
  await p.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('aria-expanded'),'false');
  assert.equal(await menu.evaluate(el=>el===document.activeElement),true,'menu Escape returns focus to its toggle');
  assert.equal(await qToggle.getAttribute('aria-expanded'),'true');
  assert(await panel.isVisible(),'menu Escape leaves the already-open companion available');

  await menu.click();await p.locator('#navigation.is-open').waitFor();
  const search=p.locator('.global-search-trigger').first();
  await search.click();await p.locator('#global-search-dialog[open]').waitFor();
  assert(await search.isHidden(),'the mobile search trigger is hidden after its menu closes for the modal');
  await p.keyboard.press('Escape');await p.locator('#global-search-dialog').waitFor({state:'hidden'});
  await p.waitForFunction(()=>{
   const dialog=document.querySelector('#global-search-dialog'),toggle=document.querySelector('.menu-toggle');
   return Boolean(dialog&&!dialog.open&&!document.body.classList.contains('search-open')&&
    toggle?.getAttribute('aria-expanded')==='false'&&document.activeElement===toggle);
  },null,{timeout:8000});
  assert.equal(await menu.getAttribute('aria-expanded'),'false');
  assert.equal(await menu.evaluate(el=>el===document.activeElement),true,'search Escape returns focus to the visible menu toggle after its menu closes');
  assert.equal(await qToggle.getAttribute('aria-expanded'),'true');
  assert(await panel.isVisible(),'search Escape does not close or refocus Small Q');
  await c.close();
 });

 await check('opened desktop context gestures stay finite and require explicit opening',async()=>{
  const c=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'no-preference'}),p=await c.newPage();
  await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});await waitReady(p);
  assert(await p.locator('#small-q-panel').isHidden());
  await p.locator('#small-q-toggle').click();await p.locator('#small-q-panel').waitFor({state:'visible'});await state(p,'wave');await state(p,'idle');
  await p.waitForTimeout(12200);await p.locator('#progress').scrollIntoViewIfNeeded();await state(p,'guide');await state(p,'idle');
  await p.waitForTimeout(12200);await p.locator('#home-village').selectOption('v:文德里');await state(p,'nod');await state(p,'idle');
  await p.waitForTimeout(12200);await p.locator('#contact').scrollIntoViewIfNeeded();await state(p,'happy');await state(p,'idle');
  await c.close();
 });

 await check('reduced motion remains static after explicit open',async()=>{
  const c=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),p=await c.newPage();
  await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});await waitReady(p);
  assert(await p.locator('#small-q-panel').isHidden());
  await p.locator('#small-q-toggle').click();await p.locator('#small-q-panel').waitFor({state:'visible'});
  await p.locator('#small-q-figure').evaluate(el=>el.decode());
  assert.equal(await p.locator('#small-q').getAttribute('data-action'),'idle');
  assert.equal(await p.locator('#small-q-figure').evaluate(el=>getComputedStyle(el).animationName),'none');
  await p.locator('#progress').scrollIntoViewIfNeeded();await p.locator('#home-village').selectOption('v:文德里');
  assert.equal(await p.locator('#small-q').getAttribute('data-action'),'idle');await c.close();
 });

 await check('without JavaScript the launcher and character are absent, site content stays available',async()=>{
  const c=await browser.newContext({javaScriptEnabled:false}),p=await c.newPage();await p.goto(base);
  assert(await p.locator('h1').isVisible());assert(await p.locator('#small-q').isHidden());await c.close();
 });

 await check('idle image failure keeps the panel closed and permits retry',async()=>{
  const c=await browser.newContext(),p=await c.newPage();
  await p.route('**/assets/small-q/**',r=>r.abort());await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});await waitReady(p);
  await p.locator('#small-q-toggle').click();await p.waitForTimeout(300);
  assert(await p.locator('#small-q-panel').isHidden());assert.equal(await p.locator('#small-q-toggle').getAttribute('aria-expanded'),'false');
  assert(await p.locator('#small-q-toggle').isVisible());assert(await p.locator('h1').isVisible());await c.close();
 });

 await check('non-home routes exclude the companion',async()=>{
  const p=await browser.newPage();await p.goto(new URL('about.html',base).href);
  assert.equal(await p.locator('#small-q').count(),0);assert.equal(await p.locator('script[src*="small-q"]').count(),0);await p.close();
 });
}finally{
 await browser.close();server?.kill();
 await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));
if(report.failures.length||report.pageErrors.length)process.exitCode=1;
