import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  compareMetrics,
  comparePngBuffers,
  readApprovedBaseline,
  sha256,
  verifyCaptureHash,
  verifyCaptureMetadata
} from './visual-qa-lib.mjs';
import { startStaticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runnerVersion = '1.0.0';
const defaultOutput = resolve(root, 'tests/donation/results/visual-qa');
const defaultCloudflareBase = 'https://www.huiwen.tw/';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) options[key] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith('--')) options[key] = rest[++index];
    else options[key] = true;
  }
  return { command, options };
}

function sourceSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function cleanHeader(headers, name) {
  const wanted = name.toLowerCase();
  const pair = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return pair ? String(pair[1]) : null;
}

function publicUrl(raw) {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

function safeRequestRecord(record) {
  return {
    url: publicUrl(record.url),
    resourceType: record.resourceType ?? 'Other',
    status: record.status ?? null,
    mimeType: record.mimeType ?? null,
    contentEncoding: record.contentEncoding || 'identity',
    encodedDataLength: record.encodedDataLength ?? null,
    failed: record.failed ?? null
  };
}

async function readPolicy() {
  const policy = JSON.parse(await readFile(new URL('./visual-qa-policy.json', import.meta.url), 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.routes.length, 15, 'A-05 must capture exactly fifteen representative routes');
  assert.equal(policy.viewports.length, 2);
  return policy;
}

function captureId(route, viewport) {
  return `${route.id}-${viewport.width}`;
}

async function captureOne({ browser, route, viewport, baseUrl, policy, environment, runOutput, playwrightVersion }) {
  const id = captureId(route, viewport);
  const screenshotEnabled = environment === 'local-http-uncompressed';
  const screenshotPath = screenshotEnabled ? `${id}.png` : null;
  const metadataPath = `${id}.json`;
  const absoluteScreenshotPath = screenshotEnabled ? resolve(runOutput, screenshotPath) : null;
  const absoluteMetadataPath = resolve(runOutput, metadataPath);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: policy.capture.deviceScaleFactor,
    locale: policy.capture.locale,
    timezoneId: policy.capture.timezoneId,
    colorScheme: policy.capture.colorScheme,
    reducedMotion: policy.capture.reducedMotion,
    serviceWorkers: 'block'
  });
  const fixedTimestamp = Date.parse(policy.capture.fixedDate);
  await context.addInitScript(({ timestamp }) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args) {
        if (args.length === 0) super(timestamp);
        else super(...args);
      }
      static now() { return timestamp; }
    }
    globalThis.Date = FixedDate;
  }, { timestamp: fixedTimestamp });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const networkById = new Map();
  let documentResponse = null;
  cdp.on('Network.requestWillBeSent', event => {
    const existing = networkById.get(event.requestId) ?? {};
    networkById.set(event.requestId, {
      ...existing,
      url: event.request.url,
      resourceType: event.type,
      requestTimestamp: event.timestamp
    });
  });
  cdp.on('Network.responseReceived', event => {
    const previous = networkById.get(event.requestId) ?? {};
    const encoding = cleanHeader(event.response.headers, 'content-encoding');
    const record = {
      ...previous,
      url: event.response.url,
      status: event.response.status,
      mimeType: event.response.mimeType,
      contentEncoding: encoding,
      responseEncodedDataLength: event.response.encodedDataLength ?? null,
      server: cleanHeader(event.response.headers, 'server'),
      hasCloudflareRay: Boolean(cleanHeader(event.response.headers, 'cf-ray')),
      type: event.type
    };
    networkById.set(event.requestId, record);
    if (event.type === 'Document' && event.response.url === new URL(route.path, baseUrl).href) {
      documentResponse = record;
    }
  });
  cdp.on('Network.loadingFinished', event => {
    const previous = networkById.get(event.requestId);
    if (previous) networkById.set(event.requestId, { ...previous, encodedDataLength: event.encodedDataLength });
  });
  cdp.on('Network.loadingFailed', event => {
    const previous = networkById.get(event.requestId);
    if (previous) networkById.set(event.requestId, { ...previous, failed: event.errorText });
  });

  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  const captureStartedAt = new Date().toISOString();
  const targetUrl = new URL(route.path, baseUrl).href;
  let navigationError = null;
  let httpStatus = null;
  let fontsReady = false;
  let imageState = { visibleImageCount: 0, decodedImageCount: 0, failedImageCount: 0 };
  let domElementCount = null;
  let performanceData = null;
  let screenshotSha256 = null;
  let screenshotError = null;
  let animationCount = 0;
  try {
    const response = await page.goto(targetUrl, { waitUntil: policy.capture.waitUntil, timeout: 60000 });
    httpStatus = response?.status() ?? null;
    const fontWaitStarted = Date.now();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    fontsReady = true;
    const fontReadyElapsedMs = Date.now() - fontWaitStarted;
    imageState = await page.evaluate(async () => {
      const visible = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.width > 0 && rect.height > 0;
      });
      const decoded = await Promise.all(visible.map(image => image.decode().then(() => true, () => false)));
      return {
        visibleImageCount: visible.length,
        decodedImageCount: decoded.filter(Boolean).length,
        failedImageCount: decoded.filter(value => !value).length
      };
    });
    animationCount = await page.evaluate(() => {
      const animations = document.getAnimations();
      for (const animation of animations) {
        try { animation.finish(); } catch { try { animation.cancel(); } catch {} }
      }
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      return animations.length;
    });
    domElementCount = await page.evaluate(() => document.querySelectorAll('*').length);
    performanceData = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource').filter(entry => /^https?:/.test(entry.name));
      const byOrigin = (entries, origin) => entries.filter(entry => new URL(entry.name).origin === origin);
      const origin = location.origin;
      const sameOriginResources = byOrigin(resources, origin);
      const thirdPartyResources = resources.filter(entry => new URL(entry.name).origin !== origin);
      return {
        navigation: navigation ? {
          transferSize: navigation.transferSize,
          encodedBodySize: navigation.encodedBodySize,
          decodedBodySize: navigation.decodedBodySize,
          responseStart: navigation.responseStart,
          domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
          loadEventEnd: navigation.loadEventEnd
        } : null,
        sameOriginResources: sameOriginResources.map(entry => ({
          name: entry.name,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize
        })),
        thirdPartyResources: thirdPartyResources.map(entry => ({
          name: entry.name,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize
        })),
        fontStatus: document.fonts.status
      };
    });
    if (screenshotEnabled) {
      await page.screenshot({ path: absoluteScreenshotPath, fullPage: false, animations: 'disabled' });
      screenshotSha256 = sha256(await readFile(absoluteScreenshotPath));
    }
    performanceData.fontReadyElapsedMs = fontReadyElapsedMs;
  } catch (error) {
    navigationError = String(error);
    try {
      if (screenshotEnabled && page.url() !== 'about:blank') {
        await page.screenshot({ path: absoluteScreenshotPath, fullPage: false, animations: 'disabled', timeout: 10000 });
        screenshotSha256 = sha256(await readFile(absoluteScreenshotPath));
      }
    } catch (captureError) {
      screenshotError = String(captureError);
    }
  }

  const targetOrigin = new URL(baseUrl).origin;
  const network = [...networkById.values()].filter(item => item.url && /^https?:/.test(item.url));
  const sameOriginNetwork = network.filter(item => new URL(item.url).origin === targetOrigin);
  const thirdPartyNetwork = network.filter(item => new URL(item.url).origin !== targetOrigin);
  const sumKnown = (items, key) => items.reduce((sum, item) => sum + (Number.isFinite(item[key]) ? item[key] : 0), 0);
  const rawSameOriginTransferSize = (performanceData?.navigation?.transferSize ?? 0) +
    sumKnown(performanceData?.sameOriginResources ?? [], 'transferSize');
  const rawThirdPartyTransferSize = sumKnown(performanceData?.thirdPartyResources ?? [], 'transferSize');
  const sameOriginEncodedDataLength = sumKnown(sameOriginNetwork, 'encodedDataLength');
  const thirdPartyEncodedDataLength = sumKnown(thirdPartyNetwork, 'encodedDataLength');
  const brEncodedDataLength = sumKnown(sameOriginNetwork.filter(item => item.contentEncoding === 'br'), 'encodedDataLength');
  const cdpTransferFallback = rawSameOriginTransferSize === 0 && sameOriginEncodedDataLength > 0;
  const transferBudgetBytes = cdpTransferFallback ? sameOriginEncodedDataLength : rawSameOriginTransferSize;
  const externalHost = new URL(baseUrl).hostname;
  const cfVerified = Boolean(documentResponse?.hasCloudflareRay || documentResponse?.server?.toLowerCase().includes('cloudflare'));
  const documentEncoding = documentResponse?.contentEncoding || 'identity';
  const environmentVerified = environment === 'cloudflare-production-br'
    ? cfVerified && documentEncoding === 'br'
    : documentEncoding === 'identity';
  const requestRecords = network.map(safeRequestRecord);
  const record = {
    id,
    routeId: route.id,
    routePath: route.path,
    template: route.template,
    exceptionCandidates: route.exceptionCandidates ?? [],
    viewport,
    environment,
    sourceSHA: sourceSha(),
    targetUrl: publicUrl(targetUrl),
    screenshotPath,
    screenshotEnabled,
    screenshotSha256,
    metadataPath,
    capturedAt: captureStartedAt,
    browserVersion: browser.version(),
    toolVersion: `${runnerVersion}; Playwright ${playwrightVersion}`,
    toolVersions: { visualQaRunner: runnerVersion, playwright: playwrightVersion },
    initialRequest: policy.capture.initialRequest,
    conditions: {
      locale: policy.capture.locale,
      timezoneId: policy.capture.timezoneId,
      fixedDate: policy.capture.fixedDate,
      deviceScaleFactor: policy.capture.deviceScaleFactor,
      reducedMotion: policy.capture.reducedMotion,
      serviceWorkers: 'blocked',
      browserCache: 'disabled per context',
      fontsReady,
      animationsFinished: true,
      activeAnimationsStabilized: animationCount,
      dynamicMasks: policy.capture.dynamicMasks
    },
    httpStatus,
    pageErrors,
    navigationError,
    screenshotError,
    environmentVerification: {
      status: environmentVerified ? 'VERIFIED' : 'NOT_VERIFIED',
      requestedMode: environment,
      originHost: externalHost,
      cloudflareVerified: cfVerified,
      documentContentEncoding: documentEncoding,
      sameOriginBrotliEncodedDataLengthBytes: brEncodedDataLength
    },
    imageState,
    metrics: {
      domElementCount,
      sameOriginTransferSizeBytes: transferBudgetBytes,
      sameOriginTransferSizeSource: cdpTransferFallback ? 'CDP.Network.loadingFinished.encodedDataLength fallback; PerformanceResourceTiming returned zero' : 'PerformanceResourceTiming.transferSize including navigation',
      sameOriginPerformanceTransferSizeBytes: rawSameOriginTransferSize,
      sameOriginEncodedDataLengthBytes: sameOriginEncodedDataLength,
      thirdPartyPerformanceTransferSizeBytes: rawThirdPartyTransferSize,
      thirdPartyEncodedDataLengthBytes: thirdPartyEncodedDataLength,
      sameOriginRequestCount: sameOriginNetwork.length,
      thirdPartyRequestCount: thirdPartyNetwork.length,
      navigation: performanceData?.navigation ?? null,
      fonts: { ready: fontsReady, status: performanceData?.fontStatus ?? 'unavailable', waitElapsedMs: performanceData?.fontReadyElapsedMs ?? null }
    },
    budgetObservation: {
      transferLimitBytes: policy.budgets.sameOriginTransferSizeBytes,
      transferWithinLimit: transferBudgetBytes <= policy.budgets.sameOriginTransferSizeBytes,
      domLimit: policy.budgets.domElementCount,
      domWithinLimit: Number.isFinite(domElementCount) && domElementCount <= policy.budgets.domElementCount,
      enforcement: 'OBSERVATION_ONLY_UNTIL_BASELINE_APPROVED'
    },
    network: requestRecords
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await writeFile(absoluteMetadataPath, metadataBytes);
  record.metadataSha256 = sha256(metadataBytes);
  await cdp.detach().catch(() => {});
  await context.close();
  return record;
}

