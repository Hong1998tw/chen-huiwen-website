import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AXE_CORE_VERSION,
  AXE_PLAYWRIGHT_VERSION,
  CANDIDATE_TARGET_SIZE_SCOPE,
  WCAG22AA_TAGS,
  axeSelectorCandidates,
  collectTargetSizeDiagnostics,
  evaluateTargetSizeGate,
  evaluateTargetSizeBaseline,
  evaluateTargetSizeCoverage,
  expectedTargetSizeCoverage,
  nonTargetAxeViolations,
  PRODUCTION_TARGET_SIZE_SCOPE,
  resolveTargetSizeMode,
  targetSizeFingerprint,
} from './wcag22aa.mjs';
import { buildTargetSizeBaselineProposal } from './wcag22aa-baseline-proposal.mjs';

const donationDir = new URL('./', import.meta.url);

function targetSizeReportFixture({ violations = [], completed = expectedTargetSizeCoverage() } = {}) {
  const sourceSha = 'a'.repeat(40);
  const coverage = evaluateTargetSizeCoverage(completed);
  const unmeasurable = violations.filter(entry => entry.measurementStatus !== 'measured');
  const gate = evaluateTargetSizeGate('capture-pending', null, violations, CANDIDATE_TARGET_SIZE_SCOPE, coverage);
  return {
    report: {
      schema: 'wcag22aa-target-size-report/v2',
      source: {
        headSha: sourceSha,
        checkoutSha: sourceSha,
        eventHeadSha: 'b'.repeat(40),
        workflowRunId: '39159143917',
        artifactName: 'full-site-browser-qa',
        runUrl: 'https://github.com/example/repo/actions/runs/39159143917',
      },
      tool: {
        entrypoint: 'tests/donation/browser.mjs',
        version: '1.0.0',
        gitHeadSha: sourceSha,
        scriptSha256: 'c'.repeat(64),
      },
      runtime: {
        node: 'v24.1.0',
        platform: 'linux',
        architecture: 'x64',
        playwrightVersion: '1.55.1',
        axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
        axeCoreVersion: AXE_CORE_VERSION,
        chromiumVersion: '140.0.7339.186',
      },
      run: { browserReportStatus: 'Pending', browserFailureCount: 0 },
      mode: 'capture-pending',
      scope: CANDIDATE_TARGET_SIZE_SCOPE,
      axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
      axeCoreVersion: AXE_CORE_VERSION,
      baseline: {
        scope: CANDIDATE_TARGET_SIZE_SCOPE,
        status: 'pending-ci',
        entries: null,
        knownViolationCount: null,
        axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
        axeCoreVersion: AXE_CORE_VERSION,
      },
      gate,
      coverage,
      counts: {
        expectedCaseCount: coverage.expected.length,
        completedCaseCount: coverage.completed.length,
        axeTargetSizeViolationCount: violations.length,
        measuredViolationCount: violations.length - unmeasurable.length,
        unmeasurableViolationCount: unmeasurable.length,
        measurementErrorCount: unmeasurable.reduce((sum, entry) => sum + (entry.measurementErrors?.length ?? 0), 0),
      },
      violations,
    },
    browserReport: {
      status: 'Pending',
      failures: [],
      wcag22aaTargetSize: {
        sourceHeadSha: sourceSha,
        scope: CANDIDATE_TARGET_SIZE_SCOPE,
        coverage,
        gate,
        counts: {
          expectedCaseCount: coverage.expected.length,
          completedCaseCount: coverage.completed.length,
          axeTargetSizeViolationCount: violations.length,
          measuredViolationCount: violations.length - unmeasurable.length,
          unmeasurableViolationCount: unmeasurable.length,
          measurementErrorCount: unmeasurable.reduce((sum, entry) => sum + (entry.measurementErrors?.length ?? 0), 0),
        },
      },
    },
  };
}

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
  const pendingBaseline = { ...baseline, status: 'pending-ci', knownViolationCount: null, entries: null, source: null };
  const capture = evaluateTargetSizeGate(undefined, baseline, [], CANDIDATE_TARGET_SIZE_SCOPE);
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
  }], CANDIDATE_TARGET_SIZE_SCOPE);
  assert.equal(captureWithFinding.status, 'capture-pending');
  assert.equal(captureWithFinding.pass, null);
  assert.equal(captureWithFinding.currentViolationCount, 1);
  assert.equal(captureWithFinding.measuredEntryCount, 0);
  assert.equal(captureWithFinding.measurementFailures.length, 1);

  const compare = evaluateTargetSizeGate('compare', pendingBaseline, [], CANDIDATE_TARGET_SIZE_SCOPE);
  assert.equal(compare.status, 'baseline-pending');
  assert.equal(compare.pass, false);
  assert.equal(compare.comparisonPerformed, true);
  assert.equal(compare.knownBaselineCount, null);
});

