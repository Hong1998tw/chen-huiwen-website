import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AXE_CORE_VERSION,
  AXE_PLAYWRIGHT_VERSION,
  CANDIDATE_TARGET_SIZE_SCOPE,
  evaluateTargetSizeCoverage,
  expectedTargetSizeCoverage,
} from './wcag22aa.mjs';

const SHA40 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const REPORT_SCHEMA = 'wcag22aa-target-size-report/v2';
const PROPOSAL_SCHEMA = 'wcag22aa-target-size-baseline-proposal/v1';

function sameCases(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalize = item => JSON.stringify([item.route, item.viewportWidth, item.viewportHeight, item.scenario]);
  const actualKeys = actual.map(normalize).sort();
  const expectedKeys = expected.map(normalize).sort();
  return actualKeys.every((key, index) => key === expectedKeys[index]);
}

function assertSource(source, tool, runtime) {
  if (!source || !SHA40.test(source.headSha ?? '') || source.headSha !== source.checkoutSha ||
      !SHA40.test(source.checkoutSha ?? '') || (source.eventHeadSha != null && !SHA40.test(source.eventHeadSha)) ||
      !/^\d+$/.test(source.workflowRunId ?? '') || source.artifactName !== 'full-site-browser-qa' ||
      typeof source.runUrl !== 'string' ||
      !new RegExp(`^https://github\\.com/[^/]+/[^/]+/actions/runs/${source.workflowRunId}/?$`).test(source.runUrl)) {
    throw new Error('The native CI run, artifact, URL, or source SHA provenance is missing or invalid.');
  }
  if (!tool || tool.entrypoint !== 'tests/donation/browser.mjs' || tool.gitHeadSha !== source.checkoutSha ||
      !SHA256.test(tool.scriptSha256 ?? '') || !runtime || runtime.node == null ||
      runtime.playwrightVersion == null || runtime.axePlaywrightVersion !== AXE_PLAYWRIGHT_VERSION ||
      runtime.axeCoreVersion !== AXE_CORE_VERSION || !String(runtime.chromiumVersion ?? '').trim()) {
    throw new Error('The A-06 runner tool or runtime provenance is incomplete.');
  }
}

function assertCoverage(coverage) {
  const expected = expectedTargetSizeCoverage();
  const recomputed = evaluateTargetSizeCoverage(coverage?.completed);
  if (!coverage || coverage.status !== 'complete' || coverage.complete !== true || !recomputed.complete ||
      !sameCases(coverage.expected, expected) || !sameCases(coverage.completed, expected) ||
      !Array.isArray(coverage.missing) || coverage.missing.length !== 0 ||
      !Array.isArray(coverage.unexpected) || coverage.unexpected.length !== 0 ||
      !Array.isArray(coverage.duplicates) || coverage.duplicates.length !== 0) {
    throw new Error('The report does not prove complete, exact coverage of all 15 core routes × 2 viewports.');
  }
  return coverage;
}

