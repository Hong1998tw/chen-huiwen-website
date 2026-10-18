import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactName = 'a05-approved-baseline';
const maxArchiveBytes = 100 * 1024 * 1024;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function readResponseBytes(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('BASELINE_ARCHIVE_SIZE_INVALID');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function main() {
  const artifactId = process.env.VISUAL_QA_BASELINE_ARTIFACT_ID ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  const tempRoot = process.env.RUNNER_TEMP ?? tmpdir();
  if (!/^\d+$/.test(artifactId) || !Number.isSafeInteger(Number(artifactId))) throw new Error('BASELINE_ARTIFACT_ID_INVALID');
  if (!repositoryPattern.test(repository)) throw new Error('CURRENT_REPOSITORY_INVALID');
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');

  const outputDir = resolve(tempRoot, 'a05-approved-baseline');
  const archivePath = resolve(tempRoot, 'a05-approved-baseline.zip');
  if (!outputDir.startsWith(resolve(tempRoot) + '/') || !archivePath.startsWith(resolve(tempRoot) + '/')) {
    throw new Error('BASELINE_TEMP_PATH_INVALID');
  }
  await rm(outputDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(dirname(archivePath), { recursive: true });

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28'
  };
  const apiRoot = `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`;
  let metadataResponse;
  try { metadataResponse = await fetch(apiRoot, { headers, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('BASELINE_ARTIFACT_METADATA_UNAVAILABLE'); }
  if (!metadataResponse.ok) throw new Error(`BASELINE_ARTIFACT_METADATA_HTTP_${metadataResponse.status}`);
  let metadata;
  try { metadata = await metadataResponse.json(); }
  catch { throw new Error('BASELINE_ARTIFACT_METADATA_INVALID'); }
  if (metadata.id !== Number(artifactId) || metadata.name !== artifactName || metadata.expired !== false ||
      !Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes <= 0 || metadata.size_in_bytes > maxArchiveBytes) {
    throw new Error('BASELINE_ARTIFACT_METADATA_REJECTED');
  }

  let zipResponse;
  try { zipResponse = await fetch(`${apiRoot}/zip`, { headers, signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('BASELINE_ARTIFACT_DOWNLOAD_FAILED'); }
  if (!zipResponse.ok || !zipResponse.body) throw new Error(`BASELINE_ARTIFACT_DOWNLOAD_HTTP_${zipResponse.status}`);
  let archiveBytes;
  try { archiveBytes = await readResponseBytes(zipResponse, maxArchiveBytes); }
  catch (error) {
    if (error?.message === 'BASELINE_ARCHIVE_SIZE_INVALID') throw error;
    throw new Error('BASELINE_ARTIFACT_DOWNLOAD_FAILED');
  }
  if (!archiveBytes.length) throw new Error('BASELINE_ARCHIVE_EMPTY');
  if (metadata.digest) {
    const actualDigest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;
    if (metadata.digest !== actualDigest) throw new Error('BASELINE_ARTIFACT_DIGEST_MISMATCH');
  }
  await writeFile(archivePath, archiveBytes, { mode: 0o600 });

  const verifier = resolve(root, 'scripts/verify_visual_qa_baseline_archive.py');
  const policy = resolve(root, 'tests/donation/visual-qa-policy.json');
  const python = process.env.VISUAL_QA_PYTHON ?? 'python3';
  const verifierEnv = { PATH: process.env.PATH ?? '' };
  if (process.env.LANG) verifierEnv.LANG = process.env.LANG;
  const extracted = spawnSync(python, [verifier, archivePath, outputDir, '--policy', policy], { encoding: 'utf8', env: verifierEnv });
  if (extracted.status !== 0) {
    const reason = (extracted.stderr || extracted.stdout || 'BASELINE_ARCHIVE_REJECTED').trim().split('\n').at(-1);
    throw new Error(reason);
  }
  let receipt;
  try { receipt = JSON.parse(extracted.stdout); }
  catch { throw new Error('BASELINE_ARCHIVE_RECEIPT_INVALID'); }
  process.stdout.write(`${JSON.stringify({ artifactId: Number(artifactId), artifactName, ...receipt })}\n`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.message ?? 'BASELINE_DOWNLOAD_FAILED')}\n`);
  process.exitCode = 1;
});
