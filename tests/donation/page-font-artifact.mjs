import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { verifyPageFontPreloadEvidence } from './page-font-preload-contract.mjs';
import {
  gotoObservedWithTimeout,
  observePendingResult,
  preservePrimaryError,
  requireObservedValue,
  withTimeout,
} from './page-font-artifact-lifecycle.mjs';
import {
  buildFinalFontNetworkSnapshot,
  buildTrustedClickCaptureScript,
  expectedSharedFallbackFontsForRoute,
  filterCriticalRequestFailures,
  hashResponseBody,
  INITIAL_RENDER_TIMEOUT_MS,
  NETWORK_SETTLE_TIMEOUT_MS,
  readCdpMonotonicTimestamp,
  validateServiceCardOnDemand,
  validateTrustedClickMarker,
  waitForTrackedNetworkQuiet,
} from './page-font-artifact-network-gate.mjs';
import {
  buildCmsFixtureHtmlFulfill,
  buildCmsPreviewDraft,
  serializeCmsFixtureScriptValue,
} from './cms-preview-fixture.mjs';
import { errorRecord, runPageFontArtifactPreflight, writePageFontArtifactReport } from './page-font-artifact-preflight.mjs';
import { redactBrowserDiagnosticText, safeBrowserDiagnosticText } from './page-font-artifact-diagnostics.mjs';
import { collectVisibleFontDiagnostics } from './page-font-artifact-collector.mjs';
import {
  VISUAL_CAPTURE_COUNT,
  VISUAL_CAPTURE_SEED,
  buildVisualCaptureRecord,
  buildExpectedPageFonts,
  buildVisualFontProbeRequests,
  selectVisualRoutes,
  SYSTEM_FALLBACK_CODEPOINTS,
  validateArtifactIdentity,
  validateVisibleCodepointCoverage,
  validateVisualTypography,
  visualPngMatchesHash,
  visualPngPath,
} from './page-font-artifact-visual.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const artifact = resolve(root, '_site');
const base = process.env.BASE_URL || 'http://127.0.0.1:8789/';
const fontRoot = 'assets/fonts/huiwen-site-sans/';
const fullTcPath = `${fontRoot}huiwen-site-sans-tc-20261007.woff2`;
const output = resolve(root, 'tests/donation/results/page-font-artifact');
const reportPath = resolve(output, 'report.json');
const visualOutput = resolve(output, 'visual');
let publication;
let fontManifest;
let fullTcSha;
let artifactIdentity;
let sharedJpFallbackFont;
let cmsDiagnosticSecrets = [];

function urlPath(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.pathname : null;
  } catch {
    return null;
  }
}

function safeUrlSummary(value) {
  try {
    const url = new URL(value);
    const summary = { origin: url.origin === 'null' ? null : url.origin, host: url.host || null, pathname: url.pathname };
    const route = url.searchParams.get('path');
    if (route !== null) summary.query = { path: /^[A-Za-z0-9_./-]{1,256}$/.test(route) ? route : '[invalid]' };
    const cmsEdit = url.searchParams.get('cmsEdit');
    if (cmsEdit === '0' || cmsEdit === '1') summary.query = { ...summary.query, cmsEdit };
    return summary;
  } catch {
    return { origin: null, host: null, pathname: null };
  }
}

function browserMessageCategory(message) {
  const text = String(message || '').toLowerCase();
  if (/content security policy|frame-ancestors|refused to frame/.test(text)) return 'csp-frame-policy';
  if (/x-frame-options/.test(text)) return 'x-frame-options';
  if (/err_blocked_by_response|blocked by response/.test(text)) return 'response-blocked';
  if (/err_blocked_by_client|blocked by client/.test(text)) return 'client-blocked';
  if (/net::err_|networkerror|failed to load resource/.test(text)) return 'network-error';
  if (/\b(401|403|404)\b/.test(text)) return 'http-denied';
  return 'other-browser-error';
}

function safeBrowserError(error, secretValues = []) {
  const message = safeBrowserDiagnosticText(error?.message, secretValues);
  const stack = safeBrowserDiagnosticText(error?.stack, secretValues).split('\n').slice(0, 10);
  return {
    name: String(error?.name || 'Error').slice(0, 100),
    category: browserMessageCategory(message),
    message,
    stack,
  };
}

function sanitizeThrownError(error, secretValues = []) {
  if (!(error instanceof Error)) return new Error(redactBrowserDiagnosticText(error, secretValues));
  try {
    error.message = redactBrowserDiagnosticText(error.message, secretValues);
    if (typeof error.stack === 'string') error.stack = redactBrowserDiagnosticText(error.stack, secretValues);
    return error;
  } catch {
    const sanitized = new Error(redactBrowserDiagnosticText(error.message, secretValues));
    sanitized.name = String(error.name || 'Error');
    if (typeof error.stack === 'string') sanitized.stack = redactBrowserDiagnosticText(error.stack, secretValues);
    return sanitized;
  }
}

async function resolveSharedJpFallbackFont() {
  const stylesheet = await readFile(resolve(artifact, 'styles.css'), 'utf8');
  const face = [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/gi)]
    .map((match) => match[1])
    .find((rule) => /font-family\s*:\s*["']Huiwen Sans JP Support["']/i.test(rule));
  assert.ok(face, 'published CSS is missing the shared JP fallback font face');
  const source = face.match(/\bsrc\s*:\s*url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/i);
  const path = source?.[1] ?? source?.[2] ?? source?.[3];
  assert.match(path || '', /^\/assets\/fonts\/huiwen-site-sans\/generated\/huiwen-cjk-support-[a-f0-9]{12}\.woff2$/,
    'published shared JP fallback font path is invalid');
  const sha256 = publication.files[path.slice(1)];
  assert.match(sha256 || '', /^[a-f0-9]{64}$/, 'published shared JP fallback font has no manifest digest');
  return { path, sha256 };
}

function waitForCmsPreviewNavigation(page, timeout = 15000) {
  return page.waitForEvent('framenavigated', {
    predicate: (frame) => {
      if (frame === page.mainFrame() || frame.parentFrame() !== page.mainFrame()) return false;
      try {
        const url = new URL(frame.url());
        return url.origin === 'https://admin.huiwen.tw' && url.pathname === '/api/page-preview';
      } catch {
        return false;
      }
    },
    timeout,
  }).then((frame) => ({ frame }), (error) => ({ error }));
}

function cmsFailureSnapshot({ page, hostNavigationStatus, proxyRequests, proxyResponses, blockedReasons, messages,
  handshake, handshakeReadError, iframeInbound, iframeDomState, iframeDiagnosticReadError }) {
  return {
    frameURLs: page.frames().map((frame) => ({
      ...safeUrlSummary(frame.url()),
      mainFrame: frame === page.mainFrame(),
      parent: frame.parentFrame() ? safeUrlSummary(frame.parentFrame().url()) : null,
    })),
    hostUrl: safeUrlSummary(page.url()),
    hostNavigationStatus,
    proxyRequests: proxyRequests.slice(0, 20),
    proxyResponses: proxyResponses.slice(0, 20),
    blockedReasons: [...new Set(blockedReasons)].slice(0, 20),
    messages: messages.slice(0, 20),
    handshake: Array.isArray(handshake) ? handshake.slice(0, 30) : [],
    ...(handshakeReadError ? { handshakeReadError } : {}),
    iframeInbound: Array.isArray(iframeInbound) ? iframeInbound.slice(0, 30) : [],
    iframeDomState: iframeDomState || null,
    ...(iframeDiagnosticReadError ? { iframeDiagnosticReadError } : {}),
  };
}

function requestInitiator(initiator) {
  const frames = [];
  let stack = initiator?.stack;
  while (stack && frames.length < 3) {
    for (const frame of stack.callFrames || []) {
      if (frames.length >= 3) break;
      frames.push({ url: urlPath(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber });
    }
    stack = stack.parent;
  }
  return {
    type: initiator?.type || 'unknown',
    url: urlPath(initiator?.url),
    lineNumber: initiator?.lineNumber ?? null,
    frames,
  };
}

async function collectVisualTypography(page, route, expectedFonts, visibleDiagnostics) {
  const computedWeights = await withTimeout(page.evaluate(() => {
    const heading = document.querySelector('main h1') || document.querySelector('h1') || document.body;
    return {
      body: getComputedStyle(document.body).fontWeight,
      heading: getComputedStyle(heading).fontWeight,
    };
  }), INITIAL_RENDER_TIMEOUT_MS, `${route}: computed body and heading font weights`);
  const fontProbeRequests = buildVisualFontProbeRequests(expectedFonts, computedWeights);
  return withTimeout(page.evaluate(async ({ routeName, faces, fontProbeRequests, visibleTextDiagnostics }) => {
    const heading = document.querySelector('main h1') || document.querySelector('h1') || document.body;
    const fontChecks = await Promise.all(fontProbeRequests.map(async (probe) => {
      const probeCodepoint = probe.probeCodepoint;
      if (!Number.isInteger(probeCodepoint)) return {
        role: probe.role, family: probe.family,
        descriptorWeight: probe.descriptorWeight, computedWeight: probe.computedWeight,
        fontSpec: probe.fontSpec, probeCodepoint: null,
        checkResult: false, loadedFaces: [],
      };
      const probeText = String.fromCodePoint(probeCodepoint);
      const loadedFaces = await document.fonts.load(probe.fontSpec, probeText);
      return {
        role: probe.role,
        family: probe.family,
        descriptorWeight: probe.descriptorWeight,
        computedWeight: probe.computedWeight,
        fontSpec: probe.fontSpec,
        probeCodepoint,
        checkResult: document.fonts.check(probe.fontSpec, probeText),
        loadedFaces: loadedFaces.map((fontFace) => ({
          family: fontFace.family, weight: fontFace.weight, status: fontFace.status,
        })),
      };
    }));
    await document.fonts.ready;
    return {
      route: routeName,
      artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      documentFontsStatus: document.fonts.status,
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      bodyFontWeight: getComputedStyle(document.body).fontWeight,
      headingFontFamily: getComputedStyle(heading).fontFamily,
      headingFontWeight: getComputedStyle(heading).fontWeight,
      visibleCodepoints: visibleTextDiagnostics.visibleCodepoints,
      visibleCodepointsTruncated: visibleTextDiagnostics.visibleCodepointsTruncated,
      rawTcUnsupportedCodepoints: visibleTextDiagnostics.rawTcUnsupportedCodepoints,
      rawTcUnsupportedGlyphOwners: visibleTextDiagnostics.rawTcUnsupportedGlyphOwners,
      fallbackCodepoints: visibleTextDiagnostics.fallbackCodepoints,
      unexpectedGlyphCount: visibleTextDiagnostics.unexpectedGlyphCount,
      unexpectedGlyphs: visibleTextDiagnostics.unexpectedGlyphs,
      uncoveredVisibleGlyphCount: visibleTextDiagnostics.uncoveredVisibleGlyphCount,
      uncoveredVisibleGlyphs: visibleTextDiagnostics.uncoveredVisibleGlyphs,
      fontFaces: [...document.fonts]
        .filter((fontFace) => faces.some((expected) => expected.family === fontFace.family))
        .map((fontFace) => ({
          family: fontFace.family, weight: fontFace.weight, style: fontFace.style, status: fontFace.status,
        })),
      fontChecks,
    };
  }, {
    routeName: route,
    faces: expectedFonts.map((font) => ({
      role: font.role, family: font.family, weight: font.weight, weightAxis: font.weightAxis,
      probeCodepoint: font.probeCodepoint,
    })),
    fontProbeRequests,
    visibleTextDiagnostics: {
      visibleCodepoints: visibleDiagnostics.visibleCodepoints,
      visibleCodepointsTruncated: visibleDiagnostics.visibleCodepointsTruncated,
      rawTcUnsupportedCodepoints: visibleDiagnostics.rawTcUnsupportedCodepoints,
      rawTcUnsupportedGlyphOwners: visibleDiagnostics.rawTcUnsupportedGlyphOwners,
      fallbackCodepoints: visibleDiagnostics.fallbackCodepoints,
      unexpectedGlyphCount: visibleDiagnostics.unexpectedGlyphCount,
      unexpectedGlyphs: visibleDiagnostics.unexpectedGlyphs,
      uncoveredVisibleGlyphCount: visibleDiagnostics.uncoveredVisibleGlyphCount,
      uncoveredVisibleGlyphs: visibleDiagnostics.uncoveredVisibleGlyphs,
    },
  }), INITIAL_RENDER_TIMEOUT_MS, `${route}: visual typography evidence`);
}

function createTrustedClickObserver(cdpSession, { initialTimestamp }) {
  const pendingTasks = [];
  const waiters = [];
  let paused = false;
  const onPaused = () => {
    paused = true;
    const task = (async () => {
      let observation;
      let failure;
      try {
        const timestamp = readCdpMonotonicTimestamp(
          await sendCdpWithTimeout(cdpSession, 'Performance.getMetrics'));
        const markerState = await sendCdpWithTimeout(cdpSession, 'Runtime.evaluate', {
          expression: 'window.__huiwenFontArtifactClickMarker || null',
          returnByValue: true,
        });
        observation = { timestamp, marker: markerState.result?.value ?? null };
      } catch (error) {
        failure = error;
      } finally {
        let resumed = false;
        try {
          await sendCdpWithTimeout(cdpSession, 'Debugger.resume');
          resumed = true;
        } catch (error) {
          failure ||= error;
        }
        if (resumed) paused = false;
      }
      const waiter = waiters.shift();
      if (waiter) {
        if (failure) waiter.reject(failure);
        else waiter.resolve(observation);
      }
    })();
    pendingTasks.push(task);
    void task.catch(() => {});
  };
  cdpSession.on('Debugger.paused', onPaused);

  return {
    arm(timeoutMs = INITIAL_RENDER_TIMEOUT_MS) {
      let resolveObservation;
      let rejectObservation;
      const pending = new Promise((resolve, reject) => {
        resolveObservation = resolve;
        rejectObservation = reject;
      });
      waiters.push({ resolve: resolveObservation, reject: rejectObservation });
      return observePendingResult(withTimeout(pending, timeoutMs,
        'trusted service-card click marker was not observed'));
    },
    validate(outcome, visualCaptureTimestamp) {
      const observation = requireObservedValue(outcome);
      return validateTrustedClickMarker({
        marker: observation.marker,
        timestamp: observation.timestamp,
        initialTimestamp,
        visualCaptureTimestamp,
      });
    },
    async dispose({ routePage, scriptIdentifier } = {}) {
      const errors = [];
      try {
        cdpSession.off('Debugger.paused', onPaused);
      } catch (error) {
        errors.push({ kind: 'debugger-pause-listener-remove', ...errorRecord(error) });
      }
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error('service-card click marker observer closed before a marker arrived'));
      }
      try {
        await withTimeout(Promise.all(pendingTasks), INITIAL_RENDER_TIMEOUT_MS,
          'finish CDP debugger pause handlers');
      } catch (error) {
        errors.push({ kind: 'debugger-pause-handler', ...errorRecord(error) });
      }
      if (paused) {
        try {
          await sendCdpWithTimeout(cdpSession, 'Debugger.resume');
          paused = false;
        } catch (error) {
          errors.push({ kind: 'debugger-resume', ...errorRecord(error) });
        }
      }
      if (routePage) {
        try {
          await withTimeout(routePage.evaluate(() => {
            if (window.__huiwenFontArtifactClickListener) {
              window.removeEventListener('click', window.__huiwenFontArtifactClickListener, true);
              delete window.__huiwenFontArtifactClickListener;
            }
            delete window.__huiwenFontArtifactClickMarker;
          }), INITIAL_RENDER_TIMEOUT_MS, 'remove service-card click listener');
        } catch (error) {
          errors.push({ kind: 'click-listener-remove', ...errorRecord(error) });
        }
      }
      if (scriptIdentifier) {
        try {
          await sendCdpWithTimeout(cdpSession, 'Page.removeScriptToEvaluateOnNewDocument', {
            identifier: scriptIdentifier,
          });
        } catch (error) {
          errors.push({ kind: 'click-script-remove', ...errorRecord(error) });
        }
      }
      try {
        await sendCdpWithTimeout(cdpSession, 'Debugger.setBreakpointsActive', { active: false });
      } catch (error) {
        errors.push({ kind: 'debugger-breakpoints-disable', ...errorRecord(error) });
      }
      try {
        await sendCdpWithTimeout(cdpSession, 'Debugger.disable');
      } catch (error) {
        errors.push({ kind: 'debugger-disable', ...errorRecord(error) });
      }
      return errors;
    },
  };
}

