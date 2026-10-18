import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AXE_CORE_VERSION,
  AXE_PLAYWRIGHT_VERSION,
  WCAG22AA_TAGS,
  axeSelectorCandidates,
  collectTargetSizeDiagnostics,
  evaluateTargetSizeBaseline,
  targetSizeFingerprint,
} from './wcag22aa.mjs';

const donationDir = new URL('./', import.meta.url);

test('full-site, readiness, lifecycle, and production runners execute wcag22aa without dropping WCAG 2.0 A/AA', async () => {
  const runnerFiles = ['browser.mjs', 'readiness.mjs', 'lifecycle.mjs', 'production-browser.mjs'];
  for (const file of runnerFiles) {
    const source = await readFile(new URL(file, donationDir), 'utf8');
    const calls = [...source.matchAll(/\.withTags\(\s*\[([^\]]*)\]\s*\)/gs)];
    assert(calls.length > 0, `${file}: withTags must use a literal tag list covered by this test`);
    for (const [, list] of calls) {
      assert.match(list, /['"]wcag2a['"]/, `${file}: wcag2a was removed`);
      assert.match(list, /['"]wcag2aa['"]/, `${file}: wcag2aa was removed`);
      assert.match(list, /['"]wcag22aa['"]/, `${file}: wcag22aa is not actually passed to AxeBuilder`);
    }
  }

  const packageJson = JSON.parse(await readFile(new URL('./package.json', donationDir), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('./package-lock.json', donationDir), 'utf8'));
  assert.equal(packageJson.devDependencies['@axe-core/playwright'], AXE_PLAYWRIGHT_VERSION);
  assert.equal(packageLock.packages['node_modules/axe-core'].version, AXE_CORE_VERSION);
  assert.deepEqual(WCAG22AA_TAGS, ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
});

test('pending browser baseline fails closed without assuming zero', async () => {
  const baseline = JSON.parse(await readFile(new URL('./wcag22aa-baseline.json', donationDir), 'utf8'));
  const gate = evaluateTargetSizeBaseline(baseline, []);
  assert.equal(gate.status, 'baseline-pending');
  assert.equal(gate.pass, false);
  assert.equal(gate.knownBaselineCount, null);
});

test('approved baseline rejects new selectors and requires cleared entries to be removed', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    status: 'approved',
    axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
    axeCoreVersion: AXE_CORE_VERSION,
    source: {
      headSha: '0123456789abcdef0123456789abcdef01234567',
      workflowRunId: '39134190011',
      artifactName: 'full-site-browser-qa',
      runUrl: 'https://github.com/example/repo/actions/runs/39134190011',
    },
    entries: [{
      route: 'index.html', viewportWidth: 390, selectors: ['.known-target'],
      exceptionReview: { status: 'reviewed', decision: 'no-applicable-exception', note: 'Fixture only.' },
    }],
  };
  const known = { route: 'index.html', viewportWidth: 390, selectors: ['.known-target'], measurementStatus: 'measured' };
  const added = { route: 'index.html', viewportWidth: 390, selectors: ['.new-target'], measurementStatus: 'measured' };

  const stable = evaluateTargetSizeBaseline(baseline, [known]);
  assert.equal(stable.status, 'pass');
  assert.equal(stable.pass, true);

  const regressed = evaluateTargetSizeBaseline(baseline, [known, added]);
  assert.equal(regressed.status, 'new-violations');
  assert.deepEqual(regressed.newViolations, [added]);

  const needsCleanup = evaluateTargetSizeBaseline(baseline, []);
  assert.equal(needsCleanup.status, 'baseline-cleanup-required');
  assert.deepEqual(needsCleanup.resolvedViolations, baseline.entries);
});

test('baseline cannot be approved while a target-size exception has no human decision', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    status: 'approved',
    axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
    axeCoreVersion: AXE_CORE_VERSION,
    source: {
      headSha: '0123456789abcdef0123456789abcdef01234567',
      workflowRunId: '39134190011',
      artifactName: 'full-site-browser-qa',
      runUrl: 'https://github.com/example/repo/actions/runs/39134190011',
    },
    entries: [{ route: 'index.html', viewportWidth: 390, selectors: ['.small-target'] }],
  };
  const gate = evaluateTargetSizeBaseline(baseline, []);
  assert.equal(gate.status, 'baseline-pending');
  assert.equal(gate.pass, false);
  assert.match(gate.reason, /human-reviewed WCAG 2\.5\.8/);
});

test('unmeasured selectors fail even against an approved baseline', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    status: 'approved',
    axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
    axeCoreVersion: AXE_CORE_VERSION,
    source: {
      headSha: '0123456789abcdef0123456789abcdef01234567',
      workflowRunId: '39134190011',
      artifactName: 'full-site-browser-qa',
      runUrl: 'https://github.com/example/repo/actions/runs/39134190011',
    },
    entries: [{
      route: 'service.html', viewportWidth: 390, selectors: ['.small-target'],
      exceptionReview: { status: 'reviewed', decision: 'needs-fix', note: 'Fixture only.' },
    }],
  };
  const current = [{
    route: 'service.html', viewportWidth: 390, selectors: ['.small-target'],
    measurementStatus: 'unresolved', measurementErrors: ['fixture cannot resolve selector'],
  }];
  const gate = evaluateTargetSizeBaseline(baseline, current);
  assert.equal(gate.status, 'measurement-incomplete');
  assert.equal(gate.pass, false);
  assert.equal(gate.measurementFailures.length, 1);
});

