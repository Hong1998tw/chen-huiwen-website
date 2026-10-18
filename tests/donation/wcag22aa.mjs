import { readFile } from 'node:fs/promises';

export const WCAG22AA_TAGS = Object.freeze([
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
]);

export const TARGET_SIZE_RULE_ID = 'target-size';
export const TARGET_SIZE_MINIMUM_CSS_PX = Object.freeze({ width: 24, height: 24 });
export const AXE_PLAYWRIGHT_VERSION = '4.10.2';
export const AXE_CORE_VERSION = '4.10.3';
export const DEFAULT_TARGET_SIZE_MODE = 'capture-pending';
export const CANDIDATE_TARGET_SIZE_SCOPE = 'candidate-core-pages-15x2';
export const PRODUCTION_TARGET_SIZE_SCOPE = 'production-live-core-pages-default';
export const TARGET_SIZE_BASELINE_SCENARIO = 'core-page-default';
export const TARGET_SIZE_CORE_ROUTES = Object.freeze([
  'index.html',
  'about.html',
  'achievements.html',
  'vision.html',
  'news.html',
  'press.html',
  'activities.html',
  'gallery.html',
  'service.html',
  'petition.html',
  'political-donation.html',
  'election.html',
  '404.html',
  'offline.html',
  'achievement-wende-school-center.html',
]);
export const TARGET_SIZE_CORE_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 390, height: 844 }),
  Object.freeze({ width: 1440, height: 960 }),
]);

export function expectedTargetSizeCoverage() {
  return TARGET_SIZE_CORE_ROUTES.flatMap(route => TARGET_SIZE_CORE_VIEWPORTS.map(viewport => ({
    route,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scenario: TARGET_SIZE_BASELINE_SCENARIO,
  })));
}

function targetSizeCoverageKey(item) {
  return JSON.stringify([item?.route, item?.viewportWidth, item?.viewportHeight, item?.scenario]);
}

export function evaluateTargetSizeCoverage(completedCases) {
  const expected = expectedTargetSizeCoverage();
  const completed = Array.isArray(completedCases) ? completedCases.map(item => ({
    route: item?.route,
    viewportWidth: item?.viewportWidth,
    viewportHeight: item?.viewportHeight,
    scenario: item?.scenario,
  })) : [];
  const expectedKeys = new Set(expected.map(targetSizeCoverageKey));
  const completedCounts = new Map();
  for (const item of completed) {
    const key = targetSizeCoverageKey(item);
    completedCounts.set(key, (completedCounts.get(key) ?? 0) + 1);
  }
  const completedKeys = new Set(completedCounts.keys());
  const duplicates = completed.filter(item => completedCounts.get(targetSizeCoverageKey(item)) > 1);
  const missing = expected.filter(item => !completedKeys.has(targetSizeCoverageKey(item)));
  const unexpected = completed.filter(item => !expectedKeys.has(targetSizeCoverageKey(item)));
  const complete = completed.length === expected.length && missing.length === 0 && unexpected.length === 0 && duplicates.length === 0;
  return {
    status: complete ? 'complete' : 'incomplete',
    complete,
    expected,
    completed,
    missing,
    unexpected,
    duplicates,
  };
}

const BASELINE_SCHEMA = 'wcag22aa-target-size-baseline/v1';

export function resolveTargetSizeMode(value) {
  const mode = value ?? DEFAULT_TARGET_SIZE_MODE;
  if (!['capture-pending', 'compare'].includes(mode)) {
    throw new Error('WCAG22AA_TARGET_SIZE_MODE must be exactly "capture-pending" or "compare".');
  }
  return mode;
}

export function nonTargetAxeViolations(violations, impacts = null) {
  return (violations ?? []).filter(violation =>
    violation.id !== TARGET_SIZE_RULE_ID && (!impacts || impacts.includes(violation.impact)));
}

export async function readTargetSizeBaseline(url = new URL('./wcag22aa-baseline.json', import.meta.url)) {
  return JSON.parse(await readFile(url, 'utf8'));
}

function normalizedSelectors(value) {
  if (Array.isArray(value)) {
    return value.map(item => Array.isArray(item) ? normalizedSelectors(item) : String(item));
  }
  return value == null ? null : String(value);
}

export function targetSizeFingerprint(entry) {
  return JSON.stringify([
    String(entry.route ?? ''),
    Number(entry.viewportWidth),
    String(entry.scenario ?? 'default'),
    normalizedSelectors(entry.selectors ?? entry.target),
  ]);
}

