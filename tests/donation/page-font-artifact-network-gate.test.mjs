import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildFinalFontNetworkSnapshot,
  classifyCdpRequestTimestamp,
  expectedSharedFallbackFontsForRoute,
  filterCriticalRequestFailures,
  hashResponseBody,
  isNoncriticalThirdPartyDocument,
  validateServiceCardOnDemand,
  validateTrustedClickMarker,
  waitForTrackedNetworkQuiet,
} from './page-font-artifact-network-gate.mjs';

const route = 'service.html';
const routeOrigin = 'http://127.0.0.1:8789';
const fullTcPath = '/assets/fonts/huiwen-site-sans/huiwen-site-sans-tc-20261007.woff2';
const expectedPreloads = ['/assets/fonts/page-common.woff2', '/assets/fonts/page-delta.woff2'];
const expectedBytes = 783820;
const expectedSha256 = 'a'.repeat(64);
const expectedFontArtifacts = [
  { path: expectedPreloads[0], bytes: 2048, sha256: 'c'.repeat(64) },
  { path: expectedPreloads[1], bytes: 3072, sha256: 'd'.repeat(64) },
];
const marker = {
  valid: true,
  source: 'trusted-capture-click-before-app-handler',
  timestamp: 3,
  timestampClock: 'CDP Performance.getMetrics Timestamp',
  selector: '[data-legal-view="card"]',
};

function request(path, timestamp, overrides = {}) {
  const isFullTc = path === fullTcPath;
  return {
    requestId: `request-${timestamp}-${path}`,
    path,
    origin: routeOrigin,
    method: 'GET',
    requestType: 'Font',
    frameId: 'main-frame',
    isMainFrame: true,
    initiator: { type: 'parser', frames: [] },
    timestamp,
    response: { status: 200, mimeType: 'font/woff2', fromDiskCache: false, fromServiceWorker: false },
    terminal: 'finished',
    encodedDataLength: 2048,
    failure: null,
    bodyBytes: isFullTc ? expectedBytes : expectedFontArtifacts.find((font) => font.path === path)?.bytes ?? null,
    bodySha256: isFullTc ? expectedSha256 : expectedFontArtifacts.find((font) => font.path === path)?.sha256 ?? null,
    bodyError: null,
    ...overrides,
  };
}

function trackedRequest(requestType, overrides = {}) {
  return request(overrides.path || `/tracked/${requestType.toLowerCase()}`, 1.4, {
    requestType,
    frameId: 'main-frame',
    isMainFrame: true,
    track: true,
    terminal: null,
    response: { status: 200, mimeType: 'text/plain' },
    encodedDataLength: null,
    bodyBytes: null,
    bodySha256: null,
    ...overrides,
  });
}

function validRequests() {
  return [
    request(expectedPreloads[0], 1.2),
    request(expectedPreloads[1], 1.3),
    request(fullTcPath, 3.2),
  ];
}

function snapshot(overrides = {}) {
  return buildFinalFontNetworkSnapshot({
    route,
    rawRequests: validRequests(),
    initialTimestamp: 1,
    visualCaptureTimestamp: 2,
    clickMarker: marker,
    expectedPreloads,
    expectedFontArtifacts,
    fullTcPath,
    routeOrigin,
    observationClosed: true,
    renderCompleteness: { domContentLoaded: true, routeReady: true, fontsLoaded: true, animationFrames: 2 },
    requireTrustedClickMarker: true,
    ...overrides,
  });
}

function validCard(snapshotValue = snapshot(), overrides = {}) {
  return validateServiceCardOnDemand({
    route,
    snapshot: snapshotValue,
    expectedOrigin: routeOrigin,
    expectedPath: fullTcPath,
    expectedBytes,
    expectedSha256,
    canvasVisible: true,
    ...overrides,
  });
}

