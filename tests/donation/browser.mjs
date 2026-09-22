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
const base = 'http://127.0.0.1:8765/';
const report = { scope: 'Full-site candidate QA', checks: [], failures: [], externalResources: 'Blocked deliberately; third-party live availability is a separate manual check.' };
let browser;

async function check(name, fn) {
  try {
    const value = await fn();
    report.checks.push({ name, status: 'Passed', ...(value === undefined ? {} : { value }) });
  } catch (error) {
    report.checks.push({ name, status: 'Failed', error: String(error) });
    report.failures.push(name);
  }
}

function largestCls(shifts) {
  const ordered = [...shifts].sort((a, b) => a.startTime - b.startTime);
  let max = 0, current = 0, windowStart = 0, last = 0;
  for (const entry of ordered) {
    if (current > 0 && entry.startTime - last < 1000 && entry.startTime - windowStart <= 5000) current += entry.value;
    else { current = entry.value; windowStart = entry.startTime; }
    last = entry.startTime;
    max = Math.max(max, current);
  }
  return max;
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    window.layoutShifts = [];
    new PerformanceObserver(list => window.layoutShifts.push(...list.getEntries().filter(x => !x.hadRecentInput))).observe({ type: 'layout-shift', buffered: true });
  });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  const pages = (await readdir(root)).filter(name => name.endsWith('.html')).sort();
  const items = JSON.parse(await readFile(new URL('../../data/achievements.json', import.meta.url))).filter(item => item.status !== '待核驗');

  for (const width of [1440, 1100, 1024, 780, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.goto(base + 'political-donation.html');

    await check(`donation ${width}px: account first, nav contract and no portrait`, async () => {
      assert.equal(await page.locator('.donation-portrait,picture').count(), 0);
      const account = await page.locator('.donation-account-number').boundingBox();
      assert(account && account.y + account.height < 844);
      assert.equal(await page.locator('#navigation .nav-group').count(), 5);
      assert.equal(await page.locator('#navigation a').first().getAttribute('href'), 'service.html');
      assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'), 'service.html#monthly-heading');
    });

    await check(`donation ${width}px: no horizontal overflow`, async () => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });

    await check(`donation ${width}px: keyboard FAQ and focus`, async () => {
      const summary = page.locator('main summary').first();
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('main details').first().getAttribute('open'), '');
      assert(await summary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
      await page.keyboard.press('Enter');
    });

    if (width === 390) await check('mobile menu: Enter, Escape, focus return and election link', async () => {
      const toggle = page.locator('.menu-toggle');
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await toggle.getAttribute('aria-label'), '關閉主要選單');
      assert(await page.locator('main').evaluate(el => el.inert));
      assert(await page.locator('#navigation a[href="political-donation.html"]').isVisible());
      assert(await page.locator('#navigation a[href="election.html"]').isVisible());
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle.getAttribute('aria-label'), '開啟主要選單');
      assert.equal(await page.locator('main').evaluate(el => el.inert), false);
      assert(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      assert.equal(await page.locator('#navigation').evaluate(el => getComputedStyle(el).position), 'fixed');
      assert.equal(await page.locator('#navigation').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
      await page.locator('.menu-backdrop').click({ position: { x: 4, y: 4 } });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    });

    await check(`donation ${width}px: axe WCAG2 A/AA`, async () => {
      for (const summary of await page.locator('main summary').all()) await summary.click();
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      await writeFile(new URL(`axe-donation-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    });
  }

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });

    await check(`all pages ${width}px: navigation, layout and core accessibility`, async () => {
      for (const file of pages) {
        const pageErrors = [];
        const localFailures = [];
        const onError = error => pageErrors.push(String(error));
        const onFailed = request => { if (new URL(request.url()).hostname === '127.0.0.1') localFailures.push(request.url()); };
        page.on('pageerror', onError);
        page.on('requestfailed', onFailed);
        await page.goto(base + file);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: horizontal overflow`);
        assert.equal(await page.locator('#navigation a[href$="political-donation.html"]').count(), 1, `${file}: donation nav`);
        assert.equal(await page.locator('#navigation a[href$="election.html"]').count(), 1, `${file}: election nav`);
        assert.equal(await page.locator('#navigation a[href$="press.html"]').count(), 1, `${file}: press nav`);
        assert.equal(await page.locator('#navigation .nav-group').count(),5,`${file}: grouped navigation`);
        assert.equal((await page.locator('#navigation a').first().getAttribute('href')).replace(/^\//,''), 'service.html', `${file}: service first`);
        assert.equal((await page.locator('#navigation a').nth(1).getAttribute('href')).replace(/^\//,''), 'service.html#monthly-heading', `${file}: lawyer order`);
        assert.equal(await page.locator('#navigation a[href$="gallery.html"]').count(), 0, `${file}: gallery nav`);
        assert.equal(await page.locator('#navigation a[href$="activities.html"]').textContent(), '公開行程與活動', `${file}: activities nav`);
        for (const href of ['tel:+88678212536','./','https://line.me/R/ti/p/@yve2766q','https://www.facebook.com/hwcfs/','https://www.instagram.com/huiwen.ifs/','https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ','https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==']) {
          assert(await page.locator('footer a').evaluateAll((els, target) => els.some(a => a.href === new URL(target,document.baseURI).href), href), `${file}: footer ${href}`);
        }
        if (file.startsWith('achievement-')) {
          const text = await page.locator('main').innerText();
          assert(!/紀錄補充|資料與追蹤|並非已完成證明|尚未取得足以|本頁保留議題索引|待核驗|資料核驗狀態|資料查核|來源邊界|不混為完成|正式選舉公報尚未取得/.test(text), `${file}: public copy`);
        }
        const core = ['index.html','about.html','achievements.html','vision.html','news.html','press.html','activities.html','gallery.html','service.html','petition.html','political-donation.html','election.html','404.html','achievement-wende-school-center.html'];
        if (core.includes(file)) {
          const axe = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
          const serious = axe.violations.filter(v => ['serious','critical'].includes(v.impact));
          await writeFile(new URL(`axe-${file}-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
          assert.deepEqual(serious.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `${file}: axe`);
        }
        assert.deepEqual(pageErrors, [], `${file}: page errors`);
        assert.deepEqual(localFailures, [], `${file}: local request failures`);
        page.off('pageerror', onError);
        page.off('requestfailed', onFailed);
      }
    });

    await check(`homepage ${width}px: portrait first, civic entry and CLS`, async () => {
      await page.goto(base + 'index.html');
      await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#campaign-countdown')?.textContent || ''));
      const electionStatus = page.locator('.hero-election-status');
      assert.match(await electionStatus.innerText(), /距離投票日/);
      assert.match(await electionStatus.innerText(), /2026\.11\.28/);
      assert.doesNotMatch(await page.locator('main').innerText(), /候選人姓名號次抽籤|10\/23/);
      assert.equal(await electionStatus.evaluate(el => el.previousElementSibling?.tagName), 'H1');
      const img = page.locator('.hero-portrait img');
      await img.evaluate(el => el.decode());
      const box = await img.boundingBox();
      const heading = await page.locator('.hero-copy h1').boundingBox();
      assert.equal(await page.locator('h1').count(),1);
      assert(await page.locator('.civic-search').isVisible());
      assert.equal(await page.locator('main > section').first().getAttribute('class'), 'hero');
      assert((await page.locator('.hero').boundingBox()).y < (await page.locator('.civic-lead').boundingBox()).y);
      assert(box && heading);
      assert(Math.abs(box.width / box.height - 1348 / 1728) < 0.01);
      assert(box.x + box.width <= heading.x);
      if (width === 390) assert(box.width >= 140 && box.width <= 160);
      const hero = await page.locator('.hero-grid').boundingBox();
      const header = await page.locator('.site-header').boundingBox();
      assert(hero && header);
      assert(hero.x >= header.x, 'hero stays within the page header alignment');
      assert(hero.x + hero.width <= header.x + header.width, 'hero stays within the page header width');
      await page.evaluate(() => document.fonts.ready);
      const cls = await page.evaluate(largest => largest(window.layoutShifts), largestCls.toString()).catch(async () => page.evaluate(() => {
        const shifts = [...window.layoutShifts].sort((a,b)=>a.startTime-b.startTime); let max=0,current=0,start=0,last=0;
        for(const e of shifts){ if(current>0&&e.startTime-last<1000&&e.startTime-start<=5000) current+=e.value; else {current=e.value;start=e.startTime;} last=e.startTime;max=Math.max(max,current); } return max;
      }));
      assert(cls < 0.1, `homepage CLS ${cls}`);
      await page.screenshot({ path: fileURLToPath(new URL(`index-${width}.png`, output)), fullPage: true });
    });

    await check(`achievement search filters and pagination ${width}px`, async () => {
      await page.goto(base + 'achievements.html');
  await page.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await page.waitForFunction(()=>!!window.HuiwenCases);
      const visible = () => page.locator('[data-case]:visible').count();
      assert.equal(await visible(), Math.min(10, items.length));
      await page.locator('#case-search').fill('文龍');
      assert((await visible()) > 0);
      await page.locator('#reset-map-filters').click();
      const village = items.find(item => item.villages.length).villages[0];
      await page.locator('#village-filter').selectOption('v:' + village);
      assert.equal(await visible(), Math.min(10, items.filter(item => item.villages.includes(village)).length));
      await page.locator('#reset-map-filters').click();
      if (await page.locator('.advanced-filters').getAttribute('open') === null) await page.locator('.advanced-filters > summary').click();
      await page.locator('#subcategory-filter').selectOption({ label: '寵物' });
      assert((await visible()) > 0);
      await page.locator('#reset-map-filters').click();
      if (items.length > 10) {
        await page.getByRole('button', { name: '第 2 頁' }).click();
        assert.equal(await page.locator('.case-page-button[aria-current="page"]').innerText(), '2');
      }
      if (await page.locator('.advanced-filters').getAttribute('open') !== null) await page.locator('.advanced-filters > summary').click();
      await page.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await page.locator('#achievement-map').scrollIntoViewIfNeeded();
      await page.locator('.leaflet-container').waitFor({state:'visible'});
      assert(await page.locator('.leaflet-container').isVisible());
      if (width === 390) {
        const controls = await page.locator('.map-controls').boundingBox();
        const map = await page.locator('#achievement-map').boundingBox();
        assert(controls && controls.height < 350, `mobile map filters too tall: ${controls?.height}`);
        assert(map && map.height >= 520, `mobile map too short: ${map?.height}`);
      }
    });

    await check(`news media controls ${width}px`, async () => {
      await page.goto(base + 'news.html');
      await page.locator('#news-search').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.news-media-grid > *').count(), 10);
      assert.equal(await page.locator('#news-sort option').allTextContents().then(x => x.join('|')), '重要優先|日期優先（新到舊）');
      assert((await page.locator('.news-media-grid .news-tag').count()) > 0);
      await page.locator('[data-filter-menu="topic"] summary').click();
      await page.locator('[data-filter-menu="topic"] input[value="education"]').check();
      await page.locator('[data-filter-menu="topic"] input[value="transport"]').check();
      assert.match(await page.locator('[data-news-count]').innerText(), /主題 2/);
      await page.locator('[data-filter-menu="tag"] summary').click();
      await page.locator('[data-filter-menu="tag"] input[value="鳳山車站"]').check();
      await page.locator('[data-filter-menu="tag"] input[value="特教"]').check();
      assert.match(await page.locator('[data-news-count]').innerText(), /# 2/);
      assert((await page.locator('.news-media-grid > *').count()) > 0);
      await page.locator('[data-filter-clear]').click();
      await page.locator('#news-search').fill('鳳山');
      assert((await page.locator('.news-media-grid > *').count()) > 0);
      assert.equal(await page.locator('.news-press-card').count(), 0);
    });

    await check(`press release controls ${width}px`, async () => {
      await page.goto(base + 'press.html');
      await page.locator('#press-search').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.news-press-grid > *').count(), 10);
      assert.equal(await page.locator('#press-sort option').allTextContents().then(x => x.join('|')), '重要優先|日期優先（新到舊）');
      assert((await page.locator('.news-press-grid .news-tag').count()) > 0);
      await page.locator('[data-filter-menu="topic"] summary').click();
      await page.locator('[data-filter-menu="topic"] input[value="education"]').check();
      await page.locator('[data-filter-menu="topic"] input[value="livelihood"]').check();
      await page.locator('[data-filter-menu="tag"] summary').click();
      await page.locator('[data-filter-menu="tag"] input[value="特教"]').check();
      await page.locator('[data-filter-menu="tag"] input[value="毛動力"]').check();
      assert((await page.locator('.news-press-grid > *').count()) > 0);
      assert((await page.locator('.news-press-grid > *').count()) <= 10);
      assert.match(await page.locator('[data-press-count]').innerText(), /主題 2.*# 2/);
      await page.locator('[data-filter-clear]').click();
      await page.locator('#press-search').fill('特教');
      assert((await page.locator('.news-press-grid > *').count()) > 0);
    });

    await check(`service/about/activities regressions ${width}px`, async () => {
      await page.goto(base + 'service.html');
      const legal = await page.locator('.legal-section').boundingBox();
      const monthly = await page.locator('.schedule-text').boundingBox();
      assert(legal && monthly && monthly.y < legal.y);
      assert.equal(await page.locator('.monthly-schedule a[href*="canva.com"]').count(), 0);
      await page.locator('.schedule-original > summary').click();
      await page.locator('.schedule-auto-embed').scrollIntoViewIfNeeded();
      await page.locator('.schedule-auto-embed iframe').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.schedule-auto-embed iframe').count(), 1, 'lawyer schedule should auto-load when it enters the viewport');
      assert.equal(await page.locator('.schedule-auto-embed iframe').getAttribute('title'), '每月公益律師諮詢時間表');
      assert.equal(await page.locator('.schedule-auto-embed a[href^="https://www.canva.com/design/"]').count(), 1, 'lawyer schedule keeps a direct-link fallback');
      assert(await page.locator('.schedule-auto-embed [data-embed-load]').isVisible(), 'lawyer schedule keeps a reload fallback');
      assert((await page.locator('.schedule-phone-cta').boundingBox()).height >= 44);
      await page.goto(base + 'about.html');
      for (const href of ['https://www.facebook.com/hwcfs/','https://www.threads.com/@huiwen.ifs','https://www.kcc.gov.tw/MemberInfo_New.aspx?msn=2215&n=39&sms=9028']) assert.equal(await page.locator(`.social-grid a[href="${href}"]`).count(), 1);
      assert.equal(await page.locator('.social-grid a').count(), 3);
      await page.goto(base + 'activities.html');
      assert(await page.getByRole('heading', { name: '公開行程與活動', exact: true }).isVisible());
      assert.equal(await page.locator('.event-empty a').count(), 0);
    });

    await check(`petition privacy boundary ${width}px`, async () => {
      await page.goto(base + 'petition.html');
      assert.equal(await page.locator('form,input,iframe').count(), 0);
      assert.equal(await page.locator('a[href*="notion"]').count(), 1);
    });
  }

  await context.close();

  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const nojsPage = await nojs.newPage();
  await check('no JavaScript: political donation remains readable', async () => {
    await nojsPage.goto(base + 'political-donation.html');
    assert(await nojsPage.locator('.brand[href="./"]').isVisible());
    await nojsPage.locator('main summary').first().click();
    assert.equal(await nojsPage.locator('main details').first().getAttribute('open'), '');
    assert(await nojsPage.getByText('752200636579', { exact: true }).isVisible());
    assert.equal(await nojsPage.locator('form,input,iframe').count(), 0);
    assert(await nojsPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  for (const file of ['vision.html','achievements.html','election.html','news.html','press.html']) {
    await check(`no JavaScript: ${file}`, async () => {
      await nojsPage.goto(base + file);
      assert(await nojsPage.locator('h1').isVisible());
      if (file === 'vision.html') assert(await nojsPage.locator('#platform-2005').first().isVisible());
      if (file === 'achievements.html') assert(await nojsPage.locator('[data-case]').first().isVisible());
      if (file === 'election.html') assert.match(await nojsPage.locator('main').innerText(), /2026\/10\/23|候選人姓名號次抽籤/);
      if (file === 'news.html') assert((await nojsPage.locator('.news-report-card').count()) >= 20);
      if (file === 'press.html') assert.equal(await nojsPage.locator('.news-press-card').count(), 17);
    });
  }
  await nojs.close();
} catch (error) {
  report.failures.push(String(error));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await writeFile(new URL('browser-report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
