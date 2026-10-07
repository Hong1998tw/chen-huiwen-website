import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startStaticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const results = join(root, 'tests/donation/results/ux-acceptance');
await mkdir(results, { recursive: true });
const server = await startStaticServer({ root, compression: 'none' });
const base = server.url;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
const page = await context.newPage();
const jsErrors = [];
page.on('pageerror', error => jsErrors.push(String(error)));
const report = { base, checks: [], failures: [], viewports: [], zoomSourceViewports: { 'proposal 200% source viewport': { width: 590, height: 378 }, 'proposal 300% source viewport': { width: 393, height: 252 } }, browserZoomApplied: false, realDeviceTested: false, wcagCertification: false };

async function check(name, fn) {
  try { const detail = await fn(); report.checks.push({ name, status: 'passed', ...(detail || {}) }); }
  catch (error) { report.checks.push({ name, status: 'failed', error: String(error.stack || error) }); report.failures.push(name); }
}
async function assertNoOverflow(expectedWidth) {
  const result = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.equal(result.viewport, expectedWidth);
  assert(result.document <= expectedWidth, `horizontal overflow: ${JSON.stringify(result)}`);
  report.viewports.push({ path: new URL(page.url()).pathname, width: expectedWidth, scrollWidth: result.document });
  return result;
}