test('the final network gate accepts one exact post-trigger service-card response after the context closes', () => {
  const result = snapshot();
  assert.deepEqual(result.violations, []);
  assert.equal(result.observationClosed, true);
  assert.equal(result.postTriggerFullTcRequests.length, 1);
  assert.equal(validCard(result).valid, true);
});

test('a pending foreign child-frame Document stays auditable as unknown without blocking font completeness', () => {
  const foreignDocument = trackedRequest('Document', {
    path: '/plugins/post.php',
    origin: 'https://www.facebook.com',
    frameId: 'facebook-child-frame',
    isMainFrame: false,
    terminal: null,
  });
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), foreignDocument, validRequests()[2],
  ] });

  assert.deepEqual(result.violations, []);
  assert.ok(result.trackedRequests.some((item) => item.requestId === foreignDocument.requestId),
    'the original CDP request must remain in the full tracked audit snapshot');
  assert.equal(result.criticalTrackedRequests.some((item) => item.requestId === foreignDocument.requestId), false);
  assert.deepEqual(result.noncriticalThirdPartyDocuments, [{
    requestId: foreignDocument.requestId,
    path: '/plugins/post.php',
    origin: 'https://www.facebook.com',
    requestType: 'Document',
    frameId: 'facebook-child-frame',
    isMainFrame: false,
    status: 200,
    terminal: 'pending',
    completeness: 'unknown',
    failure: null,
  }]);
  assert.deepEqual(result.requestScope.noncriticalThirdPartyDocuments, result.noncriticalThirdPartyDocuments);
  assert.match(result.requestScope.criticalCompleteness, /tracked Document, Font, Stylesheet, and Script/);
});

test('final critical failures scope out only foreign child Documents and preserve their exact audit outcome', () => {
  const abortedForeignChildDocument = trackedRequest('Document', {
    path: '/plugins/post.php',
    origin: 'https://www.facebook.com',
    frameId: 'facebook-child-frame',
    isMainFrame: false,
    response: null,
    terminal: 'failed',
    failure: { errorText: 'net::ERR_ABORTED', canceled: true, blockedReason: null },
  });
  const criticalFailures = [
    trackedRequest('Document', {
      origin: routeOrigin, frameId: 'same-origin-child', isMainFrame: false,
      terminal: 'failed', failure: { errorText: 'net::ERR_FAILED', canceled: false, blockedReason: null },
    }),
    trackedRequest('Document', {
      origin: 'https://www.facebook.com', frameId: 'main-frame', isMainFrame: true,
      terminal: 'failed', failure: { errorText: 'net::ERR_FAILED', canceled: false, blockedReason: null },
    }),
    trackedRequest('Document', {
      origin: 'https://www.facebook.com', frameId: null, isMainFrame: false,
      terminal: 'failed', failure: { errorText: 'net::ERR_FAILED', canceled: false, blockedReason: null },
    }),
    trackedRequest('Document', {
      origin: 'https://www.facebook.com', frameId: 'unknown-frame', isMainFrame: null,
      terminal: 'failed', failure: { errorText: 'net::ERR_FAILED', canceled: false, blockedReason: null },
    }),
    trackedRequest('Font', {
      origin: 'https://www.facebook.com', frameId: 'facebook-child-frame', isMainFrame: false,
      terminal: 'failed', failure: { errorText: 'net::ERR_FAILED', canceled: false, blockedReason: null },
    }),
    trackedRequest('Font', {
      origin: 'https://www.facebook.com', frameId: 'main-frame', isMainFrame: true,
      terminal: 'failed', failure: { errorText: 'net::ERR_FAILED', canceled: false, blockedReason: null },
    }),
  ];
  const scopedFailures = filterCriticalRequestFailures(
    [abortedForeignChildDocument, ...criticalFailures], routeOrigin);

  assert.deepEqual(scopedFailures.map((item) => item.requestId),
    criticalFailures.map((item) => item.requestId),
    'own-origin, main-frame, unknown-frame, and every Font failure must remain critical');

  const result = snapshot({ rawRequests: [...validRequests(), abortedForeignChildDocument] });
  assert.equal(result.criticalTrackedRequests.some((item) =>
    item.requestId === abortedForeignChildDocument.requestId), false);
  assert.deepEqual(result.noncriticalThirdPartyDocuments, [{
    requestId: abortedForeignChildDocument.requestId,
    path: '/plugins/post.php',
    origin: 'https://www.facebook.com',
    requestType: 'Document',
    frameId: 'facebook-child-frame',
    isMainFrame: false,
    status: null,
    terminal: 'failed',
    completeness: 'failed',
    failure: { errorText: 'net::ERR_ABORTED', canceled: true, blockedReason: null },
  }]);
  assert.deepEqual(result.violations, []);
});

