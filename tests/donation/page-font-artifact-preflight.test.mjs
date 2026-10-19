import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { errorRecord, runPageFontArtifactPreflight, writePageFontArtifactReport } from './page-font-artifact-preflight.mjs';
import { safeBrowserDiagnosticText } from './page-font-artifact-diagnostics.mjs';

const fontPath = 'assets/fonts/huiwen-site-sans/huiwen-site-sans-tc-20261007.woff2';

function initialResults() {
  const downstreamPhases = [
    'representativeSamples', 'schemaRoutes', 'initialFontNetwork', 'crossMonth', 'dynamicSearch',
    'legacyRoutes', 'cmsPreview', 'cmsNegativeGuards', 'topLevelCmsGuard', 'finalAssertions',
  ];
  return {
    source: { script: 'tests/donation/page-font-artifact.mjs', artifactRoot: '_site' },
    head: { commit: 'test-head', githubSha: 'test-head', githubRef: 'test-ref' },
    runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
    preflight: { status: 'not-run' },
    initialFontNetwork: { status: 'not-run' },
    serviceInitial: { status: 'not-run' },
    legacyRoutes: [],
    cmsPreview: { status: 'not-run' },
    negativeGuards: {},
    execution: {
      status: 'running', currentPhase: null, primaryError: null, secondaryErrors: [],
      phases: {
        preflight: { status: 'not-run' },
        ...Object.fromEntries(downstreamPhases.map((name) => [name, { status: 'not-run' }])),
      },
    },
  };
}

async function runCase(prepareArtifacts) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'page-font-preflight-'));
  const artifactRoot = join(tempRoot, 'artifact');
  const reportPath = join(tempRoot, 'results', 'report.json');
  await mkdir(artifactRoot, { recursive: true });
  await prepareArtifacts(artifactRoot);
  const results = initialResults();
  let thrown;
  try {
    await runPageFontArtifactPreflight({
      artifactRoot,
      fullTcPath: fontPath,
      expectedBytes: 783820,
      reportPath,
      results,
    });
  } catch (error) {
    thrown = error;
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await rm(tempRoot, { recursive: true, force: true });
  return { thrown, report };
}

