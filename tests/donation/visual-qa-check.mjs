import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  compareMetrics,
  compareCaptureConditions,
  comparePngBuffers,
  cloudflareEncodingEvidence,
  deploymentEvidence,
  evaluateCaptureQuality,
  readApprovedBaseline,
  readGitBaselineSelection,
  sha256,
  validateBaselineExceptions
} from './visual-qa-lib.mjs';
import { assertAllowedOptions, protectReadOnlyBaseSource, resolveCaptureRoots } from './visual-qa-identity.mjs';
import { createCrossSourceReview } from './visual-qa-cross-compare.mjs';
import {
  combineCaptureAndIntegrityErrors,
  combineCaptureAndSourceIntegrityErrors,
  createMetadataPathRegistry,
  invalidateSourceMetadata,
  prepareCaptureOutput,
  writeCaptureMetadata,
} from './visual-qa-source-integrity.mjs';
import {
  assertSamePublicationArtifact,
  publicationMetadataIdentity,
  validatePublicationArtifact,
  validatePublicationIdentityRecord,
} from './visual-qa-publication.mjs';

function png(width, height, color) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = color[0];
    image.data[index + 1] = color[1];
    image.data[index + 2] = color[2];
    image.data[index + 3] = color[3] ?? 255;
  }
  return PNG.sync.write(image);
}