test('only positively classified foreign child Documents are exempt from critical request completeness', () => {
  const cases = [
    ['same-origin child Document', trackedRequest('Document', {
      origin: routeOrigin, frameId: 'same-origin-child', isMainFrame: false,
    })],
    ['main-frame Document', trackedRequest('Document', {
      origin: 'https://www.facebook.com', frameId: 'main-frame', isMainFrame: true,
    })],
    ['unknown frame ID', trackedRequest('Document', {
      origin: 'https://www.facebook.com', frameId: null, isMainFrame: false,
    })],
    ['unknown frame classification', trackedRequest('Document', {
      origin: 'https://www.facebook.com', frameId: 'unknown-frame', isMainFrame: null,
    })],
    ['unknown origin', trackedRequest('Document', {
      origin: null, frameId: 'unknown-origin-frame', isMainFrame: false,
    })],
    ['own-origin Script', trackedRequest('Script', { origin: routeOrigin })],
    ['own-origin Stylesheet', trackedRequest('Stylesheet', { origin: routeOrigin })],
    ['foreign child Font', trackedRequest('Font', {
      path: '/assets/fonts/foreign-child.woff2', origin: 'https://www.facebook.com',
      frameId: 'facebook-child-frame', isMainFrame: false,
    })],
  ];

  for (const [label, resource] of cases) {
    assert.equal(isNoncriticalThirdPartyDocument(resource, routeOrigin), false, `${label} classification`);
    const result = snapshot({ rawRequests: [...validRequests(), resource] });
    assert.ok(result.criticalTrackedRequests.some((item) => item.requestId === resource.requestId),
      `${label} must stay in the critical tracked set`);
    assert.ok(result.violations.some((item) => item.kind === 'critical-tracked-request-pending'
      && item.requestId === resource.requestId), `${label} must block final completeness`);
    if (label === 'foreign child Font') {
      for (const kind of ['page-font-not-finished', 'page-font-origin-mismatch',
        'page-font-not-main-frame', 'unexpected-page-font-path']) {
        assert.ok(result.violations.some((item) => item.kind === kind && item.requestId === resource.requestId),
          `cross-frame Font must retain the existing ${kind} gate`);
      }
    }
  }

  assert.equal(isNoncriticalThirdPartyDocument(trackedRequest('Document', {
    origin: 'https://www.facebook.com:443', frameId: 'frame', isMainFrame: false,
  }), 'https://WWW.FACEBOOK.COM'), false,
  'default ports and host casing must be normalized before comparing origins');
});

