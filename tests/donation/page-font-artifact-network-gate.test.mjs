import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildFinalFontNetworkSnapshot,
  classifyCdpRequestTimestamp,
  hashResponseBody,
  validateServiceCardOnDemand,
  validateTrustedClickMarker,
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
  assert.match(runner, /window\.removeEventListener\('click'/);
  assert.match(runner, /Debugger\.resume/);
  assert.match(runner, /Debugger\.setBreakpointsActive[\s\S]*Debugger\.disable/);
  assert.match(runner, /routePage\.close\(\)[\s\S]*routeContext\.close\(\)[\s\S]*buildFinalFontNetworkSnapshot\(\{/);
  assert.match(runner, /visualCaptureAttempts,\s*VISUAL_CAPTURE_COUNT[\s\S]*await runServiceCardGesture\(deferredServiceState\)/);
  assert.match(runner, /assert\.deepEqual\(results\.initialFontNetwork\.fontNetworkViolations,\s*\[\]/);
  assert.doesNotMatch(runner, /routeNetwork\.phase\s*=\s*['"]service-card['"]/);
});
