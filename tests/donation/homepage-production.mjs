import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const out=root+'tests/donation/results/homepage-production/';
await mkdir(out,{recursive:true});
const live=process.env.HOME_LIVE_URL;
assert(!live||live==='https://www.huiwen.tw/');
const base=live||'http://127.0.0.1:8778/';
const server=live?null:spawn('python3',['-m','http.server','8778','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const records=JSON.parse(await readFile(root+'data/achievements-public.json','utf8'));
const schedule=JSON.parse(await readFile(root+'data/legal-schedule.json','utf8'));
const event=JSON.parse(await readFile(root+'data/events.json','utf8')).events.find(e=>e.id==='campaign-headquarters-opening-2026-10-31');
const mapSource=await readFile(root+'map.js','utf8');
const browser=await chromium.launch();
const report={base,method:'local generated source in Chromium; not Lighthouse; no external requests',checks:[],errors:[]};
try{
 if(!live)for(let n=0;n<60;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [320,390,768,1440]){
  const ctx=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce'});
  await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();
  await page.addInitScript(()=>{
   window.__homeLcp=[];
   try{new PerformanceObserver(list=>window.__homeLcp.push(...list.getEntries().map(entry=>entry.renderTime||entry.loadTime||entry.startTime))).observe({type:'largest-contentful-paint',buffered:true});}catch{}
  });
  page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);
  const initial=await page.evaluate(()=>({lcp:window.__homeLcp.at(-1)||null,height:document.documentElement.scrollHeight}));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('h1').count(),1);
  const main=page.locator('main.home-redesign');
  assert.deepEqual(await main.locator(':scope > section').evaluateAll(xs=>xs.map(x=>x.id||null)),[null,'recent','home-local-progress','council','contact']);
  assert.equal(await page.locator('.hero-actions a').count(),2,'hero has one paired service/LINE CTA group');
  assert.equal(await page.locator('.hero-actions a.primary').getAttribute('href'),await page.locator('.contact-grid .big-phone').getAttribute('href'));
  assert.equal(await page.locator('.hero-actions a.primary').innerText(),'撥打服務處');
  assert.equal(await page.locator('.hero-actions a.outline').getAttribute('href'),'https://line.me/R/ti/p/@yve2766q');
  assert.equal(await page.locator('.home-task-paths a').count(),3);
  assert.equal(await page.locator('.home-lawyer-link a[data-home-legal-month]').count(),1);
  assert.equal(await page.locator('.home-lawyer-link a').getAttribute('data-home-legal-month'),schedule.month);
  assert.equal(await page.locator('.home-recent-list > li').count(),3);
  assert.equal(await page.locator('[data-home-local-record="wende-school-center"]').count(),1);
  assert.equal((await main.innerText()).split('文德國小').length-1,1,'the featured local case appears once as a case');
  assert.equal(await main.locator('.civic-story-grid, #map, .filters, .place').count(),0);
  assert.equal(await page.locator('.home-map-preview img').getAttribute('alt'),'鳳山區里界示意圖；圓點只標示公開紀錄已有的鳳山區座標。');
  const mapEntry=page.getByRole('link',{name:'在互動地圖查看公開紀錄；也可使用下方里別選單或文字紀錄'});
  assert.equal(await mapEntry.count(),1);
  assert.equal(await mapEntry.getAttribute('href'),'achievements.html?case=wende-school-center#achievement-map');
  const boundarySource=page.getByRole('link',{name:'內政部國土測繪中心村里界圖'});
  assert.equal(await boundarySource.count(),1);
  assert.equal(await boundarySource.getAttribute('href'),'https://data.gov.tw/dataset/7438');
  assert.equal(await page.locator('.home-map-text-link').getAttribute('href'),'achievements.html#case-results');
  assert.equal(await page.locator('.home-village-form').getAttribute('method'),'get');
  assert.equal(await page.locator('.home-village-form button[type=reset]').count(),1);
  assert(mapSource.includes("new URLSearchParams(location.search)"));
  assert(mapSource.includes("'village','category','subcategory','status','year'"));

  const expectedStatus={};
  for(const record of records)expectedStatus[record.status]=(expectedStatus[record.status]||0)+1;
  const visibleStats=await page.locator('[data-home-status]').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.dataset.homeStatus,Number(node.querySelector('strong').textContent)])));
  assert.deepEqual(visibleStats,expectedStatus,'status counts project from current public records');
  assert.equal(Number(await page.locator('[data-home-stat=total] strong').innerText()),records.length);
  const coveredVillages=new Set(records.filter(r=>r.district==='鳳山區'&&!['全市政策','跨區服務'].includes(r.scope)).flatMap(r=>r.villages||[]));
  assert.equal(Number(await page.locator('[data-home-stat=villages] strong').innerText()),coveredVillages.size);
  assert((await page.locator('[data-home-stat=villages]').innerText()).includes('非鳳山行政里總數'));
  const villageValues=await page.locator('#home-village option').evaluateAll(nodes=>nodes.slice(1).map(option=>option.value));
  assert.deepEqual(villageValues,[...coveredVillages].sort().map(village=>'v:'+village));
  for(const [status] of Object.entries(expectedStatus)){
   const link=page.locator(`[data-home-status="${status}"]`),url=new URL(await link.getAttribute('href'),base);
   assert.equal(url.searchParams.get('status'),status);
  }
  const heroSources=await page.locator('.hero-portrait picture source').evaluateAll(nodes=>nodes.map(node=>node.type));
  assert.deepEqual(heroSources,['image/avif','image/webp']);
  assert.equal(await page.locator('main img[fetchpriority=high]').count(),1,'only the actual hero image has high fetch priority');
  assert.equal(await page.locator('[data-home-event] img[fetchpriority=high]').count(),0);
  const eventImage=page.locator('[data-home-event] img');
  assert.equal(await eventImage.getAttribute('loading'),'lazy');
  assert((await eventImage.getAttribute('srcset')).includes('campaign-opening-20261031-landscape-800.webp 800w'));
  assert.equal(await page.locator('[data-home-event] time').getAttribute('datetime'),event.start);
  assert((await page.locator('[data-home-event]').innerText()).includes(event.location));

  const localLayout=await page.locator('.home-local-layout').evaluate(el=>({display:getComputedStyle(el).display,columns:getComputedStyle(el).gridTemplateColumns.split(' ').map(parseFloat)}));
  if(width>780){assert.equal(localLayout.display,'grid');assert(Math.abs(localLayout.columns[0]/localLayout.columns[1]-5/7)<.04,JSON.stringify(localLayout));}
  else assert.equal(localLayout.columns.length,1,'the local progress layout is one column at and below 780px');
  const recentColumns=await page.locator('.home-recent-list').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
  if(width<=780)assert.equal(recentColumns,1,'recent cards stack below 780px');

  for(const img of await page.locator('main img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate(el=>el.decode());}
  await page.evaluate(()=>scrollTo(0,0));
  const pageHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
  if(width===390)assert(pageHeight<=5000,`mobile page height ${pageHeight}px exceeds 5000px`);
  if(width===1440)assert(pageHeight<=4000,`desktop page height ${pageHeight}px exceeds 4000px`);
  if(width===1440){
   const cardHeights=await page.locator('.home-recent-list article').evaluateAll(xs=>xs.map(x=>x.getBoundingClientRect().height));
   assert(Math.max(...cardHeights)-Math.min(...cardHeights)<1,JSON.stringify(cardHeights));
  }
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),[]);
  await page.screenshot({path:out+`home-${width}-top.png`});
  await page.screenshot({path:out+`home-${width}-full.png`,fullPage:true});
  if([390,1440].includes(width))for(const [key,selector] of [['hero','.hero'],['recent','.home-recent'],['local-progress','.home-local-progress'],['council','.home-council'],['contact','#contact']])await page.locator(selector).screenshot({path:out+`home-${width}-${key}.png`});

  const select=page.locator('#home-village');await select.focus();
  assert.equal(await select.evaluate(el=>el===document.activeElement),true,'native village select receives keyboard focus');
  await select.selectOption('v:文德里');
  await page.getByRole('button',{name:'清除選擇'}).click();
  assert.equal(await select.inputValue(),'','native reset clears the village selection');

  const lawyer=page.locator('.home-lawyer-link a');await lawyer.focus();
  await Promise.all([page.waitForURL(url=>url.pathname.endsWith('/service.html')&&url.hash==='#monthly-heading'),page.keyboard.press('Enter')]);
  await page.locator('[data-legal-calendar]').waitFor({state:'visible'});
  await page.goto(base);await page.addStyleTag({content:'html{font-size:200%!important}'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const controls=await page.locator('#home-village').evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth};});
  assert(controls.left>=0&&controls.right<=width,JSON.stringify(controls));
  assert(controls.scrollWidth<=controls.clientWidth,JSON.stringify(controls));
  await page.screenshot({path:out+`home-${width}-text-200-top.png`});
  report.checks.push({width,sourceParity:'PASS',accessibility:'PASS',keyboard:'PASS',responsive:'PASS',pageHeight,lcpMs:initial.lcp});
  await ctx.close();
 }

 const nextMonth=await browser.newContext({viewport:{width:390,height:844}});
 const nextMonthPage=await nextMonth.newPage();
 await nextMonthPage.clock.install({time:new Date('2026-11-01T01:00:00+08:00')});
 await nextMonth.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 await nextMonthPage.goto(base);
 assert.equal(await nextMonthPage.locator('.home-lawyer-link a').innerText(),'查看公益律師時間表 →');
 report.checks.push({date:'2026-11-01T01:00:00+08:00',monthMismatch:'PASS'});
 await nextMonth.close();

 const noJs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
 const noJsPage=await noJs.newPage();
 await noJs.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 await noJsPage.goto(base);
 assert(await noJsPage.locator('h1').isVisible());
 assert.equal(await noJsPage.locator('.home-village-form noscript').count(),1);
 assert((await noJsPage.locator('.home-village-form noscript').innerText()).includes('完整文字紀錄仍可在建設與進度頁查看'));
 assert.equal(await noJsPage.locator('.home-recent-list > li').count(),3);
 await noJsPage.locator('#home-village').selectOption('v:文德里');
 await Promise.all([noJsPage.waitForURL(url=>url.pathname.endsWith('/achievements.html')&&url.searchParams.get('village')==='v:文德里'),noJsPage.getByRole('button',{name:'查看紀錄'}).click()]);
 assert(await noJsPage.locator('.case-card').count()>0,'complete static record list remains available without JavaScript');
 await noJsPage.goto(base);
 const textFallback=noJsPage.getByRole('link',{name:'不使用地圖也可直接查閱全部公開紀錄 →'});
 assert.equal(await textFallback.getAttribute('href'),'achievements.html#case-results');
 await textFallback.click();
 await noJsPage.waitForURL(url=>url.pathname.endsWith('/achievements.html')&&url.hash==='#case-results');
 assert(await noJsPage.locator('.case-card').count()>0,'the explicit text link keeps the full no-JavaScript record list reachable');
 await noJs.close();
 assert.deepEqual(report.errors,[]);
}finally{
 await writeFile(out+'report.json',JSON.stringify(report,null,2));
 await browser.close();
 server?.kill();
}