function makeVisualCaptureNetwork(snapshot, serviceCardEvidence = null) {
  return {
    ...snapshot,
    phase: 'visual-capture',
    snapshotStage: 'after-context-close',
    preOnDemandPhases: ['initial', 'visual-capture'],
    fullTcRequests: snapshot.fullTcRequests.filter((request) => request.phase === 'visual-capture'),
    preOnDemandFullTcRequests: snapshot.preOnDemandFullTcRequests,
    postTriggerFullTcRequests: snapshot.postTriggerFullTcRequests,
    serviceCardEvidence,
  };
}

async function readTrackedFontBodies(routeNetwork) {
  const bodyOutcomes = routeNetwork.requests
    .filter((record) => record.requestType === 'Font' && record.bodyOutcomePromise)
    .map((record) => record.bodyOutcomePromise);
  return withTimeout(Promise.all(bodyOutcomes), INITIAL_RENDER_TIMEOUT_MS,
    'read completed page-font response bodies');
}

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
const results = {
  ci: { githubSha: process.env.GITHUB_SHA || null, githubRef: process.env.GITHUB_REF || null,
    nodeVersion: process.version },
  source: { script: 'tests/donation/page-font-artifact.mjs', artifactRoot: artifact },
  artifactIdentity: null,
  head: { commit: process.env.GITHUB_SHA || null,
    githubRef: process.env.GITHUB_REF || null },
  runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch,
    chromiumVersion: null },
  preflight: { status: 'not-run' },
  samples: [], schemaRoutes: [], initialFontNetwork: { status: 'not-run', verification: 'not-evaluated',
    expectedRoutes: 464, routesChecked: 0,
    routes: [], fullTcInitialViolations: [], preloadViolations: [], navigationErrors: [],
    criticalRequestFailures: [], fontNetworkViolations: [], runtimeErrors: [], observationErrors: [] },
  serviceInitial: { status: 'not-run', errors: [] }, legacyRoutes: [], cmsPreview: { status: 'not-run' }, negativeGuards: {},
  visualCaptures: { status: 'not-run', seed: VISUAL_CAPTURE_SEED, expected: VISUAL_CAPTURE_COUNT,
    viewport: { width: 390, height: 844 }, selectedRoutes: [], records: [], errors: [],
    initialCaptureAttemptsBeforeOnDemandGesture: 0 },
  execution: {
    status: 'running', currentPhase: null, primaryError: null, secondaryErrors: [],
    phases: {
      preflight: { status: 'not-run' },
      representativeSamples: { status: 'not-run', expected: samples.length, completed: 0 },
      schemaRoutes: { status: 'not-run', expected: schemaRoutes.length, completed: 0 },
      initialFontNetwork: { status: 'not-run', verification: 'not-evaluated', expected: 464, completed: 0 },
      crossMonth: { status: 'not-run' },
      dynamicSearch: { status: 'not-run' },
      legacyRoutes: { status: 'not-run', expected: legacyRoutes.length, completed: 0, currentRoute: null },
      cmsPreview: { status: 'not-run' },
      cmsNegativeGuards: { status: 'not-run', expected: 4, completed: 0, currentMode: null },
      topLevelCmsGuard: { status: 'not-run' },
      finalAssertions: { status: 'not-run' },
    },
  },
};
let browser;
let runError;
let cmsFullFontResponseWait;

function startPhase(name) {
  results.execution.currentPhase = name;
  results.execution.phases[name].status = 'running';
}

function completePhase(name) {
  results.execution.phases[name].status = 'completed';
  if (results.execution.currentPhase === name) results.execution.currentPhase = null;
}

function captureRunFailure(error, source = null) {
  const merged = preservePrimaryError(runError, error);
  runError = merged.primaryError;
  if (merged.secondaryError) results.execution.secondaryErrors.push({
    ...(source ? { source } : {}), ...errorRecord(merged.secondaryError, cmsDiagnosticSecrets),
  });
  if (!results.execution.primaryError) {
    results.fatalError = errorRecord(runError, cmsDiagnosticSecrets);
    results.execution.primaryError = errorRecord(runError, cmsDiagnosticSecrets);
    if (source) results.execution.primarySource = source;
  }
  results.execution.status = 'failed';
  const phaseName = results.execution.currentPhase;
  if (phaseName) {
    const phase = results.execution.phases[phaseName];
    if (phase.status === 'running') {
      phase.status = 'failed';
      phase.error = errorRecord(runError, cmsDiagnosticSecrets);
    }
  }
}

function sendCdpWithTimeout(cdpSession, method, params) {
  const request = params === undefined ? cdpSession.send(method) : cdpSession.send(method, params);
  return withTimeout(request, INITIAL_RENDER_TIMEOUT_MS, `CDP ${method}`);
}

function createFontRouteState(route) {
  const routeRow = fontManifest.routes[route];
  return {
    route,
    routeRow,
    routeRecord: {
      route,
      navigation: { status: null },
      fullTcRequests: [],
      preloads: { expected: routeRow.preloads.map((path) => `/${path}`).sort(),
        declared: [], observed: [], requests: [] },
      visibleFontDiagnostics: null,
      navigationErrors: [],
      criticalRequestFailures: [],
      runtimeErrors: [],
      observationErrors: [],
      renderCompleteness: {
        definition: 'DOMContentLoaded + route readiness + document.fonts.ready; bounded settle for tracked Document, Font, Stylesheet, and Script requests except positively identified foreign child-frame Documents; those child Documents stay audited and pending means unknown; no networkidle',
        domContentLoaded: false,
        routeReady: false,
        documentFonts: false,
        screenshotCaptured: false,
        screenshotBeforeGesture: false,
      },
    },
    routeContext: null,
    routePage: null,
    cdpSession: null,
    clickObserver: null,
    clickScriptIdentifier: null,
    fixedClock: false,
    response: null,
    pendingVisualCapture: null,
    serviceCard: null,
    routeNetwork: {
      requests: [],
      tracked: new Map(),
      criticalRequestFailures: [],
      navigationRequests: [],
      mainFrameId: null,
      initialTimestamp: null,
      visualCaptureTimestamp: null,
      clickMarker: null,
      revision: 0,
    },
    observationClose: { pageClosed: false, contextClosed: false },
  };
}

