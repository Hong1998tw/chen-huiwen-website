/** Verify rendered pointer targets, WCAG 2.2 exceptions, keyboard use and reflow on news routes. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(process.env.EVIDENCE_DIR || fileURLToPath(new URL('./results/target-size/', import.meta.url)));
const routes = [
  { id: 'news-index', path: 'news.html', search: '#news-search' },
  { id: 'press-index', path: 'press.html', search: '#press-search' },
  { id: 'news-article', path: 'news-20260915-special-education-nurse.html' }
];
const viewports = [
  { id: 'mobile-390', width: 390, height: 844 },
  { id: 'narrow-320-reflow', width: 320, height: 844 },
  { id: 'desktop-1440', width: 1440, height: 960 }
];
const report = {
  started: new Date().toISOString(),
  criteria: {
    minimumTargetPx: 24,
    mobilePrimaryTargetPx: 44,
    inlineException: 'Only inline links with visible non-target text in prose or heading context remain exempt; their inline formatting is preserved.',
    spacingException: 'A sub-24px target passes only when its centered 24px-diameter circle touches no other target or undersized-target circle.',
    narrowViewport: '320 CSS px reflow width, equivalent to a 400% zoom viewport from 1280 CSS px.',
    textResize: 'At 390 CSS px, root font-size is set to 200% as a text-scaling stress case; browser UI zoom is not emulated.'
  },
  cases: [],
  failures: []
};

const controlsSelector = 'a[href],button,summary,input:not([type="hidden"]),select,textarea,[role="button"]';
const primarySelector = [
  '.button', '.news-filter-button', '.news-page-button', '.news-filter-clear',
  '.news-multiselect > summary', '.news-multiselect-option', '.news-card-details > summary',
  '.menu-toggle', '.global-search-trigger',
  '.site-header nav a', '.site-header nav .nav-group > summary',
  '.topline a[href^="tel:"]', '.footer a', '.news-search-input', '.news-sort-select'
].join(',');

function addFailure(label, details) {
  report.failures.push({ label, details });
}

async function evaluateTargets(page) {
  return page.evaluate(({ controlsSelector, primarySelector }) => {
    const min = 24;
    const eps = 0.25;
    const inlineTextException = window.__g04TargetSize?.isInlineTextException;
    if (typeof inlineTextException !== 'function') throw new Error('Inline text exception rule 未載入。');
    const round = value => Math.round(value * 100) / 100;
    const describe = element => {
      const rect = element.getBoundingClientRect();
      const className = typeof element.className === 'string' ? element.className.trim().replace(/\s+/g, '.') : '';
      const selector = element.id ? element.tagName.toLowerCase() + '#' + element.id :
        element.tagName.toLowerCase() + (className ? '.' + className : '');
      const label = (element.getAttribute('aria-label') || element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 100);
      return {
        element,
        selector,
        label,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
        width: rect.width,
        height: rect.height,
        undersized: rect.width + eps < min || rect.height + eps < min
      };
    };
    const isPainted = element => {
      if (element.closest('[hidden],[inert],[aria-hidden="true"]') || element.matches(':disabled')) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
            style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0 && (rect.width > 0 || rect.height > 0);
    };
    const isInlineTextException = element => inlineTextException(element);
    const measured = [...document.querySelectorAll(controlsSelector)].filter(isPainted).map(describe);
    const undersized = measured.filter(item => item.undersized);
    const inlineExceptions = undersized.filter(item => isInlineTextException(item.element));
    const failures = [];
    const spacingExceptions = [];
    for (const target of undersized) {
      if (isInlineTextException(target.element)) continue;
      const cx = (target.rect.left + target.rect.right) / 2;
      const cy = (target.rect.top + target.rect.bottom) / 2;
      let collision = null;
      for (const other of measured) {
        if (other.element === target.element) continue;
        const ox = (other.rect.left + other.rect.right) / 2;
        const oy = (other.rect.top + other.rect.bottom) / 2;
        let distance;
        if (other.undersized) {
          distance = Math.hypot(cx - ox, cy - oy);
          if (distance <= 24 + eps) { collision = { selector: other.selector, distancePx: round(distance) }; break; }
        } else {
          const dx = Math.max(other.rect.left - cx, 0, cx - other.rect.right);
          const dy = Math.max(other.rect.top - cy, 0, cy - other.rect.bottom);
          distance = Math.hypot(dx, dy);
          if (distance <= 12 + eps) { collision = { selector: other.selector, distancePx: round(distance) }; break; }
        }
      }
      const detail = {
        selector: target.selector,
        label: target.label,
        widthPx: round(target.width),
        heightPx: round(target.height),
        collision
      };
      if (collision) failures.push(detail);
      else spacingExceptions.push(detail);
    }
    const primaryFailures = [];
    if (innerWidth <= 780) {
      for (const element of document.querySelectorAll(primarySelector)) {
        if (!isPainted(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width + eps < 44 || rect.height + eps < 44) {
          primaryFailures.push({
            selector: element.id ? element.tagName.toLowerCase() + '#' + element.id :
              element.tagName.toLowerCase() + (typeof element.className === 'string' && element.className ? '.' + element.className.trim().replace(/\s+/g, '.') : ''),
            label: (element.getAttribute('aria-label') || element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
            widthPx: round(rect.width),
            heightPx: round(rect.height)
          });
        }
      }
    }
    const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    return {
      viewportWidth: innerWidth,
      documentWidth,
      horizontalOverflowPx: Math.max(0, documentWidth - innerWidth),
      controlsChecked: measured.length,
      undersizedCount: undersized.length,
      inlineExceptionCount: inlineExceptions.length,
      inlineExceptions: inlineExceptions.slice(0, 12).map(item => ({ selector: item.selector, label: item.label, widthPx: round(item.width), heightPx: round(item.height) })),
      spacingExceptionCount: spacingExceptions.length,
      spacingExceptions: spacingExceptions.slice(0, 12),
      targetFailures: failures.slice(0, 30),
      primaryFailures: primaryFailures.slice(0, 30),
      moreTargetFailures: Math.max(0, failures.length - 30),
      morePrimaryFailures: Math.max(0, primaryFailures.length - 30),
      coverage: {
        telephoneLinks: document.querySelectorAll('.topline a[href^="tel:"],.footer a[href^="tel:"]').length,
        navigationControls: document.querySelectorAll('.site-header nav a,.site-header nav summary').length,
        footerLinks: document.querySelectorAll('.footer a[href]').length,
        externalSourceLinks: document.querySelectorAll('.news-source-links a[href^="http"],.news-article-source a[href^="http"]').length,
        menuIconButtons: document.querySelectorAll('.menu-toggle,button[aria-label*="選單"],button[aria-label*="menu"]').length,
        staticTopicAndTagLabels: [...document.querySelectorAll('.news-topic,.news-tag')].filter(element => !element.closest('a,button,[role="button"]')).length,
        interactiveTopicAndTagControls: [...document.querySelectorAll('.news-topic,.news-tag')].filter(element => element.closest('a,button,[role="button"]')).length
      }
    };
  }, { controlsSelector, primarySelector });
}

async function verifyKeyboard(page, route) {
  const keyboardReport = { route: route.id, passed: false, checks: [] };
  try {
    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => ({
      className: document.activeElement.className,
      outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
      outlineWidth: getComputedStyle(document.activeElement).outlineWidth,
      rect: (() => { const r = document.activeElement.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top }; })()
    }));
    if (!String(firstFocus.className).includes('skip-link')) throw new Error('第一個 Tab 未到略過導覽連結。');
    if (firstFocus.rect.width < 24 || firstFocus.rect.height < 24 || firstFocus.rect.top < 0) throw new Error('略過導覽連結取得焦點後仍未顯示完整點擊區。');
    keyboardReport.checks.push({ id: 'skip-link-first-tab-and-visible-focus', evidence: firstFocus });

    const toggle = page.locator('.menu-toggle');
    let toggleFocused = false;
    for (let i = 0; i < 8; i += 1) {
      const className = await page.evaluate(() => typeof document.activeElement.className === 'string' ? document.activeElement.className : '');
      if (className.includes('menu-toggle')) { toggleFocused = true; break; }
      await page.keyboard.press('Tab');
    }
    if (!toggleFocused) throw new Error('Tab 順序未抵達手機主選單按鈕。');
    const toggleFocus = await page.evaluate(() => ({
      focusVisible: document.activeElement.matches(':focus-visible'),
      outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
      outlineWidth: getComputedStyle(document.activeElement).outlineWidth
    }));
    if (toggleFocus.outlineStyle === 'none' || Number.parseFloat(toggleFocus.outlineWidth) < 2) throw new Error('主選單鍵盤焦點指示不足。');
    await page.keyboard.press('Enter');
    if (await toggle.getAttribute('aria-expanded') !== 'true') throw new Error('Enter 未開啟手機主選單。');
    const menuLayout = await page.evaluate(() => ({ viewport: innerWidth, document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
    if (menuLayout.document > menuLayout.viewport + 1) throw new Error('主選單開啟後產生水平溢位：' + JSON.stringify(menuLayout));
    const navSummary = page.locator('.site-header nav .nav-group > summary').first();
    await navSummary.focus();
    await page.keyboard.press('Enter');
    if (await navSummary.evaluate(element => !element.parentElement.open)) throw new Error('Enter 未展開導覽群組。');
    const navSizing = await page.evaluate(() => [...document.querySelectorAll('.site-header nav a,.site-header nav summary')]
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map(element => {
        const r = element.getBoundingClientRect();
        return {
          label: (element.getAttribute('aria-label') || element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          widthPx: Math.round(r.width * 100) / 100,
          heightPx: Math.round(r.height * 100) / 100
        };
      })
    );
    if (!navSizing.length || navSizing.some(target => target.widthPx < 44 || target.heightPx < 44)) {
      throw new Error('開啟狀態中的導覽連結／摘要未全數達 44×44px：' + JSON.stringify(navSizing));
    }
    await page.keyboard.press('Escape');
    if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('Escape 未關閉手機主選單。');
    keyboardReport.checks.push({ id: 'menu-enter-summary-enter-escape-and-44px', evidence: { focus: toggleFocus, navSizing, menuLayout } });

    const filterSummary = page.locator('.news-multiselect > summary').first();
    if (await filterSummary.count()) {
      await filterSummary.focus();
      await page.keyboard.press('Enter');
      if (!(await filterSummary.evaluate(element => element.parentElement.open))) throw new Error('Enter 未展開新聞篩選摘要。');
      const filterLayout = await page.evaluate(() => ({ viewport: innerWidth, document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
      if (filterLayout.document > filterLayout.viewport + 1) throw new Error('篩選面板展開後產生水平溢位：' + JSON.stringify(filterLayout));
      const option = page.locator('.news-multiselect-option').first();
      const checkbox = option.locator('input[type="checkbox"]');
      const optionSizing = await option.evaluate(element => {
        const label = element.getBoundingClientRect();
        const input = element.querySelector('input').getBoundingClientRect();
        return { labelWidthPx: Math.round(label.width * 100) / 100, labelHeightPx: Math.round(label.height * 100) / 100, checkboxWidthPx: Math.round(input.width * 100) / 100, checkboxHeightPx: Math.round(input.height * 100) / 100 };
      });
      if (optionSizing.labelWidthPx < 44 || optionSizing.labelHeightPx < 44 || optionSizing.checkboxWidthPx < 24 || optionSizing.checkboxHeightPx < 24) {
        throw new Error('篩選項目列或核取方塊未達指定尺寸。');
      }
      await checkbox.focus();
      await page.keyboard.press('Space');
      if (!(await checkbox.isChecked())) throw new Error('Space 未切換篩選核取方塊。');
      keyboardReport.checks.push({ id: 'filter-summary-enter-checkbox-space-and-targets', evidence: { ...optionSizing, filterLayout } });
    }

    if (route.search) {
      const search = page.locator(route.search);
      await search.focus();
      await page.keyboard.type('g04-no-match-9284');
      await page.waitForFunction(selector => document.querySelector(selector)?.value === 'g04-no-match-9284', route.search);
      await page.waitForFunction(() => document.querySelector('.news-filter-empty')?.hidden === false);
      const clear = page.locator('[data-filter-clear]');
      if (!(await clear.count()) || await clear.isDisabled()) throw new Error('搜尋後未啟用篩選清除動作。');
      const clearSizing = await clear.evaluate(element => {
        const r = element.getBoundingClientRect();
        return { widthPx: Math.round(r.width * 100) / 100, heightPx: Math.round(r.height * 100) / 100 };
      });
      if (clearSizing.widthPx < 44 || clearSizing.heightPx < 44) throw new Error('啟用後的篩選清除動作未達 44×44px。');
      await clear.focus();
      await page.keyboard.press('Enter');
      if (await search.inputValue() !== '') throw new Error('Enter 未清除搜尋條件。');
      await page.waitForFunction(() => document.querySelector('.news-filter-empty')?.hidden === true);
      keyboardReport.checks.push({ id: 'search-and-clear-by-keyboard', evidence: { clearSizing, searchValueAfterClear: await search.inputValue() } });
    }
    keyboardReport.passed = true;
  } catch (error) {
    keyboardReport.error = String(error);
    addFailure('keyboard:' + route.id, keyboardReport.error);
  }
  return keyboardReport;
}

await mkdir(out, { recursive: true });
let server;
let browser;
try {
  server = await startStaticServer({ root, compression: 'auto', port: 0 });
  browser = await chromium.launch({ headless: true });
  for (const route of routes) {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', requestRoute => {
        try {
          return new URL(requestRoute.request().url()).origin === new URL(server.url).origin ? requestRoute.continue() : requestRoute.abort();
        } catch {
          return requestRoute.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const testCase = { route: route.id, path: route.path, viewport: viewport.id, width: viewport.width, responseStatus: null, metrics: null, zoomMetrics: null, keyboard: null, error: null };
      report.cases.push(testCase);
      try {
        const response = await page.goto(new URL(route.path, server.url).href, { waitUntil: 'networkidle', timeout: 30000 });
        testCase.responseStatus = response?.status() ?? null;
        if (!response || response.status() !== 200) throw new Error('預期 HTTP 200，實際為 ' + (response?.status() ?? 'no response'));
        await page.addScriptTag({
          type: 'module',
          url: new URL('tests/donation/target-size-inline.mjs', server.url).href
        });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-progressive-controls]')].every(element => getComputedStyle(element).visibility !== 'hidden'), null, { timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        testCase.metrics = await evaluateTargets(page);
        if (testCase.metrics.controlsChecked < 20) addFailure('control-coverage:' + route.id + ':' + viewport.id, '僅檢查到 ' + testCase.metrics.controlsChecked + ' 個控制項。');
        if (testCase.metrics.coverage.telephoneLinks < 2 || testCase.metrics.coverage.navigationControls < 10 || testCase.metrics.coverage.footerLinks < 5 || testCase.metrics.coverage.menuIconButtons < 1) {
          addFailure('path-coverage:' + route.id + ':' + viewport.id, testCase.metrics.coverage);
        }
        if (route.id !== 'news-article' && testCase.metrics.coverage.staticTopicAndTagLabels < 1) {
          addFailure('tag-coverage:' + route.id + ':' + viewport.id, testCase.metrics.coverage);
        }
        if (route.id === 'news-index' && testCase.metrics.coverage.externalSourceLinks < 1) {
          addFailure('external-source-coverage:' + route.id + ':' + viewport.id, testCase.metrics.coverage);
        }
        if (testCase.metrics.horizontalOverflowPx > 1) addFailure('horizontal-overflow:' + route.id + ':' + viewport.id, testCase.metrics.horizontalOverflowPx + 'px');
        if (testCase.metrics.targetFailures.length || testCase.metrics.moreTargetFailures) addFailure('target-size:' + route.id + ':' + viewport.id, testCase.metrics.targetFailures);
        if (testCase.metrics.primaryFailures.length || testCase.metrics.morePrimaryFailures) addFailure('mobile-primary-size:' + route.id + ':' + viewport.id, testCase.metrics.primaryFailures);

        if (viewport.width === 390) {
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
          testCase.zoomMetrics = await evaluateTargets(page);
          if (testCase.zoomMetrics.horizontalOverflowPx > 1) addFailure('text-zoom-overflow:' + route.id, testCase.zoomMetrics.horizontalOverflowPx + 'px at 200% text scale');
          if (testCase.zoomMetrics.targetFailures.length || testCase.zoomMetrics.moreTargetFailures) addFailure('text-zoom-target-size:' + route.id, testCase.zoomMetrics.targetFailures);
          if (testCase.zoomMetrics.primaryFailures.length || testCase.zoomMetrics.morePrimaryFailures) addFailure('text-zoom-mobile-primary-size:' + route.id, testCase.zoomMetrics.primaryFailures);
        }
        if (viewport.width === 320 && route.search) testCase.keyboard = await verifyKeyboard(page, route);
      } catch (error) {
        testCase.error = String(error);
        addFailure('case:' + route.id + ':' + viewport.id, testCase.error);
      } finally {
        await context.close();
      }
    }
  }
} catch (error) {
  addFailure('runner', String(error));
} finally {
  await browser?.close();
  server?.kill();
  report.finished = new Date().toISOString();
  report.status = report.failures.length ? 'failed' : 'passed';
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

console.log(JSON.stringify({ status: report.status, cases: report.cases.length, failures: report.failures, evidence: resolve(out, 'report.json') }, null, 2));
if (report.failures.length) process.exitCode = 1;
