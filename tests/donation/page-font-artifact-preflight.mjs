import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function errorRecord(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error).slice(0, 1200),
    stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n').slice(0, 1200) : null,
  };
}

export async function writePageFontArtifactReport(reportPath, results) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(results, null, 2) + '\n');
}

async function readAndVerifyArtifacts({ artifactRoot, fullTcPath, expectedBytes }) {
  const publication = JSON.parse(await readFile(resolve(artifactRoot, 'publication-manifest.json'), 'utf8'));
  const fontManifestBytes = await readFile(resolve(artifactRoot, 'page-font-manifest.json'));
  const fontManifestSha = createHash('sha256').update(fontManifestBytes).digest('hex');
  assert.equal(fontManifestSha, publication.files['page-font-manifest.json'],
    'page-font manifest bytes differ from the publication manifest');
  const fontManifest = JSON.parse(fontManifestBytes.toString('utf8'));
  for (const [path, font] of Object.entries(fontManifest.fonts || {})) {
    assert.equal(font.sha256, publication.files[path],
      `page-font producer digest for ${path} differs from the publication manifest`);
  }
  const fullTcBytes = await readFile(resolve(artifactRoot, fullTcPath));
  const fullTcSha = createHash('sha256').update(fullTcBytes).digest('hex');
  assert.equal(fullTcSha, publication.files[fullTcPath]);
  assert.equal(fullTcBytes.byteLength, expectedBytes);
  return { publication, fontManifest, fullTcSha };
}

export async function runPageFontArtifactPreflight({
  artifactRoot,
  fullTcPath,
  expectedBytes,
  reportPath,
  results,
}) {
  const phase = results.execution.phases.preflight;
  results.preflight.status = 'running';
  results.execution.currentPhase = 'preflight';
  phase.status = 'running';
  await writePageFontArtifactReport(reportPath, results);

  let artifacts;
  try {
    artifacts = await readAndVerifyArtifacts({ artifactRoot, fullTcPath, expectedBytes });
  } catch (error) {
    const record = errorRecord(error);
    results.preflight.status = 'failed';
    results.preflight.error = record;
    phase.status = 'failed';
    phase.error = record;
    results.fatalError = record;
    results.execution.primaryError = record;
    results.execution.primarySource = 'preflight';
    results.execution.status = 'failed';
    try {
      await writePageFontArtifactReport(reportPath, results);
    } catch (reportError) {
      results.reportWriteError = errorRecord(reportError);
    }
    throw error;
  }

  results.preflight.status = 'passed';
  phase.status = 'completed';
  results.execution.currentPhase = null;
  await writePageFontArtifactReport(reportPath, results);
  return artifacts;
}
