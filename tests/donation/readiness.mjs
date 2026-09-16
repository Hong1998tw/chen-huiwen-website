/** Production-readiness QA: real page bytes; third-party requests are NOT blocked.
 * The local server reproduces a Pages-style 404 response, not a SPA fallback.
 * Run ROOT_DIR=/path/to/checkout LABEL=before node tests/donation/readiness.mjs.
 */
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.ROOT_DIR || fileURLToPath(new URL('../../', import.meta.url)));
const label = process.env.LABEL || 'candidate';
const engine = process.env.ENGINE || 'chromium';
const output = resolve(process.env.EVIDENCE_DIR || fileURLToPath(new URL('./results/readiness/', import.meta.url)), label + '-' + engine);
const widths = (process.env.WIDTHS || '390,430,768,1024,1440').split(',').map(Number);
const pages = (process.env.PAGES || 'index.html,about.html,achievements.html,vision.html,news.html,press.html,news-20260915-special-education-nurse.html,political-donation.html,service.html,election.html,explore.html,404.html').split(',');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.geojson':'application/geo+json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.woff2':'font/woff2','.xml':'application/xml','.txt':'text/plain'};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
    let status = 200;
    try { if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html'); await stat(file); }
    catch { file = resolve(root, '404.html'); status = 404; }
    res.writeHead(status, {'Content-Type':types[extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(await readFile(file));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
await mkdir(output, {recursive:true});
const browser = await ({chromium, webkit}[engine]).launch({headless:true});
const report = {label,engine,browser:browser.version(),root,started:new Date().toISOString(),method:'Cold contexts, external requests allowed; local no-throttle diagnostics, NOT Lighthouse or field CWV.',rows:[]};
try {
  for (const width of widths) for (const file of pages) {
    const context = await browser.newContext({viewport:{width,height:width < 768 ? 844 : 960},deviceScaleFactor:1});
    await context.addInitScript(() => {
      window.readinessMetrics = {lcp:0,shifts:[]};
      if (PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) new PerformanceObserver(l => {for(const e of l.getEntries())window.readinessMetrics.lcp=e.startTime;}).observe({type:'largest-contentful-paint',buffered:true});
      if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) new PerformanceObserver(l => {for(const e of l.getEntries())if(!e.hadRecentInput)window.readinessMetrics.shifts.push({t:e.startTime,v:e.value});}).observe({type:'layout-shift',buffered:true});
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const row = {file,width,errors:[],consoleErrors:[],failedRequests:[],httpErrors:[]};
    page.on('pageerror', e => row.errors.push(String(e)));
    page.on('console', m => {if(m.type()==='error')row.consoleErrors.push({text:m.text(),url:m.location().url});});
    page.on('requestfailed', req => row.failedRequests.push({url:req.url(),error:req.failure()?.errorText}));
    page.on('response', res => {if(res.status()>=400)row.httpErrors.push({url:res.url(),status:res.status()});});
    try {
      const response = await page.goto(base + file, {waitUntil:'domcontentloaded',timeout:30000});
      row.status = response.status();
      await page.waitForTimeout(1200);
      await page.evaluate(() => Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,2000))]));
      row.layout = await page.evaluate(() => {
        let cls=0,current=0,start=0,last=0;
        for(const e of window.readinessMetrics.shifts){if(current&&e.t-last<1000&&e.t-start<=5000)current+=e.v;else{current=e.v;start=e.t;}last=e.t;cls=Math.max(cls,current);}
        const image = document.querySelector('.hero-portrait img');
        const box = image?.getBoundingClientRect();
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cls,lcpMs:window.readinessMetrics.lcp,
          h1:document.querySelector('h1')?.textContent,mainCount:document.querySelectorAll('main').length,
          image: image ? {src:image.currentSrc,width:box.width,height:box.height,naturalWidth:image.naturalWidth,sizes:image.closest('picture')?.querySelector('source')?.sizes}:null,
          overflow:[...document.querySelectorAll('main *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1);}).slice(0,8).map(el=>({tag:el.tagName,class:el.className})),
          smallContactText:[...document.querySelectorAll('.home-office-hours dl,.home-contact-info a,.home-account p')].map(el=>({class:el.className,font:getComputedStyle(el).fontSize})),
          invalidImages:[...document.images].filter(im=>im.getBoundingClientRect().top<innerHeight&&im.getBoundingClientRect().bottom>0&&im.currentSrc&&im.complete&&!im.naturalWidth).map(im=>im.currentSrc),
          resources:performance.getEntriesByType('resource').map(r=>({name:r.name,bytes:r.encodedBodySize,duration:r.duration}))};
      });
      if ([390,1440].includes(width) || file==='index.html') {
        const fullPage = ['index.html','political-donation.html','404.html'].includes(file);
        const name = `${file.replace('.html','')}-${width}.jpg`;
        await page.screenshot({path:resolve(output,name),type:'jpeg',quality:78,fullPage}); row.screenshot=name;
      }
      const axe = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      row.violations=axe.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));

      // Auto-loaded third-party embeds are intentionally best-effort. Provider-internal
      // transport failures or accessibility findings remain recorded as diagnostics,
      // but do not make first-party production readiness fail. The surrounding site
      // still requires a titled iframe plus reload/direct-link fallbacks in browser QA.
      const embedOrigins = await page.locator('[data-embed-provider] iframe').evaluateAll(frames =>
        [...new Set(frames.map(frame => { try { return new URL(frame.src).origin; } catch { return null; } }).filter(Boolean))]
      );
      const isEmbedUrl = value => {
        try { return embedOrigins.includes(new URL(value).origin); } catch { return false; }
      };
      const externalFailedRequests = row.failedRequests.filter(item => isEmbedUrl(item.url));
      const externalHttpErrors = row.httpErrors.filter(item => isEmbedUrl(item.url));
      const hasExternalTransportError = externalFailedRequests.length || externalHttpErrors.length;
      const externalConsoleErrors = row.consoleErrors.filter(item =>
        isEmbedUrl(item.url) || (hasExternalTransportError && item.url === 'chrome-error://chromewebdata/')
      );
      const externalViolations = row.violations.filter(violation =>
        embedOrigins.length && violation.nodes.length && violation.nodes.every(node => Array.isArray(node.target) && node.target[0] === 'iframe')
      );
      row.failedRequests = row.failedRequests.filter(item => !externalFailedRequests.includes(item));
      row.httpErrors = row.httpErrors.filter(item => !externalHttpErrors.includes(item));
      row.consoleErrors = row.consoleErrors.filter(item => !externalConsoleErrors.includes(item));
      row.violations = row.violations.filter(item => !externalViolations.includes(item));
      if (externalFailedRequests.length || externalHttpErrors.length || externalConsoleErrors.length || externalViolations.length) {
        row.externalEmbedDiagnostics = {
          origins: embedOrigins,
          consoleErrors: externalConsoleErrors,
          failedRequests: externalFailedRequests,
          httpErrors: externalHttpErrors,
          violations: externalViolations
        };
      }

      if (width <=768 && file==='index.html') {
        const toggle=page.locator('.menu-toggle'); await toggle.focus(); await page.keyboard.press('Enter');
        row.menuOpen=await toggle.getAttribute('aria-expanded')==='true' && await page.locator('main').evaluate(el=>el.inert);
        await page.keyboard.press('Escape');row.focusReturned=await toggle.evaluate(el=>el===document.activeElement);
        await page.keyboard.press('Control+k');row.searchOpen=await page.locator('#global-search-dialog').evaluate(el=>el.open);
        await page.locator('#global-search-dialog input').fill('文龍');await page.waitForTimeout(400);
        row.searchResults=await page.locator('.global-search-result').count();await page.keyboard.press('Escape');
      }
    } catch(error) {row.errors.push(String(error));}
    row.passed=row.status===200 && row.layout?.scrollWidth<=width && row.layout?.mainCount===1 && row.layout?.cls < 0.1 && !row.layout?.invalidImages.length && !row.errors.length && !row.consoleErrors.length && !row.failedRequests.length && !row.httpErrors.length && !row.violations?.length && row.menuOpen!==false && row.focusReturned!==false && row.searchOpen!==false && (row.searchResults===undefined || row.searchResults>0);
    report.rows.push(row); console.log(`${label} ${engine} ${width} ${file}: ${row.passed?'PASS':'FAIL'} ${JSON.stringify({errors:row.errors,axe:row.violations?.map(v=>v.id),overflow:row.layout?.scrollWidth,cls:row.layout?.cls})}`);
    await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
    await context.close();
  }
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
report.finished=new Date().toISOString();report.passed=report.rows.every(r=>r.passed);
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;