async function writeFont(artifactRoot, bytes) {
  const fontFile = join(artifactRoot, fontPath);
  await mkdir(join(artifactRoot, 'assets/fonts/huiwen-site-sans'), { recursive: true });
  await writeFile(fontFile, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeManifest(artifactRoot, contents = '{}') {
  const bytes = Buffer.from(contents);
  await writeFile(join(artifactRoot, 'page-font-manifest.json'), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertTerminalPreflightFailure(prepareArtifacts, expectedError) {
  const { thrown, report } = await runCase(prepareArtifacts);
  assert.ok(thrown, 'preflight failure unexpectedly returned success');
  assert.equal(thrown.name, expectedError.name);
  assert.match(thrown.message, expectedError.message);
  assert.equal(report.preflight.status, 'failed');
  assert.equal(report.execution.status, 'failed');
  assert.equal(report.execution.primarySource, 'preflight');
  assert.equal(report.execution.primaryError.name, thrown.name);
  assert.equal(report.execution.primaryError.message, thrown.message.slice(0, 1200));
  assert.equal(report.execution.phases.preflight.status, 'failed');
  assert.equal(report.execution.phases.preflight.error.message, thrown.message.slice(0, 1200));
  for (const [name, phase] of Object.entries(report.execution.phases)) {
    if (name !== 'preflight') assert.equal(phase.status, 'not-run', `${name} ran after preflight failed`);
  }
  assert.equal(report.initialFontNetwork.status, 'not-run');
  assert.equal(report.serviceInitial.status, 'not-run');
  assert.equal(report.cmsPreview.status, 'not-run');
  assert.deepEqual(report.legacyRoutes, []);
  assert.deepEqual(report.negativeGuards, {});
  assert.equal(report.source.script, 'tests/donation/page-font-artifact.mjs');
  assert.ok(report.head.commit);
  assert.equal(report.runtime.nodeVersion, process.version);
}

test('missing manifest writes a terminal preflight report and preserves the read error', async () => {
  await assertTerminalPreflightFailure(async (artifactRoot) => {
    await writeFont(artifactRoot, Buffer.from('font fixture'));
    await writeManifest(artifactRoot);
  }, { name: 'Error', message: /publication-manifest\.json/ });
});

test('malformed JSON writes a terminal preflight report with the parse error', async () => {
  await assertTerminalPreflightFailure(async (artifactRoot) => {
    await writeFile(join(artifactRoot, 'publication-manifest.json'), '{');
  }, { name: 'SyntaxError', message: /JSON|property|position|end/i });
});

test('SHA mismatch writes a terminal preflight report with the assertion error', async () => {
  await assertTerminalPreflightFailure(async (artifactRoot) => {
    const pageFontManifestSha = await writeManifest(artifactRoot);
    await writeFile(join(artifactRoot, 'publication-manifest.json'), JSON.stringify({ files: {
      [fontPath]: '0'.repeat(64), 'page-font-manifest.json': pageFontManifestSha,
    } }));
    await writeFont(artifactRoot, Buffer.from('font fixture'));
  }, { name: 'AssertionError', message: /strictly equal|Expected values/ });
});

test('page-font manifest bytes must match the publication manifest digest', async () => {
  await assertTerminalPreflightFailure(async (artifactRoot) => {
    await writeManifest(artifactRoot);
    await writeFile(join(artifactRoot, 'publication-manifest.json'), JSON.stringify({ files: {
      [fontPath]: '0'.repeat(64),
      'page-font-manifest.json': '0'.repeat(64),
    } }));
    await writeFont(artifactRoot, Buffer.from('font fixture'));
  }, { name: 'AssertionError', message: /page-font manifest bytes differ from the publication manifest/ });
});

test('font size mismatch writes a terminal preflight report with the assertion error', async () => {
  await assertTerminalPreflightFailure(async (artifactRoot) => {
    const bytes = Buffer.from('font fixture');
    const sha = await writeFont(artifactRoot, bytes);
    const pageFontManifestSha = await writeManifest(artifactRoot);
    await writeFile(join(artifactRoot, 'publication-manifest.json'), JSON.stringify({ files: {
      [fontPath]: sha, 'page-font-manifest.json': pageFontManifestSha,
    } }));
  }, { name: 'AssertionError', message: /strictly equal|Expected values/ });
});

test('CMS diagnostic redaction removes secret values before truncation and strips URL queries', () => {
  const session = 'synthetic-session-boundary-value';
  const acrossBoundary = `${'x'.repeat(3998)}${session} must not leave a prefix`;
  const safeBoundary = safeBrowserDiagnosticText(acrossBoundary, [session]);
  assert.ok(safeBoundary.length <= 4000);
  assert.equal(safeBoundary.includes(session), false);
  assert.equal(safeBoundary.includes(session.slice(0, 8)), false);

  const url = `CMS error at https://admin.huiwen.tw/api/page-preview?path=news.html&session=${session}&cmsEdit=1`;
  const safeUrl = safeBrowserDiagnosticText(url, [session]);
  assert.match(safeUrl, /https:\/\/admin\.huiwen\.tw\/api\/page-preview/);
  assert.equal(safeUrl.includes('?path='), false);
  assert.equal(safeUrl.includes(session), false);

  const errorBoundary = errorRecord(new Error(`${'y'.repeat(1198)}${session}`), [session]);
  assert.equal(errorBoundary.message.includes(session.slice(0, 8)), false);
});

test('primary CMS error records are redacted in report bytes while type, stack, and failure state remain', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'page-font-cms-diagnostics-'));
  const reportPath = join(tempRoot, 'report.json');
  const session = 'synthetic-cms-session-value';
  const accessAssertion = 'synthetic-cms-access-assertion-value';
  const nonce = 'synthetic-cms-handshake-nonce-value';
  const secrets = [session, accessAssertion, nonce];
  const message = `CMS handshake failed: ${session}; ${accessAssertion}; ${nonce}; https://admin.huiwen.tw/api/page-preview?path=news.html&session=${session}&cmsEdit=1`;
  const thrown = new TypeError(message);
  thrown.stack = `TypeError: ${message}\n    at readHandshake (/repo/tests/donation/page-font-artifact.mjs:42:7)`;
  const record = errorRecord(thrown);
  const results = {
    fatalError: record,
    cmsPreview: { status: 'failed', error: record, handshake: { step: 'ready', nonce } },
    negativeGuards: { unauthenticated: { status: 'failed', error: record } },
    execution: {
      status: 'failed', primarySource: 'cmsPreview', primaryError: record,
      phases: { cmsPreview: { status: 'failed', error: record } },
    },
  };

  try {
    await writePageFontArtifactReport(reportPath, results, secrets);
    const bytes = await readFile(reportPath);
    const serialized = bytes.toString('utf8');
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('?path='), false);
    assert.match(serialized, /https:\/\/admin\.huiwen\.tw\/api\/page-preview/);
    assert.match(serialized, /page-font-artifact\.mjs:42:7/);

    const report = JSON.parse(serialized);
    assert.equal(report.fatalError.name, 'TypeError');
    assert.match(report.execution.primaryError.message, /CMS handshake failed/);
    assert.match(report.execution.primaryError.stack, /page-font-artifact\.mjs:42:7/);
    assert.equal(report.execution.status, 'failed');
    assert.equal(report.cmsPreview.status, 'failed');
    assert.equal(report.negativeGuards.unauthenticated.status, 'failed');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
