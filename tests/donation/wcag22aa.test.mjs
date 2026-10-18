import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AXE_CORE_VERSION,
  AXE_PLAYWRIGHT_VERSION,
  WCAG22AA_TAGS,
  axeSelectorCandidates,
  collectTargetSizeDiagnostics,
  evaluateTargetSizeGate,
  evaluateTargetSizeBaseline,
  FULL_SITE_TARGET_SIZE_SCOPE,
  nonTargetAxeViolations,
  PRODUCTION_TARGET_SIZE_SCOPE,
  resolveTargetSizeMode,
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

test('capture-pending stays pending at zero and compare fails closed without an approved baseline', async () => {
  const baseline = JSON.parse(await readFile(new URL('./wcag22aa-baseline.json', donationDir), 'utf8'));
  const capture = evaluateTargetSizeGate(undefined, baseline, [], FULL_SITE_TARGET_SIZE_SCOPE);
  assert.equal(capture.mode, 'capture-pending');
  assert.equal(capture.status, 'capture-pending');
  assert.equal(capture.pass, null);
  assert.equal(capture.comparisonPerformed, false);
  assert.equal(capture.currentViolationCount, 0);
  assert.equal(capture.measuredEntryCount, 0);
  assert.equal(capture.knownBaselineCount, null);

  const captureWithFinding = evaluateTargetSizeGate('capture-pending', baseline, [{
    route: 'index.html',
    viewportWidth: 390,
    selectors: ['.unresolved-target'],
    measurementStatus: 'unresolved',
    measurementErrors: ['fixture could not resolve target'],
  }], FULL_SITE_TARGET_SIZE_SCOPE);
  assert.equal(captureWithFinding.status, 'capture-pending');
  assert.equal(captureWithFinding.pass, null);
  assert.equal(captureWithFinding.currentViolationCount, 1);
  assert.equal(captureWithFinding.measuredEntryCount, 0);
  assert.equal(captureWithFinding.measurementFailures.length, 1);

  const compare = evaluateTargetSizeGate('compare', baseline, [], FULL_SITE_TARGET_SIZE_SCOPE);
  assert.equal(compare.status, 'baseline-pending');
  assert.equal(compare.pass, false);
  assert.equal(compare.comparisonPerformed, true);
  assert.equal(compare.knownBaselineCount, null);
});

test('browser runners consume the explicit mode and production uses its own baseline file', async () => {
  const browser = await readFile(new URL('./browser.mjs', donationDir), 'utf8');
  const production = await readFile(new URL('./production-browser.mjs', donationDir), 'utf8');

  for (const [name, source] of [['browser.mjs', browser], ['production-browser.mjs', production]]) {
    assert.match(source, /resolveTargetSizeMode\(process\.env\.WCAG22AA_TARGET_SIZE_MODE\)/, `${name}: explicit mode is not read`);
    assert.match(source, /evaluateTargetSizeGate\(/, `${name}: target-size mode gate is not applied`);
    assert.match(source, /status: 'Pending'/, `${name}: capture-pending is not reported as pending`);
  }
  assert.match(production, /wcag22aa-production-baseline\.json/, 'production must use its own scope baseline');
});

test('target-size mode is exact and defaults only to capture-pending', () => {
  assert.equal(resolveTargetSizeMode(undefined), 'capture-pending');
  assert.equal(resolveTargetSizeMode('compare'), 'compare');
  assert.throws(() => resolveTargetSizeMode('disabled'), /exactly "capture-pending" or "compare"/);
});

test('production compare uses its own pending scope baseline', async () => {
  const baseline = JSON.parse(await readFile(new URL('./wcag22aa-production-baseline.json', donationDir), 'utf8'));
  assert.equal(baseline.scope, PRODUCTION_TARGET_SIZE_SCOPE);
  assert.equal(baseline.status, 'pending-ci');
  assert.equal(baseline.entries, null);
  assert.equal(baseline.knownViolationCount, null);

  const compare = evaluateTargetSizeGate('compare', baseline, [], PRODUCTION_TARGET_SIZE_SCOPE);
  assert.equal(compare.status, 'baseline-pending');
  assert.equal(compare.pass, false);
  assert.equal(compare.knownBaselineCount, null);
});

test('capture mode leaves non-target axe findings in the existing strict gate', () => {
  const targetSize = { id: 'target-size', impact: 'serious', nodes: [{ target: ['.small'] }] };
  const contrast = { id: 'color-contrast', impact: 'serious', nodes: [{ target: ['.text'] }] };
  const minor = { id: 'landmark-one-main', impact: 'minor', nodes: [{ target: ['main'] }] };

  assert.deepEqual(nonTargetAxeViolations([targetSize, contrast]), [contrast]);
  assert.deepEqual(nonTargetAxeViolations([targetSize, contrast, minor], ['serious', 'critical']), [contrast]);
});

test('approved baseline rejects new selectors and requires cleared entries to be removed', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    scope: FULL_SITE_TARGET_SIZE_SCOPE,
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

  const stable = evaluateTargetSizeBaseline(baseline, [known], { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE });
  assert.equal(stable.status, 'pass');
  assert.equal(stable.pass, true);

  const regressed = evaluateTargetSizeBaseline(baseline, [known, added], { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE });
  assert.equal(regressed.status, 'new-violations');
  assert.deepEqual(regressed.newViolations, [added]);

  const needsCleanup = evaluateTargetSizeBaseline(baseline, [], { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE });
  assert.equal(needsCleanup.status, 'baseline-cleanup-required');
  assert.deepEqual(needsCleanup.resolvedViolations, baseline.entries);

  const approvedZero = evaluateTargetSizeGate(
    'compare',
    { ...baseline, entries: [] },
    [],
    FULL_SITE_TARGET_SIZE_SCOPE,
  );
  assert.equal(approvedZero.status, 'pass');
  assert.equal(approvedZero.pass, true);
  assert.equal(approvedZero.knownBaselineCount, 0);

  const wrongScope = evaluateTargetSizeBaseline(
    { ...baseline, scope: PRODUCTION_TARGET_SIZE_SCOPE },
    [known],
    { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE },
  );
  assert.equal(wrongScope.status, 'baseline-pending');
  assert.match(wrongScope.reason, /scope must exactly match/);

  const wrongVersion = evaluateTargetSizeBaseline(
    { ...baseline, axeCoreVersion: '0.0.0' },
    [known],
    { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE },
  );
  assert.equal(wrongVersion.status, 'baseline-pending');
  assert.match(wrongVersion.reason, /axe versions do not match/);
});