async function runCapture(options) {
  const policy = await readPolicy();
  const environment = options.environment;
  if (!['local-http-uncompressed', 'cloudflare-production-br'].includes(environment)) {
    throw new Error('Use --environment local-http-uncompressed or cloudflare-production-br');
  }
  const outputRoot = resolve(options.output ?? defaultOutput);
  const runOutput = resolve(outputRoot, environment);
  await mkdir(runOutput, { recursive: true });
  let server = null;
  let baseUrl;
  if (environment === 'local-http-uncompressed') {
    server = await startStaticServer({ root, compression: 'none', port: 0 });
    baseUrl = server.url;
  } else {
    baseUrl = options['base-url'] ?? process.env.VISUAL_QA_BASE_URL ?? defaultCloudflareBase;
    if (!/^https:\/\//.test(baseUrl)) throw new Error('Cloudflare capture requires an HTTPS --base-url');
    if (!baseUrl.endsWith('/')) baseUrl += '/';
  }

  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  let browser;
  const captures = [];
  try {
    browser = await chromium.launch({ headless: true });
    for (const route of policy.routes) {
      for (const viewport of policy.viewports) {
        const capture = await captureOne({
          browser,
          route,
          viewport,
          baseUrl,
          policy,
          environment,
          runOutput,
          playwrightVersion: packageJson.devDependencies.playwright
        });
        captures.push(capture);
      }
    }
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }

  const verificationFailures = captures.filter(item => item.environmentVerification.status !== 'VERIFIED');
  const screenshotEnabled = environment === 'local-http-uncompressed';
  const failedCaptures = captures.filter(item => (screenshotEnabled && !item.screenshotSha256) || item.navigationError || item.screenshotError || !item.conditions.fontsReady);
  const manifest = {
    schemaVersion: 1,
    status: captures.length === 30 && !failedCaptures.length && !verificationFailures.length
      ? screenshotEnabled ? 'CAPTURE_ONLY' : 'MEASUREMENT_ONLY'
      : 'CAPTURE_INCOMPLETE',
    baselineApproval: null,
    environment,
    baseUrl: new URL(baseUrl).origin,
    sourceSHA: sourceSha(),
    capturedAt: new Date().toISOString(),
    toolVersions: {
      visualQaRunner: runnerVersion,
      playwright: packageJson.devDependencies.playwright,
      pixelmatch: packageJson.devDependencies.pixelmatch,
      chromium: captures[0]?.browserVersion ?? null
    },
    policy: {
      viewportCount: policy.viewports.length,
      routeCount: policy.routes.length,
      expectedCaptureCount: 30,
      budgets: policy.budgets,
      comparisonPolicy: policy.comparison,
      captureConditions: policy.capture,
      exceptionCandidates: policy.routes.filter(item => item.exceptionCandidates?.length).map(item => ({ routeId: item.id, candidates: item.exceptionCandidates }))
    },
    counts: {
      captures: captures.length,
      screenshots: captures.filter(item => item.screenshotSha256).length,
      failedCaptures: failedCaptures.length,
      environmentVerificationFailures: verificationFailures.length
    },
    captures
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(runOutput, 'manifest.json'), manifestBytes);
  await writeFile(resolve(runOutput, 'manifest.sha256'), `${sha256(manifestBytes)}  manifest.json\n`);
  const receipt = {
    status: manifest.status,
    comparisonStatus: screenshotEnabled ? 'PENDING_BASELINE_APPROVAL' : 'NOT_APPLICABLE_MEASUREMENT_ONLY',
    sourceSHA: manifest.sourceSHA,
    environment,
    captureCount: captures.length,
    screenshotCount: manifest.counts.screenshots,
    transferAndDomBudgetEnforcement: 'OBSERVATION_ONLY_UNTIL_BASELINE_APPROVED',
    baseline: null
  };
  await writeFile(resolve(runOutput, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  const expectedStatus = screenshotEnabled ? 'CAPTURE_ONLY' : 'MEASUREMENT_ONLY';
  if (manifest.status !== expectedStatus) process.exitCode = 1;
}

async function runCompare(options) {
  if (!options['candidate-manifest']) throw new Error('compare requires --candidate-manifest');
  const candidateManifestPath = resolve(options['candidate-manifest']);
  const candidate = JSON.parse(await readFile(candidateManifestPath, 'utf8'));
  const comparisonPath = resolve(options.output ?? resolve(dirname(candidateManifestPath), 'comparison.json'));
  const baselineState = await readApprovedBaseline({
    manifestPath: options['baseline-manifest'] ? resolve(options['baseline-manifest']) : null,
    expectedSha256: options['baseline-sha256'],
    expectedSourceSha: options['baseline-source-sha']
  });
  if (baselineState.status === 'PENDING') {
    const report = {
      status: 'PENDING',
      reason: baselineState.reason,
      comparisonPerformed: false,
      sourceSHA: candidate.sourceSHA,
      message: 'No approved baseline was compared. Capture-only artifacts are not a visual regression pass.'
    };
    await mkdir(dirname(comparisonPath), { recursive: true });
    await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (baselineState.status !== 'APPROVED') {
    const report = { status: 'REJECTED', reason: baselineState.reason, actualBaselineSha256: baselineState.actualSha256, comparisonPerformed: false };
    await mkdir(dirname(comparisonPath), { recursive: true });
    await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const approved = baselineState.manifest;
  if (candidate.status !== 'CAPTURE_ONLY' || candidate.counts?.captures !== 30 || candidate.captures?.length !== 30) {
    throw new Error('Candidate must contain a complete 30-capture CAPTURE_ONLY manifest');
  }
  if (candidate.environment !== approved.environment) throw new Error('BASELINE_ENVIRONMENT_MISMATCH');
  if (candidate.environment !== 'local-http-uncompressed') throw new Error('PIXEL_COMPARISON_REQUIRES_LOCAL_SCREENSHOT_CAPTURE');
  const baselineById = new Map(approved.captures.map(item => [item.id, item]));
  const candidateById = new Map(candidate.captures.map(item => [item.id, item]));
  if (baselineById.size !== 30 || candidateById.size !== 30) throw new Error('BASELINE_OR_CANDIDATE_CAPTURE_IDS_INVALID');

  const diffDir = resolve(dirname(candidateManifestPath), 'diff');
  await mkdir(diffDir, { recursive: true });
  const captures = [];
  for (const [id, current] of candidateById) {
    const previous = baselineById.get(id);
    if (!previous) throw new Error(`BASELINE_CAPTURE_MISSING:${id}`);
    const baselineImage = await verifyCaptureHash(resolve(options['baseline-manifest']), previous);
    const candidateImage = await verifyCaptureHash(candidateManifestPath, current);
    const baselineMetadata = await verifyCaptureMetadata(resolve(options['baseline-manifest']), previous);
    const candidateMetadata = await verifyCaptureMetadata(candidateManifestPath, current);
    if (!baselineImage.valid) throw new Error(`BASELINE_IMAGE_SHA256_MISMATCH:${id}`);
    if (!candidateImage.valid) throw new Error(`CANDIDATE_IMAGE_SHA256_MISMATCH:${id}`);
    if (!baselineMetadata.valid) throw new Error(`BASELINE_METADATA_SHA256_MISMATCH:${id}`);
    if (!candidateMetadata.valid) throw new Error(`CANDIDATE_METADATA_SHA256_MISMATCH:${id}`);
    const pixels = comparePngBuffers(baselineImage.bytes, candidateImage.bytes, approved.comparisonPolicy);
    const metricResult = compareMetrics(current, previous, approved.exceptions ?? []);
    const diffPath = resolve(diffDir, `${id}.diff.png`);
    await writeFile(diffPath, pixels.diffPng);
    const status = pixels.status !== 'PASS' || metricResult.status === 'FAIL'
      ? 'FAIL'
      : metricResult.status === 'STALE_BASELINE' ? 'STALE_BASELINE' : 'PASS';
    captures.push({ id, status, pixels: { ...pixels, diffPng: undefined, diffPath }, metrics: metricResult });
  }
  const stale = captures.filter(item => item.status === 'STALE_BASELINE');
  const failed = captures.filter(item => item.status === 'FAIL');
  const report = {
    status: failed.length ? 'FAIL' : stale.length ? 'STALE_BASELINE' : 'PASS',
    comparisonPerformed: true,
    baseline: { sourceSHA: approved.sourceSHA, manifestSha256: baselineState.actualSha256 },
    candidate: { sourceSHA: candidate.sourceSHA, environment: candidate.environment },
    comparisonPolicy: approved.comparisonPolicy,
    summary: { captures: captures.length, failed: failed.length, staleBaseline: stale.length, passed: captures.length - failed.length - stale.length },
    captures
  };
  await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, captures: undefined }, null, 2)}\n`);
  if (report.status !== 'PASS') process.exitCode = 1;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'capture') return runCapture(options);
  if (command === 'compare') return runCompare(options);
  if (command === 'help' || command === '--help' || !command) {
    process.stdout.write('Usage:\n  node visual-qa.mjs capture --environment local-http-uncompressed\n  node visual-qa.mjs capture --environment cloudflare-production-br --base-url https://www.huiwen.tw/\n  node visual-qa.mjs compare --candidate-manifest PATH [--baseline-manifest PATH --baseline-sha256 SHA --baseline-source-sha SHA]\n');
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