test('A-06 compare gate marks the supplied zero-finding fixture as a comparison', async () => {
  const baseline = JSON.parse(await readFile(new URL('./wcag22aa-baseline.json', donationDir), 'utf8'));
  assert.equal(baseline.status, 'approved');
  assert.equal(baseline.scope, CANDIDATE_TARGET_SIZE_SCOPE);
  assert.equal(baseline.knownViolationCount, 0);
  assert.deepEqual(baseline.entries, []);

  const coverage = evaluateTargetSizeCoverage(expectedTargetSizeCoverage());
  const compare = evaluateTargetSizeGate('compare', baseline, [], CANDIDATE_TARGET_SIZE_SCOPE, coverage);
  assert.equal(compare.status, 'pass');
  assert.equal(compare.pass, true);
  assert.equal(compare.comparisonPerformed, true);
  assert.equal(compare.knownBaselineCount, 0);
  assert.equal(compare.currentViolationCount, 0);
});

test('browser runners consume the explicit mode and production uses its own baseline file', async () => {
  const browser = await readFile(new URL('./browser.mjs', donationDir), 'utf8');
  const production = await readFile(new URL('./production-browser.mjs', donationDir), 'utf8');
  const candidateWorkflow = await readFile(new URL('../../.github/workflows/donation-page-qa.yml', donationDir), 'utf8');

  for (const [name, source] of [['browser.mjs', browser], ['production-browser.mjs', production]]) {
    assert.match(source, /resolveTargetSizeMode\(process\.env\.WCAG22AA_TARGET_SIZE_MODE\)/, `${name}: explicit mode is not read`);
    assert.match(source, /evaluateTargetSizeGate\(/, `${name}: target-size mode gate is not applied`);
    assert.match(source, /status: 'Pending'/, `${name}: capture-pending is not reported as pending`);
  }
  assert.match(production, /wcag22aa-production-baseline\.json/, 'production must use its own scope baseline');
  assert.match(candidateWorkflow, /WCAG22AA_TARGET_SIZE_MODE: compare[\s\S]*?run: node tests\/donation\/browser\.mjs/,
    'candidate CI must trigger the A-06 comparison explicitly');
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
    scope: CANDIDATE_TARGET_SIZE_SCOPE,
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

  const stable = evaluateTargetSizeBaseline(baseline, [known], { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE });
  assert.equal(stable.status, 'pass');
  assert.equal(stable.pass, true);

  const regressed = evaluateTargetSizeBaseline(baseline, [known, added], { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE });
  assert.equal(regressed.status, 'new-violations');
  assert.deepEqual(regressed.newViolations, [added]);

  const needsCleanup = evaluateTargetSizeBaseline(baseline, [], { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE });
  assert.equal(needsCleanup.status, 'baseline-cleanup-required');
  assert.deepEqual(needsCleanup.resolvedViolations, baseline.entries);

  const approvedZero = evaluateTargetSizeGate(
    'compare',
    { ...baseline, entries: [] },
    [],
    CANDIDATE_TARGET_SIZE_SCOPE,
  );
  assert.equal(approvedZero.status, 'pass');
  assert.equal(approvedZero.pass, true);
  assert.equal(approvedZero.knownBaselineCount, 0);

  const wrongScope = evaluateTargetSizeBaseline(
    { ...baseline, scope: PRODUCTION_TARGET_SIZE_SCOPE },
    [known],
    { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE },
  );
  assert.equal(wrongScope.status, 'baseline-pending');
  assert.match(wrongScope.reason, /scope must exactly match/);

  const wrongVersion = evaluateTargetSizeBaseline(
    { ...baseline, axeCoreVersion: '0.0.0' },
    [known],
    { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE },
  );
  assert.equal(wrongVersion.status, 'baseline-pending');
  assert.match(wrongVersion.reason, /axe versions do not match/);
});

test('baseline cannot be approved while a target-size exception has no human decision', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    scope: CANDIDATE_TARGET_SIZE_SCOPE,
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
  const gate = evaluateTargetSizeBaseline(baseline, [], { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE });
  assert.equal(gate.status, 'baseline-pending');
  assert.equal(gate.pass, false);
  assert.match(gate.reason, /human-reviewed WCAG 2\.5\.8/);
});

