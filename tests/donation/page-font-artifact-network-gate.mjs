import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const INITIAL_RENDER_TIMEOUT_MS = 15000;
export const NETWORK_SETTLE_TIMEOUT_MS = 5000;
export const NETWORK_QUIET_WINDOW_MS = 300;
export const SERVICE_CARD_SELECTOR = '[data-legal-view="card"]';

const TRACKED_REQUEST_TYPES = new Set(['Document', 'Font', 'Stylesheet', 'Script']);
const SHA256 = /^[a-f0-9]{64}$/;

function normalizeHttpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isNoncriticalThirdPartyDocument(request, routeOrigin) {
  if (request?.requestType !== 'Document' || request.isMainFrame !== false
    || typeof request.frameId !== 'string' || !request.frameId.trim()) return false;
  const requestOrigin = normalizeHttpOrigin(request.origin);
  const normalizedRouteOrigin = normalizeHttpOrigin(routeOrigin);
  return requestOrigin !== null && normalizedRouteOrigin !== null
    && requestOrigin !== normalizedRouteOrigin;
}

export function filterCriticalRequestFailures(requestFailures, routeOrigin) {
  assert.ok(Array.isArray(requestFailures), 'critical request failures must be an array');
  return requestFailures.filter((request) => !isNoncriticalThirdPartyDocument(request, routeOrigin));
}

function auditThirdPartyDocument(request) {
  const terminal = request.terminal || 'pending';
  return {
    requestId: request.requestId || null,
    path: request.path || null,
    origin: request.origin || null,
    requestType: request.requestType,
    frameId: request.frameId || null,
    isMainFrame: request.isMainFrame,
    status: request.status ?? request.response?.status ?? null,
    terminal,
    completeness: terminal === 'finished' ? 'complete' : terminal === 'failed' ? 'failed' : 'unknown',
    failure: request.failure ? { ...request.failure } : null,
  };
}

export function expectedSharedFallbackFontsForRoute(routeManifestRow, sharedJpFallbackFont) {
  const jpFallbackCodepoints = routeManifestRow?.jpFallbackCodepoints;
  const routeSourceCodepoints = routeManifestRow?.codepoints;
  if (!Object.hasOwn(routeManifestRow || {}, 'jpFallbackCodepoints')
    || !Array.isArray(jpFallbackCodepoints) || jpFallbackCodepoints.length === 0
    || !Array.isArray(routeSourceCodepoints) || routeSourceCodepoints.length === 0) return [];

  // The producer records JP-only glyphs after checking them against the JP source cmap.
  // They must also be absent from this route's TC source cmap before JP can be allowed.
  const validCodepoint = (codepoint) => Number.isInteger(codepoint) && codepoint > 0
    && codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff);
  const routeSourceSet = new Set(routeSourceCodepoints);
  if (!routeSourceCodepoints.every(validCodepoint) || !jpFallbackCodepoints.every(validCodepoint)
    || new Set(jpFallbackCodepoints).size !== jpFallbackCodepoints.length
    || jpFallbackCodepoints.some((codepoint) => routeSourceSet.has(codepoint))) return [];
  if (typeof sharedJpFallbackFont?.path !== 'string' || !sharedJpFallbackFont.path.startsWith('/')
    || !SHA256.test(sharedJpFallbackFont.sha256 || '')) return [];
  return [sharedJpFallbackFont];
}

export function buildTrustedClickCaptureScript() {
  const selector = JSON.stringify(SERVICE_CARD_SELECTOR);
  return `(() => {
    const selector = ${selector};
    const marker = { count: 0, isTrusted: false, selectorMatched: false, targetValue: null };
    window.__huiwenFontArtifactClickMarker = marker;
    window.__huiwenFontArtifactClickListener = (event) => {
      const target = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!event.isTrusted || !target) return;
      marker.count += 1;
      marker.isTrusted = event.isTrusted;
      marker.selectorMatched = true;
      marker.targetValue = target.getAttribute('data-legal-view');
      debugger;
    };
    window.addEventListener('click', window.__huiwenFontArtifactClickListener, true);
  })();`;
}

export function readCdpMonotonicTimestamp(metrics) {
  const timestamp = metrics?.metrics?.find((metric) => metric.name === 'Timestamp')?.value;
  assert.ok(Number.isFinite(timestamp) && timestamp > 0,
    'CDP Performance.getMetrics did not return a valid monotonic Timestamp');
  return timestamp;
}