test('tracked-network quiet uses the same foreign-child Document classification and reports unknown state', async () => {
  const foreignDocument = trackedRequest('Document', {
    path: '/plugins/post.php', origin: 'https://www.facebook.com',
    frameId: 'facebook-child-frame', isMainFrame: false,
  });
  const barrierSession = { async send(method) { assert.equal(method, 'Performance.getMetrics'); } };
  const settled = await waitForTrackedNetworkQuiet({
    routeNetwork: { requests: [foreignDocument], revision: 1 },
    cdpSession: barrierSession,
    routeOrigin,
    timeoutMs: 100,
    quietWindowMs: 0,
    pollIntervalMs: 1,
  });
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.pending, []);
  assert.equal(settled.noncriticalThirdPartyDocuments[0].completeness, 'unknown');
  assert.equal(settled.noncriticalThirdPartyDocuments[0].terminal, 'pending');

  const unknownFrameDocument = trackedRequest('Document', {
    path: '/plugins/unknown-frame.php', origin: 'https://www.facebook.com',
    frameId: null, isMainFrame: false,
  });
  const failClosed = await waitForTrackedNetworkQuiet({
    routeNetwork: { requests: [unknownFrameDocument], revision: 1 },
    cdpSession: barrierSession,
    routeOrigin,
    timeoutMs: 20,
    quietWindowMs: 0,
    pollIntervalMs: 2,
  });
  assert.equal(failClosed.settled, false);
  assert.equal(failClosed.pending[0].requestId, unknownFrameDocument.requestId);
});

test('a CDP pre-trigger Full-TC request delivered after the click marker remains initial and fails', () => {
  const delayedBeforeClick = request(fullTcPath, 1.5, { deliveredToNodeAtTimestamp: 4 });
  const result = snapshot({ rawRequests: [
    request(expectedPreloads[0], 1.2), request(expectedPreloads[1], 1.3), delayedBeforeClick,
    request(fullTcPath, 3.2),
  ] });
  assert.equal(result.fullTcRequests[0].phase, 'initial');
  assert.ok(result.violations.some((item) => item.kind === 'full-tc-before-trusted-gesture'));
  assert.equal(validCard(result).valid, false);
});

test('only the declared shared JP fallback font is exempt from page-subset paths and remains hash-checked', () => {
  const sharedFallback = {
    path: '/assets/fonts/huiwen-site-sans/generated/huiwen-cjk-support-abcdef123456.woff2',
    sha256: 'e'.repeat(64),
  };
  const fallbackRequest = request(sharedFallback.path, 1.4, {
    bodyBytes: 4096,
    bodySha256: sharedFallback.sha256,
  });
  const valid = snapshot({
    expectedSharedFallbackFonts: [sharedFallback],
    rawRequests: [...validRequests().slice(0, 2), fallbackRequest, validRequests()[2]],
  });
  assert.deepEqual(valid.violations, []);
  assert.equal(valid.pageFontRequests.length, 2);
  assert.deepEqual(valid.sharedFallbackFontRequests.map((item) => item.path), [sharedFallback.path]);
  assert.throws(() => snapshot({ expectedSharedFallbackFonts: [
    { path: expectedPreloads[0], sha256: expectedFontArtifacts[0].sha256 },
  ] }), /separate from page subsets and Full-TC/);

  const badDigest = snapshot({
    expectedSharedFallbackFonts: [sharedFallback],
    rawRequests: [...validRequests().slice(0, 2), { ...fallbackRequest, bodySha256: 'f'.repeat(64) }, validRequests()[2]],
  });
  assert.ok(badDigest.violations.some((item) => item.kind === 'shared-fallback-font-sha256'));

  const unlisted = request('/assets/fonts/huiwen-site-sans/generated/huiwen-extra-abcdef123456.woff2', 1.5, {
    bodyBytes: 1024,
    bodySha256: 'f'.repeat(64),
  });
  const unexpected = snapshot({
    expectedSharedFallbackFonts: [sharedFallback],
    rawRequests: [...validRequests().slice(0, 2), fallbackRequest, unlisted, validRequests()[2]],
  });
  assert.ok(unexpected.violations.some((item) => item.kind === 'unexpected-page-font-path'
    && item.path === unlisted.path));
});