function approvedBaselineProblem(baseline, requiredScope) {
  if (!baseline || baseline.schema !== BASELINE_SCHEMA || baseline.status !== 'approved') {
    return 'No approved real-browser WCAG 2.2 target-size baseline is available.';
  }
  if (!requiredScope || baseline.scope !== requiredScope) {
    return `Approved baseline scope must exactly match ${requiredScope || 'the current runner scope'}.`;
  }
  if (!Array.isArray(baseline.entries)) {
    return 'Approved baseline entries must be an array, including an explicit empty array for zero findings.';
  }
  if (new Set(baseline.entries.map(targetSizeFingerprint)).size !== baseline.entries.length) {
    return 'Approved baseline contains duplicate route, viewport, scenario, and selector entries.';
  }
  if (baseline.axePlaywrightVersion !== AXE_PLAYWRIGHT_VERSION || baseline.axeCoreVersion !== AXE_CORE_VERSION) {
    return `Baseline axe versions do not match @axe-core/playwright ${AXE_PLAYWRIGHT_VERSION} / axe-core ${AXE_CORE_VERSION}.`;
  }
  const source = baseline.source;
  if (!source || !/^[0-9a-f]{40}$/i.test(String(source.headSha ?? '')) ||
      !String(source.workflowRunId ?? '').trim() || !String(source.artifactName ?? '').trim() ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(String(source.runUrl ?? ''))) {
    return 'Baseline approval requires a source head SHA, workflow run ID, artifact name, and run URL.';
  }
  const unreviewed = baseline.entries.filter(entry =>
    entry.exceptionReview?.status !== 'reviewed' ||
    !['applicable-exception', 'no-applicable-exception', 'needs-fix'].includes(entry.exceptionReview?.decision) ||
    !String(entry.exceptionReview?.note ?? '').trim());
  if (unreviewed.length) {
    return 'Every accepted baseline finding requires a human-reviewed WCAG 2.5.8 exception decision and note.';
  }
  return null;
}

export function evaluateTargetSizeBaseline(baseline, currentEntries, { requiredScope } = {}) {
  const current = Array.isArray(currentEntries) ? currentEntries : [];
  const measurementFailures = current.filter(entry => entry.measurementStatus !== 'measured');
  const baselineProblem = approvedBaselineProblem(baseline, requiredScope);
  if (baselineProblem) {
    return {
      status: 'baseline-pending',
      pass: false,
      reason: baselineProblem,
      knownBaselineCount: null,
      currentViolationCount: current.length,
      newViolations: [],
      resolvedViolations: [],
      measurementFailures: measurementFailures.map(entry => ({
        route: entry.route,
        viewportWidth: entry.viewportWidth,
        selectors: entry.selectors,
        measurementStatus: entry.measurementStatus,
        measurementErrors: entry.measurementErrors ?? [],
      })),
    };
  }

  const baselineByFingerprint = new Map(baseline.entries.map(entry => [targetSizeFingerprint(entry), entry]));
  const currentByFingerprint = new Map(current.map(entry => [targetSizeFingerprint(entry), entry]));
  const newViolations = [...currentByFingerprint]
    .filter(([fingerprint]) => !baselineByFingerprint.has(fingerprint))
    .map(([, entry]) => entry);
  const resolvedViolations = [...baselineByFingerprint]
    .filter(([fingerprint]) => !currentByFingerprint.has(fingerprint))
    .map(([, entry]) => entry);

  let status = 'pass';
  let reason = null;
  if (measurementFailures.length) {
    status = 'measurement-incomplete';
    reason = 'One or more target-size nodes could not be measured in the browser report.';
  } else if (newViolations.length && resolvedViolations.length) {
    status = 'new-and-resolved';
    reason = 'New target-size nodes appeared and previously baselined nodes were cleared; update and review the baseline.';
  } else if (newViolations.length) {
    status = 'new-violations';
    reason = 'Target-size findings exceed the approved selector-and-viewport baseline.';
  } else if (resolvedViolations.length) {
    status = 'baseline-cleanup-required';
    reason = 'Previously baselined target-size findings were cleared; remove them from the baseline before passing.';
  }

  return {
    status,
    pass: status === 'pass',
    reason,
    baselineSource: baseline.source,
    knownBaselineCount: baseline.entries.length,
    currentViolationCount: current.length,
    newViolations,
    resolvedViolations,
    measurementFailures: measurementFailures.map(entry => ({
      route: entry.route,
      viewportWidth: entry.viewportWidth,
      selectors: entry.selectors,
      measurementStatus: entry.measurementStatus,
      measurementErrors: entry.measurementErrors ?? [],
    })),
  };
}

function measurementFailureEvidence(current) {
  return current.filter(entry => entry.measurementStatus !== 'measured').map(entry => ({
    route: entry.route,
    viewportWidth: entry.viewportWidth,
    selectors: entry.selectors,
    measurementStatus: entry.measurementStatus,
    measurementErrors: entry.measurementErrors ?? [],
    measurementAttempts: entry.measurementAttempts ?? [],
  }));
}

