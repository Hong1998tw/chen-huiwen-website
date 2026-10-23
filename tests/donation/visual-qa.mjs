import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  compareMetrics,
  compareCaptureConditions,
  comparePngBuffers,
  cloudflareEncodingEvidence,
  deploymentEvidence,
  evaluateCaptureQuality,
  readApprovedBaseline,
  readGitBaselineSelection,
  sha256,
  validateDeploymentReceipt,
  verifyCaptureHash,
  verifyCaptureMetadata,
  TRANSFER_SOURCE,
  TRANSFER_SOURCE_CDP_FALLBACK
} from './visual-qa-lib.mjs';
import { startStaticServer } from './static-server.mjs';
import {
  assertAllowedOptions,
  protectReadOnlyBaseSource,
  resolveCaptureRoots,
  snapshotGitSource,
  verifyGitSourceSnapshot,
} from './visual-qa-identity.mjs';
import {
  assertSamePublicationArtifact,
  publicationMetadataIdentity,
  siteSourceKind,
  validatePublicationArtifact,
  validatePublicationManifestRecord,
  validateSiteSourceKindRecord,
} from './visual-qa-publication.mjs';
import { createCrossSourceReview } from './visual-qa-cross-compare.mjs';
import {
  combineCaptureAndIntegrityErrors,
  createMetadataPathRegistry,
  invalidateSourceMetadata,
  prepareCaptureOutput,
  writeCaptureMetadata,
} from './visual-qa-source-integrity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runnerVersion = '1.1.0';
const NETWORK_QUIET_MS = 500;
const NETWORK_SETTLE_TIMEOUT_MS = 10000;
const defaultOutput = resolve(root, 'tests/donation/results/visual-qa');
const defaultCloudflareBase = 'https://www.huiwen.tw/';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const [key, inline] = value.slice(2).split('=', 2);
    if (!key || seen.has(key)) throw new Error(`Invalid or repeated option: --${key}`);
    seen.add(key);
    if (inline !== undefined) options[key] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith('--')) options[key] = rest[++index];
    else options[key] = true;
  }
  return { command, options };
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
    originClass: record.originClass ?? 'unknown',
    resourceType: record.resourceType ?? 'Other',
    status: record.status ?? null,
    mimeType: record.mimeType ?? null,
    contentEncoding: record.contentEncoding || 'identity',
    encodedDataLength: record.encodedDataLength ?? null,
    failed: record.failed ?? null
  };
}

async function readLiveDeployment(baseUrl) {
  const url = new URL('deployment.json', baseUrl);
  url.searchParams.set('visual-qa-receipt', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(10000)
    });
    let receipt = null;
    try { receipt = await response.json(); } catch {}
    return {
      capturedAt: new Date().toISOString(),
      httpStatus: response.status,
      receipt: response.status === 200 && validateDeploymentReceipt(receipt) ? receipt : null,
      valid: response.status === 200 && validateDeploymentReceipt(receipt),
      error: null
    };
  } catch (error) {
    return { capturedAt: new Date().toISOString(), httpStatus: null, receipt: null, valid: false, error: error?.name ?? 'FETCH_FAILED' };
  }
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