export function validateTrustedClickMarker({ marker, timestamp, initialTimestamp, visualCaptureTimestamp = null }) {
  assert.ok(marker && typeof marker === 'object', 'trusted service-card click marker is missing');
  assert.equal(marker.count, 1, 'trusted service-card click marker must occur exactly once');
  assert.equal(marker.isTrusted, true, 'service-card click was not a trusted browser input');
  assert.equal(marker.selectorMatched, true, 'trusted click did not target the legal service card');
  assert.equal(marker.targetValue, 'card', 'trusted click marker target value changed');
  assert.ok(Number.isFinite(timestamp) && timestamp > 0, 'trusted click has no CDP monotonic timestamp');
  assert.ok(Number.isFinite(initialTimestamp) && timestamp > initialTimestamp,
    'trusted click timestamp does not follow route navigation start');
  if (visualCaptureTimestamp !== null) {
    assert.ok(Number.isFinite(visualCaptureTimestamp) && timestamp > visualCaptureTimestamp,
      'trusted click timestamp does not follow the initial visual capture window');
  }
  return {
    valid: true,
    source: 'trusted-capture-click-before-app-handler',
    timestamp,
    timestampClock: 'CDP Performance.getMetrics Timestamp',
    selector: SERVICE_CARD_SELECTOR,
  };
}

export function classifyCdpRequestTimestamp({
  timestamp,
  initialTimestamp,
  visualCaptureTimestamp = null,
  clickMarker = null,
}) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { phase: 'unclassified', error: 'request has no valid CDP monotonic timestamp' };
  }
  if (!Number.isFinite(initialTimestamp) || initialTimestamp <= 0 || timestamp < initialTimestamp) {
    return { phase: 'unclassified', error: 'request timestamp predates or lacks the navigation boundary' };
  }

  let phase = 'initial';
  if (visualCaptureTimestamp !== null) {
    if (!Number.isFinite(visualCaptureTimestamp) || visualCaptureTimestamp <= initialTimestamp) {
      return { phase: 'unclassified', error: 'visual-capture boundary is invalid' };
    }
    if (timestamp === visualCaptureTimestamp) {
      return { phase: 'unclassified', error: 'request timestamp is ambiguous at the visual-capture boundary' };
    }
    if (timestamp > visualCaptureTimestamp) phase = 'visual-capture';
  }

  if (clickMarker?.valid) {
    if (!Number.isFinite(clickMarker.timestamp) || clickMarker.timestamp <= initialTimestamp
      || (visualCaptureTimestamp !== null && clickMarker.timestamp <= visualCaptureTimestamp)) {
      return { phase: 'unclassified', error: 'trusted-click boundary is invalid' };
    }
    if (timestamp === clickMarker.timestamp) {
      return { phase: 'unclassified', error: 'request timestamp is ambiguous at the trusted-click boundary' };
    }
    if (timestamp > clickMarker.timestamp) phase = 'post-trigger';
  }
  return { phase, error: null };
}

function compactRequest(record, timing) {
  return {
    requestId: record.requestId,
    path: record.path,
    origin: record.origin,
    method: record.method,
    requestType: record.requestType,
    frameId: record.frameId,
    isMainFrame: record.isMainFrame,
    initiator: record.initiator,
    timestamp: record.timestamp,
    phase: timing.phase,
    timingError: timing.error,
    status: record.response?.status ?? null,
    mimeType: record.response?.mimeType ?? null,
    fromDiskCache: record.response?.fromDiskCache ?? null,
    fromServiceWorker: record.response?.fromServiceWorker ?? null,
    encodedDataLength: record.encodedDataLength ?? null,
    terminal: record.terminal || 'pending',
    failure: record.failure || null,
    redirect: record.redirect || null,
    bodyBytes: record.bodyBytes ?? null,
    bodySha256: record.bodySha256 ?? null,
    bodyError: record.bodyError || null,
  };
}

function pushViolation(violations, kind, request = null, details = {}) {
  violations.push({
    kind,
    ...(request ? { path: request.path, phase: request.phase, requestId: request.requestId } : {}),
    ...details,
  });
}

