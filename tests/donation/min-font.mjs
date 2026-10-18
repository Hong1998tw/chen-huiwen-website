/** Check real rendered text sizes and horizontal overflow on representative public pages. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(process.env.EVIDENCE_DIR || fileURLToPath(new URL('./results/min-font/', import.meta.url)));
const routes = [
  { id: 'home', path: 'index.html' },
  { id: 'achievements-js-map-cards', path: 'achievements.html?case=wende-school-center', requiresLeaflet: true },
  { id: 'achievement-detail-wende', path: 'achievement-wende-school-center.html' },
  { id: 'achievement-detail-boai', path: 'achievement-boai-card-rehab-bus-points.html' },
  { id: 'achievement-detail-fengshan-sports', path: 'achievement-fengshan-sports-park-parking-integration.html' },
  { id: 'news-list', path: 'news.html' },
  { id: 'news-detail', path: 'news-20251125-school-review.html' },
  { id: 'service-legal-calendar', path: 'service.html' },
  { id: 'service-print-calendar', path: 'service-print.html' },
  { id: 'about', path: 'about.html' },
  { id: 'press', path: 'press.html' },
  { id: 'activities', path: 'activities.html' },
  { id: 'vision', path: 'vision.html' },
  { id: 'political-donation', path: 'political-donation.html' },
  { id: 'terms', path: 'terms.html' }
];
const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
];
const minimumFontPx = 12;
const kbdMinimumFontPx = 11;
const roundingEpsilonPx = 0.01;
const hiddenByClass = '.sr-only,.visually-hidden,.visuallyhidden,.screen-reader-text,.screen-reader-only,.u-sr-only,.u-visually-hidden,.a11y-hidden,[data-sr-only]';

if (routes.length < 15) throw new Error(`Expected at least 15 representative pages; got ${routes.length}`);
await mkdir(out, { recursive: true });

const reports = new Map(viewports.map(viewport => [viewport.width, {
  viewport,
  expectedCases: routes.length,
  cases: [],
  failures: []
}]));
const fatalErrors = [];
let server;
let browser;

try {
  server = await startStaticServer({ root, compression: 'auto', port: 0 });
  browser = await chromium.launch({ headless: true });

  for (const viewport of viewports) {
    const report = reports.get(viewport.width);
    for (const route of routes) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        serviceWorkers: 'block'
      });
      await context.route('**/*', requestRoute => {
        try {
          return new URL(requestRoute.request().url()).origin === new URL(server.url).origin
            ? requestRoute.continue()
            : requestRoute.abort();
        } catch {
          return requestRoute.abort();
        }
      });

      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const targetUrl = new URL(route.path, server.url).href;
      const result = {
        id: route.id,
        requestedUrl: targetUrl,
        viewport,
        responseStatus: null,
        finalUrl: null,
        fontStatus: null,
        visibleTextNodeCount: 0,
        minimumVisibleText: null,
        fontViolations: [],
        horizontalOverflow: null,
        screenshot: null,
        error: null
      };

      try {
        const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
        result.responseStatus = response?.status() ?? null;
        result.finalUrl = page.url();
        if (!response || response.status() !== 200) {
          throw new Error(`Expected HTTP 200; received ${response?.status() ?? 'no response'}`);
        }

        await page.waitForFunction(() => [...document.querySelectorAll('link[rel~="stylesheet"]')]
          .every(link => link.disabled || link.sheet !== null), null, { timeout: 15000 });

        if (route.requiresLeaflet) {
          await page.waitForFunction(() => Boolean(
            window.HuiwenCases &&
            document.querySelector('#case-list [data-case]:not([hidden])') &&
            window.L &&
            document.querySelector('link[data-leaflet]')?.sheet &&
            document.querySelector('#achievement-map .leaflet-map-pane')
          ), null, { timeout: 20000 });
        }

        const readiness = await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
          return {
            fontStatus: document.fonts.status,
            stylesheets: [...document.querySelectorAll('link[rel~="stylesheet"]')]
              .filter(link => link.sheet)
              .map(link => new URL(link.href).pathname),
            leafletStylesheet: document.querySelector('link[data-leaflet]')?.sheet
              ? new URL(document.querySelector('link[data-leaflet]').href).pathname
              : null
          };
        });
        result.fontStatus = readiness.fontStatus;
        result.stylesheets = readiness.stylesheets;
        result.leafletStylesheet = readiness.leafletStylesheet;
        if (readiness.fontStatus !== 'loaded') {
          throw new Error(`Expected document.fonts.ready to settle in loaded state; received ${readiness.fontStatus}`);
        }

        const measurement = await page.evaluate(({ minimumFontPx, kbdMinimumFontPx, roundingEpsilonPx, hiddenByClass }) => {
          function selectorFor(element) {
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
              let part = current.localName;
              if (current.id) {
                part += `#${CSS.escape(current.id)}`;
                parts.unshift(part);
                break;
              }
              const classes = [...current.classList].slice(0, 2);
              if (classes.length) part += classes.map(name => `.${CSS.escape(name)}`).join('');
              const siblings = current.parentElement
                ? [...current.parentElement.children].filter(sibling => sibling.localName === current.localName)
                : [];
              if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
              parts.unshift(part);
              current = current.parentElement;
            }
            return parts.join(' > ');
          }

          function isScreenReaderOnly(element) {
            if (element.closest(hiddenByClass)) return true;
            for (let current = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              const rect = current.getBoundingClientRect();
              const hasClip = (style.clip !== 'auto' && style.clip !== 'none') || style.clipPath !== 'none';
              const tinyClipped = ['absolute', 'fixed'].includes(style.position) &&
                rect.width <= 1 && rect.height <= 1 &&
                (hasClip || style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden');
              if (tinyClipped) return true;
            }
            return false;
          }

          function isPainted(element) {
            for (let current = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
                  style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
            }
            return true;
          }

          let count = 0;
          let minimum = null;
          const violations = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const sample = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
            const element = node.parentElement;
            if (!sample || !element || element.closest('script,style,noscript,template') ||
                isScreenReaderOnly(element) || !isPainted(element)) continue;

            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = [...range.getClientRects()].find(item => item.width > 0 && item.height > 0);
            if (!rect) continue;

            count += 1;
            const style = getComputedStyle(element);
            const fontSizePx = Number.parseFloat(style.fontSize);
            const inKbd = Boolean(element.closest('kbd'));
            const thresholdPx = inKbd ? kbdMinimumFontPx : minimumFontPx;
            const textMeasurement = {
              selector: selectorFor(element),
              textSample: sample.slice(0, 120),
              actualFontSize: style.fontSize,
              actualFontSizePx: Number.isFinite(fontSizePx) ? fontSizePx : null,
              thresholdPx,
              kbdException: inKbd,
              rect: {
                x: Math.round(rect.x * 100) / 100,
                y: Math.round(rect.y * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                height: Math.round(rect.height * 100) / 100
              }
            };

            if (!minimum || (Number.isFinite(fontSizePx) && fontSizePx < minimum.actualFontSizePx)) {
              minimum = textMeasurement;
            }
            if (!Number.isFinite(fontSizePx) || fontSizePx + roundingEpsilonPx < thresholdPx) {
              violations.push(textMeasurement);
            }
          }

          const documentWidth = document.documentElement.scrollWidth;
          const bodyWidth = document.body?.scrollWidth ?? 0;
          return {
            visibleTextNodeCount: count,
            minimumVisibleText: minimum,
            fontViolations: violations,
            horizontalOverflow: {
              viewportWidth: innerWidth,
              documentScrollWidth: documentWidth,
              bodyScrollWidth: bodyWidth,
              overflowPx: Math.max(0, documentWidth - innerWidth, bodyWidth - innerWidth),
              passed: documentWidth <= innerWidth && bodyWidth <= innerWidth
            }
          };
        }, { minimumFontPx, kbdMinimumFontPx, roundingEpsilonPx, hiddenByClass });

        Object.assign(result, measurement);
        if (!result.visibleTextNodeCount) throw new Error('No visible TextNode with a non-zero rendered rectangle was measured');
      } catch (error) {
        result.error = String(error?.stack || error);
      }

      const failed = Boolean(result.error || result.fontViolations.length || !result.horizontalOverflow?.passed);
      result.status = failed ? 'FAIL' : 'PASS';
      if (failed) {
        const screenshotPath = resolve(out, `${viewport.width}x${route.id}.png`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
          result.screenshot = screenshotPath;
        } catch (error) {
          result.screenshotError = String(error);
        }
        report.failures.push({
          id: route.id,
          url: result.finalUrl || targetUrl,
          error: result.error,
          fontViolationCount: result.fontViolations.length,
          firstFontViolations: result.fontViolations.slice(0, 5),
          horizontalOverflow: result.horizontalOverflow,
          screenshot: result.screenshot
        });
      }
      report.cases.push(result);
      await context.close();
    }
  }
} catch (error) {
  fatalErrors.push(String(error?.stack || error));
} finally {
  if (browser) await browser.close().catch(error => fatalErrors.push(String(error)));
  if (server) await server.close().catch(error => fatalErrors.push(String(error)));
  for (const [width, report] of reports) {
    report.baseUrl = server?.url ?? null;
    report.minimumFontPx = minimumFontPx;
    report.kbdMinimumFontPx = kbdMinimumFontPx;
    report.roundingEpsilonPx = roundingEpsilonPx;
    report.completedCases = report.cases.length;
    report.status = !fatalErrors.length && report.completedCases === routes.length && report.failures.length === 0
      ? 'PASS'
      : 'FAIL';
    report.fatalErrors = fatalErrors;
    await writeFile(resolve(out, `min-font-${width}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
}

const totalCases = [...reports.values()].reduce((sum, report) => sum + report.cases.length, 0);
const failureCount = [...reports.values()].reduce((sum, report) => sum + report.failures.length, 0);
console.log(JSON.stringify({
  check: 'computed minimum visible text font size and horizontal overflow',
  status: !fatalErrors.length && failureCount === 0 && totalCases === routes.length * viewports.length ? 'PASS' : 'FAIL',
  pageCount: routes.length,
  expectedCases: routes.length * viewports.length,
  completedCases: totalCases,
  viewports: viewports.map(viewport => ({
    width: viewport.width,
    status: reports.get(viewport.width).status,
    completedCases: reports.get(viewport.width).completedCases,
    failureCount: reports.get(viewport.width).failures.length,
    artifact: resolve(out, `min-font-${viewport.width}.json`)
  })),
  failures: [...reports.values()].flatMap(report => report.failures).map(failure => ({
    id: failure.id,
    url: failure.url,
    error: failure.error,
    fontViolationCount: failure.fontViolationCount,
    firstFontViolations: failure.firstFontViolations,
    horizontalOverflow: failure.horizontalOverflow,
    screenshot: failure.screenshot
  })),
  fatalErrors
}, null, 2));

if (fatalErrors.length || failureCount || totalCases !== routes.length * viewports.length) process.exitCode = 1;