test('route snapshot assembly allows JP fallback only for manifest-declared JP-only source coverage', () => {
  const sharedFallback = {
    path: '/assets/fonts/huiwen-site-sans/generated/huiwen-cjk-support-abcdef123456.woff2',
    sha256: 'e'.repeat(64),
  };
  const fallbackRequest = request(sharedFallback.path, 1.4, {
    bodyBytes: 4096,
    bodySha256: sharedFallback.sha256,
  });
  const rawRequests = [...validRequests().slice(0, 2), fallbackRequest];
  const ordinaryManifestRow = { codepoints: [0x4e2d] };
  const ordinaryExpectedFallbacks = expectedSharedFallbackFontsForRoute(ordinaryManifestRow, sharedFallback);
  assert.deepEqual(ordinaryExpectedFallbacks, []);
  const ordinary = snapshot({
    route: 'ordinary.html',
    clickMarker: null,
    requireTrustedClickMarker: false,
    rawRequests,
    expectedSharedFallbackFonts: ordinaryExpectedFallbacks,
  });
  assert.ok(ordinary.violations.some((item) => item.kind === 'unexpected-page-font-path'
    && item.path === sharedFallback.path));

  const jpManifestRow = { codepoints: [0x4e2d], jpFallbackCodepoints: [0x3042] };
  const jpExpectedFallbacks = expectedSharedFallbackFontsForRoute(jpManifestRow, sharedFallback);
  assert.deepEqual(jpExpectedFallbacks, [sharedFallback]);
  const jp = snapshot({
    route: 'news-20260810-kumamoto-relief.html',
    clickMarker: null,
    requireTrustedClickMarker: false,
    rawRequests,
    expectedSharedFallbackFonts: jpExpectedFallbacks,
  });
  assert.deepEqual(jp.violations, []);
  assert.deepEqual(jp.sharedFallbackFontRequests.map((item) => item.path), [sharedFallback.path]);

  assert.deepEqual(expectedSharedFallbackFontsForRoute({
    codepoints: [0x3042], jpFallbackCodepoints: [0x3042],
  }, sharedFallback), [], 'a fallback glyph already covered by the route TC source must not grant an exemption');
  assert.deepEqual(expectedSharedFallbackFontsForRoute({
    codepoints: [], jpFallbackCodepoints: [0x3042],
  }, sharedFallback), [], 'a route without positive TC source-font coverage must not grant an exemption');
});

test('the final gate does not grant a Full-TC exemption when the trusted click marker is missing', () => {
  const result = snapshot({ clickMarker: null });
  assert.ok(result.violations.some((item) => item.kind === 'missing-or-invalid-trusted-click-marker'));
  assert.notEqual(result.fullTcRequests[0].phase, 'post-trigger');
  assert.equal(validCard(result).valid, false);
});