async function captureFontOnlyRoute(state, visualRouteSet) {
  const { route, routeRow, routeRecord, routeNetwork } = state;
  try {
    state.routeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    state.routeContext.setDefaultTimeout(INITIAL_RENDER_TIMEOUT_MS);
    state.routeContext.setDefaultNavigationTimeout(INITIAL_RENDER_TIMEOUT_MS);
    state.routePage = await state.routeContext.newPage();
    if (route === 'service.html') {
      await state.routePage.clock.setFixedTime(new Date('2026-10-19T08:00:00+08:00'));
      state.fixedClock = true;
    }
    state.routePage.on('pageerror', (error) => routeRecord.runtimeErrors.push(errorRecord(error)));
    state.cdpSession = await withTimeout(state.routeContext.newCDPSession(state.routePage),
      INITIAL_RENDER_TIMEOUT_MS, `${route}: create CDP session`);
    await sendCdpWithTimeout(state.cdpSession, 'Network.enable');
    await sendCdpWithTimeout(state.cdpSession, 'Page.enable');
    await sendCdpWithTimeout(state.cdpSession, 'Runtime.enable');
    await sendCdpWithTimeout(state.cdpSession, 'Performance.enable');
    routeNetwork.mainFrameId = (await sendCdpWithTimeout(state.cdpSession, 'Page.getFrameTree')).frameTree.frame.id;
    if (route === 'service.html') {
      await sendCdpWithTimeout(state.cdpSession, 'Debugger.enable');
      const installed = await sendCdpWithTimeout(state.cdpSession, 'Page.addScriptToEvaluateOnNewDocument', {
        source: buildTrustedClickCaptureScript(),
      });
      state.clickScriptIdentifier = installed.identifier;
      routeNetwork.initialTimestamp = readCdpMonotonicTimestamp(
        await sendCdpWithTimeout(state.cdpSession, 'Performance.getMetrics'));
      state.clickObserver = createTrustedClickObserver(state.cdpSession, {
        initialTimestamp: routeNetwork.initialTimestamp,
      });
    } else {
      routeNetwork.initialTimestamp = readCdpMonotonicTimestamp(
        await sendCdpWithTimeout(state.cdpSession, 'Performance.getMetrics'));
    }

    const trackedTypes = new Set(['Document', 'Font', 'Stylesheet', 'Script']);
    const fullTcUrlPath = `/${fullTcPath}`;
    state.cdpSession.on('Network.requestWillBeSent', (event) => {
      const path = urlPath(event.request.url);
      let origin = null;
      try { origin = new URL(event.request.url).origin; } catch {}
      const type = event.type || 'unknown';
      const isMainFrame = event.frameId === routeNetwork.mainFrameId;
      const track = trackedTypes.has(type) && (isMainFrame || type === 'Font' || type === 'Document')
        || path === fullTcUrlPath;
      if (!track) return;
      const previous = routeNetwork.tracked.get(event.requestId);
      if (event.redirectResponse && previous) {
        previous.redirect = {
          status: event.redirectResponse.status,
          mimeType: event.redirectResponse.mimeType,
          url: safeUrlSummary(event.redirectResponse.url),
        };
        previous.terminal = 'redirected';
      }
      const record = {
        requestId: event.requestId,
        path,
        origin,
        method: event.request.method,
        requestType: type,
        frameId: event.frameId || null,
        isMainFrame,
        timestamp: event.timestamp,
        initiator: requestInitiator(event.initiator),
        track: true,
        terminal: null,
        response: null,
        encodedDataLength: null,
        failure: null,
      };
      routeNetwork.requests.push(record);
      routeNetwork.tracked.set(event.requestId, record);
      routeNetwork.revision += 1;
      if (isMainFrame && type === 'Document') routeNetwork.navigationRequests.push(record);
    });
    state.cdpSession.on('Network.responseReceived', (event) => {
      const record = routeNetwork.tracked.get(event.requestId);
      if (!record) return;
      record.response = {
        status: event.response.status,
        mimeType: event.response.mimeType,
        fromDiskCache: Boolean(event.response.fromDiskCache),
        fromServiceWorker: Boolean(event.response.fromServiceWorker),
      };
      routeNetwork.revision += 1;
      if (event.response.status >= 400) {
        routeNetwork.criticalRequestFailures.push({ ...record, kind: 'http-status' });
      }
    });
    state.cdpSession.on('Network.loadingFailed', (event) => {
      const record = routeNetwork.tracked.get(event.requestId);
      if (!record) return;
      record.terminal = 'failed';
      record.failure = { errorText: event.errorText, canceled: Boolean(event.canceled),
        blockedReason: event.blockedReason || null };
      routeNetwork.revision += 1;
      routeNetwork.criticalRequestFailures.push({ ...record, kind: 'request-failed' });
    });
    state.cdpSession.on('Network.loadingFinished', (event) => {
      const record = routeNetwork.tracked.get(event.requestId);
      if (!record) return;
      record.terminal = 'finished';
      record.encodedDataLength = event.encodedDataLength ?? null;
      routeNetwork.revision += 1;
      if (record.requestType === 'Font'
        && (!Number.isFinite(record.encodedDataLength) || record.encodedDataLength <= 0)) {
        record.failure = { errorText: 'CDP reported a zero-byte or missing font response body',
          canceled: false, blockedReason: null };
        routeNetwork.criticalRequestFailures.push({ ...record, kind: 'zero-byte-font-response' });
      }
      if (record.requestType === 'Font') {
        const bodyPromise = sendCdpWithTimeout(state.cdpSession, 'Network.getResponseBody', {
          requestId: event.requestId,
        })
          .then((response) => {
            assert.equal(response.base64Encoded, true,
              `CDP did not return a base64-encoded binary page-font response body for ${record.path}`);
            const bytes = Buffer.from(response.body, 'base64');
            const digest = hashResponseBody(bytes);
            Object.assign(record, { bodyBytes: digest.bytes, bodySha256: digest.sha256 });
            return { bytes: record.bodyBytes, sha256: record.bodySha256 };
          })
          .catch((error) => {
            record.bodyError = errorRecord(error).message;
            throw error;
          });
        record.bodyOutcomePromise = observePendingResult(bodyPromise);
      }
    });

    try {
      state.response = await withTimeout(state.routePage.goto(new URL(route, base).href, {
        waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS,
      }), INITIAL_RENDER_TIMEOUT_MS, `${route}: initial navigation`);
      routeRecord.navigation.status = state.response?.status() ?? null;
      routeRecord.renderCompleteness.domContentLoaded = Boolean(state.response);
      if (!state.response || state.response.status() !== 200) {
        routeRecord.navigationErrors.push({ kind: 'document-status', status: state.response?.status() ?? null });
      }
    } catch (error) {
      routeRecord.navigationErrors.push({ kind: 'navigation-exception', ...errorRecord(error) });
    }

    if (!state.response) return state;
    try {
      await withTimeout(state.routePage.waitForFunction(() => {
        const header = document.querySelector('.site-header .nav-wrap');
        return !header || Boolean(header.querySelector('.global-search-trigger'));
      }, null, { timeout: INITIAL_RENDER_TIMEOUT_MS }), INITIAL_RENDER_TIMEOUT_MS,
      `${route}: initial header readiness`);
      routeRecord.renderCompleteness.routeReady = true;
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'dynamic-header-state', ...errorRecord(error) });
    }
    if (route === 'service.html') {
      try {
        await withTimeout(state.routePage.waitForFunction(() =>
          document.querySelector('.schedule-text table caption')?.textContent.includes('僅顯示尚未結束的場次'),
        null, { timeout: INITIAL_RENDER_TIMEOUT_MS }), INITIAL_RENDER_TIMEOUT_MS,
        'service.html: initial calendar readiness');
        routeRecord.renderCompleteness.serviceCalendarReady = true;
      } catch (error) {
        routeRecord.observationErrors.push({ kind: 'service-initial-state', ...errorRecord(error) });
      }
    }
    try {
      await withTimeout(state.routePage.evaluate(() => document.fonts.ready.then(() => true)),
        INITIAL_RENDER_TIMEOUT_MS, `${route}: initial document.fonts.ready`);
      routeRecord.renderCompleteness.documentFonts = true;
      routeRecord.visibleFontDiagnostics = await collectVisibleFontDiagnostics(
        state.routePage, route, routeRow, fontManifest);
      routeRecord.preloads.declared = routeRecord.visibleFontDiagnostics.declaredPreloads;
      routeRecord.preloads.observed = routeRecord.visibleFontDiagnostics.observedPreloads;
      const expectedFonts = buildExpectedPageFonts(routeRow, fontManifest);
      const routeFallbacks = { jp: routeRow.jpFallbackCodepoints || [], system: SYSTEM_FALLBACK_CODEPOINTS };
      routeRecord.visibleFontDiagnostics.glyphCoverage = validateVisibleCodepointCoverage({
        route,
        routeCodepoints: routeRow.codepoints,
        expectedFonts,
        visibleCodepoints: routeRecord.visibleFontDiagnostics.visibleCodepoints,
        routeFallbacks,
      });
      assert.equal(routeRecord.visibleFontDiagnostics.visibleCodepointsTruncated, false,
        `${route}: initial visible glyph capture was truncated`);
      assert.equal(routeRecord.visibleFontDiagnostics.unexpectedGlyphCount, 0,
        `${route}: initial route has unexpected visible glyphs`);
      assert.deepEqual(routeRecord.visibleFontDiagnostics.unexpectedGlyphs, [],
        `${route}: initial route has nonempty unexpected glyph diagnostics`);
      assert.equal(routeRecord.visibleFontDiagnostics.uncoveredVisibleGlyphCount,
        routeRecord.visibleFontDiagnostics.unexpectedGlyphCount,
        `${route}: uncovered glyph count differs from unexpected glyph count`);
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'font-dom-diagnostic', ...errorRecord(error) });
    }

    if (visualRouteSet.has(route)) {
      routeRecord.visualCapture = { status: 'capturing-initial-screen' };
      try {
        assert.ok(state.response.status() === 200,
          `${route}: selected visual route did not return a successful page`);
        assert.ok(routeRecord.visibleFontDiagnostics,
          `${route}: initial visible font diagnostics are missing`);
        routeNetwork.visualCaptureTimestamp = readCdpMonotonicTimestamp(
          await sendCdpWithTimeout(state.cdpSession, 'Performance.getMetrics'));
        const visibleCodepoints = routeRecord.visibleFontDiagnostics.visibleCodepoints;
        const visibleCodepointSet = new Set(visibleCodepoints);
        const expectedFonts = buildExpectedPageFonts(routeRow, fontManifest).map((font) => ({
          ...font,
          probeCodepoint: font.codepoints.find((codepoint) => visibleCodepointSet.has(codepoint)) ?? null,
        }));
        const routeFallbacks = { jp: routeRow.jpFallbackCodepoints || [], system: SYSTEM_FALLBACK_CODEPOINTS };
        const fontStateBefore = await collectVisualTypography(state.routePage, route, expectedFonts,
          routeRecord.visibleFontDiagnostics);
        validateVisualTypography({ route, routeCodepoints: routeRow.codepoints,
          expectedFonts, typography: fontStateBefore, stage: 'before screenshot', routeFallbacks });
        const viewport = state.routePage.viewportSize();
        assert.deepEqual(viewport, results.visualCaptures.viewport,
          `${route}: visual capture viewport changed during the font-only route sweep`);
        const pngBytes = await withTimeout(state.routePage.screenshot({
          type: 'png', fullPage: false, caret: 'hide', timeout: INITIAL_RENDER_TIMEOUT_MS,
        }), INITIAL_RENDER_TIMEOUT_MS, `${route}: initial screenshot`);
        await withTimeout(state.routePage.evaluate(() => document.fonts.ready.then(() => true)),
          INITIAL_RENDER_TIMEOUT_MS, `${route}: post-screenshot document.fonts.ready`);
        await withTimeout(state.routePage.evaluate(() => new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))),
        INITIAL_RENDER_TIMEOUT_MS, `${route}: post-screenshot animation frames`);
        const afterDiagnostics = await collectVisibleFontDiagnostics(
          state.routePage, route, routeRow, fontManifest);
        validateVisibleCodepointCoverage({
          route,
          routeCodepoints: routeRow.codepoints,
          expectedFonts,
          visibleCodepoints: afterDiagnostics.visibleCodepoints,
          routeFallbacks,
        });
        assert.equal(afterDiagnostics.visibleCodepointsTruncated, false,
          `${route}: post-screenshot visible glyph capture was truncated`);
        assert.equal(afterDiagnostics.unexpectedGlyphCount, 0,
          `${route}: post-screenshot route has unexpected visible glyphs`);
        assert.deepEqual(afterDiagnostics.unexpectedGlyphs, [],
          `${route}: post-screenshot route has nonempty unexpected glyph diagnostics`);
        const fontStateAfter = await collectVisualTypography(state.routePage, route, expectedFonts, afterDiagnostics);
        validateVisualTypography({ route, routeCodepoints: routeRow.codepoints,
          expectedFonts, typography: fontStateAfter, stage: 'after screenshot', routeFallbacks });
        state.pendingVisualCapture = {
          pngBytes,
          viewport,
          routeCodepoints: routeRow.codepoints,
          expectedFonts,
          routeFallbacks,
          typography: { beforeCapture: fontStateBefore, afterCapture: fontStateAfter },
          preloads: {
            expected: routeRecord.preloads.expected,
            declared: routeRecord.preloads.declared,
            observed: routeRecord.preloads.observed,
          },
        };
        routeRecord.renderCompleteness.screenshotCaptured = true;
        routeRecord.renderCompleteness.screenshotBeforeGesture = true;
        routeRecord.renderCompleteness.animationFramesAfterScreenshot = 2;
        routeRecord.visualCapture = { status: 'captured-awaiting-final-network-snapshot' };
      } catch (error) {
        const failure = { route, ...errorRecord(error), evidence: {
          visibleFontDiagnostics: routeRecord.visibleFontDiagnostics,
          screenshotBeforeGesture: true,
        } };
        results.visualCaptures.errors.push(failure);
        routeRecord.visualCapture = { status: 'failed', error: errorRecord(error) };
        routeRecord.observationErrors.push({ kind: 'visual-capture', ...errorRecord(error) });
      }
    }
    return state;
  } catch (error) {
    routeRecord.observationErrors.push({ kind: 'route-sweep-exception', ...errorRecord(error) });
    return state;
  }
}

async function runServiceCardGesture(state) {
  const { routeRecord, routeNetwork, routePage, response, clickObserver } = state;
  const card = {
    status: 'running',
    route: 'service.html',
    viewport: '390x844',
    fixedTaipeiDate: '2026-10-19',
    initialFullTcRequests: null,
    cardFullTcRequests: 0,
    totalFullTcRequests: 0,
    cardFullTcBytes: null,
    cardFullTcSha256: null,
    responsePhase: null,
    cardCanvasVisible: false,
    initialCapturesCompletedBeforeGesture: true,
    errors: [],
  };
  state.serviceCard = card;
  if (!response || response.status() !== 200 || !routePage || !clickObserver) {
    card.errors.push({ kind: 'service-card-prerequisite', message: 'service route, page, or trusted-click observer is missing' });
    return;
  }

  try {
    const clickMarkerOutcome = clickObserver.arm(INITIAL_RENDER_TIMEOUT_MS);
    const clickOutcome = observePendingResult(routePage.locator('[data-legal-view="card"]').click({
      timeout: INITIAL_RENDER_TIMEOUT_MS,
    }));
    const [markerOutcome, actionOutcome] = await Promise.all([clickMarkerOutcome, clickOutcome]);
    const action = requireObservedValue(actionOutcome);
    routeNetwork.clickMarker = clickObserver.validate(markerOutcome, routeNetwork.visualCaptureTimestamp);
    card.userGesture = {
      status: 'trusted-click-dispatched',
      selector: routeNetwork.clickMarker.selector,
      timestampClock: routeNetwork.clickMarker.timestampClock,
      timestampSource: routeNetwork.clickMarker.source,
      clickCompleted: action === undefined,
    };
  } catch (error) {
    routeNetwork.clickMarker = null;
    card.errors.push({ kind: 'card-activation', ...errorRecord(error) });
  }
  try {
    const canvas = routePage.locator('.legal-card-preview canvas');
    await withTimeout(canvas.waitFor({ state: 'visible', timeout: INITIAL_RENDER_TIMEOUT_MS }),
      INITIAL_RENDER_TIMEOUT_MS, 'service card canvas visibility');
    const box = await withTimeout(canvas.boundingBox(), INITIAL_RENDER_TIMEOUT_MS,
      'service card canvas bounds');
    card.cardCanvasVisible = Boolean(box && box.width > 0 && box.height > 0);
    if (!card.cardCanvasVisible) card.errors.push({ kind: 'canvas-not-visible' });
  } catch (error) {
    card.errors.push({ kind: 'card-canvas', ...errorRecord(error) });
  }
  routeRecord.renderCompleteness.serviceCardGestureAttempted = true;
}