export function buildFinalFontNetworkSnapshot({
  route,
  rawRequests,
  initialTimestamp,
  visualCaptureTimestamp = null,
  clickMarker = null,
  expectedPreloads,
  expectedFontArtifacts,
  expectedSharedFallbackFonts = [],
  fullTcPath,
  routeOrigin,
  observationClosed,
  renderCompleteness,
  requireTrustedClickMarker = false,
}) {
  assert.ok(typeof route === 'string' && route.length > 0, 'final network snapshot route is missing');
  assert.ok(Array.isArray(rawRequests), `${route}: CDP request records are missing`);
  assert.ok(Array.isArray(expectedPreloads) && expectedPreloads.length > 0,
    `${route}: expected page-font preloads are missing`);
  assert.ok(Array.isArray(expectedFontArtifacts) && expectedFontArtifacts.length === expectedPreloads.length,
    `${route}: expected page-font byte/hash artifacts are missing`);
  assert.ok(Array.isArray(expectedSharedFallbackFonts),
    `${route}: expected shared fallback-font artifacts are missing`);
  assert.ok(typeof fullTcPath === 'string' && fullTcPath.startsWith('/'), 'Full-TC request path is invalid');
  assert.ok(typeof routeOrigin === 'string' && routeOrigin.length > 0, `${route}: route origin is missing`);

  const violations = [];
  if (observationClosed !== true) pushViolation(violations, 'observation-not-closed');
  if (!Number.isFinite(initialTimestamp) || initialTimestamp <= 0) {
    pushViolation(violations, 'invalid-navigation-timestamp');
  }
  if (visualCaptureTimestamp !== null
    && (!Number.isFinite(visualCaptureTimestamp) || visualCaptureTimestamp <= initialTimestamp)) {
    pushViolation(violations, 'invalid-visual-capture-timestamp');
  }
  if (requireTrustedClickMarker && route !== 'service.html') {
    pushViolation(violations, 'trusted-click-marker-required-on-wrong-route');
  }
  if (requireTrustedClickMarker && route === 'service.html' && !clickMarker?.valid) {
    pushViolation(violations, 'missing-or-invalid-trusted-click-marker', null, {
      reason: clickMarker?.error || 'no trusted capture-phase click marker was recorded',
    });
  }

  const requests = rawRequests.map((record) => {
    const timing = classifyCdpRequestTimestamp({
      timestamp: record.timestamp,
      initialTimestamp,
      visualCaptureTimestamp,
      clickMarker,
    });
    const request = compactRequest(record, timing);
    if (timing.error && TRACKED_REQUEST_TYPES.has(record.requestType)) {
      pushViolation(violations, 'invalid-request-timing', request, { reason: timing.error });
    }
    if (record.redirect) pushViolation(violations, 'redirected-request', request, { response: record.redirect });
    return request;
  });

  const trackedRequests = requests.filter((request) => TRACKED_REQUEST_TYPES.has(request.requestType));
  const noncriticalThirdPartyDocuments = trackedRequests
    .filter((request) => isNoncriticalThirdPartyDocument(request, routeOrigin))
    .map(auditThirdPartyDocument);
  const criticalTrackedRequests = trackedRequests
    .filter((request) => !isNoncriticalThirdPartyDocument(request, routeOrigin));
  for (const request of criticalTrackedRequests) {
    if (request.terminal === 'pending') pushViolation(violations, 'critical-tracked-request-pending', request);
  }

  const fontRequests = requests.filter((request) => request.requestType === 'Font');
  const fullTcRequests = requests.filter((request) => request.path === fullTcPath);
  const expectedPaths = new Set(expectedPreloads);
  const expectedSharedFallbackByPath = new Map(expectedSharedFallbackFonts.map((font) => [font.path, font]));
  assert.equal(expectedSharedFallbackByPath.size, expectedSharedFallbackFonts.length,
    `${route}: expected shared fallback-font artifacts contain duplicate paths`);
  for (const font of expectedSharedFallbackFonts) {
    assert.ok(typeof font.path === 'string' && font.path.startsWith('/'),
      `${route}: expected shared fallback-font path is invalid`);
    assert.ok(font.path !== fullTcPath && !expectedPaths.has(font.path),
      `${route}: shared fallback-font paths must be separate from page subsets and Full-TC`);
    assert.match(font.sha256 || '', SHA256,
      `${route}: expected shared fallback-font digest is invalid`);
  }
  const sharedFallbackPaths = new Set(expectedSharedFallbackByPath.keys());
  const pageFontRequests = fontRequests.filter((request) => request.path !== fullTcPath
    && !sharedFallbackPaths.has(request.path));
  const sharedFallbackFontRequests = fontRequests.filter((request) => sharedFallbackPaths.has(request.path));
  const expectedArtifacts = new Map(expectedFontArtifacts.map((artifact) => [artifact.path, artifact]));
  assert.equal(expectedArtifacts.size, expectedFontArtifacts.length,
    `${route}: expected page-font artifacts contain duplicate paths`);
  assert.deepEqual([...expectedArtifacts.keys()].sort(), [...expectedPaths].sort(),
    `${route}: expected page-font artifact paths differ from the preload contract`);
  for (const artifact of expectedFontArtifacts) {
    assert.ok(Number.isInteger(artifact.bytes) && artifact.bytes > 0,
      `${route}: expected page-font artifact has no positive byte length`);
    assert.match(artifact.sha256 || '', SHA256,
      `${route}: expected page-font artifact has no valid SHA-256`);
  }

  for (const request of pageFontRequests) {
    if (!expectedPaths.has(request.path)) pushViolation(violations, 'unexpected-page-font-path', request);
    const artifact = expectedArtifacts.get(request.path);
    if (artifact && request.bodyBytes !== artifact.bytes) pushViolation(violations, 'page-font-byte-length', request,
      { expected: artifact.bytes, observed: request.bodyBytes });
    if (artifact && request.bodySha256 !== artifact.sha256) pushViolation(violations, 'page-font-sha256', request,
      { expected: artifact.sha256, observed: request.bodySha256 });
    if (request.bodyError) pushViolation(violations, 'page-font-body-read', request,
      { message: request.bodyError });
    if (request.origin !== routeOrigin) pushViolation(violations, 'page-font-origin-mismatch', request,
      { expectedOrigin: routeOrigin, observedOrigin: request.origin });
    if (request.isMainFrame !== true) pushViolation(violations, 'page-font-not-main-frame', request);
    if (request.phase !== 'initial') pushViolation(violations, 'page-font-not-requested-during-initial-render', request);
    if (request.method !== 'GET') pushViolation(violations, 'page-font-method-mismatch', request);
    if (request.status !== 200) pushViolation(violations, 'page-font-http-status', request, { status: request.status });
    if (request.terminal !== 'finished') pushViolation(violations, 'page-font-not-finished', request);
    if (!Number.isFinite(request.encodedDataLength) || request.encodedDataLength <= 0) {
      pushViolation(violations, 'page-font-empty-response', request);
    }
    if (request.failure) pushViolation(violations, 'page-font-request-failed', request);
  }

  for (const [path, artifact] of expectedSharedFallbackByPath) {
    const matching = sharedFallbackFontRequests.filter((request) => request.path === path);
    if (matching.length > 1) pushViolation(violations, 'shared-fallback-font-count', null,
      { path, expected: 'at most one', observed: matching.length });
    for (const request of matching) {
      if (request.origin !== routeOrigin) pushViolation(violations, 'shared-fallback-font-origin-mismatch', request,
        { expectedOrigin: routeOrigin, observedOrigin: request.origin });
      if (request.isMainFrame !== true) pushViolation(violations, 'shared-fallback-font-not-main-frame', request);
      if (request.phase !== 'initial') pushViolation(violations, 'shared-fallback-font-not-requested-during-initial-render', request);
      if (request.method !== 'GET') pushViolation(violations, 'shared-fallback-font-method-mismatch', request);
      if (request.status !== 200) pushViolation(violations, 'shared-fallback-font-http-status', request, { status: request.status });
      if (request.terminal !== 'finished') pushViolation(violations, 'shared-fallback-font-not-finished', request);
      if (!Number.isFinite(request.encodedDataLength) || request.encodedDataLength <= 0
        || !Number.isInteger(request.bodyBytes) || request.bodyBytes <= 0) {
        pushViolation(violations, 'shared-fallback-font-empty-response', request);
      }
      if (request.bodySha256 !== artifact.sha256) pushViolation(violations, 'shared-fallback-font-sha256', request,
        { expected: artifact.sha256, observed: request.bodySha256 });
      if (request.bodyError) pushViolation(violations, 'shared-fallback-font-body-read', request,
        { message: request.bodyError });
      if (request.failure) pushViolation(violations, 'shared-fallback-font-request-failed', request);
    }
  }

  for (const path of expectedPaths) {
    const matching = pageFontRequests.filter((request) => request.path === path);
    if (matching.length !== 1) pushViolation(violations, 'page-font-preload-count', null,
      { path, expected: 1, observed: matching.length });
  }

  for (const request of fullTcRequests) {
    if (request.requestType !== 'Font') pushViolation(violations, 'full-tc-request-type-mismatch', request,
      { expected: 'Font', observed: request.requestType });
    if (request.phase !== 'post-trigger') pushViolation(violations, 'full-tc-before-trusted-gesture', request);
    if (route !== 'service.html') pushViolation(violations, 'full-tc-on-non-service-route', request);
    if (request.origin !== routeOrigin) pushViolation(violations, 'full-tc-origin-mismatch', request,
      { expectedOrigin: routeOrigin, observedOrigin: request.origin });
    if (request.isMainFrame !== true) pushViolation(violations, 'full-tc-not-main-frame', request);
    if (request.method !== 'GET') pushViolation(violations, 'full-tc-method-mismatch', request);
    if (request.status !== 200) pushViolation(violations, 'full-tc-http-status', request, { status: request.status });
    if (request.terminal !== 'finished') pushViolation(violations, 'full-tc-not-finished', request);
    if (request.failure) pushViolation(violations, 'full-tc-request-failed', request);
  }

  const phaseNames = ['initial', 'visual-capture', 'post-trigger', 'unclassified'];
  const phaseCounts = Object.fromEntries(phaseNames.map((phase) => [phase, {
    fullTc: fullTcRequests.filter((request) => request.phase === phase).length,
    pageFont: pageFontRequests.filter((request) => request.phase === phase).length,
    sharedFallbackFont: sharedFallbackFontRequests.filter((request) => request.phase === phase).length,
  }]));

  return {
    route,
    phase: 'final',
    routeOrigin,
    finalSnapshot: true,
    observationClosed: observationClosed === true,
    timingSource: 'CDP Network.timestamp compared with CDP Performance.getMetrics Timestamp',
    requestScope: {
      trackedResourceTypes: [...TRACKED_REQUEST_TYPES],
      criticalCompleteness: 'tracked Document, Font, Stylesheet, and Script requests must reach a terminal event; only positively classified foreign child-frame Documents are excluded',
      noncriticalThirdPartyDocumentCriteria: 'Document request, isMainFrame=false, non-empty frameId, valid HTTP(S) origin different from the normalized route origin',
      noncriticalThirdPartyDocuments,
      fontFrameScope: 'all frames; only declared same-origin main-frame page preloads and explicit shared fallback fonts are allowed',
      expectedPageFontPaths: [...expectedPaths],
      expectedPageFontArtifacts: expectedFontArtifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      expectedSharedFallbackFonts,
      fullTcPath,
      initialRenderCompleteness: renderCompleteness || null,
    },
    boundaries: {
      initialTimestamp: Number.isFinite(initialTimestamp) ? initialTimestamp : null,
      visualCaptureTimestamp: Number.isFinite(visualCaptureTimestamp) ? visualCaptureTimestamp : null,
      trustedClick: clickMarker?.valid ? clickMarker : null,
    },
    phaseCounts,
    initialFullTcRequestsBeforeCapture: phaseCounts.initial.fullTc,
    fullTcRequests,
    preOnDemandFullTcRequests: fullTcRequests.filter((request) => request.phase !== 'post-trigger'),
    postTriggerFullTcRequests: fullTcRequests.filter((request) => request.phase === 'post-trigger'),
    pageFontRequests,
    sharedFallbackFontRequests,
    criticalTrackedRequests,
    noncriticalThirdPartyDocuments,
    trackedRequests,
    violations,
  };
}