test('the primary service route accepts an initial snapshot with zero Full-TC and no click marker', () => {
  const result = snapshot({
    rawRequests: [request(expectedPreloads[0], 1.2), request(expectedPreloads[1], 1.3)],
    clickMarker: null,
    requireTrustedClickMarker: false,
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.fullTcRequests, []);
});

test('a synthetic or wrong-target click marker is rejected', () => {
  assert.throws(() => validateTrustedClickMarker({
    marker: { count: 1, isTrusted: false, selectorMatched: true, targetValue: 'card' },
    timestamp: 3,
    initialTimestamp: 1,
    visualCaptureTimestamp: 2,
  }), /not a trusted browser input/);
  assert.throws(() => validateTrustedClickMarker({
    marker: { count: 1, isTrusted: true, selectorMatched: false, targetValue: 'other' },
    timestamp: 3,
    initialTimestamp: 1,
    visualCaptureTimestamp: 2,
  }), /did not target the legal service card/);
});

test('a click marker with a timestamp before the visual capture is rejected', () => {
  assert.throws(() => validateTrustedClickMarker({
    marker: { count: 1, isTrusted: true, selectorMatched: true, targetValue: 'card' },
    timestamp: 2,
    initialTimestamp: 1,
    visualCaptureTimestamp: 2,
  }), /does not follow the initial visual capture window/);
});

test('an invalid CDP request timestamp fails closed instead of receiving a phase exemption', () => {
  const result = snapshot({ rawRequests: [
    request(expectedPreloads[0], 1.2), request(expectedPreloads[1], 1.3),
    request(fullTcPath, Number.NaN),
  ] });
  assert.equal(result.fullTcRequests[0].phase, 'unclassified');
  assert.ok(result.violations.some((item) => item.kind === 'invalid-request-timing'));
});

test('a request timestamp equal to a CDP boundary is classified as ambiguous', () => {
  const timing = classifyCdpRequestTimestamp({
    timestamp: 3,
    initialTimestamp: 1,
    visualCaptureTimestamp: 2,
    clickMarker: marker,
  });
  assert.equal(timing.phase, 'unclassified');
  assert.match(timing.error, /ambiguous at the trusted-click boundary/);
});

test('Full-TC requested on another route is not permanently exempt after a later click', () => {
  const result = buildFinalFontNetworkSnapshot({
    route: 'news/example.html',
    rawRequests: [...validRequests().slice(0, 2), request(fullTcPath, 3.2)],
    initialTimestamp: 1,
    visualCaptureTimestamp: 2,
    clickMarker: marker,
    expectedPreloads,
    expectedFontArtifacts,
    fullTcPath,
    routeOrigin,
    observationClosed: true,
    renderCompleteness: { domContentLoaded: true, routeReady: true, fontsLoaded: true, animationFrames: 2 },
  });
  assert.ok(result.violations.some((item) => item.kind === 'full-tc-on-non-service-route'));
});

test('multiple post-trigger Full-TC requests fail the exact-one card contract', () => {
  const result = snapshot({ rawRequests: [...validRequests(), request(fullTcPath, 3.4)] });
  assert.equal(result.postTriggerFullTcRequests.length, 2);
  assert.equal(validCard(result).valid, false);
});

test('a Full-TC response with a non-200 status fails', () => {
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), request(fullTcPath, 3.2, { response: { status: 403 } }),
  ] });
  assert.ok(result.violations.some((item) => item.kind === 'full-tc-http-status'));
  assert.equal(validCard(result).valid, false);
});

test('a Full-TC response from the wrong path fails', () => {
  const wrongPath = '/assets/fonts/other-full-tc.woff2';
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), request(wrongPath, 3.2),
  ] });
  assert.ok(result.violations.some((item) => item.kind === 'unexpected-page-font-path'));
  assert.equal(result.postTriggerFullTcRequests.length, 0);
  assert.equal(validCard(result).valid, false);
});

test('a Full-TC response from the wrong origin fails', () => {
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), request(fullTcPath, 3.2, { origin: 'https://evil.example' }),
  ] });
  assert.ok(result.violations.some((item) => item.kind === 'full-tc-origin-mismatch'));
  assert.equal(validCard(result).valid, false);
});

test('a Full-TC path requested as a fetch instead of a font fails closed', () => {
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), request(fullTcPath, 3.2, { requestType: 'Fetch' }),
  ] });
  assert.ok(result.violations.some((item) => item.kind === 'full-tc-request-type-mismatch'));
  assert.equal(result.fullTcRequests.length, 1);
  assert.equal(validCard(result).valid, false);
});

test('a response with the wrong byte length fails', () => {
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), request(fullTcPath, 3.2, { bodyBytes: expectedBytes - 1 }),
  ] });
  assert.equal(validCard(result).valid, false);
  assert.ok(validCard(result).errors.some((item) => item.kind === 'font-byte-length'));
});

test('a response with the wrong source SHA fails', () => {
  const result = snapshot({ rawRequests: [
    ...validRequests().slice(0, 2), request(fullTcPath, 3.2, { bodySha256: 'b'.repeat(64) }),
  ] });
  assert.equal(validCard(result).valid, false);
  assert.ok(validCard(result).errors.some((item) => item.kind === 'font-sha256'));
});

