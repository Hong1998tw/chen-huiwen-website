/** User audit rows 1–4 and 6–10. No submission to external providers. */
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const publicRecordCount=JSON.parse(await readFile(root+'data/achievements-public.json','utf8')).length;
const base=process.env.BASE_URL||'http://127.0.0.1:8769/';
const server=process.env.BASE_URL?null:spawn('python3',['-m','http.server','8769','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const browser=await chromium.launch();
const report={base,checks:[],failures:[]};
const out=new URL('./results/public-service-audit/',import.meta.url);await mkdir(out,{recursive:true});
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.failures.push({name,error:String(e)});}}
try{
 for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [390,1440]){
  const ctx=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
  await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base);
  await page.locator('.hero-portrait img').evaluate(el=>el.decode());
  await page.screenshot({path:fileURLToPath(new URL('home-'+width+'.png',out))});
  await check(width+' direct homepage actions',async()=>{
   for(const href of ['service.html','achievements.html']){
    const a=page.locator('.hero-actions a[href="'+href+'"]');assert(await a.isVisible());
    const b=await a.boundingBox();assert(b.y+b.height<844);
   }
  });
  await check(width+' grouped navigation keyboard',async()=>{
   assert.equal(await page.locator('.nav-group').count(),5);
   if(width<781){await page.locator('.menu-toggle').click();assert(await page.locator('#navigation a[href="service.html"]').isVisible());await page.screenshot({path:fileURLToPath(new URL('menu-'+width+'.png',out))});await page.keyboard.press('Escape');}
   else{const group=page.locator('.nav-group').first();await group.locator('summary').focus();await page.keyboard.press('Enter');assert(await group.locator('a').first().isVisible());await page.screenshot({path:fileURLToPath(new URL('menu-'+width+'.png',out))});await page.keyboard.press('Escape');assert.equal(await group.getAttribute('open'),null);}
  });
  await check(width+' service intent and accurate highlighting',async()=>{
   await page.keyboard.press('Control+k');const input=page.locator('#global-search-dialog input');
   for(const query of ['律師','法律諮詢','律師時間表']){
    await input.fill(query);await page.waitForTimeout(220);
    const first=page.locator('.global-search-result').first();assert.match(await first.getAttribute('href'),/service\.html#monthly-heading$/);
    for(const text of await first.locator('mark').allTextContents())assert(query.includes(text)||text.includes(query));
    assert.match(await first.innerText(),/07-821-2536/);
   }
   await input.fill('電話');await page.waitForTimeout(220);assert.match(await page.locator('.global-search-result').first().getAttribute('href'),/service\.html#contact$/);
   await page.keyboard.press('Escape');
  });
  await page.goto(base+'service.html#monthly-heading');
  await page.screenshot({path:fileURLToPath(new URL('service-'+width+'.png',out))});
  await check(width+' dated accessible schedule and intact booking rules',async()=>{
   assert.equal(await page.locator('.schedule-text tbody tr').count(),13);
   assert.match(await page.locator('.schedule-text').innerText(),/非即時名額/);
   assert.match(await page.locator('.schedule-text tbody tr').last().innerText(),/9\/30（三）.*10:00–11:30/s);
   assert.match(await page.locator('#legal').innerText(),/未經許可，全程禁止錄音錄影/);
   const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations.map(v=>v.id),[]);
  });
  await page.goto(base+'achievements.html');
  await page.screenshot({path:fileURLToPath(new URL('list-'+width+'.png',out))});
  await page.waitForFunction(()=>!!window.HuiwenCases);
  await check(width+' list first and progressively disclosed filters',async()=>{
   assert(await page.locator('.map-panel').isHidden());assert.equal(await page.locator('.advanced-filters').getAttribute('open'),null);
   const cards=page.locator('#case-list [data-case]:visible');assert.equal(await cards.count(),10);
   const station=await cards.evaluateAll(xs=>xs.filter(x=>/station|rail-greenway|metro-green-line/.test(x.dataset.case)).length);assert(station<=1);
   await page.locator('.advanced-filters > summary').click();await page.locator('#status-filter').selectOption('已完成');assert((await cards.count())>0);
   await page.locator('#reset-map-filters').click();await page.getByRole('button',{name:'地圖與列表',exact:true}).click();assert(await page.locator('.map-panel').isVisible());
  });
  await page.goto(base+'achievement-metro-green-line.html');
  await page.screenshot({path:fileURLToPath(new URL('detail-'+width+'.png',out))});
  await check(width+' latest milestone source and distinct editing date',async()=>{
   assert.match(await page.locator('.case-latest').innerText(),/2026-05-14/);
   assert.match(await page.locator('.case-latest > a').getAttribute('href'),/21C32F3DE36C859F/);
   assert.match(await page.locator('.civic-article-nav').innerText(),/內容整理.*2026-09-19/s);
  });
  await page.goto(base+'achievement-wufu-2nd-lane81-drainage.html');
  await check(width+' old record not represented as recent construction',async()=>{
   assert.match(await page.locator('.case-latest').innerText(),/2019-12-25/);assert.match(await page.locator('.case-latest').innerText(),/並非即時工程進度/);
  });
  await page.goto(base+'vision.html');
  await page.screenshot({path:fileURLToPath(new URL('platform-'+width+'.png',out))});
  await check(width+' original platform and accountability gaps',async()=>{
   assert.equal(await page.locator('#platform-2026 .platform-theme li').count(),13);
   assert.match(await page.locator('.platform-accountability').innerText(),/量化目標、完成期限與執行分工/);
   assert.equal(await page.locator('#platform-2026 .platform-evidence').count(),13);
   assert(await page.locator('#platform-2026 .source-note').isVisible());
  });
  await page.goto(base+'about.html');
  await page.screenshot({path:fileURLToPath(new URL('about-'+width+'.png',out))});
  await check(width+' documented work examples',async()=>assert.equal(await page.locator('.about-work-grid a').count(),3));
  await page.goto(base+'election.html');await page.locator('#campaign-tracking .campaign-data-card').first().waitFor();
  await check(width+' election dates/source contract',async()=>{
   assert.equal(await page.getByText(/最近更新/).count(),0);
   const green=page.locator('#campaign-tracking article').filter({hasText:'推動捷運青線進入鳳山火車站'});
   assert.match(await green.innerText(),/2026-05-14/);assert.equal(await green.locator('a[href*="21C32F3DE36C859F"]').count(),1);
   assert.deepEqual(errors,[]);
  });
  await ctx.close();
 }
 for(const [time,label,expected] of [['2026-09-22T12:00:00+08:00','current month',4],['2026-10-01T12:00:00+08:00','expired month',13]]){
  const ctx=await browser.newContext({viewport:{width:390,height:844}});const page=await ctx.newPage();await page.clock.setFixedTime(new Date(time));await page.goto(base+'service.html');
  await check('schedule '+label,async()=>{if(label==='current month')await page.locator('.schedule-history-toggle').waitFor();else await page.waitForFunction(()=>document.querySelector('.schedule-period-note')?.textContent.includes('歷史時間表'));assert.equal(await page.locator('.schedule-text tbody tr:visible').count(),expected);if(label==='current month'){await page.locator('.schedule-history-toggle').click();assert.equal(await page.locator('.schedule-text tbody tr:visible').count(),13);}else assert.match(await page.locator('.schedule-period-note').innerText(),/歷史時間表/);});await ctx.close();
 }
 await check('map data failure preserves static public records',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}});await ctx.route('**/data/achievement-map.json*',r=>r.abort());const page=await ctx.newPage();await page.goto(base+'achievements.html');
  await page.getByText('篩選資料暫時無法載入；完整紀錄仍可在下方閱讀，請重新整理後再試。').waitFor();assert.equal(await page.locator('#case-list [data-case]:visible').count(),publicRecordCount);assert(await page.locator('#case-search').isDisabled());assert(await page.locator('#case-list a').first().isVisible());await ctx.close();
 });
 if(!process.env.BASE_URL)await check('excluded petition main unchanged',async()=>{
  const old=execFileSync('git',['show','8319451a6e104dbebe5ca2a4b359185247abd90a:petition.html'],{cwd:root,encoding:'utf8'});
  const current=await readFile(root+'petition.html','utf8');
  assert.equal(current.match(/<main[\s\S]*?<\/main>/)[0],old.match(/<main[\s\S]*?<\/main>/)[0]);
 });
 const ctx=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const page=await ctx.newPage();await page.goto(base+'service.html');
 await check('no JS schedule and original available',async()=>{assert.equal(await page.locator('.schedule-text tbody tr').count(),13);await page.locator('.schedule-original > summary').click();assert(await page.locator('.schedule-auto-embed a').isVisible());});await ctx.close();
}finally{await browser.close();server?.kill();await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