async function finalizeFontOnlyRoute(state) {
  const { route, routeRow, routeRecord, routeContext, routePage, cdpSession, routeNetwork } = state;
  if (routePage && cdpSession) {
    try {
      const settle = await withTimeout(waitForTrackedNetworkQuiet({
        routeNetwork,
        cdpSession,
        routeOrigin: new URL(base).origin,
        timeoutMs: NETWORK_SETTLE_TIMEOUT_MS,
      }), NETWORK_SETTLE_TIMEOUT_MS + 1000, `${route}: tracked-network settle`);
      routeRecord.networkSettle = settle;
      if (!settle.settled) routeRecord.observationErrors.push({
        kind: 'tracked-network-not-settled', pending: settle.pending, elapsedMs: settle.elapsedMs,
      });
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'tracked-network-settle', ...errorRecord(error) });
    }
    try {
      await readTrackedFontBodies(routeNetwork);
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'font-response-body-wait', ...errorRecord(error) });
    }
  }

  if (state.clickObserver) {
    try {
      const cleanupErrors = await state.clickObserver.dispose({
        routePage,
        scriptIdentifier: state.clickScriptIdentifier,
      });
      routeRecord.observationErrors.push(...cleanupErrors);
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'click-observer-dispose', ...errorRecord(error) });
    }
  }

  if (routePage) {
    try {
      await withTimeout(routePage.close(), INITIAL_RENDER_TIMEOUT_MS, `${route}: close observed page`);
      state.observationClose.pageClosed = true;
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'page-close', ...errorRecord(error) });
    }
  }
  if (routeContext) {
    try {
      await withTimeout(routeContext.close(), INITIAL_RENDER_TIMEOUT_MS, `${route}: close route context`);
      state.observationClose.contextClosed = true;
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'context-close', ...errorRecord(error) });
    }
  }
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  try {
    await readTrackedFontBodies(routeNetwork);
  } catch (error) {
    routeRecord.observationErrors.push({ kind: 'late-font-response-body-wait', ...errorRecord(error) });
  }

  let snapshot = null;
  const observationClosed = state.observationClose.pageClosed && state.observationClose.contextClosed;
  try {
    snapshot = buildFinalFontNetworkSnapshot({
      route,
      rawRequests: routeNetwork.requests,
      initialTimestamp: routeNetwork.initialTimestamp,
      visualCaptureTimestamp: routeNetwork.visualCaptureTimestamp,
      clickMarker: routeNetwork.clickMarker,
      expectedPreloads: routeRecord.preloads.expected,
      expectedFontArtifacts: routeRow.preloads.map((path) => {
        const font = fontManifest.fonts[path];
        assert.ok(font, `${route}: route preload font is missing from the producer manifest: ${path}`);
        return { path: `/${path}`, bytes: font.bytes, sha256: font.sha256 };
      }),
      expectedSharedFallbackFonts: expectedSharedFallbackFontsForRoute(routeRow, sharedJpFallbackFont),
      fullTcPath: `/${fullTcPath}`,
      routeOrigin: new URL(base).origin,
      observationClosed,
      requireTrustedClickMarker: route === 'service.html' && state.serviceCard !== null,
      renderCompleteness: routeRecord.renderCompleteness,
    });
  } catch (error) {
    routeRecord.observationErrors.push({ kind: 'final-network-snapshot', ...errorRecord(error) });
  }

  let serviceCardEvidence = null;
  if (snapshot) {
    routeRecord.finalNetworkSnapshot = snapshot;
    routeRecord.fullTcRequests = snapshot.fullTcRequests;
    routeRecord.preloads.requests = snapshot.pageFontRequests;
    routeRecord.networkGateViolations = snapshot.violations;
    for (const violation of snapshot.violations) {
      results.initialFontNetwork.fontNetworkViolations.push({ route, ...violation });
    }
    if (snapshot.preOnDemandFullTcRequests.length) {
      results.initialFontNetwork.fullTcInitialViolations.push({
        route, requests: snapshot.preOnDemandFullTcRequests,
      });
    }
    if (routeRecord.visibleFontDiagnostics) {
      const evidence = verifyPageFontPreloadEvidence({
        route,
        expected: routeRecord.preloads.expected,
        declared: routeRecord.preloads.declared,
        observed: routeRecord.preloads.observed,
        cdpRequests: snapshot.pageFontRequests,
        fixedClock: state.fixedClock,
      });
      routeRecord.preloads.verification = evidence.verification;
      routeRecord.preloads.cdpObserved = evidence.cdpObserved;
      routeRecord.preloads.domMatchesExpected = evidence.domMatchesExpected;
      routeRecord.preloads.cdpMatchesExpected = evidence.cdpMatchesExpected;
      if (!evidence.valid) results.initialFontNetwork.preloadViolations.push({
        route,
        expected: routeRecord.preloads.expected,
        declared: routeRecord.preloads.declared,
        observed: routeRecord.preloads.observed,
        cdpObserved: evidence.cdpObserved,
        verification: evidence.verification,
      });
    } else {
      results.initialFontNetwork.preloadViolations.push({
        route, expected: routeRecord.preloads.expected, declared: [], observed: [], verification: 'missing-dom-font-diagnostics',
      });
    }
    routeRecord.navigationErrors.push(...routeNetwork.navigationRequests
      .filter((item) => item.response && item.response.status !== 200)
      .map((item) => ({ kind: 'document-response', path: item.path, status: item.response.status })));
    routeRecord.criticalRequestFailures = filterCriticalRequestFailures(
      routeNetwork.criticalRequestFailures, new URL(base).origin);
  }

  if (route === 'service.html') {
    const card = state.serviceCard || {
      status: 'failed', route, errors: [{ kind: 'service-card-check-not-run' }],
      cardCanvasVisible: false, initialCapturesCompletedBeforeGesture: false,
    };
    if (snapshot) {
      serviceCardEvidence = validateServiceCardOnDemand({
        route,
        snapshot,
        expectedOrigin: new URL(base).origin,
        expectedPath: `/${fullTcPath}`,
        expectedBytes: 783820,
        expectedSha256: fullTcSha,
        canvasVisible: card.cardCanvasVisible,
      });
      card.initialFullTcRequests = snapshot.preOnDemandFullTcRequests.length;
      card.cardFullTcRequests = snapshot.postTriggerFullTcRequests.length;
      card.totalFullTcRequests = snapshot.fullTcRequests.length;
      card.cardFullTcBytes = serviceCardEvidence.request?.bytes ?? null;
      card.cardFullTcSha256 = serviceCardEvidence.request?.sha256 ?? null;
      card.responsePhase = serviceCardEvidence.request?.phase ?? null;
      card.errors.push(...serviceCardEvidence.errors);
    }
    card.status = card.errors.length === 0 ? 'passed' : 'failed';
    card.finalNetworkEvidence = serviceCardEvidence;
    routeRecord.serviceCard = card;
    results.serviceInitial = card;
  }

  if (state.pendingVisualCapture) {
    try {
      assert.ok(snapshot, `${route}: final network snapshot is missing`);
      const captureNetwork = makeVisualCaptureNetwork(snapshot,
        route === 'service.html' ? serviceCardEvidence : null);
      const record = buildVisualCaptureRecord({
        route,
        ...state.pendingVisualCapture,
        artifactIdentity,
        captureNetwork,
      });
      const file = visualPngPath(visualOutput, route);
      await writeFile(file.path, state.pendingVisualCapture.pngBytes);
      const storedPng = await readFile(file.path);
      record.file = `visual/${file.fileName}`;
      assert.ok(visualPngMatchesHash(storedPng, record.png.sha256),
        `${route}: stored screenshot bytes do not match their recorded SHA-256`);
      results.visualCaptures.records.push(record);
      routeRecord.visualCapture = {
        status: 'captured', file: record.file, pngSha256: record.png.sha256,
        capturePhase: captureNetwork.phase,
        initialFullTcRequestsBeforeCapture: captureNetwork.initialFullTcRequestsBeforeCapture,
        fullTcRequestsDuringCapture: captureNetwork.fullTcRequests.length,
        preOnDemandFullTcRequests: captureNetwork.preOnDemandFullTcRequests.length,
        postTriggerFullTcRequests: captureNetwork.postTriggerFullTcRequests.length,
        pageFontRequestsDuringCapture: captureNetwork.phaseCounts['visual-capture'].pageFont,
        pageFontRequestsBeforeOnDemand: captureNetwork.pageFontRequests.length,
        finalSnapshotStage: captureNetwork.snapshotStage,
      };
    } catch (error) {
      const failure = { route, ...errorRecord(error), evidence: {
        finalNetworkSnapshot: snapshot,
        renderCompleteness: routeRecord.renderCompleteness,
      } };
      results.visualCaptures.errors.push(failure);
      routeRecord.visualCapture = { status: 'failed', error: errorRecord(error), evidence: failure.evidence };
      routeRecord.observationErrors.push({ kind: 'visual-capture-finalization', ...errorRecord(error) });
    }
  }

  routeRecord.observationClose = state.observationClose;
  routeRecord.navigationErrors.forEach((error) =>
    results.initialFontNetwork.navigationErrors.push({ route, ...error }));
  routeRecord.criticalRequestFailures.forEach((error) =>
    results.initialFontNetwork.criticalRequestFailures.push({ route, ...error }));
  routeRecord.runtimeErrors.forEach((error) => results.initialFontNetwork.runtimeErrors.push({ route, ...error }));
  routeRecord.observationErrors.forEach((error) => results.initialFontNetwork.observationErrors.push({ route, ...error }));
  results.initialFontNetwork.routes.push(routeRecord);
  results.initialFontNetwork.routesChecked = results.initialFontNetwork.routes.length;
  results.execution.phases.initialFontNetwork.completed = results.initialFontNetwork.routesChecked;
}