async function captureOne({
  browser,
  route,
  viewport,
  baseUrl,
  policy,
  environment,
  runOutput,
  metadataRegistry,
  playwrightVersion,
  siteSourceSHA,
  sourceGitSHA,
  siteSourceKind,
  servedRootRole,
  publicationArtifact,
  publicationPayloads,
  captureToolSHA,
  deploymentAtStart,
}) {
  const id = captureId(route, viewport);
  const screenshotEnabled = environment === 'local-http-uncompressed';
  const screenshotPath = screenshotEnabled ? `${id}.png` : null;
  const metadataPath = `${id}.json`;
  const absoluteScreenshotPath = screenshotEnabled ? resolve(runOutput, screenshotPath) : null;
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
  // Same-origin requests still in flight; lazy images can start after `load`, so the
  // same-origin metrics wait for this set to drain instead of racing the image fetch.
  const settleOrigin = new URL(baseUrl).origin;
  const pendingRequests = new Set();
  let lastNetworkActivity = Date.now();
  cdp.on('Network.requestWillBeSent', event => {
    if (/^https?:/.test(event.request.url) && new URL(event.request.url).origin === settleOrigin) {
      pendingRequests.add(event.requestId);
      lastNetworkActivity = Date.now();
    }
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
    if (pendingRequests.delete(event.requestId)) lastNetworkActivity = Date.now();
    const previous = networkById.get(event.requestId);
    if (previous) networkById.set(event.requestId, { ...previous, encodedDataLength: event.encodedDataLength });
  });
  cdp.on('Network.loadingFailed', event => {
    if (pendingRequests.delete(event.requestId)) lastNetworkActivity = Date.now();
    const previous = networkById.get(event.requestId);
    if (previous) networkById.set(event.requestId, { ...previous, failed: event.errorText });
  });

  const pageErrors = [];
  const targetOrigin = new URL(baseUrl).origin;
  page.on('pageerror', error => {
    const stack = String(error?.stack ?? '');
    const sourceUrls = [...stack.matchAll(/https?:\/\/[^\s)]+/g)].map(match => {
      try { return publicUrl(match[0]); } catch { return null; }
    }).filter(Boolean);
    const sourceOrigins = [...new Set(sourceUrls.map(source => new URL(source).origin))];
    pageErrors.push({
      message: String(error),
      originClass: sourceOrigins.includes(targetOrigin) ? 'same-origin' : sourceOrigins.length ? 'third-party' : 'unknown',
      sourceUrls
    });
  });
  const captureStartedAt = new Date().toISOString();
  const targetUrl = new URL(route.path, baseUrl).href;
  let navigationError = null;
  let httpStatus = null;
  let fontsReady = false;
  let imageState = { visibleImageCount: 0, decodedImageCount: 0, failedImageCount: 0, firstPartyFailedImageCount: 0, thirdPartyFailedImageCount: 0, visibleImages: [] };
  let domElementCount = null;
  let performanceData = null;
  let screenshotSha256 = null;
  let screenshotError = null;
  let animationCount = 0;
  let networkSettled = false;
  let networkSettleElapsedMs = null;
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
      const results = await Promise.all(visible.map(async image => {
        let decoded = false;
        try { await image.decode(); decoded = image.naturalWidth > 0; } catch {}
        const imageUrl = new URL(image.currentSrc || image.src, location.href);
        return {
          url: `${imageUrl.origin}${imageUrl.pathname}`,
          originClass: imageUrl.origin === location.origin ? 'same-origin' : 'third-party',
          decoded,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight
        };
      }));
      return {
        visibleImageCount: visible.length,
        decodedImageCount: results.filter(item => item.decoded).length,
        failedImageCount: results.filter(item => !item.decoded).length,
        firstPartyFailedImageCount: results.filter(item => item.originClass === 'same-origin' && !item.decoded).length,
        thirdPartyFailedImageCount: results.filter(item => item.originClass === 'third-party' && !item.decoded).length,
        visibleImages: results
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
    const settleStarted = Date.now();
    while (Date.now() - settleStarted < NETWORK_SETTLE_TIMEOUT_MS) {
      if (pendingRequests.size === 0 && Date.now() - lastNetworkActivity >= NETWORK_QUIET_MS) {
        networkSettled = true;
        break;
      }
      await page.waitForTimeout(50);
    }
    networkSettleElapsedMs = Date.now() - settleStarted;
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
        fontStatus: document.fonts.status,
        // Chrome may or may not prefetch a loading="lazy" image that sits wholly outside the
        // viewport, so its bytes vary between identical runs; they are reported, not budgeted.
        offscreenLazyImages: [...new Set([...document.images].filter(image => {
          if (image.loading !== 'lazy') return false;
          const rect = image.getBoundingClientRect();
          return rect.top >= innerHeight || rect.bottom <= 0;
        }).map(image => {
          const imageUrl = new URL(image.currentSrc || image.src, location.href);
          return `${imageUrl.origin}${imageUrl.pathname}`;
        }))]
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

  const network = [...networkById.values()].filter(item => item.url && /^https?:/.test(item.url));
  const sameOriginNetwork = network.filter(item => new URL(item.url).origin === targetOrigin);
  const thirdPartyNetwork = network.filter(item => new URL(item.url).origin !== targetOrigin);
  const sumKnown = (items, key) => items.reduce((sum, item) => sum + (Number.isFinite(item[key]) ? item[key] : 0), 0);
  const offscreenLazy = new Set(performanceData?.offscreenLazyImages ?? []);
  const withoutQuery = url => { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; };
  const isOffscreenLazy = url => offscreenLazy.has(withoutQuery(url));
  const rawSameOriginTransferSize = (performanceData?.navigation?.transferSize ?? 0) +
    sumKnown(performanceData?.sameOriginResources ?? [], 'transferSize');
  const offscreenLazyResources = (performanceData?.sameOriginResources ?? []).filter(entry => isOffscreenLazy(entry.name));
  const offscreenLazyNetwork = sameOriginNetwork.filter(item => isOffscreenLazy(item.url));
  const rawThirdPartyTransferSize = sumKnown(performanceData?.thirdPartyResources ?? [], 'transferSize');
  const sameOriginEncodedDataLength = sumKnown(sameOriginNetwork, 'encodedDataLength');
  const thirdPartyEncodedDataLength = sumKnown(thirdPartyNetwork, 'encodedDataLength');
  const cdpTransferFallback = rawSameOriginTransferSize === 0 && sameOriginEncodedDataLength > 0;
  const transferBudgetBytes = cdpTransferFallback
    ? sameOriginEncodedDataLength - sumKnown(offscreenLazyNetwork, 'encodedDataLength')
    : rawSameOriginTransferSize - sumKnown(offscreenLazyResources, 'transferSize');
  const externalHost = new URL(baseUrl).hostname;
  const cfVerified = Boolean(documentResponse?.hasCloudflareRay || documentResponse?.server?.toLowerCase().includes('cloudflare'));
  const documentEncoding = documentResponse?.contentEncoding || 'identity';
  const encodingEvidence = environment === 'cloudflare-production'
    ? cloudflareEncodingEvidence(documentEncoding, cfVerified)
    : { contentEncoding: documentEncoding, environmentLabel: 'local-http-identity', cloudflareVerified: false, encodingValid: documentEncoding === 'identity', verified: documentEncoding === 'identity' };
  const requestRecords = network.map(item => safeRequestRecord({ ...item, originClass: new URL(item.url).origin === targetOrigin ? 'same-origin' : 'third-party' }));
  const encodedBytesByContentEncoding = {};
  for (const item of sameOriginNetwork) {
    const encoding = item.contentEncoding || 'identity';
    if (Number.isFinite(item.encodedDataLength)) encodedBytesByContentEncoding[encoding] = (encodedBytesByContentEncoding[encoding] ?? 0) + item.encodedDataLength;
  }
  const expectedHttpStatus = route.expectedHttpStatus ?? 200;
  const record = {
    id,
    routeId: route.id,
    routePath: route.path,
    template: route.template,
    exceptionCandidates: route.exceptionCandidates ?? [],
    viewport,
    environment,
    environmentLabel: encodingEvidence.environmentLabel,
    measurementScope: 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot',
    sourceSHA: environment === 'cloudflare-production' ? deploymentAtStart?.receipt?.sourceCommit ?? null : siteSourceSHA,
    siteSourceSHA: environment === 'local-http-uncompressed' ? siteSourceSHA : null,
    sourceGitSHA: environment === 'cloudflare-production'
      ? deploymentAtStart?.receipt?.sourceCommit ?? null
      : sourceGitSHA,
    siteSourceKind,
    servedRootRole,
    publicationArtifact,
    ...(publicationPayloads ? { publicationPayloads } : {}),
    captureToolSHA,
    checkoutSHA: captureToolSHA,
    liveDeployment: environment === 'cloudflare-production'
      ? { sourceCommit: deploymentAtStart?.receipt?.sourceCommit ?? null, publicArtifactDigest: deploymentAtStart?.receipt?.publicArtifactDigest ?? null }
      : null,
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
      networkSettled,
      networkQuietMs: NETWORK_QUIET_MS,
      networkSettleElapsedMs,
      animationsFinished: true,
      activeAnimationsStabilized: animationCount,
      dynamicMasks: policy.capture.dynamicMasks
    },
    httpStatus,
    expectedHttpStatus,
    pageErrors,
    navigationError,
    screenshotError,
    environmentVerification: {
      status: encodingEvidence.verified ? 'VERIFIED' : 'NOT_VERIFIED',
      requestedMode: environment,
      originHost: externalHost,
      cloudflareVerified: encodingEvidence.cloudflareVerified,
      documentContentEncoding: encodingEvidence.contentEncoding,
      encodingValid: encodingEvidence.encodingValid,
      deploymentWindowStatus: environment === 'cloudflare-production' ? (deploymentAtStart?.valid ? 'PENDING_FINAL_READ' : 'NOT_VERIFIED') : null
    },
    imageState,
    metrics: {
      domElementCount,
      sameOriginTransferSizeBytes: transferBudgetBytes,
      sameOriginTransferSizeSource: cdpTransferFallback ? TRANSFER_SOURCE_CDP_FALLBACK : TRANSFER_SOURCE,
      sameOriginPerformanceTransferSizeBytes: rawSameOriginTransferSize,
      sameOriginOffscreenLazyImagesExcluded: (cdpTransferFallback ? offscreenLazyNetwork.map(item => ({ url: publicUrl(item.url), bytes: item.encodedDataLength ?? 0 }))
        : offscreenLazyResources.map(entry => ({ url: publicUrl(entry.name), bytes: entry.transferSize ?? 0 }))),
      sameOriginEncodedDataLengthBytes: sameOriginEncodedDataLength,
      sameOriginEncodedBytesByContentEncoding: encodedBytesByContentEncoding,
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
  record.captureQuality = evaluateCaptureQuality(record, { expectedHttpStatus, screenshotRequired: screenshotEnabled });
  record.metadataSha256 = await writeCaptureMetadata({ registry: metadataRegistry, id, metadataPath, record });
  await cdp.detach().catch(() => {});
  await context.close();
  return record;
}

async function removeInvalidCaptureSummaries(runOutput) {
  const outputRoot = dirname(runOutput);
  const registry = createMetadataPathRegistry({ runOutput, outputRoot });
  const failures = [];
  try {
    await prepareCaptureOutput(registry);
  } catch (error) {
    return [error];
  }
  for (const name of ['manifest.json', 'manifest.sha256', 'receipt.json']) {
    const path = resolve(runOutput, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
        throw new Error(`Refusing to remove an unsafe A-05 summary file: ${name}`);
      }
      await unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(error);
    }
  }
  return failures;
}