export function buildTargetSizeBaselineProposal(report, browserReport) {
  if (!report || report.schema !== REPORT_SCHEMA || report.mode !== 'capture-pending' ||
      report.scope !== CANDIDATE_TARGET_SIZE_SCOPE || report.baseline?.scope !== CANDIDATE_TARGET_SIZE_SCOPE ||
      report.baseline?.status !== 'pending-ci' || report.gate?.status !== 'capture-pending' ||
      report.gate?.comparisonPerformed !== false || report.baseline?.entries !== null ||
      report.baseline?.knownViolationCount !== null || report.axePlaywrightVersion !== AXE_PLAYWRIGHT_VERSION ||
      report.axeCoreVersion !== AXE_CORE_VERSION || report.baseline?.axePlaywrightVersion !== AXE_PLAYWRIGHT_VERSION ||
      report.baseline?.axeCoreVersion !== AXE_CORE_VERSION || report.gate?.knownBaselineCount !== null ||
      report.gate?.currentViolationCount !== report.violations?.length ||
      !Array.isArray(report.gate?.measurementFailures) ||
      report.gate?.measuredEntryCount !== report.counts?.measuredViolationCount ||
      report.gate?.measurementFailures.length !== report.counts?.unmeasurableViolationCount) {
    throw new Error('Only a capture-pending candidate A-06 report can produce a baseline proposal.');
  }
  const coverage = assertCoverage(report.coverage);
  if (!browserReport || browserReport.status !== 'Pending' || !Array.isArray(browserReport.failures) ||
      browserReport.failures.length !== 0 || report.run?.browserReportStatus !== browserReport.status ||
      report.run?.browserFailureCount !== browserReport.failures.length ||
      browserReport.wcag22aaTargetSize?.sourceHeadSha !== report.source?.headSha ||
      browserReport.wcag22aaTargetSize?.scope !== report.scope ||
      browserReport.wcag22aaTargetSize?.coverage?.complete !== true ||
      JSON.stringify(browserReport.wcag22aaTargetSize?.coverage?.expected) !== JSON.stringify(report.coverage?.expected) ||
      JSON.stringify(browserReport.wcag22aaTargetSize?.coverage?.completed) !== JSON.stringify(report.coverage?.completed) ||
      JSON.stringify(browserReport.wcag22aaTargetSize?.counts) !== JSON.stringify(report.counts) ||
      JSON.stringify(browserReport.wcag22aaTargetSize?.gate) !== JSON.stringify(report.gate)) {
    throw new Error('The companion browser report is failed, incomplete, or does not match the A-06 artifact.');
  }
  assertSource(report.source, report.tool, report.runtime);
  const violations = report.violations;
  const counts = report.counts;
  if (!Array.isArray(violations) || !counts || counts.expectedCaseCount !== coverage.expected.length ||
      counts.completedCaseCount !== coverage.completed.length || counts.axeTargetSizeViolationCount !== violations.length) {
    throw new Error('A-06 violation counts do not match the measured report.');
  }
  const unmeasurable = violations.filter(entry => entry?.measurementStatus !== 'measured');
  const measurementErrorCount = violations.reduce((sum, entry) => sum + (Array.isArray(entry.measurementErrors) ? entry.measurementErrors.length : 0), 0);
  if (counts.measuredViolationCount !== violations.length - unmeasurable.length ||
      counts.unmeasurableViolationCount !== unmeasurable.length || counts.measurementErrorCount !== measurementErrorCount ||
      unmeasurable.length !== 0 || measurementErrorCount !== 0 ||
      violations.some(entry => !Array.isArray(entry.selectors) || entry.selectors.length === 0 ||
        !Array.isArray(entry.measuredBoxesCssPx) || entry.measuredBoxesCssPx.length === 0 ||
        entry.measuredBoxesCssPx.some(box => !Number.isFinite(box.width) || !Number.isFinite(box.height)) ||
        !entry.exceptionEvidence || !entry.route || !Number.isInteger(entry.viewportWidth) ||
        !Number.isInteger(entry.viewportHeight) || !entry.scenario)) {
    throw new Error('A-06 contains an unmeasurable or incomplete target-size violation.');
  }
  const validCases = new Set(coverage.expected.map(item => JSON.stringify([item.route, item.viewportWidth, item.viewportHeight, item.scenario])));
  if (violations.some(entry => !validCases.has(JSON.stringify([entry.route, entry.viewportWidth, entry.viewportHeight, entry.scenario])))) {
    throw new Error('A-06 contains a violation outside the approved route, viewport, and scenario matrix.');
  }

  return {
    schema: PROPOSAL_SCHEMA,
    status: 'pending-human-review',
    approval: null,
    scope: report.scope,
    axePlaywrightVersion: report.axePlaywrightVersion,
    axeCoreVersion: report.axeCoreVersion,
    source: report.source,
    tool: report.tool,
    runtime: report.runtime,
    coverage,
    knownViolationCount: violations.length,
    entries: violations.map(entry => ({
      route: entry.route,
      viewportWidth: entry.viewportWidth,
      viewportHeight: entry.viewportHeight,
      scenario: entry.scenario,
      selectors: entry.selectors,
      impact: entry.impact ?? null,
      help: entry.help ?? null,
      helpUrl: entry.helpUrl ?? null,
      minimumTargetSizeCssPx: entry.minimumTargetSizeCssPx,
      measuredBoxesCssPx: entry.measuredBoxesCssPx,
      failureSummary: entry.failureSummary ?? null,
      exceptionEvidence: entry.exceptionEvidence,
      exceptionReview: { status: 'pending', decision: null, note: null },
    })),
    reviewInstructions: 'Verify the native CI run and artifact, inspect every axe finding and its WCAG 2.5.8 context, then decide whether any entry belongs in an approved baseline. This proposal is not an approved baseline.',
  };
}

async function readArtifactFile(artifactRoot, filename) {
  const rootInfo = await lstat(artifactRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Artifact directory must be a real directory.');
  const path = resolve(artifactRoot, filename);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Artifact member must be a regular file: ${filename}`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--artifact-dir', '--output'].includes(argument) || options[argument]) {
      throw new Error(`Unsupported or repeated option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path.`);
    options[argument] = value;
    index += 1;
  }
  if (!options['--artifact-dir']) throw new Error('Usage: node wcag22aa-baseline-proposal.mjs --artifact-dir EXTRACTED_ARTIFACT [--output NEW_PROPOSAL.json]');
  const artifactRoot = resolve(options['--artifact-dir']);
  const report = await readArtifactFile(artifactRoot, 'wcag22aa-target-size.json');
  const browserReport = await readArtifactFile(artifactRoot, 'browser-report.json');
  const proposal = buildTargetSizeBaselineProposal(report, browserReport);
  const bytes = `${JSON.stringify(proposal, null, 2)}\n`;
  if (!options['--output']) {
    process.stdout.write(bytes);
    return;
  }
  const outputPath = resolve(options['--output']);
  if (['wcag22aa-baseline.json', 'wcag22aa-production-baseline.json'].includes(basename(outputPath))) {
    throw new Error('A proposal cannot overwrite either active A-06 baseline file.');
  }
  const outputParent = dirname(outputPath);
  const parentInfo = await lstat(outputParent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || await realpath(outputParent) !== outputParent) {
    throw new Error('Proposal output parent must be an existing, non-symlink directory.');
  }
  await writeFile(outputPath, bytes, { flag: 'wx' });
  process.stdout.write(`Wrote pending proposal: ${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