test('axe shadow-selector targets retain a measurable selector path', () => {
  assert.deepEqual(axeSelectorCandidates(['#custom-host', 'button']), [
    ['#custom-host', 'button'],
    ['#custom-host'],
    ['button'],
  ]);
  assert.equal(targetSizeFingerprint({ route: 'index.html', viewportWidth: 390, selectors: ['.cta'] }),
    targetSizeFingerprint({ route: 'index.html', viewportWidth: '390', target: ['.cta'] }));
  assert.notEqual(
    targetSizeFingerprint({ route: 'political-donation.html', viewportWidth: 390, scenario: 'core-page-default', selectors: ['.cta'] }),
    targetSizeFingerprint({ route: 'political-donation.html', viewportWidth: 390, scenario: 'donation-details-expanded', selectors: ['.cta'] }),
  );
});

test('target-size diagnostics contain selector, measured CSS size, minimum, and exception evidence', async () => {
  const page = {
    locator(selector) {
      assert.equal(selector, 'css=.small-link');
      return {
        count: async () => 1,
        nth: () => ({ boundingBox: async () => ({ width: 18, height: 20, x: 3, y: 7 }) }),
      };
    },
  };
  const entries = await collectTargetSizeDiagnostics(page, 'index.html', 390, [{
    id: 'target-size',
    impact: 'serious',
    help: 'Targets must meet minimum size',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/target-size',
    nodes: [{
      target: ['.small-link'],
      failureSummary: 'Target is too small.',
      any: [{ id: 'target-size', message: 'Target is below the minimum size.', data: { width: 18, height: 20 } }],
      all: [],
      none: [],
    }],
  }], 'test-fixture');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].scenario, 'test-fixture');
  assert.deepEqual(entries[0].selectors, ['.small-link']);
  assert.deepEqual(entries[0].measuredBoxesCssPx, [{ width: 18, height: 20, x: 3, y: 7 }]);
  assert.deepEqual(entries[0].minimumTargetSizeCssPx, { width: 24, height: 24 });
  assert.match(entries[0].exceptionEvidence.manualReview, /WCAG 2\.5\.8/);
  assert.deepEqual(entries[0].exceptionEvidence.checks.any[0].data, { width: 18, height: 20 });
});