async function runCapture(options) {
  if (typeof options.environment !== 'string') throw new Error('capture requires --environment local-http-uncompressed or cloudflare-production');
  const environment = options.environment;
  if (!['local-http-uncompressed', 'cloudflare-production'].includes(environment)) {
    throw new Error('Use --environment local-http-uncompressed or cloudflare-production');
  }
  if (options['site-root'] !== undefined && (typeof options['site-root'] !== 'string' || !options['site-root'].trim())) {
    throw new Error('--site-root requires a Git checkout root path.');
  }
  if (options['site-root'] !== undefined && environment !== 'local-http-uncompressed') {
    throw new Error('--site-root is only valid for local-http-uncompressed capture.');
  }
  if (options['public-artifact'] !== undefined && (typeof options['public-artifact'] !== 'string' || !options['public-artifact'].trim())) {
    throw new Error('--public-artifact requires a built publication directory path.');
  }
  if (options['public-artifact'] !== undefined && environment !== 'local-http-uncompressed') {
    throw new Error('--public-artifact is only valid for local-http-uncompressed capture.');
  }
  if (options['base-url'] !== undefined && typeof options['base-url'] !== 'string') throw new Error('--base-url requires an HTTPS URL.');
  if (options['base-url'] !== undefined && environment !== 'cloudflare-production') {
    throw new Error('--base-url is only valid for cloudflare-production capture.');
  }
  const identity = await resolveCaptureRoots({
    runnerRoot: root,
    siteRoot: options['site-root'],
    publicArtifact: options['public-artifact'],
    outputDir: options['output-dir'],
    defaultOutput,
  });
  const outputRoot = identity.outputRoot;
  const runOutput = resolve(outputRoot, environment);
  const metadataRegistry = createMetadataPathRegistry({ runOutput, outputRoot });
  const sourceSnapshot = await snapshotGitSource(identity.siteRoot, identity.siteSourceSHA);
  const publicationArtifactAtStart = identity.publicArtifactRoot
    ? await validatePublicationArtifact({
      artifactRoot: identity.publicArtifactRoot,
      sourceRoot: identity.siteRoot,
      sourceGitSHA: identity.siteSourceSHA,
    })
    : null;
  const sourceGuard = identity.independentSiteSource && process.env.BASE_ROOT
    ? await protectReadOnlyBaseSource({
      root: identity.siteRoot,
      runnerTemp: process.env.RUNNER_TEMP,
      baseRoot: process.env.BASE_ROOT,
    })
    : null;
  if (identity.independentSiteSource && process.env.GITHUB_EVENT_NAME === 'pull_request' && !sourceGuard) {
    throw new Error('A-05 PR base capture requires the verified RUNNER_TEMP/a05-main-reference source guard.');
  }
  const captures = [];
  let captureError = null;
  let siteSourceIntegrity = null;
  let captureToolIntegrity = null;
  let sourceIntegrityChecked = false;
  let publicationArtifactAtEnd = null;
  let publicationIntegrityChecked = !publicationArtifactAtStart;
  let integrityFailureRecorded = false;
  const finalizeCaptureInputs = async () => {
    const failures = [];
    if (!sourceIntegrityChecked) {
      sourceIntegrityChecked = true;
      try {
        siteSourceIntegrity = sourceGuard
          ? await sourceGuard.verifyAndRestore()
          : await verifyGitSourceSnapshot(sourceSnapshot);
      } catch (error) {
        failures.push({ kind: 'site-source', error });
      }
    }
    if (publicationArtifactAtStart && !publicationIntegrityChecked) {
      publicationIntegrityChecked = true;
      try {
        publicationArtifactAtEnd = await validatePublicationArtifact({
          artifactRoot: identity.publicArtifactRoot,
          sourceRoot: identity.siteRoot,
          sourceGitSHA: identity.siteSourceSHA,
        });
        assertSamePublicationArtifact(publicationArtifactAtStart, publicationArtifactAtEnd);
      } catch (error) {
        failures.push({ kind: 'publication-artifact', error });
      }
    }
    if (!failures.length) return;
    const integrityKind = failures.length === 1 ? failures[0].kind : 'capture-integrity';
    const integrityError = failures.length === 1
      ? failures[0].error
      : new AggregateError(failures.map(item => item.error), failures.map(item => item.error.message).join('; '));
    const reportErrors = await invalidateSourceMetadata({
      registry: metadataRegistry,
      captures,
      expectedHeadSha: identity.siteSourceSHA,
      claimedSourceSHAAtStart: identity.siteSourceSHA,
      reason: integrityError,
      captureError,
      integrityKind,
    });
    integrityFailureRecorded = true;
    throw combineCaptureAndIntegrityErrors(captureError, integrityError, reportErrors, integrityKind);
  };
  try {
    if (sourceGuard && sourceGuard.initialState.headSha !== identity.siteSourceSHA) {
      throw new Error(`A-05 PR base changed between identity capture (${identity.siteSourceSHA}) and read-only protection (${sourceGuard.initialState.headSha}).`);
    }
    await prepareCaptureOutput(metadataRegistry);
    const policy = await readPolicy();
    let server = null;
    let baseUrl;
    if (environment === 'local-http-uncompressed') {
      server = await startStaticServer({
        root: identity.publicArtifactRoot ?? identity.siteRoot,
        compression: 'none',
        port: 0,
      });
      baseUrl = server.url;
    } else {
      baseUrl = options['base-url'] ?? process.env.VISUAL_QA_BASE_URL ?? defaultCloudflareBase;
      if (!/^https:\/\//.test(baseUrl)) throw new Error('Cloudflare capture requires an HTTPS --base-url');
      if (!baseUrl.endsWith('/')) baseUrl += '/';
    }

    const checkoutSHA = identity.captureToolSHA;
    const siteSourceSHA = identity.siteSourceSHA;
    const siteSourceKind = environment === 'cloudflare-production'
      ? 'cloudflare-live-deployment'
      : publicationArtifactAtStart ? 'publication' : 'git-canonical-root';
    const servedRootRole = environment === 'cloudflare-production'
      ? 'cloudflare-origin'
      : publicationArtifactAtStart ? 'publication-artifact' : 'git-canonical-root';
    const publicationArtifact = publicationMetadataIdentity(publicationArtifactAtStart);
    const publicationPayloads = publicationArtifactAtStart?.payloads ?? null;
    const deploymentAtStart = environment === 'cloudflare-production' ? await readLiveDeployment(baseUrl) : null;

    const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    let browser;
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
            metadataRegistry,
            playwrightVersion: packageJson.devDependencies.playwright,
            siteSourceSHA,
            sourceGitSHA: siteSourceSHA,
            siteSourceKind,
            servedRootRole,
            publicationArtifact,
            publicationPayloads,
            captureToolSHA: identity.captureToolSHA,
            deploymentAtStart
          });
          captures.push(capture);
        }
      }
    } finally {
      if (browser) await browser.close();
      if (server) await server.close();
    }

    const deploymentAtEnd = environment === 'cloudflare-production' ? await readLiveDeployment(baseUrl) : null;
    const liveEvidence = environment === 'cloudflare-production'
      ? deploymentEvidence(checkoutSHA, deploymentAtStart?.receipt, deploymentAtEnd?.receipt)
      : null;
    const deploymentWindow = liveEvidence?.verification ?? null;
    if (deploymentWindow) {
      for (const capture of captures) {
        capture.sourceSHA = liveEvidence.sourceSHA;
        capture.siteSourceSHA = null;
        capture.sourceGitSHA = liveEvidence.sourceSHA;
        capture.siteSourceKind = 'cloudflare-live-deployment';
        capture.servedRootRole = 'cloudflare-origin';
        capture.liveDeployment = liveEvidence.liveDeployment;
        capture.environmentVerification.deploymentWindowStatus = deploymentWindow.status;
        const responseVerified = capture.environmentVerification.cloudflareVerified && capture.environmentVerification.encodingValid;
        capture.environmentVerification.status = responseVerified && deploymentWindow.status === 'VERIFIED' ? 'VERIFIED' : 'NOT_VERIFIED';
        capture.captureQuality = evaluateCaptureQuality(capture, { expectedHttpStatus: capture.expectedHttpStatus, screenshotRequired: false });
        delete capture.metadataSha256;
        capture.metadataSha256 = await writeCaptureMetadata({
          registry: metadataRegistry,
          id: capture.id,
          metadataPath: capture.metadataPath,
          record: capture,
        });
      }
    }
    await finalizeCaptureInputs();
    if (environment === 'cloudflare-production') {
      captureToolIntegrity = siteSourceIntegrity;
      siteSourceIntegrity = null;
    }
    const verificationFailures = captures.filter(item => item.environmentVerification.status !== 'VERIFIED');
    const screenshotEnabled = environment === 'local-http-uncompressed';
    const failedCaptures = captures.filter(item => item.captureQuality.status !== 'COMPLETE');
    const deploymentChanged = deploymentWindow?.status === 'MIXED_DEPLOYMENT';
    const manifest = {
      schemaVersion: 3,
      status: deploymentChanged ? 'MIXED_DEPLOYMENT' : captures.length === 30 && !failedCaptures.length && !verificationFailures.length
        ? screenshotEnabled ? 'CAPTURE_ONLY' : 'MEASUREMENT_ONLY'
        : 'CAPTURE_INCOMPLETE',
      baselineApproval: null,
      approval: null,
      exceptions: [],
      environment,
      baseUrl: new URL(baseUrl).origin,
      sourceSHA: liveEvidence ? liveEvidence.sourceSHA : siteSourceSHA,
      siteSourceSHA: liveEvidence ? null : siteSourceSHA,
      sourceGitSHA: liveEvidence ? liveEvidence.sourceSHA : siteSourceSHA,
      siteSourceKind: liveEvidence ? 'cloudflare-live-deployment' : siteSourceKind,
      servedRootRole: liveEvidence ? 'cloudflare-origin' : servedRootRole,
      publicationArtifact,
      ...(publicationPayloads ? { publicationPayloads } : {}),
      siteSourceIntegrity,
      captureToolIntegrity,
      captureToolSHA: identity.captureToolSHA,
      checkoutSHA,
      liveDeployment: liveEvidence ? {
        before: deploymentAtStart,
        after: deploymentAtEnd,
        verification: deploymentWindow,
        checkoutSHA: liveEvidence.checkoutSHA
      } : null,
      capturedAt: new Date().toISOString(),
      toolVersions: {
        visualQaRunner: runnerVersion,
        node: process.version,
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
      comparisonPolicy: policy.comparison,
      counts: {
        captures: captures.length,
        screenshots: captures.filter(item => item.screenshotSha256).length,
        failedCaptures: failedCaptures.length,
        environmentVerificationFailures: verificationFailures.length,
        firstPartyRequestFailures: captures.reduce((sum, item) => sum + item.captureQuality.firstPartyRequestFailureCount, 0),
        thirdPartyFailures: captures.reduce((sum, item) => sum + item.captureQuality.thirdPartyFailureCount, 0),
        thirdPartyPageErrors: captures.reduce((sum, item) => sum + item.captureQuality.thirdPartyPageErrorCount, 0),
        unclassifiedPageErrors: captures.reduce((sum, item) => sum + item.captureQuality.unclassifiedPageErrorCount, 0)
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
      siteSourceSHA: manifest.siteSourceSHA,
      sourceGitSHA: manifest.sourceGitSHA,
      siteSourceKind: manifest.siteSourceKind,
      servedRootRole: manifest.servedRootRole,
      publicationArtifact: manifest.publicationArtifact,
      siteSourceIntegrity,
      captureToolIntegrity,
      captureToolSHA: manifest.captureToolSHA,
      checkoutSHA: manifest.checkoutSHA,
      environment,
      liveDeployment: manifest.liveDeployment?.verification ?? null,
      captureCount: captures.length,
      screenshotCount: manifest.counts.screenshots,
      transferAndDomBudgetEnforcement: 'OBSERVATION_ONLY_UNTIL_BASELINE_APPROVED',
      baseline: null
    };
    await writeFile(resolve(runOutput, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    const expectedStatus = screenshotEnabled ? 'CAPTURE_ONLY' : 'MEASUREMENT_ONLY';
    if (manifest.status !== expectedStatus) process.exitCode = 1;
  } catch (error) {
    captureError = error;
    throw error;
  } finally {
    let deferredIntegrityError = null;
    if (!sourceIntegrityChecked || !publicationIntegrityChecked) {
      try {
        await finalizeCaptureInputs();
      } catch (error) {
        deferredIntegrityError = error;
        captureError = error;
      }
    }
    const finalFailures = [];
    try {
      await verifyGitSourceSnapshot(sourceSnapshot);
    } catch (error) {
      finalFailures.push({ kind: 'site-source', error });
    }
    if (publicationArtifactAtStart) {
      try {
        const finalArtifact = await validatePublicationArtifact({
          artifactRoot: identity.publicArtifactRoot,
          sourceRoot: identity.siteRoot,
          sourceGitSHA: identity.siteSourceSHA,
        });
        assertSamePublicationArtifact(publicationArtifactAtStart, finalArtifact);
      } catch (error) {
        finalFailures.push({ kind: 'publication-artifact', error });
      }
    }
    if (finalFailures.length) {
      const integrityKind = finalFailures.length === 1 ? finalFailures[0].kind : 'capture-integrity';
      const integrityError = finalFailures.length === 1
        ? finalFailures[0].error
        : new AggregateError(finalFailures.map(item => item.error), finalFailures.map(item => item.error.message).join('; '));
      const reportErrors = integrityFailureRecorded ? [] : await invalidateSourceMetadata({
        registry: metadataRegistry,
        captures,
        expectedHeadSha: identity.siteSourceSHA,
        claimedSourceSHAAtStart: identity.siteSourceSHA,
        reason: integrityError,
        captureError,
        integrityKind,
      });
      integrityFailureRecorded = true;
      const cleanupErrors = await removeInvalidCaptureSummaries(runOutput);
      throw combineCaptureAndIntegrityErrors(
        captureError,
        cleanupErrors.length ? new AggregateError([integrityError, ...cleanupErrors], integrityError.message) : integrityError,
        [...reportErrors, ...cleanupErrors],
        integrityKind,
      );
    }
    if (deferredIntegrityError) throw deferredIntegrityError;
  }
}

async function runCompare(options) {
  if (!options['candidate-manifest']) throw new Error('compare requires --candidate-manifest');
  const candidateManifestPath = resolve(options['candidate-manifest']);
  const candidate = JSON.parse(await readFile(candidateManifestPath, 'utf8'));
  const comparisonPath = resolve(options.output ?? resolve(dirname(candidateManifestPath), 'comparison.json'));
  const gitSelectionRequested = Boolean(options['baseline-selection']);
  const explicitBaselineRequested = Boolean(options['baseline-manifest'] || options['baseline-sha256'] || options['baseline-source-sha']);
  const baselineState = gitSelectionRequested && explicitBaselineRequested
    ? { status: 'REJECTED', reason: 'BASELINE_SOURCE_CONFLICT' }
    : gitSelectionRequested
      ? await readGitBaselineSelection({ repositoryRoot: root })
      : await readApprovedBaseline({
        manifestPath: options['baseline-manifest'] ? resolve(options['baseline-manifest']) : null,
        expectedSha256: options['baseline-sha256'],
        expectedSourceSha: options['baseline-source-sha']
      });
  const baselineSourceType = gitSelectionRequested ? 'git-selection' : 'explicit-baseline';
  const baselineManifestPath = baselineState.manifestPath ?? (options['baseline-manifest'] ? resolve(options['baseline-manifest']) : null);
  if (baselineState.status === 'PENDING') {
    const report = {
      status: 'PENDING',
      reason: baselineState.reason,
      comparisonPerformed: false,
      baselineSourceType,
      ...(baselineState.selectionPath ? { selectionPath: baselineState.selectionPath } : {}),
      sourceSHA: candidate.sourceSHA,
      message: 'No approved baseline was compared. Capture-only artifacts are not a visual regression pass.'
    };
    await mkdir(dirname(comparisonPath), { recursive: true });
    await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (baselineState.status !== 'APPROVED') {
    const report = {
      status: 'REJECTED',
      reason: baselineState.reason,
      actualBaselineSha256: baselineState.actualSha256,
      comparisonPerformed: false,
      baselineSourceType,
      ...(baselineState.selectionPath ? { selectionPath: baselineState.selectionPath } : {})
    };
    await mkdir(dirname(comparisonPath), { recursive: true });
    await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const approved = baselineState.manifest;
  if (siteSourceKind(candidate) !== siteSourceKind(approved)) {
    throw new Error('BASELINE_SITE_SOURCE_KIND_MISMATCH');
  }
  if (!validateSiteSourceKindRecord(candidate, candidate.siteSourceSHA ?? candidate.sourceSHA) ||
      !candidate.captures?.every(capture => validateSiteSourceKindRecord(capture, candidate.sourceSHA)) ||
      !validateSiteSourceKindRecord(approved, approved.siteSourceSHA ?? approved.sourceSHA) ||
      !approved.captures?.every(capture => validateSiteSourceKindRecord(capture, approved.sourceSHA))) {
    throw new Error('SITE_SOURCE_KIND_PROVENANCE_INVALID');
  }
  if (siteSourceKind(candidate) === 'publication' &&
      (!validatePublicationManifestRecord(candidate) || !validatePublicationManifestRecord(approved))) {
    throw new Error('PUBLICATION_ARTIFACT_PROVENANCE_INVALID');
  }
  if (candidate.status !== 'CAPTURE_ONLY' || candidate.counts?.captures !== 30 || candidate.captures?.length !== 30) {
    throw new Error('Candidate must contain a complete 30-capture CAPTURE_ONLY manifest');
  }
  if (!candidate.checkoutSHA || candidate.sourceSHA !== candidate.checkoutSHA ||
      candidate.siteSourceSHA !== candidate.sourceSHA || candidate.captureToolSHA !== candidate.checkoutSHA) {
    throw new Error('CANDIDATE_CHECKOUT_SHA_INVALID');
  }
  if (candidate.environment !== approved.environment) throw new Error('BASELINE_ENVIRONMENT_MISMATCH');
  if (candidate.environment !== 'local-http-uncompressed') throw new Error('PIXEL_COMPARISON_REQUIRES_LOCAL_SCREENSHOT_CAPTURE');
  const baselineById = new Map(approved.captures.map(item => [item.id, item]));
  const candidateById = new Map(candidate.captures.map(item => [item.id, item]));
  if (baselineById.size !== 30 || candidateById.size !== 30) throw new Error('BASELINE_OR_CANDIDATE_CAPTURE_IDS_INVALID');
  const incomparable = [...candidateById].flatMap(([id, current]) => {
    if (current.sourceSHA !== candidate.sourceSHA || current.siteSourceSHA !== candidate.siteSourceSHA ||
        current.captureToolSHA !== candidate.captureToolSHA || current.checkoutSHA !== candidate.checkoutSHA) {
      throw new Error(`CANDIDATE_CAPTURE_SOURCE_IDENTITY_INVALID:${id}`);
    }
    const previous = baselineById.get(id);
    if (!previous) throw new Error(`BASELINE_CAPTURE_MISSING:${id}`);
    const compatibility = compareCaptureConditions(current, previous);
    return compatibility.comparable ? [] : [{ id, reason: compatibility.reason }];
  });
  if (incomparable.length) {
    const report = {
      status: 'INCOMPARABLE',
      comparisonPerformed: false,
      baseline: {
        sourceType: baselineSourceType,
        ...(baselineState.selectionPath ? { selectionPath: baselineState.selectionPath } : {}),
        checkoutSHA: approved.checkoutSHA ?? approved.sourceSHA,
        manifestSha256: baselineState.actualSha256
      },
      candidate: { checkoutSHA: candidate.checkoutSHA, environment: candidate.environment },
      summary: { captures: 30, incomparable: incomparable.length },
      captures: incomparable.map(item => ({ ...item, status: 'INCOMPARABLE' }))
    };
    await mkdir(dirname(comparisonPath), { recursive: true });
    await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...report, captures: undefined }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const diffDir = resolve(dirname(candidateManifestPath), 'diff');
  await mkdir(diffDir, { recursive: true });
  const captures = [];
  for (const [id, current] of candidateById) {
    const previous = baselineById.get(id);
    if (!previous) throw new Error(`BASELINE_CAPTURE_MISSING:${id}`);
    const baselineImage = await verifyCaptureHash(baselineManifestPath, previous);
    const candidateImage = await verifyCaptureHash(candidateManifestPath, current);
    const baselineMetadata = await verifyCaptureMetadata(baselineManifestPath, previous);
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
    comparisonPerformed: captures.length > 0,
    baseline: {
      sourceType: baselineSourceType,
      ...(baselineState.selectionPath ? { selectionPath: baselineState.selectionPath } : {}),
      sourceSHA: approved.sourceSHA,
      manifestSha256: baselineState.actualSha256
    },
    candidate: { sourceSHA: candidate.sourceSHA, checkoutSHA: candidate.checkoutSHA, environment: candidate.environment },
    comparisonPolicy: approved.comparisonPolicy,
    summary: { captures: captures.length, failed: failed.length, staleBaseline: stale.length, passed: captures.length - failed.length - stale.length },
    captures
  };
  await mkdir(dirname(comparisonPath), { recursive: true });
  await writeFile(comparisonPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, captures: undefined }, null, 2)}\n`);
  if (report.status !== 'PASS') process.exitCode = 1;
}

async function runCrossCompare(options) {
  if (!options['candidate-manifest'] || !options['reference-manifest'] || !options['output-dir']) {
    throw new Error('cross-compare requires --reference-manifest, --candidate-manifest, and a new --output-dir.');
  }
  const report = await createCrossSourceReview({
    referenceManifestPath: resolve(options['reference-manifest']),
    candidateManifestPath: resolve(options['candidate-manifest']),
    outputDir: resolve(options['output-dir']),
  });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    reviewRequired: report.reviewRequired,
    baselineSelected: report.baselineSelected,
    summary: report.summary,
    reportPath: resolve(options['output-dir'], 'cross-source-review.json'),
  }, null, 2)}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'capture') {
    assertAllowedOptions(command, options);
    return runCapture(options);
  }
  if (command === 'compare') {
    assertAllowedOptions(command, options);
    return runCompare(options);
  }
  if (command === 'cross-compare') {
    assertAllowedOptions(command, options);
    return runCrossCompare(options);
  }
  if (command === 'help' || command === '--help' || !command) {
    process.stdout.write('Usage:\n  node visual-qa.mjs capture --environment local-http-uncompressed [--site-root GIT_ROOT] [--public-artifact BUILT_PUBLIC_ROOT] [--output-dir NEW_PATH]\n  node visual-qa.mjs capture --environment cloudflare-production --base-url https://www.huiwen.tw/ [--output-dir NEW_PATH]\n  node visual-qa.mjs cross-compare --reference-manifest PATH --candidate-manifest PATH --output-dir NEW_PATH\n  node visual-qa.mjs compare --candidate-manifest PATH [--baseline-selection]\n  node visual-qa.mjs compare --candidate-manifest PATH [--baseline-manifest PATH --baseline-sha256 SHA --baseline-source-sha SHA]\n');
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
