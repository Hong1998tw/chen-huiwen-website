import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./results/', import.meta.url);
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base='http://127.0.0.1:8765/';
const report={scope:'Full-site candidate QA',checks:[],failures:[],externalResources:'Blocked deliberately; third-party live availability is a separate manual check.'};
let browser;
async function check(name,fn){try{const value=await fn();report.checks.push({name,status:'Passed',...(value===undefined?{}:{value})});}catch(error){report.checks.push({name,status:'Failed',error:String(error)});report.failures.push(name);}}
try{
  for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1});
  await context.addInitScript(() => { window.layoutShifts=[]; new PerformanceObserver(list=>window.layoutShifts.push(...list.getEntries().filter(x=>!x.hadRecentInput))).observe({type:'layout-shift',buffered:true}); });
  await context.route('**/*',route=>{const url=new URL(route.request().url()); if(url.hostname==='127.0.0.1') route.continue(); else route.abort();});
  const page=await context.newPage();
  const pages=(await readdir(root)).filter(x=>x.endsWith('.html')).sort();
  const items=JSON.parse(await readFile(new URL('../../data/achievements.json',import.meta.url)));
  const widths=[1440,1100,1024,780,390];
  for(const width of widths){
    await page.setViewportSize({width,height:width===390?844:960});
    await page.goto(base+'political-donation.html');
    await check(`account first and no portrait ${width}px`,async()=>{
      assert.equal(await page.locator('.donation-portrait,picture').count(),0);
      const account=await page.locator('.donation-account-number').boundingBox();assert(account.y+account.height<844);
      assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'),'political-donation.html');
      assert.equal(await page.locator('#navigation a[href="election.html"]').count(),1);
    });
    await check(`donation ${width}px: no overflow`, async()=>{assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');});
    await check(`donation ${width}px: keyboard FAQ and focus`,async()=>{const summary=page.locator('summary').first();await summary.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('details').first().getAttribute('open'),'');assert(await summary.evaluate(el=>getComputedStyle(el).outlineStyle!=='none'));await page.keyboard.press('Enter');});
    if(width===390) await check('mobile menu: Enter, Escape, focus return',async()=>{const toggle=page.getByRole('button',{name:'選單',exact:true});await toggle.focus();await page.keyboard.press('Enter');assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert(await page.locator('#navigation a[href="political-donation.html"]').isVisible());await page.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert(await toggle.evaluate(el=>el===document.activeElement));await toggle.click();assert.equal(await page.locator('#navigation').evaluate(el=>getComputedStyle(el).position),'fixed');assert.equal(await page.locator('#navigation').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);await page.locator('.menu-backdrop').click({position:{x:4,y:4}});assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert(await toggle.evaluate(el=>el===document.activeElement));});
    await check(`donation ${width}px: axe WCAG2 A/AA`,async()=>{for(const summary of await page.locator('summary').all()) await summary.click();const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();await writeFile(new URL(`axe-${width}.json`,output),JSON.stringify(axe.violations,null,2));assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);});
    if([1440,390].includes(width)){
      await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path:fileURLToPath(new URL(`donation-${width}.png`,output)),fullPage:true});await page.screenshot({path:fileURLToPath(new URL(`donation-top-${width}.png`,output))});
      await check(`all pages ${width}px: navigation and layout`,async()=>{
        for(const file of pages){
          await check(`${file} ${width}px: layout and accessibility`,async()=>{
            await page.goto(base+file);
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${file}: overflow`);
            assert.equal(await page.locator('#navigation a[href="political-donation.html"]').count(),1,file);
            assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'),'political-donation.html');
            assert.equal(await page.locator('#navigation a').nth(2).getAttribute('href'),'election.html');
            assert.equal(await page.locator('#navigation a').nth(3).getAttribute('href'),'service.html#monthly-heading');
            assert.equal(await page.locator('#navigation a[href="gallery.html"]').count(),0);
            assert.equal(await page.locator('#navigation a[href="activities.html"]').innerText(),'活動公告');
            for(const target of ['tel:+88678212536','./','https://line.me/R/ti/p/@yve2766q','https://www.facebook.com/hwcfs/','https://www.instagram.com/huiwen.ifs/','https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ','https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==']) assert(await page.locator('footer a').evaluateAll((els,href)=>els.some(a=>a.getAttribute('href')===href),target));
            assert.equal(await page.locator('footer a[href="political-donation.html"]').count(),1,file);
            if(file.startsWith('achievement-')){const bodyText=await page.locator('main').innerText();assert(!/紀錄補充|資料與追蹤|並非已完成證明|尚未取得足以|本頁保留議題索引|待核驗/.test(bodyText),file+': editorial copy');}
            const core=['index.html','about.html','achievements.html','vision.html','news.html','activities.html','gallery.html','service.html','petition.html','political-donation.html','election.html','press.html','facts.html','404.html','achievement-wende-school-center.html'];
            if(core.includes(file)){const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();const serious=axe.violations.filter(v=>['serious','critical'].includes(v.impact));await writeFile(new URL(`axe-${file}-${width}.json`,output),JSON.stringify(axe.violations,null,2));assert.deepEqual(serious.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`${file}: axe`);}
            if(['index.html','election.html','political-donation.html','vision.html','achievements.html','activities.html','achievement-wende-school-center.html','achievement-huangpu-visitor-center.html'].includes(file)){await page.screenshot({path:fileURLToPath(new URL(`${file}-${width}.png`,output)),fullPage:true});}
          });
        }
      });
      await check(`homepage CTA ${width}px and back navigation`,async()=>{await page.goto(base+'index.html');if(width===390)await page.getByRole('button',{name:'選單',exact:true}).click();await page.locator('#navigation a[href="political-donation.html"]').click();assert(page.url().endsWith('/political-donation.html'));await page.getByRole('link',{name:'先看捐贈須知',exact:true}).click();assert(page.url().endsWith('#eligibility'));await page.getByRole('link',{name:'查看專戶資訊'}).click();assert(page.url().endsWith('#account'));await page.getByRole('link',{name:'← 回官網首頁'}).click();assert(page.url()===base);await page.goBack();assert(page.url().includes('/political-donation.html'));});
      await check(`map filters and pagination ${width}px against source`,async()=>{await page.goto(base+'achievements.html');const count=()=>page.locator('[data-case]:visible').count();const pageSize=Math.min(10,items.length);assert.equal(await count(),pageSize);assert.equal(await page.locator('#case-search').isVisible(),true);await page.locator('#toggle-map-search').click();assert.equal(await page.locator('#case-search').isVisible(),true);assert(await page.locator('#case-search').evaluate(el=>el===document.activeElement));await page.locator('#case-search').fill('文龍');assert((await count())>0&&(await count())<=10);await page.locator('#reset-map-filters').click();assert.equal(await page.locator('#case-search').isVisible(),true);for(const[selector,key]of[['#category-filter','categories'],['#status-filter','status']]){const value=Array.isArray(items[0][key])?items[0][key][0]:items[0][key];await page.locator(selector).selectOption(value);const expected=items.filter(x=>Array.isArray(x[key])?x[key].includes(value):x[key]===value).length;assert.equal(await count(),Math.min(10,expected));await page.locator('#reset-map-filters').click();}const village=items.find(x=>x.villages.length).villages[0];await page.locator('#village-filter').selectOption('v:'+village);assert.equal(await count(),Math.min(10,items.filter(x=>x.villages.includes(village)).length));await page.locator('#reset-map-filters').click();const scope=items.find(x=>x.scope!=='鳳山區').scope;await page.locator('#village-filter').selectOption('s:'+scope);assert.equal(await count(),Math.min(10,items.filter(x=>x.scope===scope).length));await page.locator('#reset-map-filters').click();assert.equal(await count(),pageSize);if(items.length>10){assert(await page.locator('.case-pagination').isVisible());await page.getByRole('button',{name:'第 2 頁'}).click();assert((await count())>0&&(await count())<=10);assert.equal(await page.locator('.case-page-button[aria-current="page"]').innerText(),'2');}assert(await page.locator('.leaflet-container').isVisible());});
      await check(`news unified controls ${width}px`,async()=>{await page.goto(base+'news.html');await page.locator('#unified-news-search').waitFor({state:'visible'});assert.equal(await page.locator('#news-reports').count(),0);assert.equal(await page.locator('.news-unified-grid > *').count(),10);assert.equal(await page.locator('#news-sort option').allTextContents().then(x=>x.join('|')),'重要優先|日期優先（新到舊）');await page.locator('#news-sort').selectOption('date');assert.equal(await page.locator('#news-sort').inputValue(),'date');await page.locator('#unified-news-search').fill('鳳山');assert((await page.locator('.news-unified-grid > *').count())>0);await page.locator('#unified-news-search').fill('');await page.getByRole('button',{name:'交通建設',exact:true}).click();assert((await page.locator('.news-unified-grid > *').count())>0);});
      await check(`requested UI changes ${width}px`,async()=>{await page.goto(base+'service.html');const legal=await page.locator('.legal-section').boundingBox();const monthly=await page.locator('.monthly-schedule').boundingBox();assert(legal.y<monthly.y,'lawyer rules should precede the monthly schedule');assert.equal(await page.locator('.monthly-schedule a[href*="canva.com"]').count(),0);assert((await page.locator('.schedule-phone-cta').boundingBox()).height>=60);await page.goto(base+'about.html');for(const href of['https://www.facebook.com/hwcfs/','https://www.threads.com/@huiwen.ifs','https://www.kcc.gov.tw/MemberInfo_New.aspx?msn=2215&n=39&sms=9028'])assert.equal(await page.locator(`.social-grid a[href="${href}"]`).count(),1);assert.equal(await page.locator('.social-grid a').count(),3);await page.goto(base+'activities.html');assert.equal(await page.locator('.event-empty a').count(),0);});
      await check(`portraits ${width}px: scale, ratio, no collision`,async()=>{for(const[file,selector,max]of[['index.html','.hero-portrait',width===390?100:220]]){await page.goto(base+file);const img=page.locator(selector+' img');await img.evaluate(el=>el.decode());const box=await img.boundingBox();const heading=await page.locator('h1').boundingBox();await page.evaluate(()=>document.fonts.ready);const cls=await page.evaluate(()=>{const shifts=[...window.layoutShifts].sort((a,b)=>a.startTime-b.startTime);let max=0,current=0,windowStart=0,last=0;for(const entry of shifts){if(current>0&&entry.startTime-last<1000&&entry.startTime-windowStart<=5000){current+=entry.value;}else{current=entry.value;windowStart=entry.startTime;}last=entry.startTime;max=Math.max(max,current);}return max;});report.checks.push({name:`${file} ${width}px measured initial CLS`,status:cls<0.1?'Passed':'Failed',value:cls});assert(cls<0.1,'initial CLS threshold');assert(box.width<=max+1);assert(Math.abs(box.width/box.height-1348/1728)<0.01);assert(box.x+box.width<=heading.x);assert(box.y<heading.y+heading.height);if(width===390){assert(box.width>=86&&box.width<=96,'portrait target width');const intro=await page.locator('.hero-intro').boundingBox();assert(box.y+box.height<intro.y+intro.height+4);}}});
      await check(`platforms and social fallback ${width}px`,async()=>{await page.goto(base+'vision.html');assert(await page.locator('[id="platform-2026"]').count());assert.match(await page.locator('[id="platform-2026"]').innerText(),/正式選舉公報尚未取得/);await page.goto(base+'index.html');assert(await page.locator('.facebook-page-name').isVisible());});
      await check(`local resources and JS exceptions ${width}px`,async()=>{for(const file of pages){await page.goto(base+file);const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.waitForTimeout(5);assert.equal(errors.length,0,file);}});
    }
  }
  await context.setJavaScriptEnabled(false);await page.setViewportSize({width:390,height:844});
  await check('no JavaScript: navigation, FAQ, bank information',async()=>{await page.goto(base+'political-donation.html');assert(await page.locator('#navigation').isVisible());assert(await page.locator('.donation-account-number').isVisible());assert(await page.locator('summary').first().isVisible());});
  await check('no JavaScript: vision.html',async()=>{await page.goto(base+'vision.html');assert(await page.locator('main').isVisible());assert(await page.locator('[id="platform-2026"]').isVisible());});
  await check('no JavaScript: achievements.html',async()=>{await page.goto(base+'achievements.html');assert(await page.locator('#case-list').isVisible());assert((await page.locator('[data-case]').count())===items.length);});
  await context.close();
}finally{if(browser)await browser.close();server.kill('SIGTERM');await writeFile(new URL('browser-report.json',output),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
