import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  compareCaptureConditions,
  comparePngBuffers,
  resolveCapturePath,
  sha256,
} from './visual-qa-lib.mjs';
import {
  siteSourceKind,
  validatePublicationManifestRecord,
  validateSiteSourceKindRecord,
} from './visual-qa-publication.mjs';

const SHA40 = /^[a-f0-9]{40}$/i;
const SHA64 = /^[a-f0-9]{64}$/i;
const EXPECTED_CAPTURE_COUNT = 30;
const MEASUREMENT_LIMITS = Object.freeze({
  sameOriginTransferSizeBytes: 300000,
  domElementCount: 1500,
});

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function pathsOverlap(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

async function regularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular, non-symlink file.`);
  return info;
}

async function readCaptureManifest(manifestPath, expectedIds) {
  const absoluteManifestPath = resolve(manifestPath);
  await regularFile(absoluteManifestPath, 'Capture manifest');
  const manifestDirectory = await realpath(dirname(absoluteManifestPath));
  const canonicalManifestPath = resolve(manifestDirectory, absoluteManifestPath.split(sep).at(-1));
  const manifestBytes = await readFile(canonicalManifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const sidecarPath = resolve(manifestDirectory, 'manifest.sha256');
  await regularFile(sidecarPath, 'Manifest SHA-256 sidecar');
  const sidecar = (await readFile(sidecarPath, 'utf8')).trim();
  const match = /^([a-f0-9]{64})  manifest\.json$/.exec(sidecar);
  if (!match || match[1] !== sha256(manifestBytes)) throw new Error('Capture manifest SHA-256 sidecar does not match its contents.');

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schemaVersion !== 3 || manifest.status !== 'CAPTURE_ONLY' ||
      manifest.environment !== 'local-http-uncompressed' || manifest.approval !== null ||
      manifest.baselineApproval !== null || !Array.isArray(manifest.exceptions) || manifest.exceptions.length !== 0 ||
      manifest.counts?.captures !== EXPECTED_CAPTURE_COUNT || manifest.counts?.screenshots !== EXPECTED_CAPTURE_COUNT ||
      manifest.counts?.failedCaptures !== 0 || manifest.counts?.environmentVerificationFailures !== 0 ||
      !Array.isArray(manifest.captures) || manifest.captures.length !== EXPECTED_CAPTURE_COUNT) {
    throw new Error('Capture manifest is not a complete, unapproved A-05 local CAPTURE_ONLY bundle.');
  }
  const siteSourceSHA = manifest.siteSourceSHA;
  const captureToolSHA = manifest.captureToolSHA;
  if (!SHA40.test(manifest.sourceSHA ?? '') || manifest.sourceSHA !== siteSourceSHA ||
      !SHA40.test(captureToolSHA ?? '') || manifest.checkoutSHA !== captureToolSHA) {
    throw new Error('Capture manifest source and capture-tool identities are missing or inconsistent.');
  }
  const ids = new Set();
  for (const capture of manifest.captures) {
    if (!capture || typeof capture !== 'object' || typeof capture.id !== 'string' ||
        !expectedIds.has(capture.id) || ids.has(capture.id)) {
      throw new Error('Capture manifest does not contain the exact unique policy capture IDs.');
    }
    ids.add(capture.id);
  }
  if (ids.size !== expectedIds.size || [...expectedIds].some(id => !ids.has(id))) {
    throw new Error('Capture manifest is missing one or more policy captures.');
  }
  return { manifestPath: canonicalManifestPath, manifest };
}

function expectedCaptureRecords(policy) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.routes) || !Array.isArray(policy.viewports) ||
      policy.routes.length !== 15 || policy.viewports.length !== 2 ||
      policy.budgets?.sameOriginTransferSizeBytes !== MEASUREMENT_LIMITS.sameOriginTransferSizeBytes ||
      policy.budgets?.domElementCount !== MEASUREMENT_LIMITS.domElementCount) {
    throw new Error('A-05 visual policy does not match the fixed 15-route × 2-viewport capture set.');
  }
  const expected = new Map();
  for (const route of policy.routes) {
    for (const viewport of policy.viewports) {
      const id = `${route.id}-${viewport.width}`;
      if (expected.has(id)) throw new Error('A-05 policy contains duplicate capture IDs.');
      expected.set(id, { route, viewport });
    }
  }
  if (expected.size !== EXPECTED_CAPTURE_COUNT) throw new Error('A-05 policy does not define exactly 30 captures.');
  return expected;
}

async function verifyCaptureFiles(manifestPath, capture, expected, manifest) {
  const { route, viewport } = expected;
  const manifestSourceKind = siteSourceKind(manifest);
  const captureSourceKind = siteSourceKind(capture);
  if (capture.routeId !== route.id || capture.routePath !== route.path || capture.template !== route.template ||
      stableStringify(capture.viewport) !== stableStringify(viewport) || capture.environment !== 'local-http-uncompressed' ||
      capture.sourceSHA !== manifest.sourceSHA || capture.siteSourceSHA !== manifest.siteSourceSHA ||
      captureSourceKind !== manifestSourceKind ||
      !validateSiteSourceKindRecord(capture, manifest.sourceSHA) ||
      (manifestSourceKind === 'publication' && (capture.sourceGitSHA !== manifest.sourceGitSHA ||
        capture.servedRootRole !== 'publication-artifact' ||
        stableStringify(capture.publicationArtifact) !== stableStringify(manifest.publicationArtifact) ||
        stableStringify(capture.publicationPayloads) !== stableStringify(manifest.publicationPayloads))) ||
      capture.captureToolSHA !== manifest.captureToolSHA || capture.checkoutSHA !== manifest.captureToolSHA ||
      capture.screenshotEnabled !== true || capture.screenshotPath !== `${capture.id}.png` ||
      capture.metadataPath !== `${capture.id}.json` || !SHA64.test(capture.screenshotSha256 ?? '') ||
      !SHA64.test(capture.metadataSha256 ?? '') || capture.captureQuality?.status !== 'COMPLETE' ||
      capture.environmentVerification?.status !== 'VERIFIED' || capture.environmentVerification?.requestedMode !== 'local-http-uncompressed' ||
      capture.environmentVerification?.documentContentEncoding !== 'identity' || !capture.environmentVerification?.encodingValid ||
      !capture.conditions || capture.conditions.locale !== 'zh-TW' || capture.conditions.timezoneId !== 'Asia/Taipei' ||
      capture.conditions.fixedDate !== manifest.policy?.captureConditions?.fixedDate ||
      capture.conditions.deviceScaleFactor !== manifest.policy?.captureConditions?.deviceScaleFactor ||
      capture.conditions.reducedMotion !== manifest.policy?.captureConditions?.reducedMotion ||
      capture.conditions.serviceWorkers !== 'blocked' || capture.conditions.browserCache !== 'disabled per context' ||
      capture.conditions.fontsReady !== true || capture.conditions.animationsFinished !== true ||
      stableStringify(capture.conditions.dynamicMasks) !== stableStringify(manifest.policy?.captureConditions?.dynamicMasks) ||
      capture.initialRequest !== manifest.policy?.captureConditions?.initialRequest) {
    throw new Error(`Capture identity, route, viewport, or measurement conditions are invalid: ${capture.id}`);
  }
  for (const metric of Object.keys(MEASUREMENT_LIMITS)) {
    if (!Number.isFinite(capture.metrics?.[metric]) || capture.metrics[metric] < 0) {
      throw new Error(`Capture metric is missing or invalid: ${capture.id}:${metric}`);
    }
  }
  if (![
    'PerformanceResourceTiming.transferSize including navigation',
    'CDP.Network.loadingFinished.encodedDataLength fallback; PerformanceResourceTiming returned zero',
  ].includes(capture.metrics.sameOriginTransferSizeSource)) {
    throw new Error(`Capture transfer measurement source is not comparable: ${capture.id}`);
  }
  const screenshotPath = resolveCapturePath(manifestPath, capture.screenshotPath);
  const metadataPath = resolveCapturePath(manifestPath, capture.metadataPath);
  await regularFile(screenshotPath, `Screenshot ${capture.id}`);
  await regularFile(metadataPath, `Metadata ${capture.id}`);
  const screenshotBytes = await readFile(screenshotPath);
  if (sha256(screenshotBytes) !== capture.screenshotSha256) throw new Error(`Screenshot hash mismatch: ${capture.id}`);
  const metadataBytes = await readFile(metadataPath);
  if (sha256(metadataBytes) !== capture.metadataSha256) throw new Error(`Metadata hash mismatch: ${capture.id}`);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const expectedMetadata = { ...capture };
  delete expectedMetadata.metadataSha256;
  if (stableStringify(metadata) !== stableStringify(expectedMetadata)) {
    throw new Error(`Capture metadata does not exactly match its manifest record: ${capture.id}`);
  }
  return screenshotBytes;
}

function verifyComparableManifests(reference, candidate) {
  const referenceManifest = reference.manifest;
  const candidateManifest = candidate.manifest;
  const referenceKind = siteSourceKind(referenceManifest);
  const candidateKind = siteSourceKind(candidateManifest);
  if (referenceKind !== candidateKind) {
    throw new Error('Cross-source review cannot mix Git canonical-root captures with publication-artifact captures.');
  }
  if (!['git-canonical-root', 'publication'].includes(referenceKind) ||
      !validateSiteSourceKindRecord(referenceManifest, referenceManifest.sourceSHA) ||
      !validateSiteSourceKindRecord(candidateManifest, candidateManifest.sourceSHA)) {
    throw new Error('Cross-source review contains an unsupported or inconsistent site-source kind.');
  }
  if (siteSourceKind(referenceManifest) === 'publication' &&
      (!validatePublicationManifestRecord(referenceManifest) || !validatePublicationManifestRecord(candidateManifest))) {
    throw new Error('Publication-artifact capture provenance is incomplete or inconsistent.');
  }
  if (referenceManifest.sourceSHA === candidateManifest.sourceSHA) {
    throw new Error('Cross-source review requires different site-source SHAs.');
  }
  if (candidateManifest.sourceSHA !== candidateManifest.captureToolSHA ||
      candidateManifest.sourceSHA !== candidateManifest.checkoutSHA) {
    throw new Error('Candidate site source must be the clean capture-tool checkout.');
  }
  if (referenceManifest.captureToolSHA !== candidateManifest.captureToolSHA ||
      referenceManifest.checkoutSHA !== candidateManifest.checkoutSHA) {
    throw new Error('Reference and candidate must use the same capture-tool checkout.');
  }
  for (const key of ['toolVersions', 'policy', 'comparisonPolicy']) {
    if (stableStringify(referenceManifest[key]) !== stableStringify(candidateManifest[key])) {
      throw new Error(`Reference and candidate capture ${key} are not identical.`);
    }
  }
  const versions = candidateManifest.toolVersions;
  if (!versions || !String(versions.visualQaRunner ?? '').trim() || !String(versions.node ?? '').trim() ||
      !String(versions.playwright ?? '').trim() || !String(versions.pixelmatch ?? '').trim() ||
      !String(versions.chromium ?? '').trim()) {
    throw new Error('Capture tool and runtime versions are incomplete.');
  }
  const comparisonPolicy = candidateManifest.comparisonPolicy;
  if (!Number.isFinite(comparisonPolicy?.pixelThreshold) || !Number.isFinite(comparisonPolicy?.maxDiffRatio) ||
      comparisonPolicy.maxDiffRatio < 0 || comparisonPolicy.maxDiffRatio > 1) {
    throw new Error('A-05 pixel comparison policy is invalid.');
  }
  if (candidateManifest.policy?.routeCount !== 15 || candidateManifest.policy?.viewportCount !== 2 ||
      candidateManifest.policy?.expectedCaptureCount !== EXPECTED_CAPTURE_COUNT) {
    throw new Error('A-05 capture manifest does not claim the exact 15-route × 2-viewport policy.');
  }
}

async function createOutputDirectory(outputDir, referenceManifestPath, candidateManifestPath) {
  const requested = resolve(outputDir);
  const parent = await realpath(dirname(requested));
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('Cross-source output parent must be a real directory.');
  const outputPath = resolve(parent, requested.split(sep).at(-1));
  for (const sourcePath of [dirname(referenceManifestPath), dirname(candidateManifestPath)]) {
    if (pathsOverlap(outputPath, sourcePath)) throw new Error('Cross-source output directory must be separate from both capture bundles.');
  }
  try {
    await lstat(outputPath);
    throw new Error('Cross-source output directory must not already exist.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(outputPath);
  return outputPath;
}

export async function createCrossSourceReview({ candidateManifestPath, referenceManifestPath, outputDir, policyPath = new URL('./visual-qa-policy.json', import.meta.url) }) {
  if (!candidateManifestPath || !referenceManifestPath || !outputDir) {
    throw new Error('Cross-source review requires candidate manifest, reference manifest, and a new output directory.');
  }
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const expected = expectedCaptureRecords(policy);
  const expectedIds = new Set(expected.keys());
  const [reference, candidate] = await Promise.all([
    readCaptureManifest(referenceManifestPath, expectedIds),
    readCaptureManifest(candidateManifestPath, expectedIds),
  ]);
  verifyComparableManifests(reference, candidate);
  const referenceById = new Map(reference.manifest.captures.map(capture => [capture.id, capture]));
  const candidateById = new Map(candidate.manifest.captures.map(capture => [capture.id, capture]));
  const reviewedCaptures = [];
  for (const [id, expectedCapture] of expected) {
    const referenceCapture = referenceById.get(id);
    const candidateCapture = candidateById.get(id);
    const condition = compareCaptureConditions(candidateCapture, referenceCapture);
    if (!condition.comparable) throw new Error(`Capture conditions are not comparable for ${id}: ${condition.reason}`);
    if (stableStringify(referenceCapture.conditions) !== stableStringify(candidateCapture.conditions)) {
      const normalizeConditions = item => {
        const copy = { ...item };
        delete copy.activeAnimationsStabilized;
        return copy;
      };
      if (stableStringify(normalizeConditions(referenceCapture.conditions)) !== stableStringify(normalizeConditions(candidateCapture.conditions))) {
        throw new Error(`Fixed capture conditions differ for ${id}.`);
      }
    }
    const [referencePng, candidatePng] = await Promise.all([
      verifyCaptureFiles(reference.manifestPath, referenceCapture, expectedCapture, reference.manifest),
      verifyCaptureFiles(candidate.manifestPath, candidateCapture, expectedCapture, candidate.manifest),
    ]);
    const pixels = comparePngBuffers(referencePng, candidatePng, candidate.manifest.comparisonPolicy);
    if (pixels.baselineDimensions?.width !== expectedCapture.viewport.width ||
        pixels.baselineDimensions?.height !== expectedCapture.viewport.height) {
      throw new Error(`Screenshot dimensions do not match the captured viewport for ${id}.`);
    }
    const metrics = Object.entries(MEASUREMENT_LIMITS).map(([metric, limit]) => {
      const referenceValue = referenceCapture.metrics[metric];
      const candidateValue = candidateCapture.metrics[metric];
      return {
        metric,
        limit,
        reference: referenceValue,
        candidate: candidateValue,
        delta: candidateValue - referenceValue,
        newRegression: candidateValue > referenceValue,
        referenceOverBudget: referenceValue > limit,
        candidateOverBudget: candidateValue > limit,
        existingDebtContinues: referenceValue > limit && candidateValue > limit && candidateValue <= referenceValue,
      };
    });
    reviewedCaptures.push({
      diffPng: pixels.diffPng,
      entry: {
        id,
        route: expectedCapture.route.path,
        viewport: expectedCapture.viewport,
        reference: { sourceSHA: referenceCapture.sourceSHA, screenshotSha256: referenceCapture.screenshotSha256 },
        candidate: { sourceSHA: candidateCapture.sourceSHA, screenshotSha256: candidateCapture.screenshotSha256 },
        pixelReview: {
          withinConfiguredThreshold: pixels.status === 'PASS',
          reason: pixels.reason,
          baselineDimensions: pixels.baselineDimensions,
          candidateDimensions: pixels.candidateDimensions,
          changedPixels: pixels.changedPixels,
          changedRatio: pixels.changedRatio,
          maxDiffRatio: pixels.maxDiffRatio,
          pixelThreshold: pixels.pixelThreshold,
          diffPath: `pixel-diffs/${id}.diff.png`,
        },
        metrics,
      },
    });
  }
  const outputRoot = await createOutputDirectory(outputDir, reference.manifestPath, candidate.manifestPath);
  const diffDirectory = resolve(outputRoot, 'pixel-diffs');
  await mkdir(diffDirectory);
  for (const { entry, diffPng } of reviewedCaptures) {
    await writeFile(resolve(diffDirectory, `${entry.id}.diff.png`), diffPng, { flag: 'wx' });
  }
  const captures = reviewedCaptures.map(item => item.entry);
  const metricRows = captures.flatMap(capture => capture.metrics);
  const report = {
    schemaVersion: 1,
    status: 'CROSS_SOURCE_REVIEW',
    reviewRequired: true,
    comparisonPerformed: true,
    pass: null,
    approval: null,
    baselineSelected: false,
    scope: '15-route × 2-viewport A-05 independent source comparison',
    source: {
      reference: {
        sourceSHA: reference.manifest.sourceSHA,
        sourceGitSHA: reference.manifest.sourceGitSHA ?? reference.manifest.sourceSHA,
        siteSourceKind: siteSourceKind(reference.manifest),
        servedRootRole: reference.manifest.servedRootRole ?? 'git-canonical-root',
        captureToolSHA: reference.manifest.captureToolSHA,
        publicationArtifact: reference.manifest.publicationArtifact ?? null,
      },
      candidate: {
        sourceSHA: candidate.manifest.sourceSHA,
        sourceGitSHA: candidate.manifest.sourceGitSHA ?? candidate.manifest.sourceSHA,
        siteSourceKind: siteSourceKind(candidate.manifest),
        servedRootRole: candidate.manifest.servedRootRole ?? 'git-canonical-root',
        captureToolSHA: candidate.manifest.captureToolSHA,
        publicationArtifact: candidate.manifest.publicationArtifact ?? null,
      },
      toolVersions: candidate.manifest.toolVersions,
      artifactPaths: {
        referenceManifest: reference.manifestPath,
        candidateManifest: candidate.manifestPath,
      },
    },
    summary: {
      captureCount: captures.length,
      pixelThresholdExceededCount: captures.filter(item => !item.pixelReview.withinConfiguredThreshold).length,
      capturesWithPixelChanges: captures.filter(item => item.pixelReview.changedPixels > 0).length,
      newMetricRegressionCount: metricRows.filter(item => item.newRegression).length,
      candidateOverBudgetMetricCount: metricRows.filter(item => item.candidateOverBudget).length,
      continuingOverBudgetDebtCount: metricRows.filter(item => item.existingDebtContinues).length,
      exceptionAppliedCount: 0,
    },
    reviewInstructions: 'This report compares independent site captures for human review. It does not approve or select a golden baseline, apply exceptions, or declare a QA pass.',
    captures,
  };
  await writeFile(resolve(outputRoot, 'cross-source-review.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}