test('baseline cannot be approved while a target-size exception has no human decision', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    scope: FULL_SITE_TARGET_SIZE_SCOPE,
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
  const gate = evaluateTargetSizeBaseline(baseline, [], { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE });
  assert.equal(gate.status, 'baseline-pending');
  assert.equal(gate.pass, false);
  assert.match(gate.reason, /human-reviewed WCAG 2\.5\.8/);
});

test('unmeasured selectors fail even against an approved baseline', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    scope: FULL_SITE_TARGET_SIZE_SCOPE,
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
  const gate = evaluateTargetSizeBaseline(baseline, current, { requiredScope: FULL_SITE_TARGET_SIZE_SCOPE });
  assert.equal(gate.status, 'measurement-incomplete');
  assert.equal(gate.pass, false);
  assert.equal(gate.measurementFailures.length, 1);
});

test('only a complete single axe selector is offered for measurement', () => {
  assert.deepEqual(axeSelectorCandidates(['.single-target']), [['.single-target']]);
  assert.deepEqual(axeSelectorCandidates(['#custom-host', 'button']), []);
  assert.deepEqual(axeSelectorCandidates('#frame >> .small-button'), []);
  assert.deepEqual(axeSelectorCandidates([['#host'], '.nested-target']), []);
  assert.equal(targetSizeFingerprint({ route: 'index.html', viewportWidth: 390, selectors: ['.cta'] }),
    targetSizeFingerprint({ route: 'index.html', viewportWidth: '390', target: ['.cta'] }));
  assert.notEqual(
    targetSizeFingerprint({ route: 'political-donation.html', viewportWidth: 390, scenario: 'core-page-default', selectors: ['.cta'] }),
    targetSizeFingerprint({ route: 'political-donation.html', viewportWidth: 390, scenario: 'donation-details-expanded', selectors: ['.cta'] }),
  );
});

test('an unresolvable frame target stays unresolved even when its 600x400 host can be measured', async () => {
  const hostBox = { width: 600, height: 400, x: 12, y: 18 };
  const locatorCalls = [];
  const page = {
    locator(selector) {
      locatorCalls.push(selector);
      if (selector === 'css=#frame >> css=.small-button') {
        return { count: async () => 0, nth: () => ({ boundingBox: async () => null }) };
      }
      if (selector === 'css=#frame') {
        return { count: async () => 1, nth: () => ({ boundingBox: async () => hostBox }) };
      }
      if (selector === 'css=.small-button') {
        return { count: async () => 0, nth: () => ({ boundingBox: async () => null }) };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    scope: PRODUCTION_TARGET_SIZE_SCOPE,
    status: 'approved',
    axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
    axeCoreVersion: AXE_CORE_VERSION,
    source: {
      headSha: '0123456789abcdef0123456789abcdef01234567',
      workflowRunId: '39134190011',
      artifactName: 'production-browser-qa',
      runUrl: 'https://github.com/example/repo/actions/runs/39134190011',
    },
    entries: [{
      route: 'index.html',
      viewportWidth: 390,
      scenario: 'core-page-default',
      selectors: ['#frame', '.small-button'],
      exceptionReview: { status: 'reviewed', decision: 'needs-fix', note: 'Fixture only.' },
    }],
  };
  const axeViolations = [{
    id: 'target-size',
    impact: 'serious',
    nodes: [{ target: ['#frame', '.small-button'], failureSummary: 'Target is too small.' }],
  }];

  assert.equal(await page.locator('css=#frame >> css=.small-button').count(), 0, 'the complete target path is unavailable');
  assert.equal(await page.locator('css=#frame').count(), 1, 'the host exists');
  assert.deepEqual(await page.locator('css=#frame').nth(0).boundingBox(), hostBox, 'the host itself is measurable');
  locatorCalls.length = 0;
  const entries = await collectTargetSizeDiagnostics(page, 'index.html', 390, axeViolations, 'core-page-default');
  assert.equal(entries[0].measurementStatus, 'unresolved');
  assert.deepEqual(entries[0].measuredBoxesCssPx, []);
  assert.match(entries[0].measurementErrors[0], /compound frame\/shadow paths/);
  assert.deepEqual(locatorCalls, [], 'the collector must not query or measure the host fallback');

  const gate = evaluateTargetSizeGate('compare', baseline, entries, PRODUCTION_TARGET_SIZE_SCOPE);
  assert.equal(gate.status, 'measurement-incomplete');
  assert.equal(gate.pass, false);
  assert.equal(gate.measurementFailures.length, 1);
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

  const capture = evaluateTargetSizeGate('capture-pending', null, entries, FULL_SITE_TARGET_SIZE_SCOPE);
  assert.equal(capture.status, 'capture-pending');
  assert.equal(capture.pass, null);
  assert.equal(capture.currentViolationCount, 1);
  assert.equal(capture.measuredEntryCount, 1);
});
