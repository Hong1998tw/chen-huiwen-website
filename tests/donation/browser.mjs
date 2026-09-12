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
      assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'), 'political-donation.html');
      assert.equal(await page.locator('#navigation a').nth(2).getAttribute('href'), 'election.html');
      assert.equal(await page.locator('#navigation a').nth(3).getAttribute('href'), 'service.html#monthly-heading');
    });

    await check(`donation ${width}px: no horizontal overflow`, async () => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });

    await check(`donation ${width}px: keyboard FAQ and focus`, async () => {
      const summary = page.locator('summary').first();
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('details').first().getAttribute('open'), '');
      assert(await summary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
      await page.keyboard.press('Enter');
    });

    if (width === 390) await check('mobile menu: Enter, Escape, focus return and election link', async () => {
      const toggle = page.getByRole('button', { name: '選單', exact: true });
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#navigation a[href="political-donation.html"]').isVisible());
      assert(await page.locator('#navigation a[href="election.html"]').isVisible());
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      assert.equal(await page.locator('#navigation').evaluate(el => getComputedStyle(el).position), 'fixed');
      assert.equal(await page.locator('#navigation').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
      await page.locator('.menu-backdrop').click({ position: { x: 4, y: 4 } });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    });

    await check(`donation ${width}px: axe WCAG2 A/AA`, async () => {
      for (const summary of await page.locator('summary').all()) await summary.click();
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
        assert.equal(await page.locator('#navigation a[href="political-donation.html"]').count(), 1, `${file}: donation nav`);
        assert.equal(await page.locator('#navigation a[href="election.html"]').count(), 1, `${file}: election nav`);
        assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'), 'political-donation.html', `${file}: donation order`);
        assert.equal(await page.locator('#navigation a').nth(2).getAttribute('href'), 'election.html', `${file}: election order`);
        assert.equal(await page.locator('#navigation a').nth(3).getAttribute('href'), 'service.html#monthly-heading', `${file}: lawyer order`);
        assert.equal(await page.locator('#navigation a[href="gallery.html"]').count(), 0, `${file}: gallery nav`);
        assert.equal(await page.locator('#navigation a[href="activities.html"]').innerText(), '公開行程與活動', `${file}: activities nav`);
        for (const href of ['tel:+88678212536','./','https://line.me/R/ti/p/@yve2766q','https://www.facebook.com/hwcfs/','https://www.instagram.com/huiwen.ifs/','https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ','https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==']) {
          assert(await page.locator('footer a').evaluateAll((els, target) => els.some(a => a.getAttribute('href') === target), href), `${file}: footer ${href}`);
        }
        if (file.startsWith('achievement-')) {
          const text = await page.locator('main').innerText();
          assert(!/紀錄補充|資料與追蹤|並非已完成證明|尚未取得足以|本頁保留議題索引|待核驗|資料核驗狀態|資料查核|來源邊界|不混為完成|正式選舉公報尚未取得/.test(text), `${file}: public copy`);
        }
        const core = ['index.html','about.html','achievements.html','vision.html','news.html','activities.html','gallery.html','service.html','petition.html','political-donation.html','election.html','404.html','achievement-wende-school-center.html'];
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

    await check(`homepage ${width}px: election entry, portrait and CLS`, async () => {
      await page.goto(base + 'index.html');
      await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#campaign-countdown')?.textContent || ''));
      assert.match(await page.locator('.campaign-entry').innerText(), /勝選倒數/);
      assert.match(await page.locator('.campaign-entry').innerText(), /候選人姓名號次抽籤/);
      const img = page.locator('.hero-portrait img');
      await img.evaluate(el => el.decode());
      const box = await img.boundingBox();
      const heading = await page.locator('h1').boundingBox();
      assert(box && heading);
      assert(Math.abs(box.width / box.height - 1348 / 1728) < 0.01);
      assert(box.x + box.width <= heading.x);
      if (width === 390) assert(box.width >= 140 && box.width <= 170);
      const campaign = await page.locator('.campaign-entry').boundingBox();
      const header = await page.locator('.site-header').boundingBox();
      assert(Math.abs(box.x - campaign.x) <= 1, 'portrait aligns with the content below');
      assert(Math.abs(header.x - campaign.x) <= 1, 'header and content share their left edge');
      assert(Math.abs(header.width - campaign.width) <= 1, 'header and content share their width');
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
      const visible = () => page.locator('[data-case]:visible').count();
      assert.equal(await visible(), Math.min(10, items.length));
      await page.locator('#case-search').fill('文龍');
      assert((await visible()) > 0);
      await page.locator('#reset-map-filters').click();
      const village = items.find(item => item.villages.length).villages[0];
      await page.locator('#village-filter').selectOption('v:' + village);
      assert.equal(await visible(), Math.min(10, items.filter(item => item.villages.includes(village)).length));
      await page.locator('#reset-map-filters').click();
      await page.locator('#subcategory-filter').selectOption({ label: '寵物' });
      assert((await visible()) > 0);
      await page.locator('#reset-map-filters').click();
      if (items.length > 10) {
        await page.getByRole('button', { name: '第 2 頁' }).click();
        assert.equal(await page.locator('.case-page-button[aria-current="page"]').innerText(), '2');
      }
      assert(await page.locator('.leaflet-container').isVisible());
    });

    await check(`news unified controls ${width}px`, async () => {
      await page.goto(base + 'news.html');
      await page.locator('#unified-news-search').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.news-unified-grid > *').count(), 10);
      assert.equal(await page.locator('#news-sort option').allTextContents().then(x => x.join('|')), '重要優先|日期優先（新到舊）');
      await page.locator('#unified-news-search').fill('鳳山');
      assert((await page.locator('.news-unified-grid > *').count()) > 0);
    });

    await check(`service/about/activities regressions ${width}px`, async () => {
      await page.goto(base + 'service.html');
      const legal = await page.locator('.legal-section').boundingBox();
      const monthly = await page.locator('.monthly-schedule').boundingBox();
      assert(legal && monthly && legal.y < monthly.y);
      assert.equal(await page.locator('.monthly-schedule a[href*="canva.com"]').count(), 0);
      assert((await page.locator('.schedule-phone-cta').boundingBox()).height >= 60);
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
    assert(await nojsPage.locator('#navigation a[href="./"]').isVisible());
    await nojsPage.locator('summary').first().click();
    assert.equal(await nojsPage.locator('details').first().getAttribute('open'), '');
    assert(await nojsPage.getByText('752200636579', { exact: true }).isVisible());
    assert.equal(await nojsPage.locator('form,input,iframe').count(), 0);
    assert(await nojsPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  for (const file of ['vision.html','achievements.html','election.html']) {
    await check(`no JavaScript: ${file}`, async () => {
      await nojsPage.goto(base + file);
      assert(await nojsPage.locator('h1').isVisible());
      if (file === 'vision.html') assert(await nojsPage.locator('#platform-2005').first().isVisible());
      if (file === 'achievements.html') assert(await nojsPage.locator('[data-case]').first().isVisible());
      if (file === 'election.html') assert.match(await nojsPage.locator('main').innerText(), /2026\/10\/23|候選人姓名號次抽籤/);
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
