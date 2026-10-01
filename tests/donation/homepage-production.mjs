import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=root+'tests/donation/results/homepage-production/';
await mkdir(out,{recursive:true});
const live=process.env.HOME_LIVE_URL;
assert(!live||live==='https://www.huiwen.tw/');
const base=live||'http://127.0.0.1:8778/';
const server=live?null:spawn('python3',['-m','http.server','8778','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const config=JSON.parse(await readFile(root+'data/civic-home.json','utf8'));
const ids=[config.featured,...config.reading];
const schedule=JSON.parse(await readFile(root+'data/legal-schedule.json','utf8'));
const event=JSON.parse(await readFile(root+'data/events.json','utf8')).events.find(e=>e.id==='campaign-headquarters-opening-2026-10-31');
const browser=await chromium.launch(),report={base,checks:[],errors:[]};
try{
 if(!live)for(let n=0;n<60;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [320,390,768,1440]){
  const ctx=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce'});
  await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  for(const img of await page.locator('main img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate(el=>el.decode());}
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.locator('.hero-actions a.primary').getAttribute('href'),'https://line.me/R/ti/p/@yve2766q');
  assert.equal(await page.locator('main a[href="service.html#monthly-heading"]').count(),1);
  assert.equal(await page.locator('main [data-home-legal-month]').getAttribute('data-home-legal-month'),schedule.month);
  assert.deepEqual(await page.locator('.civic-story-grid [data-record-id]').evaluateAll(xs=>xs.map(x=>x.dataset.recordId)),ids);
  assert.doesNotMatch(await page.locator('main').innerText(),/八德|預覽|試作|示意|待核/);
  for(const text of ['6,035.7','2,610.71','3,424.99','林岱樺'])assert((await page.locator('.civic-feature').innerText()).includes(text));
  assert.equal(await page.locator('[data-home-event] time').getAttribute('datetime'),event.start);
  assert((await page.locator('[data-home-event]').innerText()).includes(event.location));
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:out+`home-${width}-top.png`});
  await page.screenshot({path:out+`home-${width}-full.png`,fullPage:true});
  if([390,1440].includes(width))for(const [key,selector] of [['stories','.civic-story-grid'],['map','#map'],['event','#opening'],['contact','#contact']])await page.locator(selector).screenshot({path:out+`home-${width}-${key}.png`});
  await page.getByRole('button',{name:'教育與文化',exact:true}).click();assert.equal(await page.locator('.place:visible').count(),1);
  await page.getByRole('button',{name:'交通與基建',exact:true}).click();assert.equal(await page.locator('.place:visible').count(),4);
  await page.locator('#civic-query').fill('成立大會');await page.locator('.civic-search button').click();
  await page.locator('#global-search-dialog').waitFor({state:'visible'});await page.locator('.global-search-result').first().waitFor();
  assert((await page.locator('.global-search-result').allTextContents()).some(t=>t.includes('成立大會')));
  await page.keyboard.press('Escape');
  const lawyer=page.locator('main a[href="service.html#monthly-heading"]');await lawyer.focus();
  await Promise.all([page.waitForURL(url=>url.pathname.endsWith('/service.html')&&url.hash==='#monthly-heading'),page.keyboard.press('Enter')]);
  await page.locator('[data-legal-calendar]').waitFor({state:'visible'});
  await page.goto(base);await page.addStyleTag({content:'html{font-size:200%!important}'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  report.checks.push({width,sourceParity:'PASS',accessibility:'PASS',reflow:'PASS',search:'PASS',lawyerKeyboardEntry:'PASS'});
  await ctx.close();
 }
 const ctx=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),page=await ctx.newPage();
 await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 await page.goto(base);assert.equal(await page.locator('main a[href="service.html#monthly-heading"]').count(),1);assert((await page.locator('[data-home-event]').innerText()).includes(event.name));assert.equal(await page.locator('.place').count(),5);await ctx.close();
 assert.deepEqual(report.errors,[]);
}finally{await writeFile(out+'report.json',JSON.stringify(report,null,2));await browser.close();server?.kill();}