test('unmeasured selectors fail even against an approved baseline', () => {
  const baseline = {
    schema: 'wcag22aa-target-size-baseline/v1',
    scope: CANDIDATE_TARGET_SIZE_SCOPE,
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
  const gate = evaluateTargetSizeBaseline(baseline, current, { requiredScope: CANDIDATE_TARGET_SIZE_SCOPE });
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

  const capture = evaluateTargetSizeGate('capture-pending', null, entries, CANDIDATE_TARGET_SIZE_SCOPE);
  assert.equal(capture.status, 'capture-pending');
  assert.equal(capture.pass, null);
  assert.equal(capture.currentViolationCount, 1);
  assert.equal(capture.measuredEntryCount, 1);
});

test('candidate A-06 coverage is exactly 15 core routes by two viewports and incomplete coverage fails closed', () => {
  const expected = expectedTargetSizeCoverage();
  assert.equal(expected.length, 30);
  assert.equal(new Set(expected.map(item => item.route)).size, 15);
  assert.deepEqual(new Set(expected.map(item => item.viewportWidth)), new Set([390, 1440]));
  assert.equal(expected.every(item => item.scenario === 'core-page-default'), true);

  const complete = evaluateTargetSizeCoverage(expected);
  assert.equal(complete.complete, true);
  const missingRoute = evaluateTargetSizeCoverage(expected.slice(1));
  assert.equal(missingRoute.complete, false);
  assert.equal(missingRoute.missing.length, 1);
  const expandedScenario = evaluateTargetSizeCoverage([...expected, {
    route: 'political-donation.html', viewportWidth: 390, viewportHeight: 844, scenario: 'donation-details-expanded',
  }]);
  assert.equal(expandedScenario.complete, false);
  assert.equal(expandedScenario.unexpected.length, 1);

  const gate = evaluateTargetSizeGate('capture-pending', null, [], CANDIDATE_TARGET_SIZE_SCOPE, missingRoute);
  assert.equal(gate.status, 'coverage-incomplete');
  assert.equal(gate.pass, false);
  assert.equal(gate.comparisonPerformed, false);
});

test('A-06 baseline proposal requires a complete native report and remains explicitly unapproved', () => {
  const empty = targetSizeReportFixture();
  const zeroProposal = buildTargetSizeBaselineProposal(empty.report, empty.browserReport);
  assert.equal(zeroProposal.status, 'pending-human-review');
  assert.equal(zeroProposal.knownViolationCount, 0);
  assert.deepEqual(zeroProposal.entries, []);
  assert.equal(zeroProposal.approval, null);
  assert.equal(zeroProposal.source.workflowRunId, '39159143917');
  assert.equal(zeroProposal.source.artifactName, 'full-site-browser-qa');
  assert.equal(zeroProposal.source.runUrl, 'https://github.com/example/repo/actions/runs/39159143917');

  const finding = {
    route: 'index.html',
    viewportWidth: 390,
    viewportHeight: 844,
    scenario: 'core-page-default',
    selectors: ['.fixture-target'],
    measurementStatus: 'measured',
    measuredBoxesCssPx: [{ width: 18, height: 20, x: 0, y: 0 }],
    exceptionEvidence: { manualReview: 'Review WCAG 2.5.8 context.' },
  };
  const withFinding = targetSizeReportFixture({ violations: [finding] });
  const proposal = buildTargetSizeBaselineProposal(withFinding.report, withFinding.browserReport);
  assert.equal(proposal.entries.length, 1);
  assert.equal(proposal.entries[0].selectors[0], '.fixture-target');
  assert.deepEqual(proposal.entries[0].measuredBoxesCssPx, finding.measuredBoxesCssPx);
  assert.deepEqual(proposal.entries[0].exceptionReview, { status: 'pending', decision: null, note: null });

  const partial = targetSizeReportFixture();
  const partialCoverage = evaluateTargetSizeCoverage(expectedTargetSizeCoverage().slice(1));
  partial.report.coverage = partialCoverage;
  partial.browserReport.wcag22aaTargetSize.coverage = partialCoverage;
  assert.throws(() => buildTargetSizeBaselineProposal(partial.report, partial.browserReport), /complete, exact coverage/);
  const inconsistentGate = targetSizeReportFixture();
  inconsistentGate.report.gate.measurementFailures = [{ route: 'index.html' }];
  assert.throws(() => buildTargetSizeBaselineProposal(inconsistentGate.report, inconsistentGate.browserReport), /capture-pending candidate/);
  const unmeasurable = targetSizeReportFixture({ violations: [{ ...finding, measurementStatus: 'unresolved', measuredBoxesCssPx: [], measurementErrors: ['fixture error'] }] });
  assert.throws(() => buildTargetSizeBaselineProposal(unmeasurable.report, unmeasurable.browserReport), /unmeasurable or incomplete/);
  const failedBrowser = { ...empty.browserReport, status: 'Failed', failures: ['fixture failure'] };
  assert.throws(() => buildTargetSizeBaselineProposal(empty.report, failedBrowser), /browser report is failed/);
});

test('A-06 proposal fails closed on invalid Node or Playwright runtime provenance', () => {
  for (const nodeVersion of ['', ' ', 'unknown', null, 24, 'v24', 'v24.01.0']) {
    const fixture = targetSizeReportFixture();
    fixture.report.runtime.node = nodeVersion;
    assert.throws(
      () => buildTargetSizeBaselineProposal(fixture.report, fixture.browserReport),
      /runner tool or runtime provenance is incomplete/,
      `accepted invalid Node version ${JSON.stringify(nodeVersion)}`,
    );
  }

  for (const playwrightVersion of ['', ' ', 'unknown', null, 1.55, '1.55', '01.55.1']) {
    const fixture = targetSizeReportFixture();
    fixture.report.runtime.playwrightVersion = playwrightVersion;
    assert.throws(
      () => buildTargetSizeBaselineProposal(fixture.report, fixture.browserReport),
      /runner tool or runtime provenance is incomplete/,
      `accepted invalid Playwright version ${JSON.stringify(playwrightVersion)}`,
    );
  }

  const prerelease = targetSizeReportFixture();
  prerelease.report.runtime.node = 'v24.0.0-rc.1+build.2';
  prerelease.report.runtime.playwrightVersion = '1.56.0-beta.1+build.2';
  const proposal = buildTargetSizeBaselineProposal(prerelease.report, prerelease.browserReport);
  assert.equal(proposal.status, 'pending-human-review');
  assert.equal(proposal.knownViolationCount, 0);
  assert.equal(proposal.approval, null);
});
