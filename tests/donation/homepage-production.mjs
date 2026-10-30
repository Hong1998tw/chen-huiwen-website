import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertWithHomeDiagnostics} from './homepage-diagnostics.mjs';
import {assertNoHorizontalOverflow,captureLayoutDiagnostics} from './layout-diagnostics.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=root+'tests/donation/results/homepage-production/';
await mkdir(out,{recursive:true});
const live=process.env.HOME_LIVE_URL;
assert(!live||live==='https://www.huiwen.tw/');
const base=live||'http://127.0.0.1:8778/';
const server=live?null:spawn('python3',['-m','http.server','8778','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const catalog=JSON.parse(await readFile(root+'data/public-record-catalog.json','utf8'));
const villages=JSON.parse(await readFile(root+'data/villages.json','utf8'));
const schedule=JSON.parse(await readFile(root+'data/legal-schedule.json','utf8'));
const feed=JSON.parse(await readFile(root+'data/latest-info.json','utf8'));
const config=JSON.parse(await readFile(root+'data/civic-home.json','utf8'));
const mapSource=await readFile(root+'map.js','utf8');
const browser=await chromium.launch();
// External thumbnails are aborted on purpose: every run exercises the text/source fallback.
const report={base,method:'local generated source in Chromium; not Lighthouse; external requests aborted',checks:[],errors:[]};
const viewportCases=[320,360,390,430,780,781,1180,1440].map(width=>({width,height:960}));
viewportCases.push({width:640,height:900},{width:1180,height:757},{width:1440,height:900},{width:390,height:844});
const fengshan=new Set(villages.filter(row=>row.district==='鳳山區').map(row=>row.name));
const coveredVillages=[...new Set(catalog.flatMap(row=>row.villages||[]).filter(name=>fengshan.has(name)))].sort();
const firstOf=type=>feed.items.find(item=>type==='all'||item.type===type);
try{
 if(!live)for(let n=0;n<60;n++){try{if((await fetch(base,{method:"HEAD"})).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const {width,height} of viewportCases){
  const viewportTag=height===960?String(width):`${width}x${height}`;
  const ctx=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
  await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();
  page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(250);
  await assertNoHorizontalOverflow(page,{directory:out+'diagnostics/',label:`homepage-${viewportTag}-layout`});
  const main=page.locator('main.home-redesign');
  assert.deepEqual(await main.evaluate(el=>[...el.children].map(x=>[x.localName,x.id||null])),
   [['nav','service'],['section','latest'],['section','progress'],['section','council'],['section','contact']]);
  assert.equal(await page.locator('h1').count(),1);
  assert.equal((await page.locator('h1').innerText()).trim(),'最新資訊');
  assert.equal(await main.locator('.hero, .hero-portrait, .home-recent, .civic-story-grid, #map, .filters, .place').count(),0,'no large portrait hero or legacy lists');

  // Primary navigation: three direct tasks and one secondary menu.
  const primary=await page.locator('#navigation > a.nav-primary').evaluateAll(xs=>xs.map(x=>[x.textContent.trim(),x.getAttribute('href')]));
  assert.deepEqual(primary,[['最新資訊','./#latest'],['找服務','service.html'],['查地方進度','achievements.html']]);
  assert.equal(await page.locator('#navigation details.nav-more').count(),1);
  if(width>780)for(const link of await page.locator('#navigation > a.nav-primary').all())assert(await link.isVisible(),'primary tasks are visible on desktop');

  // Service band: four direct tasks from canonical sources.
  const services=await page.locator('.home-service-entry').evaluateAll(xs=>xs.map(x=>[x.dataset.homeTask,x.getAttribute('href')]));
  assert.deepEqual(services.map(x=>x[0]),['chat','phone','line','legal']);
  assert.equal(services[0][1],'service.html#contact');
  assert.equal(services[1][1],await page.locator('.contact-grid .big-phone').getAttribute('href'));
  assert.equal(services[2][1],'https://line.me/R/ti/p/@yve2766q');
  assert.equal(await page.locator('main [data-home-legal-month]').getAttribute('data-home-legal-month'),schedule.month);
  for(const entry of await page.locator('.home-service-entry').all()){const box=await entry.boundingBox();assert(box.height>=44&&box.width>=44,JSON.stringify(box));}

  // Latest information: same order as the derived feed, tabs filter that order.
  const tabs=page.locator('[role="tab"]');
  assert(await page.locator('[role="tablist"]').isVisible());
  assert.deepEqual(await tabs.allInnerTexts(),['全部','新聞','日常','活動']);
  const visibleIds=()=>page.locator('.latest-item:not([hidden])').evaluateAll(xs=>xs.map(x=>x.dataset.latestId));
  const allVisible=await visibleIds();
  assert.deepEqual(allVisible,feed.items.slice(0,3).map(item=>item.id));
  assert.equal(await page.locator('.latest-item.is-lead').getAttribute('data-latest-id'),firstOf('all').id);
  const lead=page.locator('.latest-item.is-lead');
  if(await lead.locator('[data-latest-media] img').count()){
   const leadSrc=await lead.locator('[data-latest-media] img').getAttribute('src');
   if(leadSrc.startsWith('https://')){
    await lead.locator('[data-latest-media].is-failed').waitFor();
    const fallback=lead.locator('[data-latest-media-fallback]');
    assert(await fallback.isVisible(),'failed external thumbnail shows the text fallback');
    assert((await fallback.locator('a').getAttribute('href')).startsWith('https://'),'fallback keeps the original source link');
   }
  }
  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'latest-tab-news');
  assert.deepEqual(await visibleIds(),feed.items.filter(item=>item.type==='news').slice(0,3).map(item=>item.id));
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.nth(2).getAttribute('aria-selected'),'true');
  if(feed.counts.daily===0){
   assert.deepEqual(await visibleIds(),[]);
   const empty=page.locator('[data-latest-empty]');
   assert(await empty.isVisible());
   assert((await empty.innerText()).includes('目前尚未收錄日常貼文'));
   assert.equal(await empty.locator('a').getAttribute('href'),'https://www.facebook.com/hwcfs/');
  }
  await page.keyboard.press('End');
  assert.equal(await tabs.nth(3).getAttribute('aria-selected'),'true');
  const activities=await visibleIds();
  assert.deepEqual(activities,feed.items.filter(item=>item.type==='activity').slice(0,3).map(item=>item.id));
  const eventItem=page.locator('.latest-item.is-lead');
  assert((await eventItem.locator('.latest-date').innerText()).includes('活動時間'));
  assert.equal(await eventItem.locator('.latest-published').count(),0,'publication time is not repeated publicly');
  await page.keyboard.press('Home');
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'),'true');
  const more=page.locator('[data-latest-more]');
  if(await more.isVisible()){await more.click();assert.equal((await visibleIds()).length,Math.min(8,(await page.locator('.latest-item').count())));}
  assert.equal(await main.locator('iframe, video').count(),0,'no autoplay player or embedded video on the homepage');
  for(const image of await main.locator('img').all()){
   assert(await image.getAttribute('alt'));assert(await image.getAttribute('width'));assert(await image.getAttribute('height'));
  }

  // Local progress: village search, featured project and map only; no public statistics.
  assert.equal(await page.locator('#progress [data-home-stat], #progress [data-home-status]').count(),0,'homepage shows no record statistics');
  assert(!(await page.locator('#progress').innerText()).includes('收錄不等於完成'));
  assert.deepEqual(await page.locator('#home-village option').evaluateAll(nodes=>nodes.slice(1).map(o=>o.value)),coveredVillages.map(v=>'v:'+v));
  assert.equal(await page.locator('[data-home-featured-project]').getAttribute('data-home-featured-project'),config.featured);
  assert.equal(await page.locator('.home-map-preview img').getAttribute('alt'),'鳳山區里界示意圖；圓點只標示公開紀錄已有的鳳山區座標。');
  const mapEntry=page.getByRole('link',{name:'在互動地圖查看公開紀錄；也可使用上方里別選單或文字紀錄'});
  assert.equal(await mapEntry.getAttribute('href'),'achievements.html?case=wende-school-center#achievement-map');
  assert.equal(await page.getByRole('link',{name:'內政部國土測繪中心村里界圖'}).getAttribute('href'),'https://data.gov.tw/dataset/7438');
  assert.equal(await page.locator('.home-map-text-link').getAttribute('href'),'achievements.html#case-results');
  assert.equal(await page.locator('.home-village-form').getAttribute('method'),'get');
  assert(mapSource.includes("new URLSearchParams(location.search)"));
  assert(mapSource.includes("'village','category','subcategory','status','year'"));
  assert((await page.locator('#council').innerText()).includes('2026 鳳山區・陳慧文5號'));

  const pageHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
  await assertWithHomeDiagnostics(page,out,viewportTag,'page-height',async()=>{
   if(width===390)assert(pageHeight<6200,`mobile page height ${pageHeight}px must stay below 6200px`);
   if(width===1440)assert(pageHeight<4200,`desktop page height ${pageHeight}px must stay below 4200px`);
   if(width>=1180){
    const leadBox=await page.locator('.latest-item.is-lead [data-latest-media]').boundingBox();
    const copyBox=await page.locator('.latest-item.is-lead .latest-copy').boundingBox();
    if(leadBox&&copyBox)assert(leadBox.x+leadBox.width<=copyBox.x+1,'desktop lead uses image left, copy right');
   }
  });
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),[]);
  await page.screenshot({path:out+`home-${viewportTag}-top.png`});
  await page.screenshot({path:out+`home-${viewportTag}-full.png`,fullPage:true});

  const select=page.locator('#home-village');await select.focus();
  assert.equal(await select.evaluate(el=>el===document.activeElement),true,'native village select receives keyboard focus');
  const legal=page.locator('main [data-home-legal-month]');await legal.focus();
  await Promise.all([page.waitForURL(url=>url.pathname.endsWith('/service.html')&&url.hash==='#monthly-heading'),page.keyboard.press('Enter')]);
  await page.locator('[data-legal-calendar]').waitFor({state:'visible'});
  await page.goto(base);await page.addStyleTag({content:'html{font-size:200%!important}'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const controls=await page.locator('#home-village').evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth};});
  assert(controls.left>=0&&controls.right<=width,JSON.stringify(controls));
  assert(controls.scrollWidth<=controls.clientWidth,JSON.stringify(controls));
  if(width<=780){
   const menuLayout=await page.locator('.menu-toggle').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),node=Array.from(el.childNodes).find(child=>child.nodeType===3&&child.textContent.includes('選單')),range=document.createRange();if(node)range.selectNodeContents(node);return{label:node?.textContent.trim(),labelRects:node?[...range.getClientRects()].map(x=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom})):[],left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,headerHeight:document.querySelector('.site-header').getBoundingClientRect().height,whiteSpace:s.whiteSpace,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};});
   assert.equal(menuLayout.label,'選單',JSON.stringify(menuLayout));assert.equal(menuLayout.labelRects.length,1,JSON.stringify(menuLayout));
   assert(menuLayout.headerHeight>=64,JSON.stringify(menuLayout));assert(menuLayout.height>=44,JSON.stringify(menuLayout));
   assert(menuLayout.scrollWidth<=menuLayout.clientWidth&&menuLayout.scrollHeight<=menuLayout.clientHeight,JSON.stringify(menuLayout));
   assert.equal(menuLayout.whiteSpace,'nowrap');
  }
  await assertNoHorizontalOverflow(page,{directory:out+'diagnostics/',label:`homepage-${viewportTag}-text-200-layout`});
  const legalLayout=await page.locator('main [data-home-legal-month]').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el);return{tagName:el.tagName.toLowerCase(),display:s.display,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,whiteSpace:s.whiteSpace,overflowX:s.overflowX,overflowY:s.overflowY,textRects:[...range.getClientRects()].map(x=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom}))};});
  if(legalLayout.height<44||legalLayout.left<0||legalLayout.right>width||legalLayout.scrollWidth>legalLayout.clientWidth)await captureLayoutDiagnostics(page,{directory:out+'diagnostics/',label:`homepage-${viewportTag}-legal-target`,extra:legalLayout});
  assert.equal(legalLayout.tagName,'a','the 44px target measurement must use the actual clickable link');
  assert(['flex','inline-flex'].includes(legalLayout.display),JSON.stringify(legalLayout));
  assert(legalLayout.height>=44,JSON.stringify(legalLayout));
  assert(legalLayout.left>=0&&legalLayout.right<=width,JSON.stringify(legalLayout));
  assert(legalLayout.scrollWidth<=legalLayout.clientWidth,JSON.stringify(legalLayout));
  assert.equal(legalLayout.whiteSpace,'normal');
  assert(!['hidden','clip'].includes(legalLayout.overflowX)&&!['hidden','clip'].includes(legalLayout.overflowY),JSON.stringify(legalLayout));
  await page.screenshot({path:out+`home-${viewportTag}-text-200-top.png`});
  report.checks.push({width,height,sourceParity:'PASS',latestOrder:'PASS',thumbnailFallback:'PASS',accessibility:'PASS',keyboard:'PASS',responsive:'PASS',pageHeight});
  await ctx.close();
 }

 // Protected phrases (names, offices, campaign/council terms) stay on one line on phones.
 for(const width of [320,360,390,414]){
  const ctx=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  const splits=[];
  for(const tab of ['all','news','activity']){
   await page.locator(`[data-latest-filter="${tab}"]`).click();
   splits.push(...await page.evaluate(()=>[...document.querySelectorAll('[data-latest-items] > .latest-item:not([hidden]) .latest-keep')].flatMap(keep=>{
    const range=document.createRange();range.selectNodeContents(keep);
    const tops=[...new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top)))];
    return tops.length>1?[{text:keep.textContent,tops}]:[];
   })));
  }
  assert.deepEqual(splits,[],`${width}px protected headline phrases split across lines`);
  const kept=await page.evaluate(()=>[...document.querySelectorAll('.latest-keep')].map(node=>node.textContent));
  for(const phrase of ['陳慧文','賴瑞隆','聯合']) assert(kept.some(text=>text.includes(phrase)),phrase);
  await assertNoHorizontalOverflow(page,{directory:out+'diagnostics/',label:`homepage-${width}-headline-phrases`});
  report.checks.push({width,headlinePhrases:'PASS'});
  await ctx.close();
 }

 const nextMonth=await browser.newContext({viewport:{width:390,height:844}});
 const nextMonthPage=await nextMonth.newPage();
 await nextMonthPage.clock.install({time:new Date('2026-11-01T01:00:00+08:00')});
 await nextMonth.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 await nextMonthPage.goto(base);
 if(schedule.month!=='2026-11')assert.equal(await nextMonthPage.locator('main [data-home-legal-month] small').innerText(),'查看律師時間表');
 const badge=nextMonthPage.locator('[data-latest-id="event-campaign-headquarters-opening-2026-10-31"] [data-latest-event-badge]');
 if(await badge.count())assert.equal(await badge.textContent(),'日期已過','a passed date is not presented as a held event');
 report.checks.push({date:'2026-11-01T01:00:00+08:00',monthMismatch:'PASS'});
 await nextMonth.close();

 const noJs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
 const noJsPage=await noJs.newPage();
 await noJs.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 await noJsPage.goto(base);
 assert(await noJsPage.locator('h1').isVisible());
 assert.equal(await noJsPage.locator('[role="tablist"]').isVisible(),false,'tabs stay hidden without JavaScript instead of offering dead controls');
 assert.equal(await noJsPage.locator('.latest-item:not([hidden])').count(),3);
 assert(await noJsPage.locator('.home-latest-lists a[href="news.html"]').isVisible());
 assert.equal(await noJsPage.locator('.home-village-form noscript').count(),1);
 await noJsPage.locator('#home-village').selectOption('v:文德里');
 await Promise.all([noJsPage.waitForURL(url=>url.pathname.endsWith('/achievements.html')&&url.searchParams.get('village')==='v:文德里'),noJsPage.getByRole('button',{name:'查看紀錄'}).click()]);
 assert(await noJsPage.locator('.case-card').count()>0,'complete static record list remains available without JavaScript');
 await noJsPage.goto(base);
 const textFallback=noJsPage.getByRole('link',{name:'不使用地圖也可直接查閱全部公開紀錄 →'});
 assert.equal(await textFallback.getAttribute('href'),'achievements.html#case-results');
 await noJs.close();
 assert.deepEqual(report.errors,[]);
}finally{
 await writeFile(out+'report.json',JSON.stringify(report,null,2));
 await browser.close();
 server?.kill();
}