try {
  const preflight = await runPageFontArtifactPreflight({
    artifactRoot: artifact,
    fullTcPath,
    expectedBytes: 783820,
    reportPath,
    results,
  });
  publication = preflight.publication;
  fontManifest = preflight.fontManifest;
  fullTcSha = preflight.fullTcSha;
  sharedJpFallbackFont = await resolveSharedJpFallbackFont();
  const [publicationBytes, deploymentBytes] = await Promise.all([
    readFile(resolve(artifact, 'publication-manifest.json')),
    readFile(resolve(artifact, 'deployment.json')),
  ]);
  artifactIdentity = validateArtifactIdentity({
    deployment: JSON.parse(deploymentBytes.toString('utf8')),
    publicationBytes,
    expectedSourceCommit: process.env.GITHUB_SHA || null,
  });
  results.artifactIdentity = artifactIdentity;
  const legalRoutes = Object.keys(fontManifest.routes);
  assert.equal(legalRoutes.length, 464, 'visual selection requires the complete schema-2 route inventory');
  const visualRoutes = selectVisualRoutes(legalRoutes, {
    seed: VISUAL_CAPTURE_SEED,
    count: VISUAL_CAPTURE_COUNT,
  });
  const visualRouteSet = new Set(visualRoutes);
  results.visualCaptures.selectedRoutes = visualRoutes;
  results.visualCaptures.status = 'running';
  await mkdir(visualOutput, { recursive: true });

  browser = await chromium.launch({ headless: true });
  results.ci.chromiumVersion = await browser.version();
  results.runtime.chromiumVersion = results.ci.chromiumVersion;
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  context.setDefaultTimeout(INITIAL_RENDER_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(INITIAL_RENDER_TIMEOUT_MS);
  const page = await context.newPage();
  const observedFullTc = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === `/${fullTcPath}`) observedFullTc.push(response.url());
  });

  startPhase('representativeSamples');
  for (const route of samples) {
    const routeRow = fontManifest.routes[route];
    assert.ok(routeRow, `missing manifest route: ${route}`);
    const commonCodepoint = fontManifest.fonts[routeRow.commonFont].codepoints.find((cp) => routeRow.codepoints.includes(cp));
    const deltaCodepoint = fontManifest.fonts[routeRow.deltaFont].codepoints.find((cp) => routeRow.codepoints.includes(cp));
    assert.ok(Number.isInteger(commonCodepoint) && Number.isInteger(deltaCodepoint), `${route}: no common/delta glyph sample`);
    const response = await gotoObservedWithTimeout(page, new URL(route, base).href,
      { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
    assert.equal(response.status(), 200, route);
    await withTimeout(page.evaluate(() => document.fonts.ready.then(() => true)),
      INITIAL_RENDER_TIMEOUT_MS, `${route}: representative document.fonts.ready`);
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
    results.execution.phases.representativeSamples.completed += 1;
  }
  completePhase('representativeSamples');

  startPhase('schemaRoutes');
  for (const route of schemaRoutes) {
    const routeRow = fontManifest.routes[route];
    assert.ok(routeRow, `missing schema-2 route: ${route}`);
    const response = await gotoObservedWithTimeout(page, new URL(route, base).href,
      { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
    assert.equal(response.status(), 200, route);
    await withTimeout(page.evaluate(() => document.fonts.ready.then(() => true)),
      INITIAL_RENDER_TIMEOUT_MS, `${route}: schema document.fonts.ready`);
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
    results.execution.phases.schemaRoutes.completed += 1;
  }
  completePhase('schemaRoutes');
  const fontOnlyRoutes = Object.keys(fontManifest.routes).sort();
  const fullTcInitialViolations = results.initialFontNetwork.fullTcInitialViolations;
  const fontOnlyStarted = performance.now();
  startPhase('initialFontNetwork');
  results.initialFontNetwork.status = 'running';
  let deferredServiceState = null;
  let visualCaptureAttempts = 0;
  for (const route of fontOnlyRoutes) {
    const state = createFontRouteState(route);
    await captureFontOnlyRoute(state, visualRouteSet);
    if (visualRouteSet.has(route)) visualCaptureAttempts += 1;
    if (route === 'service.html') deferredServiceState = state;
    else await finalizeFontOnlyRoute(state);
  }
  results.visualCaptures.initialCaptureAttemptsBeforeOnDemandGesture = visualCaptureAttempts;
  assert.equal(visualCaptureAttempts, VISUAL_CAPTURE_COUNT,
    'the complete 20-route initial capture attempt set did not finish before the on-demand gesture');
  if (deferredServiceState) {
    await runServiceCardGesture(deferredServiceState);
    await finalizeFontOnlyRoute(deferredServiceState);
  } else {
    results.serviceInitial = { status: 'failed', errors: [{ kind: 'missing-service-route',
      message: 'service route was absent from the primary 464-route sweep' }] };
  }
  results.initialFontNetwork.routes.sort((left, right) => left.route.localeCompare(right.route));
  results.initialFontNetwork.durationSeconds = Number(((performance.now() - fontOnlyStarted) / 1000).toFixed(2));
  results.initialFontNetwork.status = 'observed';
  completePhase('initialFontNetwork');
  results.visualCaptures.status = results.visualCaptures.records.length === VISUAL_CAPTURE_COUNT
    && results.visualCaptures.errors.length === 0 ? 'captured' : 'failed';
  results.visualCaptures.visualReview = 'not-performed';
  try {
    assert.equal(results.initialFontNetwork.routesChecked, 464, 'initial font-only sweep missed schema-2 routes');
    assert.deepEqual(fullTcInitialViolations, [], 'a route requested full TC before explicit user on-demand activation');
    assert.deepEqual(results.initialFontNetwork.fontNetworkViolations, [],
      'the final closed-session font network snapshot contains a gate violation');
    assert.deepEqual(results.initialFontNetwork.preloadViolations, [], 'at least one route had a different first-view font preload closure');
    assert.deepEqual(results.initialFontNetwork.navigationErrors, [], 'at least one route had a navigation error');
    assert.deepEqual(results.initialFontNetwork.criticalRequestFailures, [], 'at least one route had a critical request failure');
    assert.deepEqual(results.initialFontNetwork.runtimeErrors, [], 'at least one route raised an uncaught page error');
    assert.deepEqual(results.initialFontNetwork.observationErrors, [], 'at least one route could not be fully diagnosed');
    results.initialFontNetwork.verification = 'passed';
    results.execution.phases.initialFontNetwork.verification = 'passed';
    results.initialFontNetwork.verificationEvaluation = { status: 'passed', assertions: 8 };
  } catch (error) {
    results.initialFontNetwork.verification = 'failed';
    results.execution.phases.initialFontNetwork.verification = 'failed';
    results.initialFontNetwork.verificationEvaluation = {
      status: 'failed', assertions: 8, error: errorRecord(error),
    };
  }

  startPhase('crossMonth');
  const crossMonthContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  crossMonthContext.setDefaultTimeout(INITIAL_RENDER_TIMEOUT_MS);
  crossMonthContext.setDefaultNavigationTimeout(INITIAL_RENDER_TIMEOUT_MS);
  let crossMonthError;
  try {
    const crossMonthPage = await crossMonthContext.newPage();
    await crossMonthPage.clock.setFixedTime(new Date('2026-11-01T08:00:00+08:00'));
    const crossMonthFullTcRequests = [];
    crossMonthPage.on('request', (request) => {
      if (new URL(request.url()).pathname === `/${fullTcPath}`) crossMonthFullTcRequests.push(request.url());
    });
    await gotoObservedWithTimeout(crossMonthPage, new URL('service.html', base).href,
      { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
    await withTimeout(crossMonthPage.waitForFunction(() =>
      document.querySelector('[data-legal-month-state]')?.textContent.includes('此為2026年10月時間表'),
    null, { timeout: INITIAL_RENDER_TIMEOUT_MS }), INITIAL_RENDER_TIMEOUT_MS,
    'cross-month legal-calendar readiness');
    await withTimeout(crossMonthPage.evaluate(() => document.fonts.ready.then(() => true)),
      INITIAL_RENDER_TIMEOUT_MS, 'cross-month document.fonts.ready');
    assert.deepEqual(crossMonthFullTcRequests, [],
      'the cross-month legal-calendar state requested the 783,820-byte full TC font');
    results.serviceCrossMonth = { route: 'service.html', viewport: '390x844', fixedTaipeiDate: '2026-11-01',
      initialFullTcRequests: crossMonthFullTcRequests.length };
  } catch (error) {
    crossMonthError = error;
  }
  try {
    await withTimeout(crossMonthContext.close(), INITIAL_RENDER_TIMEOUT_MS,
      'close cross-month route context');
  } catch (error) {
    const merged = preservePrimaryError(crossMonthError, error);
    crossMonthError = merged.primaryError;
    if (merged.secondaryError) results.execution.secondaryErrors.push({
      source: 'cross-month-context-close', ...errorRecord(merged.secondaryError),
    });
  }
  if (crossMonthError) throw crossMonthError;
  completePhase('crossMonth');
  assert.deepEqual(observedFullTc, [], 'initial representative page visits downloaded the 783,820-byte full TC font');

  startPhase('dynamicSearch');
  const searchPage = await context.newPage();
  await searchPage.setViewportSize({ width: 390, height: 844 });
  const searchFullTcResponses = [];
  searchPage.on('response', (response) => {
    if (new URL(response.url()).pathname === `/${fullTcPath}`) searchFullTcResponses.push(response);
  });
  await gotoObservedWithTimeout(searchPage, new URL('index.html', base).href,
    { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
  await withTimeout(searchPage.evaluate(() => document.fonts.ready.then(() => true)),
    INITIAL_RENDER_TIMEOUT_MS, 'dynamic-search document.fonts.ready');
  assert.deepEqual(searchFullTcResponses, [], 'full TC font loaded before dynamic search was opened');
  await searchPage.locator('.menu-toggle').click();
  await searchPage.waitForFunction(() => document.querySelector('.menu-toggle')?.getAttribute('aria-expanded') === 'true',
    null, { timeout: INITIAL_RENDER_TIMEOUT_MS });
  await searchPage.locator('.global-search-trigger').click();
  await searchPage.locator('#global-search-dialog').waitFor({ state: 'visible', timeout: INITIAL_RENDER_TIMEOUT_MS });
  await searchPage.locator('#global-search-dialog input[type="search"]').fill('文德國小');
  await searchPage.locator('.global-search-result').first().waitFor({ timeout: INITIAL_RENDER_TIMEOUT_MS });
  await withTimeout(searchPage.evaluate(() => document.fonts.ready.then(() => true)),
    INITIAL_RENDER_TIMEOUT_MS, 'dynamic-search post-trigger document.fonts.ready');
  const searchFontResponse = searchFullTcResponses.find((response) => response.status() === 200);
  assert.ok(searchFontResponse, 'dynamic search did not request the full TC font after activation');
  const searchFontBytes = await searchFontResponse.body();
  assert.equal(createHash('sha256').update(searchFontBytes).digest('hex'), fullTcSha,
    'dynamic search downloaded bytes that differ from the published full TC font');
  results.dynamicSearch = { triggered: true, fullTcBytes: searchFontBytes.byteLength,
    fullTcSha256: fullTcSha, firstResult: await searchPage.locator('.global-search-result').first().innerText() };
  await searchPage.close();
  completePhase('dynamicSearch');

  startPhase('legacyRoutes');
  for (const [route, expectedPage] of legacyRoutes) {
    results.execution.phases.legacyRoutes.currentRoute = route;
    const response = await gotoObservedWithTimeout(page, new URL(route, base).href,
      { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
    assert.equal(response.status(), 200, route);
    await withTimeout(page.evaluate(() => document.fonts.ready.then(() => true)),
      INITIAL_RENDER_TIMEOUT_MS, `${route}: legacy document.fonts.ready`);
    const pageData = await page.locator('html').getAttribute('data-huiwen-font-page');
    assert.equal(pageData, expectedPage, `${route}: existing nine-route font marker changed`);
    assert.equal(await page.locator('html').getAttribute('data-huiwen-font-artifact-route'), null, route);
    results.legacyRoutes.push({ route, fontPage: pageData });
    results.execution.phases.legacyRoutes.completed += 1;
  }
  results.execution.phases.legacyRoutes.currentRoute = null;
  completePhase('legacyRoutes');

  startPhase('cmsPreview');
  results.cmsPreview = { status: 'running', documentCharacterSet: { host: null, proxy: null } };
  const cmsRoute = 'achievement-wujia-public-parking.html';
  const cmsRow = fontManifest.routes[cmsRoute];
  const draftChar = '黑';
  const cmsDraft = buildCmsPreviewDraft(draftChar);
  const cmsDraftJson = serializeCmsFixtureScriptValue(cmsDraft);
  const unauthorizedDraftJson = serializeCmsFixtureScriptValue({
    title: 'UNAUTHORIZED DRAFT', paragraphs: [draftChar], history: [], media: [],
  });
  assert.ok(!cmsRow.codepoints.includes(draftChar.codePointAt(0)), 'draft test glyph already exists in original route subset');
  const publishedStyles = await readFile(resolve(artifact, 'styles.css'), 'utf8');
  const fullTcFaceRule = [...publishedStyles.matchAll(/@font-face\s*\{[^}]*\}/gi)]
    .map((match) => match[0])
    .find((rule) => rule.includes(`url("/${fullTcPath}")`));
  assert.ok(fullTcFaceRule, 'published CSS does not define the expected full TC font file');
  const fullTcUnicodeRange = fullTcFaceRule.match(/unicode-range\s*:\s*([^;}]+)/i)?.[1] || '';
  const draftCodepoint = draftChar.codePointAt(0);
  const fullTcCmapContainsDraft = fullTcUnicodeRange.split(',').some((token) => {
    const match = token.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
    if (!match) return false;
    const start = Number.parseInt(match[1], 16);
    const end = Number.parseInt(match[2] || match[1], 16);
    return draftCodepoint >= start && draftCodepoint <= end;
  });
  assert.ok(fullTcCmapContainsDraft, 'published full TC CMap does not declare the CI draft glyph');
  results.cmsPreview.cmapCoverage = { fontPath: fullTcPath,
    codepoint: `U+${draftCodepoint.toString(16).toUpperCase()}`, includedInPublishedUnicodeRange: true };
  const editorAsset = Object.keys(publication.files).find((path) => /^cms-page-editor\.[a-f0-9]{12}\.js$/.test(path));
  assert.ok(editorAsset, 'published CMS editor runtime missing');
  const session = 'g02-ci-page-preview-nonce';
  const accessAssertion = 'g02-ci-fixture-verified-owner-access-assertion';
  const nonce = 'g02-ci-preview-nonce';
  cmsDiagnosticSecrets = [session, accessAssertion, nonce];
  async function fetchPublishedPreview(timeoutMs = 15000) {
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000,
      'published preview fetch timeout must be finite and no greater than 15000ms');
    const upstream = await fetch(new URL(cmsRoute, base), {
      headers: { Accept: 'text/html', 'Cache-Control': 'no-cache, no-store' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(upstream.status, 200, 'authenticated preview proxy could not fetch the published artifact route');
    assert.match(upstream.headers.get('content-type') || '', /text\/html/, 'artifact service did not return HTML');
    const source = await withTimeout(upstream.text(), timeoutMs, 'read published CMS preview response body');
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
  cmsContext.setDefaultTimeout(INITIAL_RENDER_TIMEOUT_MS);
  cmsContext.setDefaultNavigationTimeout(INITIAL_RENDER_TIMEOUT_MS);
  await cmsContext.addInitScript(({ expectedNonce }) => {
    if (window.parent === window) return;
    const allowedTypes = new Set([
      'huiwen-cms-init', 'huiwen-cms-case-preview', 'huiwen-cms-home-preview',
      'huiwen-cms-editorial-preview', 'huiwen-cms-seo-preview', 'huiwen-cms-apply',
    ]);
    window.__g02CmsIframeInbound = [];
    window.addEventListener('message', (event) => {
      if (window.__g02CmsIframeInbound.length >= 30) return;
      const data = event.data;
      const origin = event.origin === 'null' ? 'opaque'
        : event.origin === 'https://admin.huiwen.tw' ? 'admin' : 'other';
      window.__g02CmsIframeInbound.push({
        sourceMatches: event.source === window.parent,
        origin,
        type: allowedTypes.has(data?.type) ? data.type : 'other',
        nonceMatches: data?.nonce === expectedNonce,
      });
    }, true);
  }, { expectedNonce: nonce });
  await cmsContext.route('https://www.huiwen.tw/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const localUrl = new URL(requestUrl.pathname.slice(1) + requestUrl.search, base).href;
    const upstream = await fetch(localUrl, {
      headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(15000),
    });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers),
      body: Buffer.from(await withTimeout(upstream.arrayBuffer(), INITIAL_RENDER_TIMEOUT_MS,
        'read routed CMS preview response body')) });
  });
  await cmsContext.route('https://evil.test/**', (route) => route.fulfill(buildCmsFixtureHtmlFulfill(
    `<script>let n=0;const t=setInterval(()=>{parent.frames[0].postMessage({type:'huiwen-cms-init',nonce:'forged'},'*');if(++n>30)clearInterval(t)},100)</script>`,
  )));

  async function installAdminRoutes(adminPage, mode) {
    await cmsContext.route('https://admin.huiwen.tw/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__g02/cms') {
        const cmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
        const previewPath = mode === 'wrong-path' ? 'index.html' : cmsRoute;
        const evilFrame = mode === 'unauthorized-message' ? '<iframe title="untrusted sender" src="https://evil.test/send"></iframe>' : '';
        const handshake = ['valid', 'wrong-cms-edit'].includes(mode)
          ? `
            window.__g02CmsHandshake = [];
            const note = (step, details = {}) => {
              if (window.__g02CmsHandshake.length < 30) window.__g02CmsHandshake.push({ step, ...details });
            };
            const sendInit = () => {
              note('init-sent');
              frame.contentWindow.postMessage({ type: 'huiwen-cms-init', nonce: '${nonce}' }, '*');
            };
            frame.onload = () => { note('frame-load'); sendInit(); };
            window.addEventListener('message', (event) => {
              const data = event.data;
              const sourceMatches = event.source === frame.contentWindow;
              const origin = event.origin === 'null' ? 'opaque'
                : event.origin === 'https://admin.huiwen.tw' ? 'admin' : 'other';
              const type = ['huiwen-cms-hello', 'huiwen-cms-ready', 'huiwen-cms-error', 'huiwen-cms-case-focus'].includes(data?.type)
                ? data.type : 'other';
              const nonceMatches = data?.nonce === '${nonce}';
              const section = type === 'huiwen-cms-case-focus'
                && ['sources', 'history', 'paragraphs', 'media', 'updated'].includes(data?.section)
                ? data.section : null;
              note('message', { sourceMatches, origin, type, nonceMatches, ...(section ? { section } : {}) });
              if (!sourceMatches || event.origin !== 'null') return;
              if (type === 'huiwen-cms-hello') sendInit();
              if (type === 'huiwen-cms-ready' && nonceMatches && !window.__draftSent) {
                window.__draftSent = true;
                note('draft-sent');
                frame.contentWindow.postMessage({ type: 'huiwen-cms-case-preview', nonce: '${nonce}',
                  case: ${cmsDraftJson} }, '*');
              }
            });`
          : '';
        return route.fulfill(buildCmsFixtureHtmlFulfill(`
          <iframe id="preview" title="CMS preview" sandbox="allow-scripts" src="/api/page-preview?path=${encodeURIComponent(previewPath)}&session=${session}&cmsEdit=${cmsEdit}"></iframe>
          ${evilFrame}<script>const frame=document.querySelector('#preview');${handshake}</script>`));
      }
      if (url.pathname === '/api/page-preview') {
        // Cloudflare Access injects this verified assertion at the edge before
        // the Worker calls security.owner(); the fixture models that boundary.
        const accessEdgeHeaders = mode === 'unauthenticated' ? {} : { 'cf-access-jwt-assertion': accessAssertion };
        const authorizedOwner = accessEdgeHeaders['cf-access-jwt-assertion'] === accessAssertion;
        const correctRoute = url.searchParams.get('path') === cmsRoute;
        const correctSession = url.searchParams.get('session') === session;
        const correctCapability = url.searchParams.get('cmsEdit') === '1';
        if (!authorizedOwner || !correctRoute || !correctSession || !correctCapability || !publication.files[cmsRoute])
          return route.fulfill({ status: 401, body: 'unauthorized preview' });
        return route.fulfill({
          status: 200, body: await fetchPublishedPreview(),
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-frame-options': 'SAMEORIGIN', 'content-security-policy': previewCsp },
        });
      }
      return route.fulfill(buildCmsFixtureHtmlFulfill('not found', { status: 404 }));
    });
  }

  const cmsPage = await cmsContext.newPage();
  const isCmsProxyUrl = (value) => {
    try {
      const url = new URL(value);
      return url.origin === 'https://admin.huiwen.tw' && url.pathname === '/api/page-preview';
    } catch {
      return false;
    }
  };
  const cmsProxyRequests = [];
  const cmsProxyResponses = [];
  const cmsProxyBlockedReasons = [];
  const cmsBrowserMessages = [];
  cmsPage.on('request', (request) => {
    if (isCmsProxyUrl(request.url())) cmsProxyRequests.push({ method: request.method(), ...safeUrlSummary(request.url()) });
  });
  cmsPage.on('response', (response) => {
    if (isCmsProxyUrl(response.url())) cmsProxyResponses.push({ status: response.status(), ...safeUrlSummary(response.url()) });
  });
  cmsPage.on('requestfailed', (request) => {
    if (!isCmsProxyUrl(request.url())) return;
    const category = browserMessageCategory(request.failure()?.errorText);
    cmsProxyBlockedReasons.push(category);
  });
  cmsPage.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    const location = message.location();
    cmsBrowserMessages.push({ type: message.type(), category: browserMessageCategory(message.text()),
      message: safeBrowserDiagnosticText(message.text(), cmsDiagnosticSecrets),
      source: { path: urlPath(location.url), lineNumber: location.lineNumber ?? null,
        columnNumber: location.columnNumber ?? null } });
  });
  cmsPage.on('pageerror', (error) => {
    cmsBrowserMessages.push({ type: 'pageerror', ...safeBrowserError(error, cmsDiagnosticSecrets) });
  });
  cmsFullFontResponseWait = observePendingResult(cmsPage.waitForResponse((response) =>
    new URL(response.url()).pathname === `/${fullTcPath}` && response.status() === 200,
  { timeout: INITIAL_RENDER_TIMEOUT_MS }));
  await installAdminRoutes(cmsPage, 'valid');
  const cmsProxyNavigation = waitForCmsPreviewNavigation(cmsPage);
  let cmsHostResponse;
  let cmsHostCharacterSet = null;
  let cmsProxyFrame;
  try {
    cmsHostResponse = await gotoObservedWithTimeout(cmsPage, 'https://admin.huiwen.tw/__g02/cms',
      { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
    assert.equal(cmsHostResponse?.status(), 200, 'CMS fixture host route did not return HTTP 200');
    cmsHostCharacterSet = await cmsPage.evaluate(() => document.characterSet);
    results.cmsPreview.documentCharacterSet.host = cmsHostCharacterSet;
    assert.equal(cmsHostCharacterSet, 'UTF-8', 'CMS fixture host document did not decode as UTF-8');
    const navigation = await cmsProxyNavigation;
    if (navigation.error) throw navigation.error;
    cmsProxyFrame = navigation.frame;
    await cmsPage.frameLocator('#preview').locator('html').waitFor({ state: 'attached', timeout: 15000 });
    await cmsProxyFrame.waitForLoadState('domcontentloaded', { timeout: 15000 });
    const proxyCharacterSet = await cmsProxyFrame.evaluate(() => document.characterSet);
    results.cmsPreview.documentCharacterSet.proxy = proxyCharacterSet;
    assert.equal(proxyCharacterSet, 'UTF-8', 'authenticated CMS proxy document did not decode as UTF-8');
    const proxyUrl = new URL(cmsProxyFrame.url());
    assert.equal(proxyUrl.origin, 'https://admin.huiwen.tw', 'CMS proxy frame navigated on an unexpected host');
    assert.equal(proxyUrl.pathname, '/api/page-preview', 'CMS proxy frame navigated to an unexpected path');
    assert.equal(proxyUrl.searchParams.get('path'), cmsRoute, 'CMS proxy frame requested an unexpected public route');
    assert.equal(proxyUrl.searchParams.get('cmsEdit'), '1', 'CMS proxy request did not carry its edit capability');
    if (proxyUrl.searchParams.get('session') !== session)
      throw new Error('CMS proxy request did not carry the fixture session');
    const proxyResponse = cmsProxyResponses.at(-1);
    assert.ok(proxyResponse, 'CMS proxy frame navigation produced no response');
    assert.equal(proxyResponse.status, 200, 'authenticated CMS proxy route was denied or failed');
    await cmsProxyFrame.waitForFunction(() => document.documentElement.dataset.huiwenFontArtifactPreview === '1', null, { timeout: 15000 });
    await cmsProxyFrame.waitForFunction(({ expectedTitle, draftGlyph }) => {
      const heading = document.querySelector('.case-head h1');
      const paragraph = [...(document.querySelector('.case-background')?.querySelectorAll('p') || [])]
        .find((item) => item.textContent.includes(draftGlyph));
      return heading?.textContent === expectedTitle && heading.innerText.includes(draftGlyph)
        && paragraph?.textContent.includes(draftGlyph);
    }, { expectedTitle: cmsDraft.title, draftGlyph: draftChar }, { timeout: 15000 });
    const previewInbound = await cmsProxyFrame.evaluate(() =>
      (window.__g02CmsIframeInbound || []).find((message) => message.type === 'huiwen-cms-case-preview'
        && message.sourceMatches && message.origin === 'admin' && message.nonceMatches));
    assert.ok(previewInbound, 'CMS preview did not receive the correct owner source, origin, and nonce');
    results.cmsPreview.casePreviewInbound = previewInbound;
    await cmsProxyFrame.locator('.case-background summary').click({ timeout: 15000 });
    await cmsPage.waitForFunction(() =>
      (window.__g02CmsHandshake || []).some((message) => message.step === 'message'
        && message.sourceMatches && message.origin === 'opaque'
        && message.type === 'huiwen-cms-case-focus' && message.nonceMatches
        && message.section === 'paragraphs'), null, { timeout: 15000 });
    const focusMessage = await cmsPage.evaluate(() =>
      (window.__g02CmsHandshake || []).find((message) => message.step === 'message'
        && message.type === 'huiwen-cms-case-focus' && message.nonceMatches
        && message.section === 'paragraphs'));
    assert.ok(focusMessage?.sourceMatches, 'summary click focus message did not come from the preview iframe');
    assert.equal(focusMessage.origin, 'opaque', 'sandboxed preview focus message had an unexpected origin');
    results.cmsPreview.summaryClickMessage = focusMessage;
  } catch (error) {
    let handshake = [];
    let handshakeReadError = null;
    let iframeInbound = [];
    let iframeDomState = null;
    let iframeDiagnosticReadError = null;
    try {
      handshake = await withTimeout(cmsPage.evaluate(() => Array.isArray(window.__g02CmsHandshake)
        ? window.__g02CmsHandshake.slice(0, 30) : []), INITIAL_RENDER_TIMEOUT_MS,
      'read sanitized CMS fixture handshake');
    } catch (snapshotError) {
      handshakeReadError = safeBrowserError(snapshotError, cmsDiagnosticSecrets);
    }
    if (cmsProxyFrame) {
      try {
        const iframeDiagnostic = await withTimeout(cmsProxyFrame.evaluate(({ expectedPath, expectedTitle, draftGlyph }) => {
          const validPath = (value) => typeof value === 'string'
            && /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/.test(value);
          const loader = document.querySelector('script[data-cms-editor-loader]');
          const loaderPath = loader?.dataset.cmsPagePath || null;
          const queryPath = new URL(location.href).searchParams.get('path');
          const runtime = document.querySelector('script[data-cms-editor-runtime]');
          let runtimeScriptPath = null;
          try {
            const runtimeUrl = new URL(runtime?.src || '', location.href);
            if (['https://admin.huiwen.tw', 'https://www.huiwen.tw'].includes(runtimeUrl.origin))
              runtimeScriptPath = runtimeUrl.pathname;
          } catch {}
          const caseBody = document.querySelector('.case-body');
          const latestWrap = document.querySelector('.case-latest-wrap');
          const background = document.querySelector('.case-background');
          const title = document.querySelector('.case-head h1');
          const headingRect = title?.getBoundingClientRect();
          const headingStyle = title ? getComputedStyle(title) : null;
          const paragraph = [...(background?.querySelectorAll('p') || [])]
            .find((item) => item.textContent.includes(draftGlyph));
          const inbound = Array.isArray(window.__g02CmsIframeInbound)
            ? window.__g02CmsIframeInbound.slice(0, 30) : [];
          return {
            inbound,
            domState: {
              documentCharacterSet: document.characterSet,
              bodyConnected: document.body?.isConnected === true,
              caseBodyConnected: caseBody?.isConnected === true,
              latestWrapConnected: latestWrap?.isConnected === true,
              backgroundsCount: document.querySelectorAll('.case-background').length,
              titleIsDraft: title?.textContent === expectedTitle,
              titleContainsDraft: Boolean(title?.innerText.includes(draftGlyph)),
              titleHasClientRects: Boolean(title?.getClientRects().length),
              titleIntersectsViewport: Boolean(headingRect && headingRect.width > 0 && headingRect.height > 0
                && headingRect.bottom > 0 && headingRect.top < innerHeight
                && headingRect.right > 0 && headingRect.left < innerWidth
                && headingStyle?.display !== 'none' && headingStyle?.visibility === 'visible'),
              paragraphInDom: Boolean(paragraph),
              paragraphContainsDraft: Boolean(paragraph?.textContent.includes(draftGlyph)),
              paragraphVisible: Boolean(paragraph?.getClientRects().length),
              anyMainContainsDraft: [...document.querySelectorAll('main')]
                .some((main) => main.textContent.includes(draftGlyph)),
              detailsOpen: background?.open === true,
              loaderCmsPagePath: validPath(loaderPath) ? loaderPath : loaderPath ? '[invalid]' : null,
              loaderPathValid: validPath(loaderPath),
              loaderRouteMatchesExpected: validPath(loaderPath) && loaderPath === expectedPath,
              queryPath: validPath(queryPath) ? queryPath : queryPath ? '[invalid]' : null,
              queryPathValid: validPath(queryPath),
              queryRouteMatchesExpected: validPath(queryPath) && queryPath === expectedPath,
              cmsEditEnabled: new URL(location.href).searchParams.get('cmsEdit') === '1',
              runtimeScriptPresent: Boolean(runtime),
              runtimeScriptPath,
            },
          };
        }, { expectedPath: cmsRoute, expectedTitle: cmsDraft.title, draftGlyph: draftChar }), 3000,
        'read bounded CMS iframe failure diagnostics');
        iframeInbound = iframeDiagnostic.inbound;
        iframeDomState = iframeDiagnostic.domState;
      } catch (snapshotError) {
        iframeDiagnosticReadError = safeBrowserError(snapshotError, cmsDiagnosticSecrets);
      }
    }
    results.cmsPreview.failureSnapshot = cmsFailureSnapshot({
      page: cmsPage,
      hostNavigationStatus: cmsHostResponse?.status() ?? null,
      proxyRequests: cmsProxyRequests,
      proxyResponses: cmsProxyResponses,
      blockedReasons: cmsProxyBlockedReasons,
      messages: cmsBrowserMessages,
      handshake,
      handshakeReadError,
      iframeInbound,
      iframeDomState,
      iframeDiagnosticReadError,
    });
    throw error;
  }
  const frame = cmsProxyFrame;
  results.cmsPreview.proxyNavigation = {
    hostUrl: safeUrlSummary(cmsPage.url()),
    hostStatus: cmsHostResponse.status(),
    frameUrl: safeUrlSummary(frame.url()),
    proxyStatus: cmsProxyResponses.at(-1)?.status ?? null,
  };
  const fullFontResponseOutcome = await cmsFullFontResponseWait;
  results.cmsPreview.fullFontResponseWait = { status: fullFontResponseOutcome.status,
    error: fullFontResponseOutcome.status === 'rejected'
      ? errorRecord(fullFontResponseOutcome.error, cmsDiagnosticSecrets) : null };
  const loadedFullFont = requireObservedValue(fullFontResponseOutcome);
  assert.equal(loadedFullFont.status(), 200, 'CMS proxy did not return HTTP 200 for the full TC font');
  results.cmsPreview.fullFontHttpStatus = loadedFullFont.status();
  const loadedBytes = await withTimeout(loadedFullFont.body(), INITIAL_RENDER_TIMEOUT_MS,
    'read CMS full-TC response body');
  assert.equal(loadedBytes.byteLength, 783820, 'CMS preview full TC response has an unexpected byte length');
  assert.equal(createHash('sha256').update(loadedBytes).digest('hex'), fullTcSha, 'CMS proxy did not download the published full TC font bytes');
  const cmsState = await withTimeout(frame.evaluate(async ({ draftGlyph, expectedTitle }) => {
    const details = document.querySelector('.case-background');
    const paragraph = [...(details?.querySelectorAll('p') || [])]
      .find((item) => item.textContent.includes(draftGlyph));
    const heading = document.querySelector('.case-head h1');
    const headingStyle = getComputedStyle(heading);
    const paragraphStyle = paragraph ? getComputedStyle(paragraph) : headingStyle;
    const headingRect = heading.getBoundingClientRect();
    const headingRects = [...heading.getClientRects()].map((rect) => ({
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    }));
    const fullTcFontSpec = `${paragraphStyle.fontStyle} ${paragraphStyle.fontWeight} ${paragraphStyle.fontSize} "Huiwen Sans TC"`;
    const fontProbeText = paragraph?.textContent || heading.innerText;
    const loadedFaces = await document.fonts.load(fullTcFontSpec, fontProbeText);
    const fontLoaded = document.fonts.check(fullTcFontSpec, fontProbeText);
    const matchingLoadedFaces = loadedFaces.filter((fontFace) => fontFace.family === 'Huiwen Sans TC');
    let headingVisibilityChain = true;
    for (let element = heading; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) {
        headingVisibilityChain = false;
        break;
      }
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${headingStyle.fontStyle} ${headingStyle.fontWeight} ${headingStyle.fontSize} ${headingStyle.fontFamily}`;
    const glyphWidth = context.measureText(draftGlyph).width;
    const headingVisible = headingRects.length > 0 && headingRect.width > 0 && headingRect.height > 0
      && headingRect.bottom > 0 && headingRect.top < innerHeight
      && headingRect.right > 0 && headingRect.left < innerWidth
      && headingVisibilityChain;
    return {
      marker: document.documentElement.dataset.huiwenFontArtifactPreview,
      documentCharacterSet: document.characterSet,
      headingText: heading.innerText,
      headingIsDraft: heading.textContent === expectedTitle,
      headingContainsDraftGlyph: heading.innerText.includes(draftGlyph),
      headingVisible,
      headingVisibilityChain,
      headingRects,
      headingFontFamily: headingStyle.fontFamily,
      headingFontWeight: headingStyle.fontWeight,
      paragraphInDom: Boolean(paragraph),
      paragraphContainsDraftGlyph: Boolean(paragraph?.textContent.includes(draftGlyph)),
      paragraphText: paragraph?.textContent || '',
      paragraphVisible: Boolean(paragraph?.getClientRects().length),
      detailsOpen: details?.open === true,
      paragraphFontFamily: paragraphStyle.fontFamily,
      paragraphFontWeight: paragraphStyle.fontWeight,
      paragraphUsesFullTcFamily: /Huiwen Sans TC/.test(paragraphStyle.fontFamily),
      fullTcFontSpec,
      fontLoaded,
      fullTcLoadedFaces: matchingLoadedFaces.map((fontFace) => ({
        family: fontFace.family, weight: fontFace.weight, status: fontFace.status,
      })),
      fullTcWeightProbe: { loadCalls: 1, checkCalls: 1, computedWeight: paragraphStyle.fontWeight },
      glyphCoverageProbe: {
        codepoint: `U+${draftGlyph.codePointAt(0).toString(16).toUpperCase()}`,
        loadTextContainsGlyph: fontProbeText.includes(draftGlyph),
        loadedMatchingFaceCount: matchingLoadedFaces.length,
      },
      glyphWidth,
      tofu: /[\uFFFD\u25A1]/.test(heading.innerText),
    };
  }, { draftGlyph: draftChar, expectedTitle: cmsDraft.title }), INITIAL_RENDER_TIMEOUT_MS,
  'read authenticated CMS preview frame state');
  assert.equal(cmsState.marker, '1');
  assert.equal(cmsState.documentCharacterSet, 'UTF-8');
  assert.equal(cmsState.headingIsDraft, true, 'CMS draft title was not applied to the visible heading');
  assert.ok(cmsState.headingContainsDraftGlyph, 'visible CMS draft heading omitted its draft-only TC glyph');
  assert.equal(cmsState.headingVisible, true, 'CMS draft heading is not visible in the viewport');
  assert.equal(cmsState.paragraphInDom, true, 'CMS draft paragraph was not inserted into the document');
  assert.equal(cmsState.paragraphContainsDraftGlyph, true, 'CMS draft paragraph omitted its draft-only TC glyph');
  assert.equal(cmsState.detailsOpen, false, 'CMS capture handler unexpectedly expanded the background details');
  assert.equal(cmsState.paragraphVisible, false, 'closed CMS background paragraph was unexpectedly reported visible');
  assert.match(cmsState.headingFontFamily, /Huiwen Sans TC/);
  assert.match(cmsState.paragraphFontFamily, /Huiwen Sans TC/);
  assert.equal(cmsState.paragraphUsesFullTcFamily, true);
  assert.equal(cmsState.paragraphFontWeight, '400', 'CMS paragraph did not retain its normal computed body weight');
  assert.equal(cmsState.fontLoaded, true);
  assert.equal(cmsState.fullTcLoadedFaces.length, 1, 'the actual paragraph weight did not load exactly one Full TC face');
  assert.equal(cmsState.fullTcLoadedFaces[0].status, 'loaded');
  assert.equal(cmsState.fullTcWeightProbe.loadCalls, 1);
  assert.equal(cmsState.fullTcWeightProbe.checkCalls, 1);
  assert.equal(cmsState.glyphCoverageProbe.loadTextContainsGlyph, true);
  assert.equal(cmsState.glyphCoverageProbe.loadedMatchingFaceCount, 1);
  assert.ok(cmsState.glyphWidth > 0);
  assert.equal(cmsState.tofu, false);
  results.cmsPreview = { ...results.cmsPreview, route: cmsRoute, access: 'verified owner assertion fixture', draftChar,
    fontBytes: loadedBytes.byteLength, fontSha256: fullTcSha, ...cmsState };
  await cmsContext.close();
  results.cmsPreview.status = 'passed';
  completePhase('cmsPreview');

  startPhase('cmsNegativeGuards');
  for (const mode of ['unauthenticated', 'wrong-path', 'wrong-cms-edit', 'unauthorized-message']) {
    results.execution.phases.cmsNegativeGuards.currentMode = mode;
    const negativeContext = await browser.newContext();
    negativeContext.setDefaultTimeout(15000);
    negativeContext.setDefaultNavigationTimeout(15000);
    await negativeContext.route('https://www.huiwen.tw/**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const upstream = await fetch(new URL(requestUrl.pathname.slice(1) + requestUrl.search, base), {
        signal: AbortSignal.timeout(15000),
      });
      await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers),
        body: Buffer.from(await withTimeout(upstream.arrayBuffer(), INITIAL_RENDER_TIMEOUT_MS,
          'read negative routed CMS preview response body')) });
    });
    await negativeContext.route('https://evil.test/**', (route) => route.fulfill({
      ...buildCmsFixtureHtmlFulfill(`<script>let n=0;const t=setInterval(()=>{parent.frames[0].postMessage({type:'huiwen-cms-init',nonce:'${nonce}'},'*');parent.frames[0].postMessage({type:'huiwen-cms-case-preview',nonce:'${nonce}',case:${unauthorizedDraftJson}},'*');if(++n>30)clearInterval(t)},100)</script>`),
    }));
    await negativeContext.route('https://admin.huiwen.tw/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__g02/cms') {
        const cmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
        const previewPath = mode === 'wrong-path' ? 'index.html' : cmsRoute;
        const sender = mode === 'unauthorized-message' ? '<iframe title="untrusted sender" src="https://evil.test/send"></iframe>' : '';
        return route.fulfill(buildCmsFixtureHtmlFulfill(`
          <iframe id="preview" title="CMS preview" sandbox="allow-scripts" src="/api/page-preview?path=${encodeURIComponent(previewPath)}&session=${session}&cmsEdit=${cmsEdit}"></iframe>${sender}`));
      }
      if (url.pathname === '/api/page-preview') {
        // This negative route models Access denying the request before the Worker.
        if (mode === 'unauthenticated') return route.fulfill({ status: 401, body: 'unauthorized preview' });
        if (url.searchParams.get('path') !== cmsRoute
          || url.searchParams.get('session') !== session
          || url.searchParams.get('cmsEdit') !== '1')
          return route.fulfill({ status: 401, body: 'unauthorized preview' });
        return route.fulfill({ status: 200, body: await withTimeout(fetchPublishedPreview(), 15000,
          'negative CMS published preview fetch'),
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-frame-options': 'SAMEORIGIN', 'content-security-policy': previewCsp },
        });
      }
      return route.fulfill(buildCmsFixtureHtmlFulfill('not found', { status: 404 }));
    });
    const negativePage = await negativeContext.newPage();
    const negativeProxyNavigation = waitForCmsPreviewNavigation(negativePage);
    const negativeProxyResponseWait = observePendingResult(negativePage.waitForResponse(
      (response) => isCmsProxyUrl(response.url()), { timeout: 15000 }));
    const negativeHostResponse = await gotoObservedWithTimeout(negativePage,
      'https://admin.huiwen.tw/__g02/cms', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const negativeHostCharacterSet = await negativePage.evaluate(() => document.characterSet);
    assert.equal(negativeHostCharacterSet, 'UTF-8', `${mode}: CMS fixture host document did not decode as UTF-8`);
    const negativeNavigation = await negativeProxyNavigation;
    if (negativeNavigation.error) throw negativeNavigation.error;
    const negativeFrame = negativeNavigation.frame;
    await negativePage.frameLocator('#preview').locator('html').waitFor({ state: 'attached', timeout: 15000 });
    const negativeFrameLoadWait = observePendingResult(
      negativeFrame.waitForLoadState('domcontentloaded', { timeout: 15000 }));
    const [negativeProxyResponseOutcome, negativeFrameLoadOutcome] = await Promise.all([
      negativeProxyResponseWait,
      negativeFrameLoadWait,
    ]);
    const negativeProxyResponse = requireObservedValue(negativeProxyResponseOutcome);
    const expectedFrameStatus = mode === 'unauthorized-message' ? 200 : 401;
    const expectedFramePath = mode === 'wrong-path' ? 'index.html' : cmsRoute;
    const expectedCmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
    const frameUrl = new URL(negativeFrame.url());
    const responseUrl = new URL(negativeProxyResponse.url());
    const frameEvidence = {
      hostStatus: negativeHostResponse?.status() ?? null,
      hostCharacterSet: negativeHostCharacterSet,
      frameUrl: safeUrlSummary(negativeFrame.url()),
      responseUrl: safeUrlSummary(negativeProxyResponse.url()),
      frameStatus: negativeProxyResponse.status(),
      expectedFrameStatus,
    };
    results.negativeGuards[mode] = frameEvidence;
    assert.equal(negativeHostResponse?.status(), 200, `${mode}: CMS host fixture did not return HTTP 200`);
    assert.equal(frameUrl.origin, 'https://admin.huiwen.tw', `${mode}: CMS iframe used an unexpected host`);
    assert.equal(frameUrl.pathname, '/api/page-preview', `${mode}: CMS iframe used an unexpected handler path`);
    assert.equal(frameUrl.searchParams.get('path'), expectedFramePath,
      `${mode}: CMS iframe route did not match the negative fixture`);
    assert.equal(frameUrl.searchParams.get('session'), session, `${mode}: CMS iframe session changed`);
    assert.equal(frameUrl.searchParams.get('cmsEdit'), expectedCmsEdit,
      `${mode}: CMS iframe edit capability did not match the fixture`);
    assert.equal(responseUrl.origin, frameUrl.origin, `${mode}: observed response came from the host page, not its iframe`);
    assert.equal(responseUrl.pathname, frameUrl.pathname, `${mode}: observed response did not match the iframe handler`);
    assert.equal(responseUrl.search, frameUrl.search, `${mode}: observed response did not match the iframe capability request`);
    assert.equal(negativeProxyResponse.request().method(), 'GET', `${mode}: CMS proxy iframe used an unexpected request method`);
    assert.equal(negativeProxyResponse.status(), expectedFrameStatus,
      `${mode}: CMS iframe returned an unexpected HTTP status`);
    requireObservedValue(negativeFrameLoadOutcome);
    if (mode === 'unauthorized-message') {
      await negativeFrame.waitForFunction(() => Boolean(document.querySelector('script[data-cms-editor-runtime]')),
        null, { timeout: 15000 });
    }
    await negativePage.waitForTimeout(700);
    let evilCharacterSet = null;
    if (mode === 'unauthorized-message') {
      const evilFrame = negativePage.frames().find((frame) => {
        try { return new URL(frame.url()).origin === 'https://evil.test'; } catch { return false; }
      });
      assert.ok(evilFrame, 'negative sender fixture did not create its evil frame');
      evilCharacterSet = await evilFrame.evaluate(() => document.characterSet);
      assert.equal(evilCharacterSet, 'UTF-8', 'negative sender fixture document did not decode as UTF-8');
    }
    const state = await withTimeout(negativeFrame.evaluate(() => ({
      documentCharacterSet: document.characterSet,
      marker: document.documentElement.dataset.huiwenFontArtifactPreview || null,
      unauthorizedDraft: document.body.innerText.includes('UNAUTHORIZED DRAFT'),
      editorRuntime: Boolean(document.querySelector('script[data-cms-editor-runtime]')),
    })), 15000, `${mode}: read negative iframe state`);
    if (mode === 'unauthorized-message')
      assert.equal(state.documentCharacterSet, 'UTF-8', `${mode}: authenticated preview proxy document did not decode as UTF-8`);
    results.negativeGuards[mode] = { ...frameEvidence, ...state,
      ...(evilCharacterSet ? { evilCharacterSet } : {}) };
    if (mode === 'unauthenticated') {
      assert.equal(state.marker, null, 'an unauthenticated request unexpectedly enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'an unauthenticated request loaded the CMS runtime');
    } else if (mode === 'wrong-path') {
      assert.equal(state.marker, null, 'an unexpected route path enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'an unexpected route path loaded the CMS runtime');
    } else if (mode === 'wrong-cms-edit') {
      assert.equal(state.marker, null, 'cmsEdit=0 unexpectedly enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'cmsEdit=0 loaded the CMS runtime');
    } else {
      assert.equal(state.unauthorizedDraft, false, 'untrusted postMessage changed the CMS preview');
      assert.equal(state.marker, '1', 'cmsEdit=1 in the authenticated iframe did not set the preview marker');
      assert.equal(state.editorRuntime, true, 'the iframe did not load its guarded CMS runtime');
    }
    if (mode === 'wrong-path') {
      const unknownRouteResponse = await gotoObservedWithTimeout(negativePage,
        'https://admin.huiwen.tw/__g02/unrecognized', { waitUntil: 'domcontentloaded', timeout: 15000 });
      assert.equal(unknownRouteResponse?.status(), 404, 'unrecognized CMS handler path did not fail closed');
      assert.equal((await negativePage.locator('body').innerText({ timeout: 15000 })).trim(), 'not found',
        'unrecognized CMS handler path returned unexpected content');
      const unknownCharacterSet = await negativePage.evaluate(() => document.characterSet);
      assert.equal(unknownCharacterSet, 'UTF-8', 'unrecognized CMS handler fixture document did not decode as UTF-8');
      results.negativeGuards.handlerFailClosed = { status: unknownRouteResponse.status(), body: 'not found',
        documentCharacterSet: unknownCharacterSet };
    }
    await withTimeout(negativeContext.close(), INITIAL_RENDER_TIMEOUT_MS,
      `${mode}: close negative CMS context`);
    results.execution.phases.cmsNegativeGuards.completed += 1;
  }
  results.execution.phases.cmsNegativeGuards.currentMode = null;
  completePhase('cmsNegativeGuards');

  startPhase('topLevelCmsGuard');
  const topLevelPage = await context.newPage();
  const topLevelRequests = [];
  topLevelPage.on('request', (request) => topLevelRequests.push(request.url()));
  await gotoObservedWithTimeout(topLevelPage, new URL(`${cmsRoute}?cmsEdit=1`, base).href,
    { waitUntil: 'domcontentloaded', timeout: INITIAL_RENDER_TIMEOUT_MS });
  await topLevelPage.waitForTimeout(300);
  assert.equal(await topLevelPage.locator('html').getAttribute('data-huiwen-font-artifact-preview'), null,
    'top-level cmsEdit=1 unexpectedly enabled CMS preview');
  assert.equal(topLevelRequests.some((url) => new URL(url).pathname === `/${editorAsset}`), false,
    'top-level cmsEdit=1 downloaded the CMS runtime');
  results.negativeGuards.topLevel = { marker: null, editorRuntimeRequested: false };
  completePhase('topLevelCmsGuard');

  startPhase('finalAssertions');
  try {
    assert.equal(results.visualCaptures.status, 'captured', 'the 20-route visual capture set did not complete');
    assert.equal(results.visualCaptures.records.length, VISUAL_CAPTURE_COUNT,
      'the visual capture set does not contain exactly 20 real page screenshots');
    assert.equal(new Set(results.visualCaptures.records.map((record) => record.route)).size, VISUAL_CAPTURE_COUNT,
      'the visual capture set contains duplicate routes');
    assert.deepEqual(results.visualCaptures.errors, [], 'at least one selected visual page could not be captured');
    assert.equal(results.initialFontNetwork.routesChecked, 464, 'initial font-only sweep missed schema-2 routes');
    assert.deepEqual(fullTcInitialViolations, [], 'a route requested full TC before explicit user on-demand activation');
    assert.deepEqual(results.initialFontNetwork.fontNetworkViolations, [],
      'the final closed-session font network snapshot contains a gate violation');
    assert.deepEqual(results.initialFontNetwork.preloadViolations, [], 'at least one route had a different first-view font preload closure');
    assert.deepEqual(results.initialFontNetwork.navigationErrors, [], 'at least one route had a navigation error');
    assert.deepEqual(results.initialFontNetwork.criticalRequestFailures, [], 'at least one route had a critical request failure');
    assert.deepEqual(results.initialFontNetwork.runtimeErrors, [], 'at least one route raised an uncaught page error');
    assert.deepEqual(results.initialFontNetwork.observationErrors, [], 'at least one route could not be fully diagnosed');
    results.initialFontNetwork.verification = 'passed';
    results.execution.phases.initialFontNetwork.verification = 'passed';
  } catch (error) {
    results.initialFontNetwork.verification = 'failed';
    results.execution.phases.initialFontNetwork.verification = 'failed';
    throw error;
  }
  assert.equal(results.serviceInitial.status, 'passed', 'service-card check did not complete successfully');
  assert.deepEqual(results.serviceInitial.errors, [], 'service-card font bytes or on-demand behavior failed');

  await context.close();
  completePhase('finalAssertions');
} catch (error) {
  captureRunFailure(error);
} finally {
  if (browser) {
    try { await browser.close(); } catch (error) {
      results.browserCloseError = errorRecord(error, cmsDiagnosticSecrets);
      captureRunFailure(error, 'browser-close');
    }
  }
  if (cmsFullFontResponseWait) {
    const outcome = await cmsFullFontResponseWait;
    results.cmsPreview.fullFontResponseWait = { status: outcome.status,
      error: outcome.status === 'rejected' ? errorRecord(outcome.error, cmsDiagnosticSecrets) : null };
    if (outcome.status === 'rejected') captureRunFailure(outcome.error, 'cms-full-font-response-wait');
  }
  if (results.cmsPreview.status === 'running') {
    results.cmsPreview.status = runError ? 'failed' : 'incomplete';
    if (runError) results.cmsPreview.error = errorRecord(runError, cmsDiagnosticSecrets);
  }
  if (results.initialFontNetwork.status === 'running') {
    results.initialFontNetwork.status = runError ? 'failed' : 'incomplete';
  }
  for (const phase of Object.values(results.execution.phases)) {
    if (phase.status === 'running') {
      phase.status = runError ? 'failed' : 'incomplete';
      if (runError) phase.error ||= errorRecord(runError, cmsDiagnosticSecrets);
    }
  }
  results.execution.currentPhase = results.execution.currentPhase || null;
  results.execution.status = runError ? 'failed' : 'passed';
  if (runError && !results.execution.primaryError) {
    results.execution.primaryError = errorRecord(runError, cmsDiagnosticSecrets);
  }
  try {
    await writePageFontArtifactReport(reportPath, results, cmsDiagnosticSecrets);
  } catch (error) {
    results.reportWriteError = errorRecord(error, cmsDiagnosticSecrets);
    if (!runError) runError = error;
  }
}
if (runError) throw sanitizeThrownError(runError, cmsDiagnosticSecrets);
console.log(JSON.stringify({ samples: results.samples.length, schemaRoutes: results.schemaRoutes.length,
  allRouteFontChecks: results.initialFontNetwork.routesChecked,
  allRouteFontSeconds: results.initialFontNetwork.durationSeconds,
  visualCaptures: results.visualCaptures.records.length,
  serviceInitialFullTcRequests: results.serviceInitial.initialFullTcRequests,
  serviceCardFullTcBytes: results.serviceInitial.cardFullTcBytes,
  serviceCrossMonthFullTcRequests: results.serviceCrossMonth.initialFullTcRequests,
  legacyRoutes: results.legacyRoutes.length,
  cmsFontBytes: results.cmsPreview.fontBytes, negativeGuards: Object.keys(results.negativeGuards) }));