export function validateServiceCardOnDemand({
  route,
  snapshot,
  expectedOrigin,
  expectedPath,
  expectedBytes,
  expectedSha256,
  canvasVisible,
}) {
  const errors = [];
  const marker = snapshot?.boundaries?.trustedClick;
  if (route !== 'service.html') errors.push({ kind: 'wrong-service-route', route });
  if (!marker?.valid) errors.push({ kind: 'missing-trusted-click-marker' });

  const before = snapshot?.preOnDemandFullTcRequests || [];
  const onDemand = snapshot?.postTriggerFullTcRequests || [];
  if (before.length) errors.push({ kind: 'pre-trigger-full-tc-request', count: before.length });
  if (onDemand.length !== 1) errors.push({ kind: 'on-demand-full-tc-count', expected: 1, observed: onDemand.length });

  const request = onDemand.length === 1 ? onDemand[0] : null;
  if (request) {
    if (request.path !== expectedPath) errors.push({ kind: 'font-path', expected: expectedPath, observed: request.path });
    if (request.origin !== expectedOrigin) errors.push({ kind: 'font-origin', expected: expectedOrigin, observed: request.origin });
    if (request.method !== 'GET') errors.push({ kind: 'font-method', expected: 'GET', observed: request.method });
    if (request.requestType !== 'Font' || request.isMainFrame !== true) errors.push({ kind: 'font-frame-or-type' });
    if (request.status !== 200) errors.push({ kind: 'font-http-status', expected: 200, observed: request.status });
    if (request.terminal !== 'finished' || request.failure) errors.push({ kind: 'font-response-incomplete' });
    if (!Number.isFinite(request.encodedDataLength) || request.encodedDataLength <= 0) {
      errors.push({ kind: 'font-response-empty' });
    }
    if (request.bodyBytes !== expectedBytes) errors.push({ kind: 'font-byte-length', expected: expectedBytes, observed: request.bodyBytes });
    if (!SHA256.test(request.bodySha256 || '') || request.bodySha256 !== expectedSha256) {
      errors.push({ kind: 'font-sha256', expected: expectedSha256, observed: request.bodySha256 });
    }
    if (request.bodyError) errors.push({ kind: 'font-body-read', message: request.bodyError });
  }
  if (canvasVisible !== true) errors.push({ kind: 'canvas-not-visible' });

  return {
    valid: errors.length === 0,
    errors,
    requestCount: onDemand.length,
    request: request ? {
      path: request.path,
      status: request.status,
      bytes: request.bodyBytes,
      sha256: request.bodySha256,
      phase: request.phase,
    } : null,
    canvasVisible: canvasVisible === true,
  };
}

