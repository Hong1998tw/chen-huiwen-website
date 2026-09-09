import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./results/', import.meta.url);
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base = 'http://127.0.0.1:8765/';
const report = { scope: 'Full-site candidate QA', checks: [], failures: [], externalResources: 'Blocked deliberately; third-party live availability is a separate manual check.' };
let browser;
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, status: 'Passed' }); }
  catch (e) { report.checks.push({ name, status: 'Failed', error: String(e) }); report.failures.push(name); }
}
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const pages = (await readdir(root)).filter(n => n.endsWith('.html'));
  const items = JSON.parse(await readFile(new URL('../../data/achievements.json', import.meta.url)));
  for (const width of [1440, 1100, 1024, 780, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, deviceScaleFactor: 1 });
    // Exercise usable fallback when embeds and map tile providers are unreachable.
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(() => {
      window.layoutShifts=[];
      new PerformanceObserver(list=>{
        for(const entry of list.getEntries()) {
          if(!entry.hadRecentInput) window.layoutShifts.push({value:entry.value,startTime:entry.startTime});
        }
      }).observe({type:'layout-shift',buffered:true});
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const localFailures = [];
    page.on('response', r => { if (r.url().startsWith(base) && r.status() >= 400) localFailures.push(r.url()); });
    await page.goto(base + 'political-donation.html');
    await check(`account first and no portrait ${width}px`,async()=>{
      assert.equal(await page.locator('.donation-portrait,picture').count(),0);
      const account=await page.locator('.donation-account-number').boundingBox();assert(account.y+account.height<844);
      assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'),'political-donation.html');
    });
    await check(`donation ${width}px: no overflow`, async () => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
    });
    await check(`donation ${width}px: keyboard FAQ and focus`, async () => {
      const summary = page.locator('summary').first();
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('details').first().getAttribute('open'), '');
      assert(await summary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
      await page.keyboard.press('Enter');
    });
    if (width === 390) await check('mobile menu: Enter, Escape, focus return', async () => {
      const toggle = page.getByRole('button', { name: '選單', exact: true });
      await toggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#navigation a[href="political-donation.html"]').isVisible());
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      assert.equal(await page.locator('#navigation').evaluate(el=>getComputedStyle(el).position),'fixed');
      assert.equal(await page.locator('#navigation').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
      await page.locator('.menu-backdrop').click({position:{x:4,y:4}});
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      assert(await toggle.evaluate(el=>el===document.activeElement));
    });
    await check(`donation ${width}px: axe WCAG2 A/AA`, async () => {
      // Open every FAQ to include hidden content in accessibility coverage.
      for (const summary of await page.locator('summary').all()) await summary.click();
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      await writeFile(new URL(`axe-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    });
    if ([1440,390].includes(width)) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: fileURLToPath(new URL(`donation-${width}.png`, output)), fullPage: true });
      await page.screenshot({ path: fileURLToPath(new URL(`donation-top-${width}.png`, output)) });
      await check(`all pages ${width}px: navigation and layout`, async () => {
        for (const file of pages) {
          await check(`${file} ${width}px: layout and accessibility`, async()=>{
          await page.goto(base + file);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: overflow`);
          assert.equal(await page.locator('#navigation a[href="political-donation.html"]').count(), 1, file);
          assert.equal(await page.locator('#navigation a').nth(2).getAttribute('href'),'service.html#monthly-heading');
          assert.equal(await page.locator('#navigation a[href="gallery.html"]').count(),0);
          assert.equal(await page.locator('#navigation a[href="activities.html"]').innerText(),'活動公告');
          for(const target of ['tel:+88678212536','./','https://line.me/R/ti/p/@yve2766q','https://www.facebook.com/hwcfs/','https://www.instagram.com/huiwen.ifs/','https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ','https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==']) assert(await page.locator('footer a').evaluateAll((els,href)=>els.some(a=>a.getAttribute('href')===href),target));
          assert.equal(await page.locator('footer a[href="political-donation.html"]').count(), 1, file);
          if(file.startsWith('achievement-')) {
            const bodyText=await page.locator('main').innerText();
            assert(!/紀錄補充|資料與追蹤|並非已完成證明|尚未取得足以|本頁保留議題索引|待核驗/.test(bodyText),file+': editorial copy');
          }
          const core = ['index.html','about.html','achievements.html','vision.html','news.html','activities.html','gallery.html','service.html','petition.html','political-donation.html','404.html','achievement-wende-school-center.html'];
          if (core.includes(file)) {
            const axe = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
            const serious = axe.violations.filter(v => ['serious','critical'].includes(v.impact));
            await writeFile(new URL(`axe-${file}-${width}.json`, output), JSON.stringify(axe.violations,null,2));
            assert.deepEqual(serious.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`${file}: axe`);
          }
          if (['index.html','political-donation.html','vision.html','achievements.html','activities.html','achievement-wende-school-center.html','achievement-huangpu-visitor-center.html'].includes(file)) {
            await page.screenshot({path:fileURLToPath(new URL(`${file}-${width}.png`,output)),fullPage:true});
          }
          });
        }
      });
      await check(`homepage CTA ${width}px and back navigation`, async () => {
        await page.goto(base + 'index.html');
        if(width===390) await page.getByRole('button',{name:'選單',exact:true}).click();
        await page.locator('#navigation a[href="political-donation.html"]').click();
        assert(page.url().endsWith('/political-donation.html'));
        await page.getByRole('link', { name: '先看捐贈須知', exact: true }).click();
        assert(page.url().endsWith('#eligibility'));
        await page.getByRole('link', { name: '查看專戶資訊' }).click();
        assert(page.url().endsWith('#account'));
        await page.getByRole('link', { name: '← 回官網首頁' }).click();
        assert(page.url() === base);
        await page.goBack(); assert(page.url().includes('/political-donation.html'));
      });
      await check(`map filters ${width}px against source`, async () => {
        await page.goto(base + 'achievements.html');
        const count = () => page.locator('[data-case]:visible').count();
        assert.equal(await count(), items.length);
        await page.locator('#case-search').fill('文龍');
        assert((await count()) > 0 && (await count()) < items.length);
        await page.locator('#reset-map-filters').click();
        for (const [selector, key] of [['#category-filter','categories'], ['#status-filter','status']]) {
          const value = Array.isArray(items[0][key]) ? items[0][key][0] : items[0][key];
          await page.locator(selector).selectOption(value);
          const expected = items.filter(x => Array.isArray(x[key]) ? x[key].includes(value) : x[key] === value).length;
          assert.equal(await count(), expected);
          await page.locator('#reset-map-filters').click();
        }
        const village = items.find(x => x.villages.length).villages[0];
        await page.locator('#village-filter').selectOption('v:' + village);
        assert.equal(await count(), items.filter(x => x.villages.includes(village)).length);
        await page.locator('#reset-map-filters').click();
        const scope=items.find(x=>x.scope!=='鳳山區').scope;
        await page.locator('#village-filter').selectOption('s:'+scope);
        assert.equal(await count(),items.filter(x=>x.scope===scope).length);
        await page.locator('#reset-map-filters').click();
        assert.equal(await count(), items.length);
        assert(await page.locator('.leaflet-container').isVisible());
      });
      await check(`portraits ${width}px: scale, ratio, no collision`, async () => {
        for (const [file,selector,max] of [['index.html','.hero-portrait',width===390?100:220]]) {
          await page.goto(base+file);
          const img=page.locator(selector+' img'); await img.evaluate(el=>el.decode());
          const box=await img.boundingBox(); const heading=await page.locator('h1').boundingBox();
          await page.evaluate(()=>document.fonts.ready);
          const cls=await page.evaluate(()=>{
            // Current Core Web Vitals CLS is the largest session window, not the legacy lifetime sum.
            // A session window allows gaps under 1s and lasts at most 5s.
            const shifts=[...window.layoutShifts].sort((a,b)=>a.startTime-b.startTime);
            let max=0,current=0,windowStart=0,last=0;
            for(const entry of shifts){
              if(current>0 && entry.startTime-last<1000 && entry.startTime-windowStart<=5000){
                current+=entry.value;
              }else{
                current=entry.value;
                windowStart=entry.startTime;
              }
              last=entry.startTime;
              max=Math.max(max,current);
            }
            return max;
          });
          report.checks.push({name:`${file} ${width}px measured initial CLS`,status:cls<0.1?'Passed':'Failed',value:cls});
          assert(cls<0.1,'initial CLS threshold');
          assert(box.width<=max+1);assert(Math.abs(box.width/box.height-1348/1728)<0.01);
          assert(box.x+box.width<=heading.x); assert(box.y<heading.y+heading.height);
          if(width===390){
            assert(box.width>=86&&box.width<=96,'portrait target width');
            const intro=await page.locator('.hero-intro').boundingBox();
            assert(intro.width>325,'intro spans centered mobile width');
            assert(box.x>=28,'hero inset to the right');
            const account=await page.locator('.home-account-number').boundingBox();
            const contact=await page.locator('.home-contact').boundingBox();
            assert(contact.y+contact.height<account.y,'service contact precedes donation');
            assert.equal(await page.locator('.home-contact a[href="petition.html"]').count(),1);
            assert.equal(await page.locator('.home-contact a[href="https://line.me/R/ti/p/@yve2766q"]').count(),1);
            for(const a of await page.locator('.home-contact-actions a').all()) assert((await a.boundingBox()).height>=48);
            assert.equal(await page.locator('.quick-services,.explore-grid,.news-grid,.hero .actions').count(),0);
            assert.equal(await page.locator('h1').innerText(),'慧文會武\n會做事');
            await page.locator('.home-donation-notes').click();
            assert(page.url().endsWith('political-donation.html#eligibility'));
            await page.goBack();
          }
          assert.equal(await img.evaluate(el=>getComputedStyle(el).objectFit),'contain');
          assert((await img.evaluate(el=>el.currentSrc)).match(/\.(avif|webp)$/));
        }
      });
      await check(`platforms and social fallback ${width}px`, async()=>{
        await page.goto(base+'vision.html');
        for(const year of [2005,2010,2014,2018,2022]) assert(await page.locator('#platform-'+year).isVisible());
        const election=page.locator('#platform-2022 details');
        assert.equal(await election.getAttribute('open'),null);
        await election.locator('summary').focus();await page.keyboard.press('Enter');
        assert.equal(await election.getAttribute('open'),'');
        assert(await election.locator('h3').first().isVisible());
        await page.keyboard.press('Enter');assert.equal(await election.getAttribute('open'),null);
        await page.goto(base);assert.equal(await page.locator('iframe').count(),1);
        assert.equal(await page.locator('iframe').getAttribute('loading'),'eager');
        const frame=page.locator('.home-facebook iframe');
        const frameBox=await frame.boundingBox();
        assert(frameBox.width>=(width===390?350:499));
        assert.equal(new URL(await frame.getAttribute('src')).searchParams.get('small_header'),'false');
        assert.equal(new URL(await frame.getAttribute('src')).searchParams.get('hide_cover'),'true');
        const hours=await page.locator('.home-office-hours').boundingBox();
        const contacts=await page.locator('.home-contact-info').boundingBox();
        assert(hours.x>=contacts.x+contacts.width,'office hours to the right of contact information');
        assert((await page.locator('.home-office-hours').innerText()).includes('09:00–12:00'));
        assert((await page.locator('.home-office-hours').innerText()).includes('14:00–18:00'));
        assert(await page.getByText('陳慧文 高雄市議員',{exact:true}).isVisible());
        const hero=await page.locator('.hero-grid').boundingBox();
        assert(Math.abs(hero.x+hero.width/2-width/2)<2,'hero centered');
        assert.equal(await page.locator('#load-facebook,template#facebook-template').count(),0);
        assert(await page.getByRole('link',{name:'前往陳慧文 Facebook'}).isVisible());
        await page.goto(base+'activities.html');
        assert(await page.getByRole('heading',{name:'活動公告',exact:true}).isVisible());
        assert.equal(await page.locator('.content-card,.photo-grid').count(),0);
        await page.goto(base+'petition.html');
        assert.equal(await page.locator('form,input,iframe').count(),0);
        assert.equal(await page.locator('a[href="https://lihong-tw.notion.site/1ffbd1468054800b9940fbfde5fee74d"]').count(),1);
        assert.equal(await page.locator('a[href*="notion"]').count(),1);
        await page.goto(base+'gallery.html');
        const photo=page.locator('[data-lightbox]').first();await photo.focus();await page.keyboard.press('Enter');
        assert(await page.locator('#photo-dialog').isVisible());await page.keyboard.press('Escape');assert(!(await page.locator('#photo-dialog').isVisible()));
      });
      await check(`local resources and JS exceptions ${width}px`, async () => {
        assert.deepEqual(errors, []); assert.deepEqual(localFailures, []);
      });
    }
    await context.close();
  }
  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await nojs.newPage();
  await page.goto(base + 'political-donation.html');
  await check('no JavaScript: navigation, FAQ, bank information', async () => {
    assert(await page.locator('#navigation a[href="./"]').isVisible());
    await page.locator('summary').first().click();
    assert.equal(await page.locator('details').first().getAttribute('open'), '');
    assert(await page.getByText('752200636579', { exact: true }).isVisible());
    assert.equal(await page.locator('form,input,iframe').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  for (const file of ['vision.html','achievements.html']) {
    await page.goto(base+file);
    await check(`no JavaScript: ${file}`,async()=>{
      assert(await page.locator('h1').isVisible());
      assert(await page.locator(file==='vision.html'?'#platform-2005':'[data-case]').first().isVisible());
    });
  }
  await nojs.close();
} catch (e) { report.failures.push(String(e)); }
finally {
  if (browser) await browser.close();
  server.kill();
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}