export function evaluateTargetSizeGate(mode, baseline, currentEntries, requiredScope, coverage = null) {
  const resolvedMode = resolveTargetSizeMode(mode);
  const current = Array.isArray(currentEntries) ? currentEntries : [];
  if (coverage && coverage.complete !== true) {
    return {
      mode: resolvedMode,
      status: 'coverage-incomplete',
      pass: false,
      comparisonPerformed: false,
      reason: 'The expected route, viewport, and scenario matrix was not completed exactly.',
      knownBaselineCount: null,
      currentViolationCount: current.length,
      measuredEntryCount: current.filter(entry => entry.measurementStatus === 'measured').length,
      measurementFailures: measurementFailureEvidence(current),
    };
  }
  if (resolvedMode === 'capture-pending') {
    return {
      mode: resolvedMode,
      status: 'capture-pending',
      pass: null,
      comparisonPerformed: false,
      reason: 'Capture-pending records current axe and selector evidence; no approved-baseline comparison is claimed.',
      knownBaselineCount: null,
      currentViolationCount: current.length,
      measuredEntryCount: current.filter(entry => entry.measurementStatus === 'measured').length,
      measurementFailures: measurementFailureEvidence(current),
    };
  }

  return {
    ...evaluateTargetSizeBaseline(baseline, current, { requiredScope }),
    mode: resolvedMode,
    comparisonPerformed: true,
  };
}

export function axeSelectorCandidates(target) {
  const isCompleteSingleSelector = selector =>
    typeof selector === 'string' && selector.trim() && !selector.includes('>>');
  if (isCompleteSingleSelector(target)) return [[target]];
  if (Array.isArray(target) && target.length === 1 && isCompleteSingleSelector(target[0])) {
    return [[target[0]]];
  }
  return [];
}

function playwrightSelectorPart(selector) {
  if (/^(css|xpath|text|role|id|data-testid|data-test-id)=/.test(selector)) return selector;
  return selector.startsWith('/') ? `xpath=${selector}` : `css=${selector}`;
}

function summarizeCheck(check) {
  return {
    id: check.id ?? null,
    impact: check.impact ?? null,
    message: check.message ?? null,
    data: check.data ?? null,
    relatedTargets: Array.isArray(check.relatedNodes)
      ? check.relatedNodes.map(node => node.target ?? null)
      : [],
  };
}

function exceptionEvidence(node) {
  return {
    interpretation: 'Axe check evidence only; it does not decide every WCAG 2.5.8 exception or establish conformance.',
    manualReview: 'Review applicable WCAG 2.5.8 exceptions against the rendered control and its context.',
    checks: Object.fromEntries(['any', 'all', 'none'].map(group => [
      group,
      Array.isArray(node[group]) ? node[group].map(summarizeCheck) : [],
    ])),
  };
}

async function measureSelectors(page, selectors) {
  const attempts = [];
  const candidates = axeSelectorCandidates(selectors);
  if (!candidates.length) {
    return {
      status: 'unresolved',
      attempts,
      boxes: [],
      errors: ['Axe target is not a complete single selector; compound frame/shadow paths are not measured.'],
    };
  }
  for (const path of candidates) {
    const locatorSelector = path.map(playwrightSelectorPart).join(' >> ');
    try {
      const locator = page.locator(locatorSelector);
      const count = await locator.count();
      const boxes = [];
      for (let index = 0; index < Math.min(count, 10); index += 1) {
        const box = await locator.nth(index).boundingBox();
        if (box) boxes.push({
          width: Number(box.width.toFixed(2)),
          height: Number(box.height.toFixed(2)),
          x: Number(box.x.toFixed(2)),
          y: Number(box.y.toFixed(2)),
        });
      }
      attempts.push({ path, matchedElements: count, boxes });
      if (boxes.length) return { status: 'measured', attempts, boxes };
    } catch (error) {
      attempts.push({ path, error: String(error) });
    }
  }
  return {
    status: 'unresolved',
    attempts,
    boxes: [],
    errors: ['No measurable element matched the complete axe target selector.'],
  };
}

export async function collectTargetSizeDiagnostics(page, route, viewportWidth, axeViolations, scenario = 'default', viewportHeight = null) {
  const rule = (axeViolations ?? []).find(violation => violation.id === TARGET_SIZE_RULE_ID);
  if (!rule) return [];

  const entries = [];
  for (const node of rule.nodes ?? []) {
    const measured = await measureSelectors(page, node.target);
    entries.push({
      route,
      viewportWidth,
      ...(Number.isInteger(viewportHeight) ? { viewportHeight } : {}),
      scenario,
      selectors: node.target ?? null,
      selectorCandidates: axeSelectorCandidates(node.target),
      impact: node.impact ?? rule.impact ?? null,
      help: rule.help ?? null,
      helpUrl: rule.helpUrl ?? null,
      minimumTargetSizeCssPx: TARGET_SIZE_MINIMUM_CSS_PX,
      measuredBoxesCssPx: measured.boxes,
      measurementStatus: measured.status,
      measurementAttempts: measured.attempts,
      measurementErrors: measured.errors ?? [],
      failureSummary: node.failureSummary ?? null,
      exceptionEvidence: exceptionEvidence(node),
    });
  }
  return entries;
}

export function targetSizeGateMessage(result) {
  const baseline = result.knownBaselineCount == null ? 'unknown' : result.knownBaselineCount;
  return `WCAG 2.2 target-size gate ${result.status} (mode=${result.mode ?? 'compare'}): current=${result.currentViolationCount}, approved baseline=${baseline}. ${result.reason ?? ''} See the wcag22aa-target-size.json CI artifact.`.trim();
}