export async function waitForTrackedNetworkQuiet({
  routeNetwork,
  cdpSession,
  routeOrigin,
  timeoutMs = NETWORK_SETTLE_TIMEOUT_MS,
  quietWindowMs = NETWORK_QUIET_WINDOW_MS,
  pollIntervalMs = 25,
}) {
  assert.ok(routeNetwork && Array.isArray(routeNetwork.requests), 'route network request tracker is missing');
  assert.ok(cdpSession && typeof cdpSession.send === 'function', 'route CDP session is missing');
  const startedAt = performance.now();
  let quietSince = null;
  let observedRevision = routeNetwork.revision;
  const criticalPendingRequests = () => routeNetwork.requests.filter((request) => request.track
    && !request.terminal && !isNoncriticalThirdPartyDocument(request, routeOrigin));
  const thirdPartyDocumentAudit = () => routeNetwork.requests
    .filter((request) => request.track && isNoncriticalThirdPartyDocument(request, routeOrigin))
    .map(auditThirdPartyDocument);

  while (performance.now() - startedAt < timeoutMs) {
    const pending = criticalPendingRequests();
    if (pending.length === 0 && observedRevision === routeNetwork.revision) {
      if (quietSince === null) quietSince = performance.now();
      if (performance.now() - quietSince >= quietWindowMs) {
        await cdpSession.send('Performance.getMetrics');
        const afterBarrierPending = criticalPendingRequests();
        if (afterBarrierPending.length === 0 && observedRevision === routeNetwork.revision) {
          return { settled: true, elapsedMs: Math.round(performance.now() - startedAt), pending: [],
            noncriticalThirdPartyDocuments: thirdPartyDocumentAudit() };
        }
        observedRevision = routeNetwork.revision;
        quietSince = null;
      }
    } else {
      observedRevision = routeNetwork.revision;
      quietSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const pending = criticalPendingRequests()
    .map((request) => ({ requestId: request.requestId, path: request.path, requestType: request.requestType,
      origin: request.origin || null, frameId: request.frameId || null, isMainFrame: request.isMainFrame,
      terminal: request.terminal || 'pending' }));
  return { settled: false, elapsedMs: Math.round(performance.now() - startedAt), pending,
    noncriticalThirdPartyDocuments: thirdPartyDocumentAudit() };
}

export function hashResponseBody(bytes) {
  assert.ok(Buffer.isBuffer(bytes), 'CDP response body must be decoded to bytes');
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