function stableStringifyFixture(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringifyFixture).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringifyFixture(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvedManifest(overrides = {}) {
  const sourceSHA = 'a'.repeat(40);
  const captures = Array.from({ length: 30 }, (_, index) => ({
    id: `capture-${index}`,
    sourceSHA,
    siteSourceSHA: sourceSHA,
    captureToolSHA: sourceSHA,
    checkoutSHA: sourceSHA,
    screenshotPath: `capture-${index}.png`,
    metadataPath: `capture-${index}.json`,
    screenshotSha256: 'b'.repeat(64),
    metadataSha256: 'c'.repeat(64),
    environmentLabel: 'local-http-identity',
    measurementScope: 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot',
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120, sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation' }
  }));
  return {
    schemaVersion: 3,
    status: 'APPROVED',
    sourceSHA,
    siteSourceSHA: sourceSHA,
    captureToolSHA: sourceSHA,
    checkoutSHA: sourceSHA,
    approval: { reviewedBy: 'independent-controller', reviewedAt: '2026-10-18T00:00:00+08:00', note: 'Independently inspected baseline.' },
    comparisonPolicy: { pixelThreshold: 0.1, maxDiffRatio: 0.005 },
    exceptions: [],
    captures,
    ...overrides
  };
}

function gitAtFixture(repositoryRoot, args) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initRepositoryFixture(repositoryRoot) {
  await mkdir(repositoryRoot, { recursive: true });
  gitAtFixture(repositoryRoot, ['init', '-q']);
  gitAtFixture(repositoryRoot, ['config', 'user.name', 'A05 fixture']);
  gitAtFixture(repositoryRoot, ['config', 'user.email', 'a05-fixture@example.invalid']);
}

function commitFixtureRepository(repositoryRoot) {
  gitAtFixture(repositoryRoot, ['add', '.']);
  gitAtFixture(repositoryRoot, ['commit', '-q', '-m', 'fixture checkout']);
}

async function createMinimalPublicationArtifact(artifactRoot, sourceSHA, payloads = { 'index.html': '<main>published</main>\n' }, options = {}) {
  await mkdir(artifactRoot, { recursive: true });
  const payloadHashes = {};
  for (const [path, value] of Object.entries(payloads)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const target = join(artifactRoot, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    payloadHashes[path] = sha256(bytes);
  }
  const publication = { version: 1, publicRecordCount: 1, files: payloadHashes };
  const manifestBytes = Buffer.from(`${JSON.stringify(publication, null, 2)}\n`);
  await writeFile(join(artifactRoot, 'publication-manifest.json'), manifestBytes);
  const deployment = {
    schemaVersion: 1,
    provider: 'cloudflare-static-assets',
    sourceCommit: options.sourceCommit ?? sourceSHA,
    publicArtifactDigest: options.publicArtifactDigest ?? sha256(manifestBytes),
    publicFileCount: options.publicFileCount ?? Object.keys(payloadHashes).length,
    publicRecordCount: 1,
  };
  await writeFile(join(artifactRoot, 'deployment.json'), `${JSON.stringify(deployment)}\n`);
  await writeFile(join(artifactRoot, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
  await writeFile(join(artifactRoot, '_redirects'), '/ /index.html 200\n');
  return { publication, deployment, manifestBytes };
}

async function writeGitBaseline(repositoryRoot, sourceSHA = 'd'.repeat(40), captureToolSHA = sourceSHA) {
  const baselineRoot = join(repositoryRoot, 'tests', 'baselines', 'visual-qa');
  const releaseDirectory = join(baselineRoot, sourceSHA);
  await mkdir(releaseDirectory, { recursive: true });
  const captures = [];
  const measurementScope = 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot';
  for (let index = 0; index < 30; index++) {
    const id = `capture-${index}`;
    const screenshotPath = `${id}.png`;
    const metadataPath = `${id}.json`;
    const screenshotBytes = png(4, 4, [30 + index, 50, 80]);
    const screenshotSha256 = sha256(screenshotBytes);
    const capture = {
      id,
      sourceSHA,
      siteSourceSHA: sourceSHA,
      captureToolSHA,
      checkoutSHA: captureToolSHA,
      screenshotPath,
      metadataPath,
      screenshotSha256,
      metadataSha256: null,
      environmentLabel: 'local-http-uncompressed',
      measurementScope,
      metrics: {
        sameOriginTransferSizeBytes: 1200,
        domElementCount: 120,
        sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation'
      }
    };
    const metadata = {
      id,
      sourceSHA,
      siteSourceSHA: sourceSHA,
      captureToolSHA,
      checkoutSHA: captureToolSHA,
      metrics: capture.metrics,
      environmentLabel: capture.environmentLabel,
      measurementScope,
      screenshotSha256
    };
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    capture.metadataSha256 = sha256(metadataBytes);
    await writeFile(join(releaseDirectory, screenshotPath), screenshotBytes);
    await writeFile(join(releaseDirectory, metadataPath), metadataBytes);
    captures.push(capture);
  }

  const manifest = {
    schemaVersion: 3,
    status: 'APPROVED',
    sourceSHA,
    siteSourceSHA: sourceSHA,
    captureToolSHA,
    checkoutSHA: captureToolSHA,
    environment: 'local-http-uncompressed',
    approval: { reviewedBy: 'independent-controller', reviewedAt: '2026-10-18T00:00:00+08:00', note: 'Inspected all 30 captures.' },
    comparisonPolicy: { pixelThreshold: 0.1, maxDiffRatio: 0.005 },
    exceptions: [],
    captures
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const manifestPath = join(releaseDirectory, 'manifest.json');
  await writeFile(manifestPath, manifestBytes);
  const selection = {
    schemaVersion: 1,
    manifestPath: `${sourceSHA}/manifest.json`,
    manifestSha256: sha256(manifestBytes),
    sourceSHA
  };
  await writeFile(join(baselineRoot, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
  return { baselineRoot, releaseDirectory, manifestPath, manifest, selection };
}

async function writeCrossSourceBundle(bundleRoot, sourceSHA, captureToolSHA, { candidate = false, siteSourceKind = 'git-canonical-root' } = {}) {
  const policy = JSON.parse(await readFile(new URL('./visual-qa-policy.json', import.meta.url), 'utf8'));
  const toolVersions = {
    visualQaRunner: '1.0.0',
    node: 'v24.1.0',
    playwright: '1.55.1',
    pixelmatch: '6.0.0',
    chromium: '140.0.7339.186',
  };
  const publicationPayloads = siteSourceKind === 'publication'
    ? [{ path: 'index.html', sha256: 'b'.repeat(64), bytes: 3 }]
    : null;
  const wrapperFiles = siteSourceKind === 'publication'
    ? Object.fromEntries([
      ['deployment.json', { sha256: '1'.repeat(64), bytes: 20 }],
      ['_headers', { sha256: '2'.repeat(64), bytes: 30 }],
      ['_redirects', { sha256: '3'.repeat(64), bytes: 40 }],
      ['publication-manifest.json', { sha256: '4'.repeat(64), bytes: 50 }],
    ])
    : null;
  const artifactModeEntries = siteSourceKind === 'publication'
    ? [
      { path: '.', kind: 'directory', mode: candidate ? '0750' : '0755' },
      { path: '_headers', kind: 'file', mode: candidate ? '0600' : '0644' },
      { path: '_redirects', kind: 'file', mode: candidate ? '0600' : '0644' },
      { path: 'deployment.json', kind: 'file', mode: candidate ? '0600' : '0644' },
      { path: 'index.html', kind: 'file', mode: candidate ? '0640' : '0644' },
      { path: 'publication-manifest.json', kind: 'file', mode: candidate ? '0600' : '0644' },
    ].sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0)
    : null;
  const publicationArtifact = siteSourceKind === 'publication'
    ? {
      status: 'VERIFIED',
      servedRootRole: 'publication-artifact',
      sourceGitSHA: sourceSHA,
      deploymentSourceCommit: sourceSHA,
      publicArtifactDigest: sourceSHA[0].repeat(64),
      rawManifestSha256: sourceSHA[0].repeat(64),
      publicFileCount: publicationPayloads.length,
      payloadFileCount: publicationPayloads.length,
      payloadBytes: publicationPayloads.reduce((sum, item) => sum + item.bytes, 0),
      payloadInventorySha256: sha256(Buffer.from(stableStringifyFixture(publicationPayloads))),
      wrapperInventorySha256: sha256(Buffer.from(stableStringifyFixture(wrapperFiles))),
      wrapperFiles,
      artifactModeEntryCount: artifactModeEntries.length,
      artifactModeInventorySha256: sha256(Buffer.from(stableStringifyFixture(artifactModeEntries))),
      artifactModeEntries,
    }
    : null;
  const baselinePolicy = {
    viewportCount: policy.viewports.length,
    routeCount: policy.routes.length,
    expectedCaptureCount: 30,
    budgets: policy.budgets,
    comparisonPolicy: policy.comparison,
    captureConditions: policy.capture,
    exceptionCandidates: policy.routes.filter(route => route.exceptionCandidates?.length).map(route => ({ routeId: route.id, candidates: route.exceptionCandidates })),
  };
  const pngCache = new Map();
  const captures = [];
  await mkdir(bundleRoot, { recursive: true });
  for (const route of policy.routes) {
    for (const viewport of policy.viewports) {
      const id = `${route.id}-${viewport.width}`;
      const isChangedCandidate = candidate && id === 'home-390';
      const color = isChangedCandidate ? [240, 10, 10] : [10, 20, 30];
      const colorKey = `${viewport.width}:${viewport.height}:${color.join(',')}`;
      if (!pngCache.has(colorKey)) pngCache.set(colorKey, png(viewport.width, viewport.height, color));
      const screenshotBytes = pngCache.get(colorKey);
      const screenshotPath = `${id}.png`;
      const metadataPath = `${id}.json`;
      const metrics = {
        sameOriginTransferSizeBytes: 1200 + (isChangedCandidate ? 1 : 0),
        domElementCount: 120 + (isChangedCandidate ? 2 : 0),
        sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation',
        sameOriginPerformanceTransferSizeBytes: 1200,
        sameOriginEncodedDataLengthBytes: 1200,
      };
      const capture = {
        id,
        routeId: route.id,
        routePath: route.path,
        template: route.template,
        exceptionCandidates: route.exceptionCandidates ?? [],
        viewport,
        environment: 'local-http-uncompressed',
        environmentLabel: 'local-http-identity',
        measurementScope: 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot',
        sourceSHA,
        siteSourceSHA: sourceSHA,
        sourceGitSHA: sourceSHA,
        siteSourceKind,
        servedRootRole: siteSourceKind === 'publication' ? 'publication-artifact' : 'git-canonical-root',
        publicationArtifact,
        ...(publicationPayloads ? { publicationPayloads } : {}),
        captureToolSHA,
        checkoutSHA: captureToolSHA,
        liveDeployment: null,
        targetUrl: `http://127.0.0.1:8765/${route.path}`,
        screenshotPath,
        screenshotEnabled: true,
        screenshotSha256: sha256(screenshotBytes),
        metadataPath,
        capturedAt: '2026-10-19T00:00:00.000Z',
        browserVersion: toolVersions.chromium,
        toolVersion: '1.0.0; Playwright 1.55.1',
        toolVersions: { visualQaRunner: toolVersions.visualQaRunner, playwright: toolVersions.playwright },
        initialRequest: policy.capture.initialRequest,
        conditions: {
          locale: policy.capture.locale,
          timezoneId: policy.capture.timezoneId,
          fixedDate: policy.capture.fixedDate,
          deviceScaleFactor: policy.capture.deviceScaleFactor,
          reducedMotion: policy.capture.reducedMotion,
          serviceWorkers: 'blocked',
          browserCache: 'disabled per context',
          fontsReady: true,
          animationsFinished: true,
          activeAnimationsStabilized: 0,
          dynamicMasks: policy.capture.dynamicMasks,
        },
        httpStatus: route.expectedHttpStatus ?? 200,
        expectedHttpStatus: route.expectedHttpStatus ?? 200,
        pageErrors: [],
        navigationError: null,
        screenshotError: null,
        environmentVerification: {
          status: 'VERIFIED',
          requestedMode: 'local-http-uncompressed',
          originHost: '127.0.0.1',
          cloudflareVerified: false,
          documentContentEncoding: 'identity',
          encodingValid: true,
          deploymentWindowStatus: null,
        },
        imageState: { visibleImageCount: 0, decodedImageCount: 0, failedImageCount: 0, firstPartyFailedImageCount: 0, thirdPartyFailedImageCount: 0, visibleImages: [] },
        metrics,
        budgetObservation: {
          transferLimitBytes: policy.budgets.sameOriginTransferSizeBytes,
          transferWithinLimit: metrics.sameOriginTransferSizeBytes <= policy.budgets.sameOriginTransferSizeBytes,
          domLimit: policy.budgets.domElementCount,
          domWithinLimit: metrics.domElementCount <= policy.budgets.domElementCount,
          enforcement: 'OBSERVATION_ONLY_UNTIL_BASELINE_APPROVED',
        },
        network: [],
        captureQuality: { status: 'COMPLETE', firstPartyRequestFailureCount: 0, thirdPartyFailureCount: 0, thirdPartyPageErrorCount: 0, unclassifiedPageErrorCount: 0 },
      };
      const metadataBytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`);
      capture.metadataSha256 = sha256(metadataBytes);
      await writeFile(join(bundleRoot, screenshotPath), screenshotBytes);
      await writeFile(join(bundleRoot, metadataPath), metadataBytes);
      captures.push(capture);
    }
  }
  const manifest = {
    schemaVersion: 3,
    status: 'CAPTURE_ONLY',
    baselineApproval: null,
    approval: null,
    exceptions: [],
    environment: 'local-http-uncompressed',
    baseUrl: 'http://127.0.0.1:8765',
    sourceSHA,
    siteSourceSHA: sourceSHA,
    sourceGitSHA: sourceSHA,
    siteSourceKind,
    servedRootRole: siteSourceKind === 'publication' ? 'publication-artifact' : 'git-canonical-root',
    publicationArtifact,
    ...(publicationPayloads ? { publicationPayloads } : {}),
    captureToolSHA,
    checkoutSHA: captureToolSHA,
    capturedAt: '2026-10-19T00:00:00.000Z',
    toolVersions,
    policy: baselinePolicy,
    comparisonPolicy: policy.comparison,
    counts: { captures: 30, screenshots: 30, failedCaptures: 0, environmentVerificationFailures: 0 },
    captures,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(bundleRoot, 'manifest.json'), manifestBytes);
  await writeFile(join(bundleRoot, 'manifest.sha256'), `${sha256(manifestBytes)}  manifest.json\n`);
  return { manifestPath: join(bundleRoot, 'manifest.json'), manifest };
}

test('missing baseline stays PENDING and never reports a comparison pass', async () => {
  const missing = await readApprovedBaseline({ manifestPath: null, expectedSha256: null, expectedSourceSha: null });
  assert.deepEqual(missing, { status: 'PENDING', reason: 'BASELINE_MISSING' });
});

test('A-05 resolves site and capture-tool Git identities separately and rejects unsafe output or SHA overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-independent-source-'));
  const runnerRoot = join(directory, 'capture-tool');
  const siteRoot = join(directory, 'site-source');
  const outputRoot = join(directory, 'capture-output');
  const defaultOutput = join(runnerRoot, 'tests', 'donation', 'results', 'visual-qa');
  try {
    await mkdir(runnerRoot, { recursive: true });
    await mkdir(siteRoot, { recursive: true });
    await writeFile(join(runnerRoot, 'runner.mjs'), 'export const runnerFixture = true;\n');
    await writeFile(join(siteRoot, 'index.html'), '<main>source fixture</main>\n');
    const gitAt = (repositoryRoot, args) => {
      const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    for (const repositoryRoot of [runnerRoot, siteRoot]) {
      gitAt(repositoryRoot, ['init', '-q']);
      gitAt(repositoryRoot, ['config', 'user.name', 'A05 fixture']);
      gitAt(repositoryRoot, ['config', 'user.email', 'a05-fixture@example.invalid']);
      gitAt(repositoryRoot, ['add', '.']);
      gitAt(repositoryRoot, ['commit', '-q', '-m', 'fixture checkout']);
    }
    const siteSha = gitAt(siteRoot, ['rev-parse', 'HEAD']);
    const result = await resolveCaptureRoots({ runnerRoot, siteRoot, outputDir: outputRoot, defaultOutput });
    const toolSha = gitAt(runnerRoot, ['rev-parse', 'HEAD']);
    assert.equal(result.siteSourceSHA, siteSha);
    assert.equal(result.captureToolSHA, toolSha);
    assert.notEqual(result.siteSourceSHA, result.captureToolSHA);
    assert.equal(result.independentSiteSource, true);
    const publicationRoot = join(directory, 'publication-output');
    await mkdir(publicationRoot);
    const publicationIdentity = await resolveCaptureRoots({
      runnerRoot,
      siteRoot,
      publicArtifact: publicationRoot,
      outputDir: join(directory, 'publication-capture-output'),
      defaultOutput,
    });
    assert.equal(publicationIdentity.publicArtifactRoot, await realpath(publicationRoot));
    await assert.rejects(resolveCaptureRoots({
      runnerRoot,
      siteRoot,
      publicArtifact: siteRoot,
      outputDir: join(directory, 'overlapping-publication-capture'),
      defaultOutput,
    }), /separate from both Git source roots/);

    const siteAlias = join(directory, 'site-source-alias');
    await symlink(siteRoot, siteAlias, 'dir');
    await assert.rejects(
      resolveCaptureRoots({ runnerRoot, siteRoot: siteAlias, outputDir: join(directory, 'alias-output'), defaultOutput }),
      /site source root must be a real directory/
    );
    await assert.rejects(resolveCaptureRoots({ runnerRoot, siteRoot, outputDir: join(siteRoot, 'capture-output'), defaultOutput }), /must not overlap/);
    await writeFile(join(siteRoot, 'index.html'), '<main>dirty source fixture</main>\n');
    await assert.rejects(resolveCaptureRoots({ runnerRoot, siteRoot, outputDir: join(directory, 'other-output'), defaultOutput }), /must be clean/);
    gitAt(siteRoot, ['checkout', '--', 'index.html']);
    await writeFile(join(runnerRoot, 'runner.mjs'), 'export const runnerFixture = false;\n');
    await assert.rejects(resolveCaptureRoots({ runnerRoot, siteRoot, outputDir: join(directory, 'dirty-tool-output'), defaultOutput }), /Capture tool worktree must be clean/);
    assert.throws(() => assertAllowedOptions('capture', { environment: 'local-http-uncompressed', 'source-sha': siteSha }), /Unsupported capture option/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A-05 publication identity verifies a real Git source and exact public artifact bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-publication-artifact-'));
  const sourceRoot = join(directory, 'git-source');
  const artifactRoot = join(directory, 'public-artifact');
  try {
    await initRepositoryFixture(sourceRoot);
    await writeFile(join(sourceRoot, 'index.html'), '<main>canonical source</main>\n');
    commitFixtureRepository(sourceRoot);
    const sourceSHA = gitAtFixture(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    await createMinimalPublicationArtifact(artifactRoot, sourceSHA, {
      'index.html': '<main>published projection</main>\n',
      'assets/site.css': 'body{font-family:system-ui}\n',
      '.nojekyll': '',
    });

    const attestation = await validatePublicationArtifact({ artifactRoot, sourceRoot, sourceGitSHA: sourceSHA });
    assert.equal(attestation.status, 'VERIFIED');
    assert.equal(attestation.servedRootRole, 'publication-artifact');
    assert.equal(attestation.sourceGitSHA, sourceSHA);
    assert.equal(attestation.deploymentSourceCommit, sourceSHA);
    assert.equal(attestation.rawManifestSha256, attestation.publicArtifactDigest);
    assert.equal(attestation.publicFileCount, 3);
    assert.equal(attestation.payloadFileCount, 3);
    assert.equal(attestation.payloads.length, 3);
    assert(attestation.payloads.some(item => item.path === 'assets/site.css' && item.bytes > 0));
    assert.deepEqual(attestation.artifactModeEntries.map(item => [item.path, item.kind]), [
      ['.', 'directory'],
      ['.nojekyll', 'file'],
      ['_headers', 'file'],
      ['_redirects', 'file'],
      ['assets', 'directory'],
      ['assets/site.css', 'file'],
      ['deployment.json', 'file'],
      ['index.html', 'file'],
      ['publication-manifest.json', 'file'],
    ]);
    assert.equal(attestation.artifactModeEntryCount, attestation.artifactModeEntries.length);
    assert.match(attestation.artifactModeInventorySha256, /^[a-f0-9]{64}$/);
    const publicationIdentity = publicationMetadataIdentity(attestation);
    assert.deepEqual(publicationIdentity.artifactModeEntries, attestation.artifactModeEntries);
    assert.equal(publicationIdentity.artifactModeInventorySha256, attestation.artifactModeInventorySha256);
    const metadataRecord = {
      sourceGitSHA: sourceSHA,
      sourceSHA,
      siteSourceSHA: sourceSHA,
      siteSourceKind: 'publication',
      servedRootRole: 'publication-artifact',
      publicationArtifact: publicationIdentity,
      publicationPayloads: attestation.payloads,
    };
    assert.equal(validatePublicationIdentityRecord(metadataRecord, sourceSHA), true);
    const unchanged = await validatePublicationArtifact({ artifactRoot, sourceRoot, sourceGitSHA: sourceSHA });
    assert.doesNotThrow(() => assertSamePublicationArtifact(attestation, unchanged));

    const changedRoot = join(directory, 'changed-artifact');
    await createMinimalPublicationArtifact(changedRoot, sourceSHA, { 'index.html': 'before\n' });
    const before = await validatePublicationArtifact({ artifactRoot: changedRoot, sourceRoot, sourceGitSHA: sourceSHA });
    await writeFile(join(changedRoot, 'index.html'), 'changed\n');
    await assert.rejects(validatePublicationArtifact({ artifactRoot: changedRoot, sourceRoot, sourceGitSHA: sourceSHA }), /payload SHA-256 mismatch/);
    const rebuiltRoot = join(directory, 'rebuilt-artifact');
    await createMinimalPublicationArtifact(rebuiltRoot, sourceSHA, { 'index.html': 'after\n' });
    const rebuilt = await validatePublicationArtifact({ artifactRoot: rebuiltRoot, sourceRoot, sourceGitSHA: sourceSHA });
    assert.throws(() => assertSamePublicationArtifact(before, rebuilt), /integrity changed/);

    const wrongSourceRoot = join(directory, 'wrong-source-artifact');
    await createMinimalPublicationArtifact(wrongSourceRoot, sourceSHA, { 'index.html': 'wrong source\n' }, { sourceCommit: '0'.repeat(40) });
    await assert.rejects(validatePublicationArtifact({ artifactRoot: wrongSourceRoot, sourceRoot, sourceGitSHA: sourceSHA }), /sourceCommit does not match/);
    await assert.rejects(validatePublicationArtifact({ artifactRoot, sourceRoot, sourceGitSHA: 'f'.repeat(40) }), /clean site-source Git HEAD/);

    const privateRoot = join(directory, 'private-artifact');
    await createMinimalPublicationArtifact(privateRoot, sourceSHA, { 'data/private/record.json': '{"public":true}\n' });
    await assert.rejects(validatePublicationArtifact({ artifactRoot: privateRoot, sourceRoot, sourceGitSHA: sourceSHA }), /private path/);

    const missingRoot = join(directory, 'missing-artifact');
    await createMinimalPublicationArtifact(missingRoot, sourceSHA, { 'index.html': 'expected\n' });
    await unlink(join(missingRoot, 'index.html'));
    await assert.rejects(validatePublicationArtifact({ artifactRoot: missingRoot, sourceRoot, sourceGitSHA: sourceSHA }), /file set differs|missing required wrapper/);

    const externalPayload = join(directory, 'outside-public-payload.txt');
    await writeFile(externalPayload, 'outside payload\n');
    const symlinkRoot = join(directory, 'symlink-artifact');
    await createMinimalPublicationArtifact(symlinkRoot, sourceSHA, { 'index.html': 'outside payload\n' });
    await unlink(join(symlinkRoot, 'index.html'));
    await symlink(externalPayload, join(symlinkRoot, 'index.html'));
    await assert.rejects(validatePublicationArtifact({ artifactRoot: symlinkRoot, sourceRoot, sourceGitSHA: sourceSHA }), /symlink/);

    const hardlinkRoot = join(directory, 'hardlink-artifact');
    await createMinimalPublicationArtifact(hardlinkRoot, sourceSHA, { 'index.html': 'outside payload\n' });
    await unlink(join(hardlinkRoot, 'index.html'));
    await link(externalPayload, join(hardlinkRoot, 'index.html'));
    await assert.rejects(validatePublicationArtifact({ artifactRoot: hardlinkRoot, sourceRoot, sourceGitSHA: sourceSHA }), /hard-linked file/);

    const badDigestRoot = join(directory, 'bad-digest-artifact');
    await createMinimalPublicationArtifact(badDigestRoot, sourceSHA, { 'index.html': 'digest\n' }, { publicArtifactDigest: 'd'.repeat(64) });
    await assert.rejects(validatePublicationArtifact({ artifactRoot: badDigestRoot, sourceRoot, sourceGitSHA: sourceSHA }), /digest does not match/);

    const secretRoot = join(directory, 'secret-artifact');
    await createMinimalPublicationArtifact(secretRoot, sourceSHA, { 'content.json': '{"api_key":"fixture-secret-value-123456"}\n' });
    await assert.rejects(validatePublicationArtifact({ artifactRoot: secretRoot, sourceRoot, sourceGitSHA: sourceSHA }), /secret-like value/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A-05 publication artifact pre/post identity rejects same-byte payload, directory, wrapper, and root mode changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-publication-artifact-mode-'));
  const sourceRoot = join(directory, 'git-source');
  const cases = [
    { name: 'payload', path: 'index.html', entryPath: 'index.html' },
    { name: 'directory', path: 'assets', entryPath: 'assets' },
    { name: 'wrapper', path: '_headers', entryPath: '_headers' },
    { name: 'root', path: '.', entryPath: '.' },
  ];
  try {
    await initRepositoryFixture(sourceRoot);
    await writeFile(join(sourceRoot, 'index.html'), '<main>canonical source</main>\n');
    commitFixtureRepository(sourceRoot);
    const actualSourceSHA = gitAtFixture(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    for (const item of cases) {
      const artifactRoot = join(directory, `artifact-${item.name}`);
      await createMinimalPublicationArtifact(artifactRoot, actualSourceSHA, {
        'index.html': '<main>same payload bytes</main>\n',
        'assets/site.css': 'body{color:#123}\n',
      });
      const before = await validatePublicationArtifact({ artifactRoot, sourceRoot, sourceGitSHA: actualSourceSHA });
      const target = item.path === '.' ? artifactRoot : join(artifactRoot, ...item.path.split('/'));
      const originalMode = (await lstat(target)).mode & 0o7777;
      await chmod(target, originalMode ^ 0o001);
      const after = await validatePublicationArtifact({ artifactRoot, sourceRoot, sourceGitSHA: actualSourceSHA });

      assert.deepEqual(after.payloads, before.payloads, `${item.name}: payload bytes or hashes changed`);
      assert.deepEqual(after.wrapperFiles, before.wrapperFiles, `${item.name}: wrapper bytes or hashes changed`);
      assert.equal(after.payloadInventorySha256, before.payloadInventorySha256, `${item.name}: payload inventory changed`);
      assert.equal(after.wrapperInventorySha256, before.wrapperInventorySha256, `${item.name}: wrapper inventory changed`);
      assert.notEqual(after.artifactModeInventorySha256, before.artifactModeInventorySha256, `${item.name}: mode fingerprint did not change`);
      assert.notEqual(
        after.artifactModeEntries.find(entry => entry.path === item.entryPath)?.mode,
        before.artifactModeEntries.find(entry => entry.path === item.entryPath)?.mode,
        `${item.name}: recorded mode did not change`
      );
      assert.throws(() => assertSamePublicationArtifact(before, after), /integrity changed/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A-05 default output rejects a committed symlink escape and the PR base source is guarded and rechecked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-default-output-and-readonly-base-'));
  const gitAt = (repositoryRoot, args) => {
    const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const initRepository = async repositoryRoot => {
    await mkdir(repositoryRoot, { recursive: true });
    gitAt(repositoryRoot, ['init', '-q']);
    gitAt(repositoryRoot, ['config', 'user.name', 'A05 fixture']);
    gitAt(repositoryRoot, ['config', 'user.email', 'a05-fixture@example.invalid']);
  };
  const commitAll = repositoryRoot => {
    gitAt(repositoryRoot, ['add', '.']);
    gitAt(repositoryRoot, ['commit', '-q', '-m', 'fixture checkout']);
  };
  const escapedRunner = join(directory, 'escaped-runner');
  const externalOutput = join(directory, 'external-output');
  const escapedDefault = join(escapedRunner, 'tests', 'donation', 'results', 'visual-qa');
  await initRepository(escapedRunner);
  await mkdir(join(escapedRunner, 'tests', 'donation', 'results'), { recursive: true });
  await mkdir(externalOutput);
  await writeFile(join(escapedRunner, 'runner.mjs'), 'export const fixture = true;\n');
  await symlink(externalOutput, escapedDefault, 'dir');
  commitAll(escapedRunner);
  await assert.rejects(
    resolveCaptureRoots({ runnerRoot: escapedRunner, defaultOutput: escapedDefault }),
    /Default capture output directory (?:must resolve within|symlink resolves outside) the capture tool checkout/
  );
  const explicitOutput = join(directory, 'explicit-output');
  const explicitIdentity = await resolveCaptureRoots({ runnerRoot: escapedRunner, outputDir: explicitOutput, defaultOutput: escapedDefault });
  assert.equal(explicitIdentity.outputRoot, join(await realpath(directory), 'explicit-output'));

  const escapedParentRunner = join(directory, 'escaped-parent-runner');
  const externalParent = join(directory, 'external-parent');
  const escapedResultsParent = join(escapedParentRunner, 'tests', 'donation', 'results');
  await initRepository(escapedParentRunner);
  await mkdir(join(escapedParentRunner, 'tests', 'donation'), { recursive: true });
  await mkdir(externalParent);
  await writeFile(join(escapedParentRunner, 'runner.mjs'), 'export const fixture = true;\n');
  await symlink(externalParent, escapedResultsParent, 'dir');
  commitAll(escapedParentRunner);
  await assert.rejects(
    resolveCaptureRoots({
      runnerRoot: escapedParentRunner,
      defaultOutput: join(escapedResultsParent, 'visual-qa'),
    }),
    /symlink resolves outside the capture tool checkout/
  );

  const safeRunner = join(directory, 'safe-runner');
  await initRepository(safeRunner);
  await writeFile(join(safeRunner, '.gitignore'), 'tests/donation/results/\n');
  await writeFile(join(safeRunner, 'runner.mjs'), 'export const fixture = true;\n');
  commitAll(safeRunner);
  const safeDefault = join(safeRunner, 'tests', 'donation', 'results', 'visual-qa');
  await mkdir(safeDefault, { recursive: true });
  const defaultIdentity = await resolveCaptureRoots({ runnerRoot: safeRunner, defaultOutput: safeDefault });
  assert.equal(defaultIdentity.outputRoot, await realpath(safeRunner).then(path => join(path, 'tests', 'donation', 'results', 'visual-qa')));

  const sourceRepository = join(directory, 'source-repository');
  const runnerTemp = join(directory, 'runner-temp');
  const baseRoot = join(runnerTemp, 'a05-main-reference');
  const externalSourceTarget = join(directory, 'external-source-target.txt');
  await initRepository(sourceRepository);
  await mkdir(join(sourceRepository, 'pages'), { recursive: true });
  await writeFile(join(sourceRepository, 'pages', 'index.html'), '<main>reviewed source</main>\n');
  await writeFile(externalSourceTarget, 'outside the base worktree\n');
  await symlink(externalSourceTarget, join(sourceRepository, 'external-link'), 'file');
  commitAll(sourceRepository);
  await mkdir(runnerTemp, { recursive: true });
  gitAt(sourceRepository, ['worktree', 'add', '--detach', baseRoot, 'HEAD']);
  const sourcePath = join(baseRoot, 'pages', 'index.html');
  const sourceRepositoryPath = join(sourceRepository, 'pages', 'index.html');
  const commonGitDir = join(sourceRepository, gitAt(sourceRepository, ['rev-parse', '--git-common-dir']));
  const originalFileMode = (await lstat(sourcePath)).mode & 0o777;
  const originalDirectoryMode = (await lstat(join(baseRoot, 'pages'))).mode & 0o777;
  const originalRepositoryMode = (await lstat(sourceRepositoryPath)).mode & 0o777;
  const originalCommonGitDirMode = (await lstat(commonGitDir)).mode & 0o777;
  const originalExternalTargetMode = (await lstat(externalSourceTarget)).mode & 0o777;

  const guard = await protectReadOnlyBaseSource({ root: baseRoot, runnerTemp, baseRoot });
  assert.equal(guard.initialState.headSha, gitAt(baseRoot, ['rev-parse', 'HEAD']));
  assert.equal((await lstat(sourcePath)).mode & 0o222, 0);
  assert.equal((await lstat(join(baseRoot, 'pages'))).mode & 0o222, 0);
  assert.equal(guard.modeRecord.skippedSymlinkCount, 1);
  assert.notEqual((await lstat(sourceRepositoryPath)).mode & 0o222, 0);
  assert.equal((await lstat(commonGitDir)).mode & 0o777, originalCommonGitDirMode);
  assert.equal((await lstat(externalSourceTarget)).mode & 0o777, originalExternalTargetMode);
  const integrity = await guard.verifyAndRestore();
  assert.equal(integrity.cleanAfterCapture, true);
  assert.equal(integrity.trackedContentSha256After, integrity.trackedContentSha256Before);
  assert.notEqual(integrity.readOnlyMode.sha256, '');
  assert.match(integrity.readOnlyMode.expectedProtectedDigest, /^[a-f0-9]{64}$/);
  assert.equal(integrity.readOnlyMode.postCaptureModeDigest, integrity.readOnlyMode.expectedProtectedDigest);
  assert.equal((await lstat(sourcePath)).mode & 0o777, originalFileMode);
  assert.equal((await lstat(join(baseRoot, 'pages'))).mode & 0o777, originalDirectoryMode);
  assert.equal((await lstat(sourceRepositoryPath)).mode & 0o777, originalRepositoryMode);
  assert.equal((await lstat(commonGitDir)).mode & 0o777, originalCommonGitDirMode);
  assert.equal((await lstat(externalSourceTarget)).mode & 0o777, originalExternalTargetMode);

  const changedSourceGuard = await protectReadOnlyBaseSource({ root: baseRoot, runnerTemp, baseRoot });
  await chmod(sourcePath, originalFileMode);
  await writeFile(sourcePath, '<main>changed during capture</main>\n');
  await assert.rejects(changedSourceGuard.verifyAndRestore(), /tracked content changed/);
  assert.equal(await readFile(sourcePath, 'utf8'), '<main>changed during capture</main>\n');
  assert.equal((await lstat(sourcePath)).mode & 0o777, originalFileMode);
});

test('A-05 post-capture mode digest rejects same-byte file and directory mode changes and restores exact base modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-post-mode-digest-'));
  const sourceRepository = join(directory, 'source-repository');
  const runnerTemp = join(directory, 'runner-temp');
  const baseRoot = join(runnerTemp, 'a05-main-reference');
  try {
    await initRepositoryFixture(sourceRepository);
    await writeFile(join(sourceRepository, 'index.html'), '<main>same bytes</main>\n');
    await chmod(join(sourceRepository, 'index.html'), 0o644);
    await mkdir(join(sourceRepository, 'nested'), { recursive: true });
    await writeFile(join(sourceRepository, 'nested', 'item.txt'), 'same nested bytes\n');
    await chmod(join(sourceRepository, 'nested'), 0o755);
    await mkdir(runnerTemp, { recursive: true });
    commitFixtureRepository(sourceRepository);
    gitAtFixture(sourceRepository, ['worktree', 'add', '--detach', baseRoot, 'HEAD']);

    const filePath = join(baseRoot, 'index.html');
    const originalFileBytes = await readFile(filePath);
    const originalFileMode = (await lstat(filePath)).mode & 0o7777;
    assert.equal(originalFileMode, 0o644);
    const fileGuard = await protectReadOnlyBaseSource({ root: baseRoot, runnerTemp, baseRoot });
    assert.equal((await lstat(filePath)).mode & 0o222, 0);
    await chmod(filePath, 0o644);
    assert.deepEqual(await readFile(filePath), originalFileBytes);
    assert.equal(gitAtFixture(baseRoot, ['status', '--porcelain=v1', '-uall']), '');
    await assert.rejects(fileGuard.verifyAndRestore(), error => {
      assert(error instanceof AggregateError);
      assert(error.errors.some(item => /protected mode digest changed/.test(item.message)));
      assert(error.errors.some(item => /became writable during capture/.test(item.message)));
      return true;
    });
    assert.equal(fileGuard.completed, true);
    assert.deepEqual(await readFile(filePath), originalFileBytes);
    assert.equal((await lstat(filePath)).mode & 0o7777, originalFileMode);

    const directoryPath = join(baseRoot, 'nested');
    const originalDirectoryMode = (await lstat(directoryPath)).mode & 0o7777;
    const directoryGuard = await protectReadOnlyBaseSource({ root: baseRoot, runnerTemp, baseRoot });
    await chmod(directoryPath, 0o500);
    assert.equal(gitAtFixture(baseRoot, ['status', '--porcelain=v1', '-uall']), '');
    await assert.rejects(directoryGuard.verifyAndRestore(), /protected mode digest changed/);
    assert.equal((await lstat(directoryPath)).mode & 0o7777, originalDirectoryMode);
    assert.deepEqual(await readFile(filePath), originalFileBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source integrity invalidates every registered on-disk metadata file outside captures and preserves both failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-metadata-invalidation-'));
  const canonicalRoot = await realpath(directory);
  const outputRoot = join(canonicalRoot, 'artifacts');
  const runOutput = join(outputRoot, 'local-http-uncompressed');
  const registry = createMetadataPathRegistry({ runOutput, outputRoot });
  const claimedSourceSHA = 'a'.repeat(40);
  const returnedCapture = {
    id: 'home-390',
    metadataPath: 'home-390.json',
    sourceSHA: claimedSourceSHA,
    siteSourceSHA: claimedSourceSHA,
    metrics: { domElementCount: 100 },
  };
  const failedBeforeReturn = {
    id: 'about-390',
    metadataPath: 'about-390.json',
    sourceSHA: claimedSourceSHA,
    siteSourceSHA: claimedSourceSHA,
    screenshotSha256: null,
    screenshotError: 'synthetic PNG finalization failure',
  };
  try {
    returnedCapture.metadataSha256 = await writeCaptureMetadata({
      registry,
      id: returnedCapture.id,
      metadataPath: returnedCapture.metadataPath,
      record: returnedCapture,
    });
    assert.equal(returnedCapture.metadataSha256, sha256(await readFile(join(runOutput, returnedCapture.metadataPath))));
    await writeCaptureMetadata({
      registry,
      id: failedBeforeReturn.id,
      metadataPath: failedBeforeReturn.metadataPath,
      record: failedBeforeReturn,
    });

    const originalCaptureError = new Error('PNG finalization failed after metadata was written');
    const sourceIntegrityError = new Error('A-05 source mode digest changed');
    const reportErrors = await invalidateSourceMetadata({
      registry,
      captures: [returnedCapture],
      expectedHeadSha: claimedSourceSHA,
      claimedSourceSHAAtStart: claimedSourceSHA,
      reason: sourceIntegrityError,
      captureError: originalCaptureError,
    });
    assert.deepEqual(reportErrors, []);

    const combined = combineCaptureAndSourceIntegrityErrors(originalCaptureError, sourceIntegrityError, reportErrors);
    assert(combined instanceof AggregateError);
    assert.equal(combined.errors[0], originalCaptureError);
    assert.equal(combined.errors[1], sourceIntegrityError);

    for (const id of ['home-390', 'about-390']) {
      const metadata = JSON.parse(await readFile(join(runOutput, `${id}.json`), 'utf8'));
      assert.equal(metadata.sourceSHA, null);
      assert.equal(metadata.siteSourceSHA, null);
      assert.equal(metadata.claimedSourceSHAAtStart, claimedSourceSHA);
      assert.equal(metadata.siteSourceIntegrityStatus, 'FAILED');
      assert.equal(metadata.sourceIntegrity.status, 'FAILED');
      assert.equal(metadata.sourceIntegrity.sourceSHA, null);
      assert.equal(metadata.sourceIntegrity.siteSourceSHA, null);
      assert.equal(metadata.sourceIntegrity.reason, sourceIntegrityError.message);
    }
    const partialReport = JSON.parse(await readFile(join(runOutput, 'site-source-integrity-failure.json'), 'utf8'));
    assert.equal(partialReport.status, 'FAILED');
    assert.equal(partialReport.sourceSHA, null);
    assert.equal(partialReport.siteSourceSHA, null);
    assert.equal(partialReport.claimedSourceSHAAtStart, claimedSourceSHA);
    assert.equal(partialReport.captureFailure, originalCaptureError.message);
    assert.deepEqual(partialReport.metadataPathsAttempted, ['home-390.json', 'about-390.json']);
    assert.equal(partialReport.invalidatedMetadata.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication artifact failure invalidates every partial capture identity and rejects verified metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-metadata-invalidation-'));
  const canonicalRoot = await realpath(directory);
  const outputRoot = join(canonicalRoot, 'artifacts');
  const runOutput = join(outputRoot, 'local-http-uncompressed');
  const registry = createMetadataPathRegistry({ runOutput, outputRoot });
  const sourceSHA = 'a'.repeat(40);
  const capture = {
    id: 'home-390',
    metadataPath: 'home-390.json',
    sourceSHA,
    siteSourceSHA: sourceSHA,
    sourceGitSHA: sourceSHA,
    siteSourceKind: 'publication',
    servedRootRole: 'publication-artifact',
    publicationArtifact: {
      status: 'VERIFIED',
      publicArtifactDigest: 'b'.repeat(64),
      rawManifestSha256: 'b'.repeat(64),
    },
    environmentVerification: { status: 'VERIFIED', encodingValid: true },
    captureQuality: { status: 'COMPLETE' },
  };
  try {
    capture.metadataSha256 = await writeCaptureMetadata({
      registry,
      id: capture.id,
      metadataPath: capture.metadataPath,
      record: capture,
    });
    const failure = new Error('Publication artifact payload changed after capture.');
    const captureFailure = new Error('Capture failed after writing partial metadata.');
    const errors = await invalidateSourceMetadata({
      registry,
      captures: [capture],
      expectedHeadSha: sourceSHA,
      claimedSourceSHAAtStart: sourceSHA,
      reason: failure,
      captureError: captureFailure,
      integrityKind: 'publication-artifact',
    });
    assert.deepEqual(errors, []);
    const combined = combineCaptureAndIntegrityErrors(captureFailure, failure, errors, 'publication-artifact');
    assert(combined instanceof AggregateError);
    assert.equal(combined.errors[0], captureFailure);
    assert.equal(combined.errors[1], failure);
    const metadata = JSON.parse(await readFile(join(runOutput, 'home-390.json'), 'utf8'));
    assert.equal(metadata.sourceSHA, null);
    assert.equal(metadata.siteSourceSHA, null);
    assert.equal(metadata.sourceGitSHA, null);
    assert.equal(metadata.siteSourceKind, 'invalidated');
    assert.equal(metadata.servedRootRole, null);
    assert.equal(metadata.publicationArtifact.status, 'FAILED');
    assert.equal(metadata.environmentVerification.status, 'NOT_VERIFIED');
    assert.equal(metadata.captureQuality.status, 'INVALIDATED');
    assert.equal(metadata.captureIntegrityStatus, 'FAILED');
    const report = JSON.parse(await readFile(join(runOutput, 'publication-artifact-integrity-failure.json'), 'utf8'));
    assert.equal(report.status, 'FAILED');
    assert.equal(report.integrityKind, 'publication-artifact');
    assert.equal(report.captureFailure, captureFailure.message);
    assert.equal(report.invalidatedMetadata.length, 1);
    await assert.rejects(readFile(join(runOutput, 'site-source-integrity-failure.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source metadata invalidation refuses a symlink path and leaves its outside target untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-metadata-symlink-'));
  const canonicalRoot = await realpath(directory);
  const outputRoot = join(canonicalRoot, 'artifacts');
  const runOutput = join(outputRoot, 'local-http-uncompressed');
  const registry = createMetadataPathRegistry({ runOutput, outputRoot });
  const outsidePath = join(canonicalRoot, 'outside.json');
  const outsideBytes = Buffer.from('{"sourceSHA":"must remain"}\n');
  try {
    await mkdir(runOutput, { recursive: true });
    await writeFile(outsidePath, outsideBytes);
    registry.register('home-390', 'home-390.json');
    await symlink(outsidePath, join(runOutput, 'home-390.json'));
    const errors = await invalidateSourceMetadata({
      registry,
      captures: [],
      expectedHeadSha: 'b'.repeat(40),
      claimedSourceSHAAtStart: 'b'.repeat(40),
      reason: new Error('synthetic source integrity failure'),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /unsafe capture metadata file/);
    assert.deepEqual(await readFile(outsidePath), outsideBytes);
    const partialReport = JSON.parse(await readFile(join(runOutput, 'site-source-integrity-failure.json'), 'utf8'));
    assert.equal(partialReport.status, 'FAILED');
    assert.equal(partialReport.invalidatedMetadata.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capture output preparation rejects an environment directory symlink outside the output root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-metadata-root-symlink-'));
  const canonicalRoot = await realpath(directory);
  const outputRoot = join(canonicalRoot, 'artifacts');
  const runOutput = join(outputRoot, 'local-http-uncompressed');
  const outsideDirectory = join(canonicalRoot, 'outside');
  const outsideFile = join(outsideDirectory, 'keep.json');
  const outsideBytes = Buffer.from('{"keep":true}\n');
  const registry = createMetadataPathRegistry({ runOutput, outputRoot });
  try {
    await mkdir(outputRoot, { recursive: true });
    await mkdir(outsideDirectory);
    await writeFile(outsideFile, outsideBytes);
    await symlink(outsideDirectory, runOutput, 'dir');
    await assert.rejects(prepareCaptureOutput(registry), /not a real directory/);
    assert.deepEqual(await readFile(outsideFile), outsideBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A-05 cross-source review verifies both capture bundles and emits review diffs without selecting a golden', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-cross-source-review-'));
  const runnerSha = 'f'.repeat(40);
  const referenceSourceSha = 'a'.repeat(40);
  const candidateSourceSha = runnerSha;
  const reference = await writeCrossSourceBundle(join(directory, 'reference'), referenceSourceSha, runnerSha);
  const candidate = await writeCrossSourceBundle(join(directory, 'candidate'), candidateSourceSha, runnerSha, { candidate: true });
  const reviewOutput = join(directory, 'cross-source-review');
  try {
    const report = await createCrossSourceReview({
      referenceManifestPath: reference.manifestPath,
      candidateManifestPath: candidate.manifestPath,
      outputDir: reviewOutput,
    });
    assert.equal(report.status, 'CROSS_SOURCE_REVIEW');
    assert.equal(report.reviewRequired, true);
    assert.equal(report.pass, null);
    assert.equal(report.approval, null);
    assert.equal(report.baselineSelected, false);
    assert.equal(report.summary.captureCount, 30);
    assert.equal(report.summary.capturesWithPixelChanges, 1);
    assert.equal(report.summary.newMetricRegressionCount, 2);
    assert.equal(report.summary.exceptionAppliedCount, 0);
    assert.equal(report.captures[0].pixelReview.withinConfiguredThreshold, false);
    assert.equal(report.captures[0].metrics[0].delta, 1);
    assert.equal((await readFile(join(reviewOutput, report.captures[0].pixelReview.diffPath))).length > 0, true);
    const publicationReference = await writeCrossSourceBundle(
      join(directory, 'publication-reference'), referenceSourceSha, runnerSha, { siteSourceKind: 'publication' }
    );
    const publicationCandidate = await writeCrossSourceBundle(
      join(directory, 'publication-candidate'), candidateSourceSha, runnerSha,
      { candidate: true, siteSourceKind: 'publication' }
    );
    const publicationReview = await createCrossSourceReview({
      referenceManifestPath: publicationReference.manifestPath,
      candidateManifestPath: publicationCandidate.manifestPath,
      outputDir: join(directory, 'publication-review'),
    });
    assert.equal(publicationReview.status, 'CROSS_SOURCE_REVIEW');
    assert.equal(publicationReview.pass, null);
    assert.equal(publicationReview.approval, null);
    assert.equal(publicationReview.source.reference.siteSourceKind, 'publication');
    assert.equal(publicationReview.source.candidate.servedRootRole, 'publication-artifact');
    assert.notEqual(
      publicationReview.source.reference.publicationArtifact.artifactModeInventorySha256,
      publicationReview.source.candidate.publicationArtifact.artifactModeInventorySha256,
      'base and candidate artifacts may carry different native modes without being rejected as a pre/post mutation'
    );
    await assert.rejects(createCrossSourceReview({
      referenceManifestPath: reference.manifestPath,
      candidateManifestPath: publicationCandidate.manifestPath,
      outputDir: join(directory, 'mixed-source-kind-review'),
    }), /cannot mix Git canonical-root captures with publication-artifact captures/);
    await assert.rejects(createCrossSourceReview({
      referenceManifestPath: reference.manifestPath,
      candidateManifestPath: candidate.manifestPath,
      outputDir: reviewOutput,
    }), /must not already exist/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compare CLI writes PENDING and exits successfully when the baseline has not been approved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-compare-pending-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const comparisonPath = join(directory, 'comparison.json');
    await writeFile(candidatePath, JSON.stringify({ sourceSHA: 'c'.repeat(40) }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--output', comparisonPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(comparisonPath, 'utf8'));
    assert.equal(report.status, 'PENDING');
    assert.equal(report.comparisonPerformed, false);
    assert.match(report.message, /not a visual regression pass/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the fixed Git selection is PENDING when it has not been created', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-pending-'));
  try {
    const result = await readGitBaselineSelection({ repositoryRoot });
    assert.deepEqual(result, {
      status: 'PENDING',
      reason: 'BASELINE_SELECTION_MISSING',
      selectionPath: 'tests/baselines/visual-qa/selection.json'
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('the Git selection accepts a complete approved bundle with independent site and capture-tool SHAs', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-valid-'));
  try {
    const sourceSHA = 'd'.repeat(40);
    const captureToolSHA = 'e'.repeat(40);
    const bundle = await writeGitBaseline(repositoryRoot, sourceSHA, captureToolSHA);
    const selected = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(selected.status, 'APPROVED');
    assert.equal(selected.manifest.sourceSHA, sourceSHA);
    assert.equal(selected.manifest.siteSourceSHA, sourceSHA);
    assert.equal(selected.manifest.captureToolSHA, captureToolSHA);
    assert.equal(selected.sourceType, 'git-selection');
    assert.equal(selected.selectionPath, 'tests/baselines/visual-qa/selection.json');
    assert.equal(selected.manifestPath, await realpath(bundle.manifestPath));
    assert.equal(selected.actualSha256, bundle.selection.manifestSha256);
    assert.equal(selected.manifest.captures.length, 30);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('the Git selection rejects missing baselines, wrong hashes, missing provenance and paths outside its release directory', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-negative-'));
  try {
    const bundle = await writeGitBaseline(repositoryRoot);
    const selectionPath = join(bundle.baselineRoot, 'selection.json');
    const valid = bundle.selection;

    await writeFile(selectionPath, JSON.stringify({ ...valid, manifestPath: '../outside/manifest.json' }));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'BASELINE_SELECTION_PATH_INVALID');

    const { sourceSHA: ignoredSourceSHA, ...missingProvenance } = valid;
    await writeFile(selectionPath, JSON.stringify(missingProvenance));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'BASELINE_SELECTION_PROVENANCE_INVALID');

    await writeFile(selectionPath, JSON.stringify({ ...valid, manifestSha256: '0'.repeat(64) }));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'BASELINE_SHA256_MISMATCH');

    await writeFile(selectionPath, JSON.stringify({ ...valid, sourceSHA: 'e'.repeat(40), manifestPath: `${'e'.repeat(40)}/manifest.json` }));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'CONFIGURED_BASELINE_MISSING');

    await writeFile(selectionPath, JSON.stringify(valid));
    await unlink(join(bundle.releaseDirectory, bundle.manifest.captures[7].screenshotPath));
    const missingCapture = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(missingCapture.status, 'REJECTED');
    assert.equal(missingCapture.reason, 'BASELINE_CAPTURE_FILE_MISSING');
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('a symlinked Git selection directory is rejected as an unsafe path', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'a05-git-selection-outside-'));
  try {
    await mkdir(join(repositoryRoot, 'tests', 'baselines'), { recursive: true });
    await symlink(outside, join(repositoryRoot, 'tests', 'baselines', 'visual-qa'));
    const result = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.reason, 'BASELINE_SELECTION_PATH_UNSAFE');
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a selected capture file cannot escape its Git baseline directory through a symlink', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-capture-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'a05-git-capture-outside-'));
  try {
    const bundle = await writeGitBaseline(repositoryRoot);
    const screenshot = join(bundle.releaseDirectory, bundle.manifest.captures[0].screenshotPath);
    const outsideFile = join(outside, 'outside.png');
    const bytes = await readFile(screenshot);
    await writeFile(outsideFile, bytes);
    await unlink(screenshot);
    await symlink(outsideFile, screenshot);
    const selected = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(selected.status, 'REJECTED');
    assert.equal(selected.reason, 'BASELINE_CAPTURE_PATH_UNSAFE');
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('compare CLI fails closed when Git and explicit baseline selectors are supplied together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-baseline-selector-conflict-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const comparisonPath = join(directory, 'comparison.json');
    await writeFile(candidatePath, JSON.stringify({ sourceSHA: 'c'.repeat(40) }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--baseline-selection',
      '--baseline-manifest', join(directory, 'artifact-manifest.json'),
      '--baseline-sha256', '0'.repeat(64),
      '--baseline-source-sha', 'a'.repeat(40),
      '--output', comparisonPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(comparisonPath, 'utf8'));
    assert.equal(report.status, 'REJECTED');
    assert.equal(report.reason, 'BASELINE_SOURCE_CONFLICT');
    assert.equal(report.comparisonPerformed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compare CLI refuses to compare publication captures against a Git canonical-root baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-baseline-source-kind-mismatch-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const baselinePath = join(directory, 'canonical-baseline.json');
    const comparisonPath = join(directory, 'comparison.json');
    const baseline = approvedManifest();
    const baselineBytes = Buffer.from(JSON.stringify(baseline));
    await writeFile(baselinePath, baselineBytes);
    await writeFile(candidatePath, JSON.stringify({
      schemaVersion: 3,
      status: 'CAPTURE_ONLY',
      sourceSHA: 'c'.repeat(40),
      siteSourceSHA: 'c'.repeat(40),
      sourceGitSHA: 'c'.repeat(40),
      siteSourceKind: 'publication',
      servedRootRole: 'publication-artifact',
    }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--baseline-manifest', baselinePath,
      '--baseline-sha256', sha256(baselineBytes),
      '--baseline-source-sha', baseline.sourceSHA,
      '--output', comparisonPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BASELINE_SITE_SOURCE_KIND_MISMATCH/);
    await assert.rejects(readFile(comparisonPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a configured but missing baseline fails and never falls back to PENDING', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-configured-missing-baseline-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const missingPath = join(directory, 'configured-baseline', 'manifest.json');
    const comparisonPath = join(directory, 'comparison.json');
    await writeFile(candidatePath, JSON.stringify({ sourceSHA: 'c'.repeat(40) }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--baseline-manifest', missingPath,
      '--baseline-sha256', '0'.repeat(64),
      '--baseline-source-sha', 'a'.repeat(40),
      '--output', comparisonPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(comparisonPath, 'utf8'));
    assert.equal(report.status, 'REJECTED');
    assert.equal(report.reason, 'CONFIGURED_BASELINE_MISSING');
    assert.equal(report.comparisonPerformed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('live deployment evidence stays separate from checkout SHA and detects a mid-capture change', () => {
  const checkoutSHA = 'c'.repeat(40);
  const first = { schemaVersion: 1, provider: 'cloudflare-static-assets', sourceCommit: 'a'.repeat(40), publicArtifactDigest: '1'.repeat(64) };
  const stable = deploymentEvidence(checkoutSHA, first, { ...first });
  assert.equal(stable.checkoutSHA, checkoutSHA);
  assert.equal(stable.sourceSHA, first.sourceCommit);
  assert.notEqual(stable.sourceSHA, checkoutSHA);
  assert.equal(stable.liveDeployment.sourceCommitAtStart, first.sourceCommit);
  assert.equal(stable.verification.status, 'VERIFIED');
  assert.notEqual(stable.checkoutSHA, stable.liveDeployment.sourceCommitAtStart);

  const changed = deploymentEvidence(checkoutSHA, first, { ...first, sourceCommit: 'b'.repeat(40), publicArtifactDigest: '2'.repeat(64) });
  assert.equal(changed.verification.status, 'MIXED_DEPLOYMENT');
  assert.equal(changed.verification.stable, false);
  assert.equal(changed.sourceSHA, null);
  const missing = deploymentEvidence(checkoutSHA, null, first);
  assert.equal(missing.sourceSHA, null);
  assert.equal(missing.checkoutSHA, checkoutSHA);
});

test('identity and gzip Cloudflare negotiation are valid evidence and never mislabeled as Brotli', () => {
  for (const [encoding, label] of [['identity', 'cloudflare-production-identity'], ['gzip', 'cloudflare-production-gzip'], ['br', 'cloudflare-production-br']]) {
    const evidence = cloudflareEncodingEvidence(encoding, true);
    assert.equal(evidence.verified, true);
    assert.equal(evidence.environmentLabel, label);
    assert.equal(evidence.contentEncoding, encoding);
  }
  const gzip = cloudflareEncodingEvidence('gzip', true);
  assert.notEqual(gzip.environmentLabel, 'cloudflare-production-br');
  assert.equal(cloudflareEncodingEvidence('gzip', false).verified, false);
  assert.equal(cloudflareEncodingEvidence(' GZip ', true).contentEncoding, 'GZip');
  assert.deepEqual(compareCaptureConditions({
    environmentLabel: gzip.environmentLabel,
    measurementScope: 'same-scope',
    metrics: { sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation' }
  }, {
    environmentLabel: 'cloudflare-production-identity',
    measurementScope: 'same-scope',
    metrics: { sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation' }
  }), { comparable: false, reason: 'CAPTURE_ENVIRONMENT_LABEL_MISMATCH' });
});

test('403, first-party JavaScript errors and missing visible first-party images invalidate capture; third-party auth remains classified', () => {
  const good = {
    httpStatus: 200,
    conditions: { fontsReady: true },
    pageErrors: [],
    imageState: { firstPartyFailedImageCount: 0 },
    network: [{ originClass: 'same-origin', status: 200, failed: null }],
    screenshotSha256: 'a'.repeat(64)
  };
  assert.equal(evaluateCaptureQuality(good).status, 'COMPLETE');

  const forbidden = evaluateCaptureQuality({ ...good, httpStatus: 403 });
  assert.equal(forbidden.status, 'INCOMPLETE');
  assert(forbidden.failureReasons.includes('HTTP_STATUS_UNEXPECTED'));

  const jsError = evaluateCaptureQuality({ ...good, pageErrors: ['uncaught first-party error'] });
  assert(jsError.failureReasons.includes('FIRST_PARTY_PAGE_ERROR'));

  const missingImage = evaluateCaptureQuality({ ...good, imageState: { firstPartyFailedImageCount: 1 } });
  assert(missingImage.failureReasons.includes('FIRST_PARTY_VISIBLE_IMAGE_FAILED'));

  const externalAuth = evaluateCaptureQuality({ ...good, network: [...good.network, { originClass: 'third-party', status: 403, failed: null }] });
  assert.equal(externalAuth.status, 'COMPLETE');
  assert.equal(externalAuth.thirdPartyFailureCount, 1);

  const externalPageError = evaluateCaptureQuality({ ...good, pageErrors: [{ message: 'blocked vendor error', originClass: 'third-party', sourceUrls: [] }] });
  assert.equal(externalPageError.status, 'COMPLETE');
  assert.equal(externalPageError.thirdPartyPageErrorCount, 1);
});

test('tampered manifest bytes and an unapproved manifest are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-tampered-baseline-'));
  const path = join(directory, 'baseline.json');
  try {
    const manifest = approvedManifest();
    const original = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, original);
    await writeFile(path, Buffer.from(`${original.toString()} `));
    const tampered = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(original),
      expectedSourceSha: manifest.sourceSHA
    });
    assert.equal(tampered.status, 'REJECTED');
    assert.equal(tampered.reason, 'BASELINE_SHA256_MISMATCH');

    const unapproved = Buffer.from(JSON.stringify({ ...manifest, status: 'CAPTURE_ONLY' }));
    await writeFile(path, unapproved);
    const rejected = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(unapproved),
      expectedSourceSha: manifest.sourceSHA
    });
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.reason, 'BASELINE_NOT_APPROVED_OR_UNSUPPORTED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PNG comparison passes identical pixels and reports actual pixel and dimension changes', () => {
  const policy = { pixelThreshold: 0.1, maxDiffRatio: 0.005 };
  const base = png(20, 20, [10, 20, 30]);
  const same = comparePngBuffers(base, png(20, 20, [10, 20, 30]), policy);
  assert.equal(same.status, 'PASS');
  assert.equal(same.changedPixels, 0);

  const changed = PNG.sync.read(base);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const index = (y * changed.width + x) * 4;
      changed.data[index] = 250;
      changed.data[index + 1] = 240;
      changed.data[index + 2] = 230;
    }
  }
  const pixelChange = comparePngBuffers(base, PNG.sync.write(changed), policy);
  assert.equal(pixelChange.status, 'FAIL');
  assert.equal(pixelChange.reason, 'PIXEL_DIFF_THRESHOLD_EXCEEDED');
  assert(pixelChange.changedPixels > 0);
  assert(PNG.sync.read(pixelChange.diffPng));

  const sizeChange = comparePngBuffers(base, png(21, 20, [10, 20, 30]), policy);
  assert.equal(sizeChange.status, 'FAIL');
  assert.equal(sizeChange.reason, 'DIMENSION_MISMATCH');
  assert.notEqual(sizeChange.changedPixels, 0);
  assert.equal(PNG.sync.read(sizeChange.diffPng).width, 21);
});

test('metric comparison catches a new regression against an approved baseline', () => {
  const baseline = { id: 'home-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120 } };
  const candidate = { id: 'home-390', metrics: { sameOriginTransferSizeBytes: 1300, domElementCount: 110 } };
  const result = compareMetrics(candidate, baseline);
  assert.equal(result.status, 'FAIL');
  assert(result.metrics.some(item => item.reason === 'NEW_REGRESSION' && item.metric === 'sameOriginTransferSizeBytes'));
});

test('a resolved exception makes its old approved baseline stale and requires re-approval', () => {
  const baseline = { id: 'gallery-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1800 } };
  const candidate = { id: 'gallery-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1400 } };
  const exceptions = [{ captureId: 'gallery-390', metric: 'domElementCount', limit: 1500, observedValue: 1800, expiresAt: '2026-10-30T00:00:00+08:00' }];
  const result = compareMetrics(candidate, baseline, exceptions);
  assert.equal(result.status, 'STALE_BASELINE');
  assert.equal(result.staleExceptions[0].currentValue, 1400);
});

test('an over-budget baseline exception must match captured measurement and include evidence/task', () => {
  const captures = Array.from({ length: 30 }, (_, index) => ({
    id: `capture-${index}`,
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120 }
  }));
  captures[4] = {
    id: 'gallery-390',
    metadataPath: 'gallery-390.json',
    metadataSha256: 'a'.repeat(64),
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1800 }
  };
  const exception = {
    captureId: 'gallery-390',
    metric: 'domElementCount',
    limit: 1500,
    observedValue: 1800,
    reason: 'Measured gallery nodes retained for the active gallery view.',
    resolutionTask: 'Review the measured gallery DOM and reduce initial nodes without removing the browse flow.',
    evidencePath: 'gallery-390.json',
    expiresAt: '2026-10-30T00:00:00+08:00'
  };
  const manifest = {
    approval: { reviewedAt: '2026-10-18T00:00:00+08:00' },
    captures,
    exceptions: [exception],
  };
  assert.deepEqual(validateBaselineExceptions(manifest, { now: new Date('2026-10-19T00:00:00+08:00') }), { valid: true });
  assert.equal(validateBaselineExceptions({ ...manifest, exceptions: [{ ...exception, observedValue: 6380 }] }, { now: new Date('2026-10-19T00:00:00+08:00') }).reason, 'BASELINE_EXCEPTION_MEASUREMENT_MISMATCH');
  assert.equal(validateBaselineExceptions({ ...manifest, exceptions: [{ ...exception, resolutionTask: '' }] }, { now: new Date('2026-10-19T00:00:00+08:00') }).reason, 'BASELINE_EXCEPTION_EVIDENCE_INCOMPLETE');
  assert.equal(validateBaselineExceptions({ ...manifest, exceptions: [{ ...exception, expiresAt: '2026-10-30T00:00:00' }] }, { now: new Date('2026-10-19T00:00:00+08:00') }).reason, 'BASELINE_EXCEPTION_EXPIRY_INVALID');
  assert.equal(validateBaselineExceptions({ ...manifest, exceptions: [{ ...exception, expiresAt: '2026-02-30T00:00:00+08:00' }] }, { now: new Date('2026-10-19T00:00:00+08:00') }).reason, 'BASELINE_EXCEPTION_EXPIRY_INVALID');
  assert.equal(validateBaselineExceptions(manifest, { now: new Date('2026-10-30T00:00:00+08:00') }).reason, 'BASELINE_EXCEPTION_EXPIRED');
  assert.equal(validateBaselineExceptions({ ...manifest, exceptions: [{ ...exception, expiresAt: '2026-11-18T00:00:00+08:00' }] }, { now: new Date('2026-10-19T00:00:00+08:00') }).reason, 'BASELINE_EXCEPTION_TTL_EXCEEDS_30_DAYS');
});

test('an active exception cannot produce a comparison pass at or after expiresAt', () => {
  const baseline = { id: 'gallery-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1800 } };
  const candidate = { id: 'gallery-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1800 } };
  const exception = { captureId: 'gallery-390', metric: 'domElementCount', limit: 1500, observedValue: 1800, expiresAt: '2026-10-30T00:00:00+08:00' };
  const beforeExpiry = compareMetrics(candidate, baseline, [exception], { now: new Date('2026-10-29T23:59:59+08:00') });
  assert.equal(beforeExpiry.status, 'PASS');
  const worseExceptionMetric = compareMetrics({
    ...candidate,
    metrics: { ...candidate.metrics, domElementCount: 1801 },
  }, baseline, [exception], { now: new Date('2026-10-29T23:59:59+08:00') });
  assert.equal(worseExceptionMetric.status, 'FAIL');
  assert(worseExceptionMetric.metrics.some(item => item.metric === 'domElementCount' && item.reason === 'NEW_REGRESSION'));
  const worseOtherMetric = compareMetrics({
    ...candidate,
    metrics: { ...candidate.metrics, sameOriginTransferSizeBytes: 1201 },
  }, baseline, [exception], { now: new Date('2026-10-29T23:59:59+08:00') });
  assert.equal(worseOtherMetric.status, 'FAIL');
  assert(worseOtherMetric.metrics.some(item => item.metric === 'sameOriginTransferSizeBytes' && item.reason === 'NEW_REGRESSION'));
  const atExpiry = compareMetrics(candidate, baseline, [exception], { now: new Date('2026-10-30T00:00:00+08:00') });
  assert.equal(atExpiry.status, 'FAIL');
  assert(atExpiry.metrics.some(item => item.reason === 'BASELINE_EXCEPTION_EXPIRED'));
});

test('approved baseline source SHA is checked independently from its content hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-source-sha-'));
  const path = join(directory, 'baseline.json');
  try {
    const manifest = approvedManifest();
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, bytes);
    const result = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(bytes),
      expectedSourceSha: 'b'.repeat(40)
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.reason, 'BASELINE_SOURCE_SHA_MISMATCH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a correctly hashed, fully approved baseline is accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-approved-baseline-'));
  const path = join(directory, 'baseline.json');
  try {
    const manifest = approvedManifest();
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, bytes);
    const result = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(bytes),
      expectedSourceSha: manifest.sourceSHA
    });
    assert.equal(result.status, 'APPROVED');
    assert.equal(result.actualSha256, sha256(bytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
