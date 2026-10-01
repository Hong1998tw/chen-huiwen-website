import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const out=fileURLToPath(new URL('./results/events/',import.meta.url));
await mkdir(out,{recursive:true});
const base='http://127.0.0.1:8771/';
const server=spawn('python3',['-m','http.server','8771','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const browser=await chromium.launch();
const report={checks:[],downloads:[],errors:[]};
const events=JSON.parse(await readFile(root+'data/events.json','utf8')).events;
const opening=events.find(e=>e.id==='campaign-headquarters-opening-2026-10-31');
assert(opening && opening.end===null);
try{
 for(let i=0;i<60;i++){try{if((await fetch(base+'activities.html')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [320,390,768,1440]){
  const context=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce',acceptDownloads:true});
  await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(base+'activities.html#event-'+opening.id);
  const card=page.locator('#event-'+opening.id);
  assert.equal(await page.locator('.event-card').count(),events.length);
  assert((await card.innerText()).includes('2026/10/31（六）15:50'));
  assert((await card.innerText()).includes('高雄市鳳山區錦田路231號'));
  assert((await card.innerText()).includes('07-821-2536'));
  assert.equal(await card.locator('a[href*="calendar.google.com"]').count(),0);
  assert.equal(await page.locator('#event-council-general-interpellation-2026-10-08 a[href*="calendar.google.com"]').count(),1);
  await card.locator('img').last().scrollIntoViewIfNeeded();
  assert(await card.locator('img').evaluateAll(images=>images.every(img=>img.complete && img.naturalWidth===Number(img.getAttribute('width')) && img.naturalHeight===Number(img.getAttribute('height')))));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(a11y.violations.map(x=>({id:x.id,targets:x.nodes.map(n=>n.target)})),[]);
  for(const image of opening.images){
   const link=card.locator('a[download]').filter({hasText:image.caption});
   await link.focus();assert(await link.evaluate(el=>el===document.activeElement));
   const pending=page.waitForEvent('download');await page.keyboard.press('Enter');
   const download=await pending;assert.deepEqual(await readFile(await download.path()),await readFile(root+image.src));
   report.downloads.push({width,file:image.src,status:'PASS'});
  }
  await card.scrollIntoViewIfNeeded();await page.screenshot({path:out+`/activities-${width}.png`,fullPage:true});
  await page.addStyleTag({content:'html{font-size:200% !important}'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  report.checks.push({width,reflow:'PASS',accessibility:'PASS',downloads:'PASS',zoom:'PASS'});
  await context.close();
 }
 for(const now of ['2026-10-31T16:30:00+08:00','2026-11-01T00:01:00+08:00']){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  const page=await context.newPage();await page.clock.setFixedTime(new Date(now));
  await page.goto(base+'election.html');
  await page.waitForResponse(r=>r.url().endsWith('/data/events.json'));
  await page.waitForTimeout(200);
  const cards=page.locator('.campaign-event').filter({hasText:opening.name});
  assert.equal(await cards.count(),now.startsWith('2026-10-31')?1:0);
  assert.equal(await cards.locator('a[href*="calendar.google.com"]').count(),0);
  report.checks.push({clock:now,startOnlyListing:'PASS'});
  await context.close();
 }
 assert.deepEqual(report.errors,[]);
}finally{
 await writeFile(out+'/report.json',JSON.stringify(report,null,2));
 await browser.close();server.kill();
}
console.log(JSON.stringify(report,null,2));
