import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPageFontPreloadEvidence } from './page-font-preload-contract.mjs';

const expected = ['/assets/fonts/page-core.woff2', '/assets/fonts/page-delta.woff2'];
const declared = expected.map((path) => ({ path }));
const cdpRequests = expected.map((path) => ({
  path,
  requestType: 'Font',
  phase: 'initial',
  isMainFrame: true,
}));

test('service accepts empty Resource Timing only with exact DOM and main-frame CDP font evidence', () => {
  const result = verifyPageFontPreloadEvidence({
    route: 'service.html', expected, declared, observed: [], cdpRequests, fixedClock: true,
  });
  assert.equal(result.valid, true);
  assert.equal(result.verification, 'cdp-font-events');
  assert.deepEqual(result.cdpObserved, expected);
});

test('service rejects a missing DOM declaration even when CDP requests are exact', () => {
  const result = verifyPageFontPreloadEvidence({
    route: 'service.html', expected, declared: declared.slice(0, 1), observed: [], cdpRequests, fixedClock: true,
  });
  assert.equal(result.valid, false);
});

test('service rejects missing CDP evidence when Resource Timing was cleared', () => {
  const result = verifyPageFontPreloadEvidence({
    route: 'service.html', expected, declared, observed: [], cdpRequests: cdpRequests.slice(0, 1), fixedClock: true,
  });
  assert.equal(result.valid, false);
});

test('service rejects partial Resource Timing even if CDP lists the expected fonts', () => {
  const result = verifyPageFontPreloadEvidence({
    route: 'service.html', expected, declared, observed: expected.slice(0, 1), cdpRequests, fixedClock: true,
  });
  assert.equal(result.valid, false);
});

test('other routes cannot use the service fixed-clock exception', () => {
  const result = verifyPageFontPreloadEvidence({
    route: '404.html', expected, declared, observed: [], cdpRequests, fixedClock: true,
  });
  assert.equal(result.valid, false);
});

test('service also requires CDP confirmation when Resource Timing is complete', () => {
  const result = verifyPageFontPreloadEvidence({
    route: 'service.html', expected, declared, observed: expected, cdpRequests: cdpRequests.slice(0, 1), fixedClock: true,
  });
  assert.equal(result.valid, false);
});
