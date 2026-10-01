import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const out=fileURLToPath(new URL('./results/events/',import.meta.url));
await mkdir(out,{recursive:true});
const live=process.env.EVENTS_LIVE_URL;
if(live && live!=='https://www.huiwen.tw/')throw new Error('EVENTS_LIVE_URL must be the official production origin');
const base=live||'http://127.0.0.1:8771/';
const server=live?null:spawn('python3',['-m','http.server','8771','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const browser=await chromium.launch();
const report={mode:live?'production-direct':'candidate',base,checks:[],downloads:[],errors:[]};
const events=JSON.parse(await readFile(root+'data/events.json','utf8')).events;
const opening=events.find(e=>e.id==='campaign-headquarters-opening-2026-10-31');
const council=events.find(e=>e.id==='council-general-interpellation-2026-10-08');
assert(opening && opening.end===null);
const detail=event=>'event-'+event.id+'.html';
const stamp=date=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
const assertLayout=async page=>{
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 assert.deepEqual(a11y.violations.map(x=>({id:x.id,targets:x.nodes.map(n=>n.target)})),[]);
};
const assertPicker=async (page,container)=>{
 const picker=container.locator('.event-reminder');
 const select=picker.locator('select');
 const link=picker.locator('.event-reminder-link');
 assert.equal(await select.inputValue(),'');
 assert.equal(await link.getAttribute('href'),null);
 await picker.locator('summary').focus();
 await page.keyboard.press('Enter');
 assert(await picker.evaluate(el=>el.open));
 for(const minutes of ['15','30','60']){
  await select.selectOption(minutes);
  if(minutes==='15'){
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false})));
   assert.equal(await select.inputValue(),minutes,'Initial load must preserve a choice made during navigation');
  }
  assert(await link.isVisible());
  const url=new URL(await link.getAttribute('href'));
  assert.equal(url.origin,'https://calendar.google.com');
  assert.equal(url.pathname,'/calendar/r/eventedit');
  assert.equal(url.searchParams.get('stz'),'Asia/Taipei');
  assert.equal(url.searchParams.get('etz'),'Asia/Taipei');
  assert.equal(url.searchParams.get('dates'),stamp(new Date(opening.start))+'/'+stamp(new Date(Date.parse(opening.start)+Number(minutes)*60000)));
  assert.equal(url.searchParams.get('text'),opening.name+'（開始提醒）');
  assert(url.searchParams.get('details').includes(minutes+' 分鐘個人開始提醒，不是活動時長'));
  assert(url.searchParams.get('details').includes('不會自動更新'));
  assert.equal(url.searchParams.get('location'),opening.location);
  await link.focus();assert(await link.evaluate(el=>el===document.activeElement));
 }
 await select.selectOption('');
 assert.equal(await link.getAttribute('href'),null);
 assert(!(await link.isVisible()));
 await picker.locator('summary').focus();await page.keyboard.press('Enter');
 assert(!(await picker.evaluate(el=>el.open)));
};
try{
 for(let i=0;i<60;i++){try{if((await fetch(base+'activities.html')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [320,390,768,1440]){
  const context=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce',acceptDownloads:true});
  if(!live)await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(base+'activities.html#event-'+opening.id);
  const card=page.locator('#event-'+opening.id);
  assert.equal(await page.locator('.event-timeline .event-card').count(),events.length);
  assert((await card.innerText()).includes('2026/10/31（六）15:50'));
  assert((await card.innerText()).includes(opening.location));
  assert.equal(await card.locator('a[href*="calendar.google.com"]').count(),0);
  assert.equal(await page.locator('#event-'+council.id+' a[href*="calendar.google.com"]').count(),1);
  assert.equal(await page.locator('#event-'+council.id+' a[href*="maps/search"]').count(),0);
  const map=new URL(await card.locator('.event-map-link').getAttribute('href'));
  assert.equal(map.searchParams.get('api'),'1');assert.equal(map.searchParams.get('query'),opening.location);
  await assertPicker(page,card);await assertLayout(page);
  await page.screenshot({path:out+'/activities-'+width+'.png',fullPage:true});
  await card.locator('.event-detail-link').click();
  assert.equal(new URL(page.url()).pathname,'/'+detail(opening));
  const article=page.locator('.event-detail');
  assert((await article.innerText()).includes('07-821-2536'));
  await assertPicker(page,article);
  for(const img of await article.locator('img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate(el=>el.decode());}
  assert(await article.locator('img').evaluateAll(images=>images.every(img=>img.complete && img.naturalWidth===Number(img.getAttribute('width')) && img.naturalHeight===Number(img.getAttribute('height')))));
  for(const image of opening.images){
   const link=article.locator('a[download]').filter({hasText:image.caption});
   await link.focus();assert(await link.evaluate(el=>el===document.activeElement));
   const pending=page.waitForEvent('download');await page.keyboard.press('Enter');
   const download=await pending;assert.deepEqual(await readFile(await download.path()),await readFile(root+image.src));
   report.downloads.push({width,file:image.src,status:'PASS'});
  }
  await assertLayout(page);
  await page.screenshot({path:out+'/event-opening-'+width+'.png',fullPage:true});
  await page.addStyleTag({content:'html{font-size:200% !important}'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await article.locator('.event-back-link').click();
  assert.equal(new URL(page.url()).hash,'#event-'+opening.id);
  await page.goBack();
  assert.equal(new URL(page.url()).pathname,'/'+detail(opening));
  assert.equal(await page.locator('.event-reminder select').inputValue(),'');
  assert.equal(await page.locator('.event-reminder-link').getAttribute('href'),null);
  await page.goto(base+detail(council));
  assert.equal(await page.locator('meta[property="og:image:alt"]').getAttribute('content'),'陳慧文官網品牌分享圖，非本活動照片');
  assert.equal(await page.locator('.event-detail img').count(),0);
  await assertLayout(page);
  report.checks.push({width,timeline:'PASS',detail:'PASS',reminder:'PASS',reflow:'PASS',accessibility:'PASS',downloads:'PASS',zoom:'PASS',history:'PASS'});
  await context.close();
 }
 const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
 const fallback=await nojs.newPage();await fallback.goto(base+detail(opening));
 assert((await fallback.locator('main').innerText()).includes('15:50'));
 assert.equal(await fallback.locator('main a[href*="calendar.google.com"]').count(),0);
 assert.equal(await fallback.locator('.event-actions a[href="'+opening.sourceUrl+'"]').count(),1);
 await nojs.close();report.checks.push({noJavaScript:'PASS'});
 for(const now of ['2026-10-31T16:30:00+08:00','2026-11-01T00:01:00+08:00']){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  if(!live)await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  const page=await context.newPage();await page.clock.setFixedTime(new Date(now));
  const loaded=page.waitForResponse(r=>r.url().endsWith('/data/events.json'));
  await page.goto(base+'election.html');await loaded;await page.waitForTimeout(200);
  const cards=page.locator('.campaign-event').filter({hasText:opening.name});
  assert.equal(await cards.count(),now.startsWith('2026-10-31')?1:0);
  assert.equal(await cards.locator('a[href*="calendar.google.com"]').count(),0);
  if(now.startsWith('2026-10-31'))assert.equal(await cards.locator('a[href="'+detail(opening)+'"]').count(),1);
  report.checks.push({clock:now,startOnlyListing:'PASS'});await context.close();
 }
 assert.deepEqual(report.errors,[]);
}finally{
 await writeFile(out+'/report.json',JSON.stringify(report,null,2));
 await browser.close();server?.kill();
}
console.log(JSON.stringify(report,null,2));