test('the card gate fails when the canvas was not visible after the trusted gesture', () => {
  assert.equal(validCard(snapshot(), { canvasVisible: false }).valid, false);
});

test('a page-font request added after an early snapshot is still checked in the final closed-session snapshot', () => {
  const latePageFont = request('/assets/fonts/injected-wrong-font.woff2', 2.5);
  const liveRequests = validRequests();
  const early = snapshot({ rawRequests: liveRequests });
  assert.deepEqual(early.violations, []);
  liveRequests.push(latePageFont);
  const final = snapshot({ rawRequests: liveRequests });
  assert.ok(final.pageFontRequests.some((item) => item.path === latePageFont.path));
  assert.ok(final.violations.some((item) => item.kind === 'unexpected-page-font-path'));
  assert.ok(final.violations.some((item) => item.kind === 'page-font-not-requested-during-initial-render'));
});

test('a page-font response with the wrong manifest SHA fails the final shared network gate', () => {
  const result = snapshot({ rawRequests: [
    request(expectedPreloads[0], 1.2, { bodySha256: 'e'.repeat(64) }),
    request(expectedPreloads[1], 1.3),
    request(fullTcPath, 3.2),
  ] });
  assert.ok(result.violations.some((item) => item.kind === 'page-font-sha256'));
});

test('a pending font response at observation close is a hard gate violation', () => {
  const result = snapshot({ rawRequests: [
    request(expectedPreloads[0], 1.2),
    request(expectedPreloads[1], 1.3),
    request(fullTcPath, 3.2, { terminal: null, encodedDataLength: null, response: null, bodyBytes: null, bodySha256: null }),
  ] });
  assert.ok(result.violations.some((item) => item.kind === 'full-tc-not-finished'));
  assert.equal(validCard(result).valid, false);
});

test('CDP body hashing uses the exact response bytes', () => {
  const bytes = Buffer.from('served font bytes');
  assert.deepEqual(hashResponseBody(bytes), {
    bytes: bytes.length,
    sha256: '41dd5b35b2f2e37bd773320f9f3c2eef3dc349874c649ebc9713d4ed5678357a',
  });
});

test('the browser runner wires the exercised shared gate after all initial capture attempts and context close', async () => {
  const runner = await readFile(new URL('./page-font-artifact.mjs', import.meta.url), 'utf8');
  assert.match(runner, /buildFinalFontNetworkSnapshot,\s*buildTrustedClickCaptureScript/);
  assert.match(runner, /snapshot = buildFinalFontNetworkSnapshot\(\{/);
  assert.match(runner, /snapshotStage: 'after-context-close'/);
  assert.match(runner, /validateServiceCardOnDemand\(\{/);
  assert.match(runner, /Network\.getResponseBody/);
  assert.match(runner, /routeRecord\.criticalRequestFailures\s*=\s*filterCriticalRequestFailures\(\s*routeNetwork\.criticalRequestFailures,\s*new URL\(base\)\.origin\s*\)/);
  assert.match(runner, /window\.removeEventListener\('click'/);
  assert.match(runner, /Debugger\.resume/);
  assert.match(runner, /Debugger\.setBreakpointsActive[\s\S]*Debugger\.disable/);
  assert.match(runner, /routePage\.close\(\)[\s\S]*routeContext\.close\(\)[\s\S]*buildFinalFontNetworkSnapshot\(\{/);
  assert.match(runner, /visualCaptureAttempts,\s*VISUAL_CAPTURE_COUNT[\s\S]*await runServiceCardGesture\(deferredServiceState\)/);
  assert.match(runner, /assert\.deepEqual\(results\.initialFontNetwork\.fontNetworkViolations,\s*\[\]/);
  assert.doesNotMatch(runner, /routeNetwork\.phase\s*=\s*['"]service-card['"]/);
});
