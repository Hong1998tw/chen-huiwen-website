import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const artifact = resolve(root, '_site');
const base = process.env.BASE_URL || 'http://127.0.0.1:8789/';
const publication = JSON.parse(await readFile(resolve(artifact, 'publication-manifest.json'), 'utf8'));
const fontManifest = JSON.parse(await readFile(resolve(artifact, 'page-font-manifest.json'), 'utf8'));
const fontRoot = 'assets/fonts/huiwen-site-sans/';
const fullTcPath = `${fontRoot}huiwen-site-sans-tc-20261007.woff2`;
const fullTcBytes = await readFile(resolve(artifact, fullTcPath));
const fullTcSha = createHash('sha256').update(fullTcBytes).digest('hex');
assert.equal(fullTcSha, publication.files[fullTcPath]);
assert.equal(fullTcBytes.byteLength, 783820);

const samples = [
  'news-20251125-school-review.html',
  'achievement-wujia-public-parking.html',
  'achievement-metro-green-line.html',
];
const legacyRoutes = [
  ['index.html', 'index'], ['about.html', 'about'], ['achievements.html', 'achievements'],
  ['vision.html', 'vision'], ['news.html', 'news'],
  ['news-20260915-special-education-nurse.html', 'news-detail'],
  ['political-donation.html', 'political-donation'], ['election.html', 'election'],
  ['explore.html', 'explore'],
];
const schemaRoutes = ['offline.html', 'renwu-anju-social-housing/index.html'];
const results = { samples: [], schemaRoutes: [], initialFontNetwork: {}, legacyRoutes: [],
  cmsPreview: {}, negativeGuards: {} };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  const page = await context.newPage();
  const observedFullTc = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === `/${fullTcPath}`) observedFullTc.push(response.url());
  });

  for (const route of samples) {
    const routeRow = fontManifest.routes[route];
    assert.ok(routeRow, `missing manifest route: ${route}`);
    const commonCodepoint = fontManifest.fonts[routeRow.commonFont].codepoints.find((cp) => routeRow.codepoints.includes(cp));
    const deltaCodepoint = fontManifest.fonts[routeRow.deltaFont].codepoints.find((cp) => routeRow.codepoints.includes(cp));
    assert.ok(Number.isInteger(commonCodepoint) && Number.isInteger(deltaCodepoint), `${route}: no common/delta glyph sample`);
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const expected = routeRow.preloads.map((path) => `/${path}`).sort();
    const state = await page.evaluate(async ({ common, delta, commonCodepoint, deltaCodepoint }) => {
      const core = await document.fonts.load('16px "Huiwen Sans TC Page Common"', String.fromCodePoint(commonCodepoint));
      const pageDelta = await document.fonts.load('16px "Huiwen Sans TC Page Delta"', String.fromCodePoint(deltaCodepoint));
      const footer = document.querySelector('footer');
      const heading = document.querySelector('main h1');
      return {
        preloads: performance.getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname)
          .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
          .sort(),
        family: getComputedStyle(heading).fontFamily,
        rootFamily: getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'),
        coreLoaded: core.some((font) => font.family === 'Huiwen Sans TC Page Common'),
        deltaLoaded: pageDelta.some((font) => font.family === 'Huiwen Sans TC Page Delta'),
        headingBox: heading.getBoundingClientRect().toJSON(),
        footerText: footer?.innerText || '',
        artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      };
    }, {
      common: routeRow.commonFont,
      delta: routeRow.deltaFont,
      commonCodepoint,
      deltaCodepoint,
    });
    assert.deepEqual(state.preloads, expected, `${route}: first-view font preload closure`);
    assert.match(state.family, /Huiwen Sans TC Page Delta/);
    assert.match(state.rootFamily, /Huiwen Sans TC Page Common/);
    assert.equal(state.coreLoaded, true, `${route}: common font did not shape its glyph`);
    assert.equal(state.deltaLoaded, true, `${route}: delta font did not shape its glyph`);
    assert.ok(state.headingBox.width > 0 && state.headingBox.height > 0, `${route}: heading has no shape`);
    assert.equal(state.artifactRoute, route);

    const routeCodepoints = new Set(routeRow.codepoints);
    const footerCodepoints = [...state.footerText]
      .filter((char) => /[\p{L}\p{M}\p{N}]/u.test(char))
      .map((char) => char.codePointAt(0));
    assert.ok(footerCodepoints.length > 0, `${route}: footer has no readable text`);
    assert.ok(footerCodepoints.every((cp) => routeCodepoints.has(cp)), `${route}: footer glyph missing from subset`);

    await page.setViewportSize({ width: 640, height: 950 });
    await page.locator('html').evaluate((html) => { html.style.fontSize = '200%'; });
    const zoom = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headingWidth: document.querySelector('main h1').getBoundingClientRect().width,
      footerWidth: document.querySelector('footer').getBoundingClientRect().width,
      replacementGlyphs: (document.querySelector('main').innerText.match(/[\uFFFD\u25A1]/g) || []).length,
    }));
    assert.ok(zoom.headingWidth > 0 && zoom.footerWidth > 0, `${route}: 200% text has no shape`);
    assert.ok(zoom.scrollWidth <= zoom.width + 4, `${route}: 200% text causes horizontal page overflow`);
    assert.equal(zoom.replacementGlyphs, 0, `${route}: 200% text contains replacement glyphs`);
    await page.locator('html').evaluate((html) => { html.style.removeProperty('font-size'); });
    await page.setViewportSize({ width: 1365, height: 950 });
    results.samples.push({ route, preloads: state.preloads, footerGlyphs: footerCodepoints.length, zoom });
  }

  for (const route of schemaRoutes) {
    const routeRow = fontManifest.routes[route];
    assert.ok(routeRow, `missing schema-2 route: ${route}`);
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const state = await page.evaluate(() => {
      const heading = document.querySelector('main h1');
      return {
        preloads: performance.getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname)
          .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
          .sort(),
        rootFamily: getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'),
        bodyFamily: getComputedStyle(document.body).fontFamily,
        headingFamily: heading ? getComputedStyle(heading).fontFamily : '',
        headingPresent: Boolean(heading),
        artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      };
    });
    const expected = routeRow.preloads.map((path) => `/${path}`).sort();
    assert.deepEqual(state.preloads, expected, `${route}: schema-2 first-view preload closure`);
    assert.equal(state.artifactRoute, route);
    assert.ok(state.headingPresent, `${route}: missing page heading`);
    assert.match(state.rootFamily, /Huiwen Sans TC Page Common/);
    assert.match(state.headingFamily, /Huiwen Sans TC Page Delta/);
    if (route === 'offline.html') {
      assert.match(state.bodyFamily, /Huiwen Sans TC Page Delta/,
        'offline direct Huiwen Sans TC body family was not overridden by the artifact faces');
      assert.match(state.bodyFamily, /Huiwen Sans TC Page Common/,
        'offline body family did not retain the common fallback face');
    }
    results.schemaRoutes.push({ route, preloads: state.preloads, rootFamily: state.rootFamily,
      bodyFamily: state.bodyFamily, headingFamily: state.headingFamily });
  }
  const fontOnlyRoutes = Object.keys(fontManifest.routes).sort();
  const fullTcInitialViolations = [];
  const fontOnlyStarted = performance.now();
  for (const route of fontOnlyRoutes) {
    const routeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const routePage = await routeContext.newPage();
      if (route === 'service.html')
        await routePage.clock.setFixedTime(new Date('2026-10-19T08:00:00+08:00'));
      const fullTcRequests = [];
      routePage.on('request', (request) => {
        if (new URL(request.url()).pathname === `/${fullTcPath}`) fullTcRequests.push(request.url());
      });
      const response = await routePage.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200, `${route}: initial font-only visit`);
      if (route === 'service.html') {
        await routePage.waitForFunction(() =>
          document.querySelector('.schedule-text table caption')?.textContent.includes('僅顯示尚未結束的場次'));
      }
      await routePage.evaluate(() => document.fonts.ready.then(() => true));
      const observedPreloads = await routePage.evaluate(() => performance.getEntriesByType('resource')
        .map((entry) => new URL(entry.name).pathname)
        .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
        .sort());
      const expectedPreloads = fontManifest.routes[route].preloads.map((path) => `/${path}`).sort();
      assert.deepEqual(observedPreloads, expectedPreloads, `${route}: isolated first-view font closure`);
      if (fullTcRequests.length) fullTcInitialViolations.push({ route, requests: fullTcRequests });
      assert.deepEqual(fullTcRequests, [], `${route}: first view requested the 783,820-byte full TC font`);

      if (route === 'service.html') {
        const initialFullTcRequests = fullTcRequests.length;
        const cardFontResponsePromise = routePage.waitForResponse((item) =>
          new URL(item.url()).pathname === `/${fullTcPath}` && item.status() === 200);
        await routePage.locator('[data-legal-view="card"]').click();
        const cardFontResponse = await cardFontResponsePromise;
        const cardFontBytes = await cardFontResponse.body();
        assert.equal(cardFontBytes.byteLength, 783820, 'legal-card request size differs from the full TC font');
        assert.equal(createHash('sha256').update(cardFontBytes).digest('hex'), fullTcSha,
          'legal-card request differs from the published full TC font');
        await routePage.locator('.legal-card-preview canvas').waitFor();
        results.serviceInitial = { route, viewport: '390x844', fixedTaipeiDate: '2026-10-19',
          initialFullTcRequests, cardFullTcRequests: fullTcRequests.length - initialFullTcRequests,
          totalFullTcRequests: fullTcRequests.length, cardFullTcBytes: cardFontBytes.byteLength,
          cardFullTcSha256: fullTcSha };
      }
    } finally {
      await routeContext.close();
    }
  }
  results.initialFontNetwork = { routesChecked: fontOnlyRoutes.length,
    fullTcInitialViolations, durationSeconds: Number(((performance.now() - fontOnlyStarted) / 1000).toFixed(2)) };
  assert.equal(results.initialFontNetwork.routesChecked, 464, 'initial font-only sweep missed schema-2 routes');
  assert.deepEqual(fullTcInitialViolations, [], 'at least one of the 464 initial route visits requested full TC');

  const crossMonthContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const crossMonthPage = await crossMonthContext.newPage();
    await crossMonthPage.clock.setFixedTime(new Date('2026-11-01T08:00:00+08:00'));
    const crossMonthFullTcRequests = [];
    crossMonthPage.on('request', (request) => {
      if (new URL(request.url()).pathname === `/${fullTcPath}`) crossMonthFullTcRequests.push(request.url());
    });
    await crossMonthPage.goto(new URL('service.html', base).href, { waitUntil: 'domcontentloaded' });
    await crossMonthPage.waitForFunction(() =>
      document.querySelector('[data-legal-month-state]')?.textContent.includes('此為2026年10月時間表'));
    await crossMonthPage.evaluate(() => document.fonts.ready.then(() => true));
    assert.deepEqual(crossMonthFullTcRequests, [],
      'the cross-month legal-calendar state requested the 783,820-byte full TC font');
    results.serviceCrossMonth = { route: 'service.html', viewport: '390x844', fixedTaipeiDate: '2026-11-01',
      initialFullTcRequests: crossMonthFullTcRequests.length };
  } finally {
    await crossMonthContext.close();
  }
  assert.deepEqual(observedFullTc, [], 'initial representative page visits downloaded the 783,820-byte full TC font');

  const searchPage = await context.newPage();
  await searchPage.setViewportSize({ width: 390, height: 844 });
  const searchFullTcResponses = [];
  searchPage.on('response', (response) => {
    if (new URL(response.url()).pathname === `/${fullTcPath}`) searchFullTcResponses.push(response);
  });
  await searchPage.goto(new URL('index.html', base).href, { waitUntil: 'domcontentloaded' });
  await searchPage.evaluate(() => document.fonts.ready);
  assert.deepEqual(searchFullTcResponses, [], 'full TC font loaded before dynamic search was opened');
  await searchPage.locator('.menu-toggle').click();
  await searchPage.waitForFunction(() => document.querySelector('.menu-toggle')?.getAttribute('aria-expanded') === 'true');
  await searchPage.locator('.global-search-trigger').click();
  await searchPage.locator('#global-search-dialog').waitFor({ state: 'visible' });
  await searchPage.locator('#global-search-dialog input[type="search"]').fill('文德國小');
  await searchPage.locator('.global-search-result').first().waitFor();
  await searchPage.evaluate(() => document.fonts.ready);
  const searchFontResponse = searchFullTcResponses.find((response) => response.status() === 200);
  assert.ok(searchFontResponse, 'dynamic search did not request the full TC font after activation');
  const searchFontBytes = await searchFontResponse.body();
  assert.equal(createHash('sha256').update(searchFontBytes).digest('hex'), fullTcSha,
    'dynamic search downloaded bytes that differ from the published full TC font');
  results.dynamicSearch = { triggered: true, fullTcBytes: searchFontBytes.byteLength,
    fullTcSha256: fullTcSha, firstResult: await searchPage.locator('.global-search-result').first().innerText() };
  await searchPage.close();

  for (const [route, expectedPage] of legacyRoutes) {
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const pageData = await page.locator('html').getAttribute('data-huiwen-font-page');
    assert.equal(pageData, expectedPage, `${route}: existing nine-route font marker changed`);
    assert.equal(await page.locator('html').getAttribute('data-huiwen-font-artifact-route'), null, route);
    results.legacyRoutes.push({ route, fontPage: pageData });
  }

  const cmsRoute = 'achievement-wujia-public-parking.html';
  const cmsRow = fontManifest.routes[cmsRoute];
  const draftChar = '黑';
  assert.ok(!cmsRow.codepoints.includes(draftChar.codePointAt(0)), 'draft test glyph already exists in original route subset');
  const editorAsset = Object.keys(publication.files).find((path) => /^cms-page-editor\.[a-f0-9]{12}\.js$/.test(path));
  assert.ok(editorAsset, 'published CMS editor runtime missing');
  const session = 'g02-ci-page-preview-nonce';
  const accessAssertion = 'g02-ci-fixture-verified-owner-access-assertion';
  const nonce = 'g02-ci-preview-nonce';
  async function fetchPublishedPreview() {
    const upstream = await fetch(new URL(cmsRoute, base), {
      headers: { Accept: 'text/html', 'Cache-Control': 'no-cache, no-store' },
    });
    assert.equal(upstream.status, 200, 'authenticated preview proxy could not fetch the published artifact route');
    assert.match(upstream.headers.get('content-type') || '', /text\/html/, 'artifact service did not return HTML');
    const source = await upstream.text();
    return source
      .replace(/<head\b[^>]*>/i, (head) => `${head}<base href="https://www.huiwen.tw/${cmsRoute}">`)
      .replace(/<script\b(?=[^>]*\bdata-cms-editor-loader\b)[^>]*>/i, (tag) =>
        `${tag.slice(0, -1)} data-cms-editor-enabled="true" data-cms-page-path="${cmsRoute}" data-cms-admin-origin="https://admin.huiwen.tw">`);
  }
  const previewCsp = [
    "default-src 'none'", 'base-uri https://www.huiwen.tw',
    "script-src https://www.huiwen.tw 'unsafe-inline'", "style-src https://www.huiwen.tw 'unsafe-inline'",
    'img-src https://www.huiwen.tw https: data: blob:', 'font-src https://www.huiwen.tw data:',
    'connect-src https://www.huiwen.tw https://tile.openstreetmap.org',
    'frame-src https://www.huiwen.tw https://www.youtube.com https://www.youtube-nocookie.com https://www.facebook.com https://drive.google.com https://www.canva.com',
    'media-src https://www.huiwen.tw https: data: blob:', "object-src 'none'", "form-action 'none'",
    'frame-ancestors https://admin.huiwen.tw',
  ].join('; ');

  const cmsContext = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  await cmsContext.route('https://www.huiwen.tw/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const localUrl = new URL(requestUrl.pathname.slice(1) + requestUrl.search, base).href;
    const upstream = await fetch(localUrl, { headers: { 'Accept-Encoding': 'identity' } });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: Buffer.from(await upstream.arrayBuffer()) });
  });
  await cmsContext.route('https://evil.test/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><script>let n=0;const t=setInterval(()=>{parent.frames[0].postMessage({type:'huiwen-cms-init',nonce:'forged'},'*');if(++n>30)clearInterval(t)},100)</script>`,
  }));

  async function installAdminRoutes(adminPage, mode) {
    await cmsContext.route('https://admin.huiwen.tw/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__g02/cms') {
        const cmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
        const evilFrame = mode === 'unauthorized-message' ? '<iframe title="untrusted sender" src="https://evil.test/send"></iframe>' : '';
        const handshake = ['valid', 'wrong-cms-edit'].includes(mode)
          ? `const sendInit=()=>frame.contentWindow.postMessage({type:'huiwen-cms-init',nonce:'${nonce}'},'*');frame.onload=sendInit;window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null')return;if(event.data?.type==='huiwen-cms-hello')sendInit();if(event.data?.type==='huiwen-cms-ready'&&event.data?.nonce==='${nonce}'&&!window.__draftSent){window.__draftSent=true;frame.contentWindow.postMessage({type:'huiwen-cms-case-preview',nonce:'${nonce}',case:{title:'CI草稿',updated:'2026-10-19',paragraphs:['CI草稿新增字：${draftChar}'],history:[],media:[]}},'*');}});`
          : '';
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>
          <iframe id="preview" title="CMS preview" sandbox="allow-scripts" src="/api/page-preview?path=${encodeURIComponent(cmsRoute)}&session=${session}&cmsEdit=${cmsEdit}"></iframe>
          ${evilFrame}<script>const frame=document.querySelector('#preview');${handshake}</script></body></html>` });
      }
      if (url.pathname === '/api/page-preview') {
        // Cloudflare Access injects this verified assertion at the edge before
        // the Worker calls security.owner(); the fixture models that boundary.
        const accessEdgeHeaders = mode === 'unauthenticated' ? {} : { 'cf-access-jwt-assertion': accessAssertion };
        const authorizedOwner = accessEdgeHeaders['cf-access-jwt-assertion'] === accessAssertion;
        const correctRoute = url.searchParams.get('path') === cmsRoute;
        const correctSession = url.searchParams.get('session') === session;
        if (!authorizedOwner || !correctRoute || !correctSession || !publication.files[cmsRoute])
          return route.fulfill({ status: 401, body: 'unauthorized preview' });
        return route.fulfill({
          status: 200, body: await fetchPublishedPreview(),
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-frame-options': 'SAMEORIGIN', 'content-security-policy': previewCsp },
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });
  }

  const cmsPage = await cmsContext.newPage();
  const fullFontResponse = cmsPage.waitForResponse((response) => new URL(response.url()).pathname === `/${fullTcPath}` && response.status() === 200);
  await installAdminRoutes(cmsPage, 'valid');
  await cmsPage.goto('https://admin.huiwen.tw/__g02/cms', { waitUntil: 'domcontentloaded' });
  const frame = cmsPage.frames().find((item) => item.url().includes('/api/page-preview'));
  assert.ok(frame, 'authenticated CMS proxy iframe did not load');
  await frame.waitForFunction(() => document.documentElement.dataset.huiwenFontArtifactPreview === '1', null, { timeout: 15000 });
  await frame.waitForFunction((text) => document.querySelector('.case-background')?.innerText.includes(text), draftChar, { timeout: 15000 });
  const loadedFullFont = await fullFontResponse;
  const loadedBytes = await loadedFullFont.body();
  assert.equal(createHash('sha256').update(loadedBytes).digest('hex'), fullTcSha, 'CMS proxy did not download the published full TC font bytes');
  const cmsState = await frame.evaluate((text) => {
    const main = document.querySelector('.case-background');
    const family = getComputedStyle(main.querySelector('p')).fontFamily;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `16px ${family}`;
    return {
      marker: document.documentElement.dataset.huiwenFontArtifactPreview,
      text: main.innerText,
      family,
      fontLoaded: document.fonts.check('16px "Huiwen Sans TC"', text),
      glyphWidth: context.measureText(text).width,
      tofu: /[\uFFFD\u25A1]/.test(main.innerText),
    };
  }, draftChar);
  assert.equal(cmsState.marker, '1');
  assert.ok(cmsState.text.includes(draftChar), 'CMS draft-only TC glyph was dropped');
  assert.match(cmsState.family, /Huiwen Sans TC/);
  assert.equal(cmsState.fontLoaded, true);
  assert.ok(cmsState.glyphWidth > 0);
  assert.equal(cmsState.tofu, false);
  results.cmsPreview = { route: cmsRoute, access: 'verified owner assertion fixture', draftChar,
    fontBytes: loadedBytes.byteLength, fontSha256: fullTcSha, ...cmsState };
  await cmsContext.close();

  for (const mode of ['unauthenticated', 'wrong-cms-edit', 'unauthorized-message']) {
    const negativeContext = await browser.newContext();
    await negativeContext.route('https://www.huiwen.tw/**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const upstream = await fetch(new URL(requestUrl.pathname.slice(1) + requestUrl.search, base));
      await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: Buffer.from(await upstream.arrayBuffer()) });
    });
    await negativeContext.route('https://evil.test/**', (route) => route.fulfill({
      status: 200, contentType: 'text/html',
      body: `<!doctype html><script>let n=0;const t=setInterval(()=>{parent.frames[0].postMessage({type:'huiwen-cms-init',nonce:'${nonce}'},'*');parent.frames[0].postMessage({type:'huiwen-cms-case-preview',nonce:'${nonce}',case:{title:'UNAUTHORIZED DRAFT',paragraphs:['${draftChar}'],history:[],media:[]}},'*');if(++n>30)clearInterval(t)},100)</script>`,
    }));
    await negativeContext.route('https://admin.huiwen.tw/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__g02/cms') {
        const cmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
        const sender = mode === 'unauthorized-message' ? '<iframe title="untrusted sender" src="https://evil.test/send"></iframe>' : '';
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body>
          <iframe id="preview" title="CMS preview" sandbox="allow-scripts" src="/api/page-preview?path=${encodeURIComponent(cmsRoute)}&session=${session}&cmsEdit=${cmsEdit}"></iframe>${sender}</body>` });
      }
      if (url.pathname === '/api/page-preview') {
        // This negative route models Access denying the request before the Worker.
        if (mode === 'unauthenticated') return route.fulfill({ status: 401, body: 'unauthorized preview' });
        return route.fulfill({ status: 200, body: await fetchPublishedPreview(),
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-frame-options': 'SAMEORIGIN', 'content-security-policy': previewCsp },
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });
    const negativePage = await negativeContext.newPage();
    await negativePage.goto('https://admin.huiwen.tw/__g02/cms', { waitUntil: 'domcontentloaded' });
    const negativeFrame = negativeContext.pages()[0].frames().find((item) => item.url().includes('/api/page-preview'));
    assert.ok(negativeFrame, `${mode}: proxy frame missing`);
    await negativeFrame.waitForLoadState('domcontentloaded');
    if (mode === 'unauthorized-message') {
      await negativeFrame.waitForFunction(() => Boolean(document.querySelector('script[data-cms-editor-runtime]')),
        null, { timeout: 15000 });
    }
    await negativePage.waitForTimeout(700);
    const state = await negativeFrame.evaluate(() => ({
      marker: document.documentElement.dataset.huiwenFontArtifactPreview || null,
      unauthorizedDraft: document.body.innerText.includes('UNAUTHORIZED DRAFT'),
      editorRuntime: Boolean(document.querySelector('script[data-cms-editor-runtime]')),
    }));
    if (mode === 'unauthenticated') {
      assert.equal(state.marker, null, 'an unauthenticated request unexpectedly enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'an unauthenticated request loaded the CMS runtime');
    } else if (mode === 'wrong-cms-edit') {
      assert.equal(state.marker, null, 'cmsEdit=0 unexpectedly enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'cmsEdit=0 loaded the CMS runtime');
    } else {
      assert.equal(state.unauthorizedDraft, false, 'untrusted postMessage changed the CMS preview');
      assert.equal(state.marker, '1', 'cmsEdit=1 in the authenticated iframe did not set the preview marker');
      assert.equal(state.editorRuntime, true, 'the iframe did not load its guarded CMS runtime');
    }
    results.negativeGuards[mode] = state;
    await negativeContext.close();
  }

  const topLevelPage = await context.newPage();
  const topLevelRequests = [];
  topLevelPage.on('request', (request) => topLevelRequests.push(request.url()));
  await topLevelPage.goto(new URL(`${cmsRoute}?cmsEdit=1`, base).href, { waitUntil: 'domcontentloaded' });
  await topLevelPage.waitForTimeout(300);
  assert.equal(await topLevelPage.locator('html').getAttribute('data-huiwen-font-artifact-preview'), null,
    'top-level cmsEdit=1 unexpectedly enabled CMS preview');
  assert.equal(topLevelRequests.some((url) => new URL(url).pathname === `/${editorAsset}`), false,
    'top-level cmsEdit=1 downloaded the CMS runtime');
  results.negativeGuards.topLevel = { marker: null, editorRuntimeRequested: false };

  await context.close();
  const output = resolve(root, 'tests/donation/results/page-font-artifact');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ samples: results.samples.length, schemaRoutes: results.schemaRoutes.length,
    allRouteFontChecks: results.initialFontNetwork.routesChecked,
    allRouteFontSeconds: results.initialFontNetwork.durationSeconds,
    serviceInitialFullTcRequests: results.serviceInitial.initialFullTcRequests,
    serviceCardFullTcBytes: results.serviceInitial.cardFullTcBytes,
    serviceCrossMonthFullTcRequests: results.serviceCrossMonth.initialFullTcRequests,
    legacyRoutes: results.legacyRoutes.length,
    cmsFontBytes: results.cmsPreview.fontBytes, negativeGuards: Object.keys(results.negativeGuards) }));
} finally {
  await browser.close();
}