try {
  await page.goto(base + 'index.html');
  await page.locator('.hero-task-links a').first().waitFor();
  await check('homepage service, local-record and council task routes are directly available', async () => {
    assert.deepEqual(await page.locator('.hero-task-links a').evaluateAll(links => links.map(link => link.getAttribute('href'))), [
      'service.html#contact', 'achievements.html#case-results', 'council-records.html'
    ]);
    const order = await page.locator('#recent .home-recent-list > li').evaluateAll(rows => rows.map(row => row.dataset.homeRecentItem));
    assert.deepEqual(order, ['award', 'headquarters', 'local']);
    assert.match(await page.locator('#recent').innerText(), /獲選[\s\S]*總部成立[\s\S]*文德國小活動中心/);
    await page.screenshot({ path: join(results, 'homepage-desktop-1440x960.png'), fullPage: false });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + 'index.html');
  await check('390×844 homepage keeps task routes inside the first screen without overflow', async () => {
    await assertNoOverflow(390);
    const boxes = await page.locator('.hero-task-links a').evaluateAll(links => links.map(link => {
      const r = link.getBoundingClientRect();
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    }));
    assert.equal(boxes.length, 3);
    assert(boxes.every(box => box.left >= 0 && box.right <= 390 && box.top >= 0 && box.bottom <= 844));
    assert(boxes.every(box => box.width >= 44 && box.height >= 40));
    await page.screenshot({ path: join(results, 'homepage-390x844.png'), fullPage: false });
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(base + 'index.html');
  await page.getByRole('button', { name: '搜尋陳慧文官網' }).click();
  await check('global search gives matched content context and clear next actions', async () => {
    const dialog = page.locator('#global-search-dialog');
    const input = dialog.getByRole('searchbox', { name: '搜尋陳慧文官網' });
    await input.fill('文德國小');
    const result = dialog.locator('.global-search-result').filter({ hasText: '文德國小活動中心' }).first();
    await result.waitFor({ state: 'visible' });
    assert.match(await result.locator('.global-search-meta').innerText(), /地區：文德里.*最後紀錄：2026-09-01.*階段：持續追蹤/);
    assert.match(await result.locator('.global-search-reason').innerText(), /符合欄位/);
    for (const [query,target] of [
      ['文德國小活動中心','/achievement-wende-school-center.html'],
      ['文龍路','/achievement-wenlong-lane16.html'],
      ['法律諮詢','/service.html#monthly-heading'],
    ]) {
      await input.fill(query);
      await page.waitForFunction(({target})=>[...document.querySelectorAll('.global-search-result')].some(link=>{
        const url=new URL(link.href);
        return url.pathname.endsWith(target.split('#')[0])&&(!target.includes('#')||url.hash===target.slice(target.indexOf('#')));
      }),{target});
      const resultLinks=await dialog.locator('.global-search-result').evaluateAll(links=>links.map(link=>link.href));
      assert(resultLinks.some(href=>{
        const url=new URL(href);
        return url.pathname.endsWith(target.split('#')[0])&&(!target.includes('#')||url.hash===target.slice(target.indexOf('#')));
      }),`${query} should lead to ${target}`);
    }
    await input.fill('zzzz-ux-no-match');
    await dialog.locator('[data-search-empty]').waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('[data-search-empty] a[href*="explore.html"]').count(), 1);
    assert.equal(await dialog.locator('[data-search-empty] a[href*="service.html#contact"]').count(), 1);
    await dialog.locator('[data-search-clear]').click();
    assert.equal(await input.inputValue(), '');
  });

  for (const width of [320,427,640,1180,1440]) {
    const height = width === 1180 ? 757 : 900;
    await page.setViewportSize({ width, height });
    await page.goto(base + 'index.html');
    await page.locator('.hero-task-links a').first().waitFor();
    await check(`homepage reflows at ${width}px with all three task links visible and no horizontal overflow`, async () => {
      await assertNoOverflow(width);
      const boxes=await page.locator('.hero-task-links a').evaluateAll(links=>links.map(link=>{const r=link.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}));
      assert.equal(boxes.length,3);
      assert(boxes.every(box=>box.left>=0&&box.right<=width&&box.width>=44&&box.height>=40));
      assert(boxes.every(box=>box.bottom<=height));
    });
  }

  for(const viewport of [{width:590,height:378,label:'200% source viewport'},{width:393,height:252,label:'300% short viewport'}]){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto(base+'index.html');
    await page.locator('.hero-task-links a').first().waitFor();
    await check(`homepage reflows at ${viewport.width}×${viewport.height} CSS px (${viewport.label}) without fixed controls obscuring content`,async()=>{
      await assertNoOverflow(viewport.width);
      const layout=await page.evaluate(()=>({
        topline:getComputedStyle(document.querySelector('.topline')).display,
        header:getComputedStyle(document.querySelector('.site-header')).position,
        headerBottom:document.querySelector('.site-header').getBoundingClientRect().bottom,
        titleTop:document.querySelector('#hero-title').getBoundingClientRect().top,
        titleBottom:document.querySelector('#hero-title').getBoundingClientRect().bottom,
        actions:getComputedStyle(document.querySelector('.mobile-actions')).position,
      }));
      assert.equal(layout.topline,'none');
      assert.equal(layout.header,'relative');
      assert(layout.titleTop>=layout.headerBottom,'hero title must follow the compact header');
      await page.screenshot({path:join(results,`homepage-${viewport.width}x${viewport.height}.png`),fullPage:false});
      if(viewport.height<=360){
        assert.notEqual(layout.actions,'fixed','bottom actions must return to document flow in a short viewport');
        assert(layout.titleBottom<=viewport.height,'the homepage title must remain fully readable in the short viewport');
        await page.locator('.menu-toggle').click();
        const search=page.locator('#navigation .global-search-trigger');
        await search.waitFor({state:'visible'});
        await search.click();
        const input=page.getByRole('searchbox',{name:'搜尋陳慧文官網'});
        await input.waitFor({state:'visible'});
        const rect=await input.boundingBox();
        assert(rect&&rect.y>=0&&rect.y+rect.height<=viewport.height,`search input is outside the short viewport: ${JSON.stringify(rect)}`);
        assert.equal(await input.evaluate(el=>document.activeElement===el),true,'opening search must place focus in the input');
        const resultsBox=await page.locator('#global-search-results').evaluate(el=>({overflow:getComputedStyle(el).overflowY,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight}));
        assert.equal(resultsBox.overflow,'auto');
        assert(resultsBox.clientHeight>0);
        await page.screenshot({path:join(results,`homepage-${viewport.width}x${viewport.height}-search.png`),fullPage:false});
      }
      return layout;
    });
  }

  await page.goto(base + 'explore.html?type=topic&value=' + encodeURIComponent('交通與基建'));
  await page.locator('#explore-achievements .explore-result-card').first().waitFor();
  await check('exploration separates counts, retains filters in URL and returns with browser back', async () => {
    assert.equal(await page.locator('#explore-achievements .explore-result-card').count(), 10);
    assert.equal(Number(await page.locator('[data-explore-count="achievements"]').innerText()),62);
    assert.equal(await page.locator('#explore-news-section').count(), 1);
    assert.equal(await page.locator('#explore-platforms-section').count(), 1);
    assert.match(await page.locator('#explore-related').innerText(), /方便延伸閱讀/);
    assert.deepEqual(await page.locator('#explore-pagination .explore-page-button').allTextContents(),['上一頁','1','2','3','4','5','6','7','下一頁']);
    let reachable=10;
    for(const number of [2,3,4,5,6,7]){
      await page.getByRole('button',{name:`第 ${number} 頁，共 7 頁`}).click();
      await page.waitForFunction(number=>new URL(location.href).searchParams.get('page')===String(number),number);
      const count=await page.locator('#explore-achievements .explore-result-card').count();
      assert.equal(count,number===7?2:10);
      reachable+=count;
    }
    assert.equal(reachable,62,'all 62 matching records must be reachable through pagination');
    await page.reload();
    assert.equal(new URL(page.url()).searchParams.get('page'),'7');
    assert.equal(await page.locator('#explore-achievements .explore-result-card').count(),2);
    await page.goto(base+'explore.html?type=topic&value='+encodeURIComponent('交通與基建'));
    await page.locator('#explore-achievements .explore-result-card').first().waitFor();
    await page.getByRole('button', { name: '下一頁' }).click();
    assert.equal(new URL(page.url()).searchParams.get('page'), '2');
    assert.equal(await page.locator('#explore-achievements .explore-result-card').count(), 10);
    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('page') !== '2');
    assert.equal(await page.locator('#explore-achievements .explore-result-card').count(), 10);
  });
  await check('exploration zero state offers clear-filter, complete-list and service paths', async () => {
    await page.locator('#explore-keyword').fill('no-match-ux-159');
    await page.locator('#explore-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#explore-empty a[href="achievements.html"]').count(), 1);
    assert.equal(await page.locator('#explore-empty a[href="service.html#contact"]').count(), 1);
    await page.getByRole('button', { name: '清除關鍵字與進度篩選' }).click();
    assert.equal(await page.locator('#explore-keyword').inputValue(), '');
    assert(await page.locator('#explore-achievements .explore-result-card').count() > 0);
  });
  await check('exploration retry preserves the URL query and restores full results', async () => {
    await page.route('**/data/achievements-public.json', route => route.fulfill({ status: 503, body: 'temporary failure' }));
    await page.goto(base + 'explore.html?type=topic&value=' + encodeURIComponent('教育與文化') + '&q=' + encodeURIComponent('文德'));
    await page.locator('#explore-load-state').waitFor({ state: 'visible' });
    await page.unroute('**/data/achievements-public.json');
    await page.getByRole('button', { name: '重新載入探索資料' }).click();
    await page.locator('#explore-achievements .explore-result-card').first().waitFor();
    assert.equal(await page.locator('#explore-keyword').inputValue(), '文德');
    assert(new URL(page.url()).searchParams.get('q') === '文德');
  });

  await page.goto(base+'explore.html?type=topic&value='+encodeURIComponent('交通與基建')+'&q='+encodeURIComponent('鳳山車站'));
  const longCard=page.locator('#explore-achievements .explore-result-card').filter({has:page.locator('a[href*="achievement-station-design.html"]')});
  await longCard.waitFor();
  await check('exploration card keeps a long title, short summary, one category and visible status without relying on a photo',async()=>{
    assert.match(await longCard.locator('h3').innerText(),/鳳山車站站體設計、公民參與與電影院爭取/);
    assert.match(await longCard.locator('.eyebrow').innerText(),/交通與基建/);
    assert.match(await longCard.innerText(),/地區：.*階段：.*最後紀錄：/);
    assert.equal(await longCard.locator('img').count(),0);
    assert.equal(await longCard.locator('.eyebrow').count(),1);
  });
  await page.goto(base+'achievement-station-design.html');
  await check('full case detail retains all source categories hidden from the compact exploration card',async()=>{
    const labels=await page.locator('.case-taxonomy .case-tags span').allTextContents();
    assert(labels.includes('交通與基建')&&labels.includes('經濟與產業')&&labels.includes('教育與文化'));
    assert.equal(await page.locator('.case-taxonomy .case-subtags span').count(),3);
    await page.screenshot({path:join(results,'case-station-design-taxonomy.png'),fullPage:false});
  });

  await page.goto(base + 'achievement-wende-school-center.html');
  await check('case overview shows region, stage and last-record date before latest record; full timeline stays present', async () => {
    const order = await page.evaluate(() => {
      const overview = document.querySelector('.case-overview-summary');
      const latest = document.querySelector('.case-latest');
      return Boolean(overview && latest && (overview.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(order, true);
    const meta = await page.locator('.case-overview-meta').innerText();
    assert(meta.includes('文德里') && meta.includes('持續追蹤') && meta.includes('2026-09-01'));
    assert.equal(await page.locator('.case-timeline > li').count(), 6);
  });

  await page.goto(base + 'achievements.html');
  await check('funding details in the public record card stay collapsed until requested', async () => {
    const funding = page.locator('#case-list .case-card[data-case="wende-school-center"] .case-funding details');
    assert.equal(await funding.count(), 1);
    assert.equal(await funding.getAttribute('open'), null);
    await funding.locator('summary').click();
    assert.equal(await funding.getAttribute('open'), '');
    assert.match(await funding.innerText(),/2,610\.71萬元/);
    assert.match(await funding.innerText(),/林岱樺/);
  });

  for(const [id,title] of [['wende-school-center','文德國小活動中心'],['wenlong-lane16','文龍路16巷'],['bade-detention','八德滯洪池']]){
    await page.goto(base+`achievements.html?case=${encodeURIComponent(id)}`);
    await page.waitForFunction(({id,title})=>window.HuiwenCases?.getState().selectedId===id&&document.querySelector('#achievement-map .map-popup')?.innerText.includes(title),{id,title},{timeout:12000});
    await check(`direct case URL ${id} selects and opens its matching map point`,async()=>{
      const state=await page.evaluate(()=>({selected:window.HuiwenCases?.getState().selectedId,markers:document.querySelectorAll('#achievement-map .leaflet-marker-icon').length,popup:document.querySelector('#achievement-map .map-popup')?.innerText||null}));
      assert(state.selected===id&&state.markers>0&&state.popup?.includes(title),JSON.stringify(state));
      assert.equal(await page.locator(`#case-list .case-card[data-case="${id}"]`).getAttribute('class').then(value=>value.includes('is-selected')),true);
      if(id==='wende-school-center')await page.screenshot({path:join(results,'achievement-map-direct-case.png'),fullPage:false});
    });
  }

  await page.goto(base + 'council-records.html');
  await check('seven completed council sessions each point to a distinct official query and transcript start page', async () => {
    const sessions = await page.locator('.council-session-card').evaluateAll(rows => rows.map(row => ({
      date:row.querySelector('time')?.dateTime,
      href:row.querySelector('a')?.href,
      text:row.innerText
    })));
    assert.equal(sessions.length, 7);
    assert.equal(new Set(sessions.map(item => new URL(item.href).searchParams.get('meetcode'))).size, 7);
    assert(sessions.every(item => new URL(item.href).hostname === 'cissearch.kcc.gov.tw' && item.date && /第\d+頁起/.test(item.text)));
  });

  await page.goto(base + 'petition.html');
  await check('petition makes external Notion flow clear and preserves telephone option', async () => {
    const copy = await page.locator('main').innerText();
    assert(copy.includes('新分頁開啟外部 Notion') && copy.includes('本頁不會顯示填寫或送出狀態'));
    assert.match(copy,/服務處能與你聯繫/);
    const form = page.locator('a[href*="notion.site"]');
    assert.equal(await form.getAttribute('target'), '_blank');
    assert.match(await form.getAttribute('rel'), /noopener/);
    assert.equal(await page.locator('.petition-panel a[href="tel:+88678212536"]').count(), 1);
    const prep = await page.locator('.prepare-list').innerText();
    assert(prep.includes('姓名、電話') && prep.includes('問題與地點') && prep.includes('案號'));
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320,390,427,640,1180,1440]) {
    const height = width === 390 ? 844 : width === 1180 ? 757 : 900;
    await page.setViewportSize({ width, height });
    await page.goto(base + 'explore.html?type=topic&value=' + encodeURIComponent('交通與基建'));
    await page.locator('#explore-achievements .explore-result-card').first().waitFor();
    await check(`exploration reflows at ${width}px with no horizontal overflow`, () => assertNoOverflow(width));
  }
  await page.setViewportSize({ width: 390, height: 320 });
  await page.goto(base + 'index.html');
  await check('short landscape homepage keeps the primary task paths usable', async () => {
    await assertNoOverflow(390);
    const menu = page.locator('.menu-toggle');
    assert(await menu.isVisible());
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
  });

  await check('browser pages complete without uncaught JavaScript exceptions', async () => {
    assert.deepEqual(jsErrors, []);
  });
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
