import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=new URL('../../',import.meta.url).pathname;
const out=new URL('./results/',import.meta.url);await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8777','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const base='http://127.0.0.1:8777/';
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const report={scope:'P0 connected features',checks:[],failures:[],metrics:{}};
const check=async(name,fn)=>{try{await fn();report.checks.push({name,status:'Passed'});}catch(e){report.checks.push({name,status:'Failed',error:String(e)});report.failures.push(name);}};
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
await ctx.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
const page=await ctx.newPage();page.setDefaultTimeout(6000);
const data=JSON.parse(await readFile(root+'data/achievements.json')).filter(c=>c.status!=='待核驗');
const go=async(path='achievements.html')=>{await page.goto(base+path);await page.locator('.global-search-trigger').waitFor({state:'attached'});};
const count=async(n)=>page.waitForFunction(n=>document.querySelector('#case-count').textContent.startsWith(`共 ${n} 個`),n);
try{
 await go('index.html');
 await check('Public-page search, lazy index and Cmd+K keyboard navigation',async()=>{
  assert(!await page.evaluate(()=>performance.getEntriesByType('resource').some(e=>e.name.includes('search-index'))));
  await page.keyboard.press('Meta+k');await page.locator('#global-search-dialog').waitFor({state:'visible'});
  const input=page.locator('#global-search-dialog input');await input.fill('文德國小');await page.locator('.global-search-result[href="achievement-wende-school-center.html"]').waitFor();
  assert(await page.locator('.global-search-result mark').count()>0);
  const id=await input.getAttribute('aria-activedescendant');await page.keyboard.press('ArrowDown');assert.notEqual(await input.getAttribute('aria-activedescendant'),id);
  await input.fill('');await page.locator('[data-search-more]').click();await page.waitForFunction(()=>document.querySelectorAll('.global-search-result').length===24);
  await input.fill('不存在XYZ<svg onload=alert(1)>');await page.waitForFunction(()=>document.querySelector('.global-search-status').textContent.includes('找不到'));
  assert.equal(await page.locator('#global-search-dialog svg').count(),0);await page.keyboard.press('Escape');
 });
 await check('Mobile search restores focus to the visible menu button',async()=>{
  await page.setViewportSize({width:390,height:844});await page.locator('.menu-toggle').click();await page.locator('.global-search-trigger').click();await page.keyboard.press('Escape');await page.locator('#global-search-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.classList.contains('menu-toggle'));
  assert(await page.locator('.menu-toggle').evaluate(el=>el===document.activeElement));
 });
 await page.setViewportSize({width:1440,height:1000});await go();
 await check('Overview counts agree with source and status stays distinct',async()=>{
  await page.locator('.digital-dashboard').waitFor();assert.equal(Number(await page.locator('.digital-stat strong').first().textContent()),data.length);
  await page.locator('.dashboard-status [data-filter="已完成"]').click();await count(data.filter(c=>c.status==='已完成').length);
  assert.equal(Number(await page.locator('.digital-stat strong').first().textContent()),data.filter(c=>c.status==='已完成').length);
  assert.equal(await page.locator('#status-filter').inputValue(),'已完成');await page.locator('#reset-map-filters').click();
 });
 await check('History-only search, multiple tokens and IME composition',async()=>{
  await page.locator('#case-search').fill('票卡 車牌');await count(2);assert.equal(await page.locator('#case-list .case-card[data-case=station-parking]').isVisible(),true);
  await page.locator('#case-search').fill('　特教　護理　');await count(1);
  await page.locator('#case-search').evaluate(el=>{el.value='文德國小';el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'文德國小'}));});await count(1);
  await page.locator('#reset-map-filters').click();
 });
 await check('Year filter uses history dates and handles missing years',async()=>{
  await page.locator('#reset-map-filters').click();
  await page.locator('#year-filter').selectOption('2013');await count(1);assert.match(await page.locator('#case-list .case-card:visible').textContent(),/鳳山車站整合專題/);
  await page.locator('#year-filter').selectOption('undated');await count(3);await page.locator('#reset-map-filters').click();
 });
 await check('Grouped map point exposes every topic and selection never leaks through filters',async()=>{
  await page.locator('#reset-map-filters').click();
  const marker=page.locator('.case-marker').filter({hasText:'6'});await marker.click();await page.locator('.insight-group').waitFor();
  assert.equal(await page.locator('.insight-group button').count(),5);
  await page.locator('.insight-group button').filter({hasText:'智慧停車'}).click();assert.match(await page.locator('.map-insight-panel h3').textContent(),/智慧停車/);
  assert(new URL(page.url()).searchParams.get('case')==='station-parking');
  await page.locator('#category-filter').selectOption('社福與衛環');await count(data.filter(c=>c.categories.includes('社福與衛環')).length);
  assert.equal(await page.locator('.insight-group').count(),0);assert(!new URL(page.url()).searchParams.has('case'));
  await page.locator('#reset-map-filters').click();
 });
 await check('Shared query reload, deep case links and invalid query resilience',async()=>{
  await go('achievements.html?category='+encodeURIComponent('交通與基建')+'&year=2026');await page.locator('.digital-dashboard').waitFor();const before=await page.locator('#case-count').textContent();await page.reload();await page.locator('.digital-dashboard').waitFor();assert.equal(await page.locator('#case-count').textContent(),before);
  await go('achievements.html?case=haibang-bridge');await page.locator('.map-insight-panel').waitFor();assert.match(await page.locator('.map-insight-panel h3').textContent(),/海邦橋/);assert.equal(await page.locator('.case-card.is-selected').isVisible(),true);
  await go('achievements.html?year=garbage&category=invalid&page=NaN');await count(data.length);assert.equal(await page.locator('#year-filter').inputValue(),'all');
 });
 await check('Map failure preserves interactive search and all public records',async()=>{
  await page.route('**/assets/vendor/leaflet.js',r=>r.abort());await go();await page.locator('#case-search').fill('文德');await count(2);assert.match(await page.locator('#map-message').textContent(),/互動地圖暫時無法載入/);await page.unroute('**/assets/vendor/leaflet.js');
 });
 await go();
 await check('All filters clear to the full source count and ten items per page',async()=>{
  await page.locator('#case-search').fill('qzx-no-match');await count(0);assert(await page.locator('#case-empty').isVisible());await page.locator('[data-clear-filters]').click();await count(data.length);assert.equal(await page.locator('#case-list .case-card:visible').count(),10);
  await page.getByRole('button',{name:'下一頁',exact:true}).click();assert.equal(await page.locator('#case-list .case-card:visible').count(),10);assert(new URL(page.url()).searchParams.get('page')==='2');
 });
 await check('WCAG AA: dashboard, map panel and search dialog',async()=>{
  const axe=await new AxeBuilder({page}).include('.digital-dashboard').include('.map-insight-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations.map(v=>v.id),[]);
  await page.keyboard.press('Control+k');await page.locator('#global-search-dialog input').fill('文德');await page.locator('.global-search-result').first().waitFor();
  const a=await new AxeBuilder({page}).include('#global-search-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();await writeFile(new URL('p0-axe.json',out),JSON.stringify(a.violations,null,2));assert.deepEqual(a.violations.map(v=>v.id),[]);await page.keyboard.press('Escape');
 });
 await check('Search failure is visible and retry recovers',async()=>{
  await go('about.html');await page.route('**/data/search-index.json',r=>r.abort());await page.keyboard.press('Control+k');await page.locator('[data-search-retry]').waitFor({state:'visible'});
  assert.match(await page.locator('.global-search-status').textContent(),/暫時無法載入/);await page.unroute('**/data/search-index.json');await page.locator('[data-search-retry]').click();await page.locator('#global-search-dialog input').fill('文德國小');await page.locator('.global-search-result[href="achievement-wende-school-center.html"]').waitFor();await page.keyboard.press('Escape');
 });
 await check('Clipboard unavailable provides a usable URL fallback',async()=>{
  await go();await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>Promise.reject(Error('denied'))},configurable:true}));await page.locator('.share-current-page').click();await page.locator('.share-fallback').waitFor({state:'visible'});assert.equal(await page.locator('.share-fallback input').inputValue(),page.url());await page.locator('.share-fallback button').click();
 });
 await check('Reduced motion and no-JS progressive reading',async()=>{
  await page.emulateMedia({reducedMotion:'reduce'});await go('achievement-fengshan-station-overview.html');await page.locator('.case-timeline .is-visible').first().waitFor();assert.equal(await page.locator('.case-timeline>li:not(.is-visible)').count(),0);assert.equal(await page.locator('.case-timeline>li').first().evaluate(el=>getComputedStyle(el).transform),'none');
  const nojs=await browser.newContext({javaScriptEnabled:false});const np=await nojs.newPage();await np.goto(base+'achievements.html');assert.equal(await np.locator('#case-list .case-card:visible').count(),data.length);await nojs.close();await page.emulateMedia({reducedMotion:'no-preference'});
 });
 await go();await page.locator('.digital-dashboard').waitFor();await page.screenshot({path:root+'tests/donation/results/desktop-dashboard.png'});
 await page.locator('#achievement-map').scrollIntoViewIfNeeded();await page.screenshot({path:root+'tests/donation/results/desktop-map.png'});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:width===390?844:1000});await go();await page.locator('.digital-dashboard').waitFor();
  await check(`P0 layout ${width}px: no overflow`,async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));
  await page.locator('.digital-dashboard').screenshot({path:root+`tests/donation/results/dashboard-${width}.png`});
  await page.keyboard.press('Control+k');await page.locator('#global-search-dialog input').fill('鳳山車站');await page.locator('.global-search-result').first().waitFor();await page.screenshot({path:root+`tests/donation/results/search-${width}.png`});await page.keyboard.press('Escape');
 }
 await go();await page.locator('.digital-dashboard').waitFor();
 await check('Warm interactive search updates within 500ms in local Chromium',async()=>{const start=performance.now();await page.locator('#case-search').fill('文德國小');await count(1);report.metrics.liveSearchMs=Math.round(performance.now()-start);assert(report.metrics.liveSearchMs<500);});
}finally{await browser.close();server.kill();await writeFile(new URL('p0-report.json',out),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
