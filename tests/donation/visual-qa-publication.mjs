import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readGitCheckoutIdentity } from './visual-qa-identity.mjs';

const NOFOLLOW = fsConstants.O_NOFOLLOW;
const SHA40 = /^[a-f0-9]{40}$/i;
const SHA64 = /^[a-f0-9]{64}$/;
export const PUBLICATION_WRAPPERS = Object.freeze([
  'deployment.json',
  '_headers',
  '_redirects',
  'publication-manifest.json',
]);

const PRIVATE_PATHS = new Set([
  'data/case-context.json',
  'data/deployment-target.json',
  'data/deployment-request.json',
  'scripts/build_all.py',
  'admin/wrangler.jsonc',
]);
const PRIVATE_SEGMENTS = new Set([
  '.git', '.github', '.codex', '.agents', 'node_modules', '__pycache__',
  'secrets', 'credentials', 'private', 'internal',
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)["']\s*:\s*["'][^"']{8,}["']/i,
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') ||
      path.startsWith('/') || /^[a-z]:/i.test(path) || path.startsWith('//')) {
    throw new Error(`Publication manifest contains an unsafe path: ${String(path)}`);
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Publication manifest contains an unsafe path: ${path}`);
  }
  const lowerPath = path.toLowerCase();
  const lowerParts = parts.map(part => part.toLowerCase());
  if (PRIVATE_PATHS.has(lowerPath) || lowerParts.some(part =>
    PRIVATE_SEGMENTS.has(part) || /^\.env(?:\.|$)/.test(part) ||
    /^(?:credentials|secrets?)(?:\.|$)/.test(part))) {
    throw new Error(`Publication artifact contains a private path: ${path}`);
  }
  return path;
}

function assertSecretFree(path, bytes) {
  const content = bytes.toString('utf8');
  if (SECRET_PATTERNS.some(pattern => pattern.test(content))) {
    throw new Error(`Publication artifact contains a secret-like value in ${path}.`);
  }
}

async function readRegularFileWithoutFollowingLinks(path, label) {
  if (typeof NOFOLLOW !== 'number') throw new Error('This runtime does not support no-follow publication reads.');
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`${label} must be a regular, single-link file: ${path}`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while opening: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== bytes.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${label} changed while reading: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function walkArtifact(root) {
  const files = new Map();
  const directories = new Set();
  const pending = [''];
  while (pending.length) {
    const current = pending.pop();
    const absoluteDirectory = current ? resolve(root, ...current.split('/')) : root;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      const relativePath = current ? `${current}/${entry.name}` : entry.name;
      safeRelativePath(relativePath);
      const absolutePath = resolve(root, ...relativePath.split('/'));
      if (!isWithin(root, absolutePath)) throw new Error(`Publication artifact path escaped its root: ${relativePath}`);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`Publication artifact contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        directories.add(relativePath);
        pending.push(relativePath);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(`Publication artifact contains a non-regular or hard-linked file: ${relativePath}`);
      }
      files.set(relativePath, { absolutePath, size: info.size });
    }
  }
  return { files, directories };
}

function expectedDirectories(filePaths) {
  const directories = new Set();
  for (const path of filePaths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  return directories;
}

function sameSet(first, second) {
  return first.size === second.size && [...first].every(value => second.has(value));
}

function validateJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

async function assertSourceCheckout(sourceRoot, expectedSourceGitSHA) {
  const source = await readGitCheckoutIdentity(sourceRoot, 'site source');
  const status = execFileSync('git', ['-C', source.root, 'status', '--porcelain=v1', '-uall'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  if (!SHA40.test(expectedSourceGitSHA ?? '') || source.headSha !== expectedSourceGitSHA.toLowerCase() || status) {
    throw new Error('Publication artifact source must match the actual clean site-source Git HEAD.');
  }
  return source;
}

export async function validatePublicationArtifact({ artifactRoot, sourceRoot, sourceGitSHA }) {
  if (typeof artifactRoot !== 'string' || !artifactRoot.trim()) {
    throw new Error('--public-artifact requires a built publication directory.');
  }
  const source = await assertSourceCheckout(sourceRoot, sourceGitSHA);
  const requestedRoot = resolve(artifactRoot);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Publication artifact root must be an existing real directory.');
  }
  const artifact = await realpath(requestedRoot);
  if (isWithin(source.root, artifact) || isWithin(artifact, source.root)) {
    throw new Error('Publication artifact must be separate from the Git site source root.');
  }

  const { files: actualFiles, directories: actualDirectories } = await walkArtifact(artifact);
  const wrapperSet = new Set(PUBLICATION_WRAPPERS);
  for (const wrapper of PUBLICATION_WRAPPERS) {
    if (!actualFiles.has(wrapper)) throw new Error(`Publication artifact is missing required wrapper: ${wrapper}`);
  }
  const manifestBytes = await readRegularFileWithoutFollowingLinks(resolve(artifact, 'publication-manifest.json'), 'Publication manifest');
  const deploymentBytes = await readRegularFileWithoutFollowingLinks(resolve(artifact, 'deployment.json'), 'Deployment receipt');
  const headersBytes = await readRegularFileWithoutFollowingLinks(resolve(artifact, '_headers'), 'Headers wrapper');
  const redirectsBytes = await readRegularFileWithoutFollowingLinks(resolve(artifact, '_redirects'), 'Redirects wrapper');
  for (const [path, bytes] of [
    ['publication-manifest.json', manifestBytes],
    ['deployment.json', deploymentBytes],
    ['_headers', headersBytes],
    ['_redirects', redirectsBytes],
  ]) assertSecretFree(path, bytes);

  let publication;
  let deployment;
  try {
    publication = JSON.parse(manifestBytes.toString('utf8'));
    deployment = JSON.parse(deploymentBytes.toString('utf8'));
  } catch {
    throw new Error('Publication manifest or deployment receipt is not valid JSON.');
  }
  validateJsonObject(publication, 'Publication manifest');
  validateJsonObject(deployment, 'Deployment receipt');
  const declaredFiles = publication.files;
  if (!declaredFiles || typeof declaredFiles !== 'object' || Array.isArray(declaredFiles) || Object.keys(declaredFiles).length === 0) {
    throw new Error('Publication manifest must contain a non-empty files map.');
  }
  const payloadPaths = Object.keys(declaredFiles).map(safeRelativePath).sort();
  if (payloadPaths.some(path => wrapperSet.has(path))) {
    throw new Error('Publication payload map must not contain delivery wrappers.');
  }
  const allExpectedFiles = new Set([...payloadPaths, ...PUBLICATION_WRAPPERS]);
  if (!sameSet(new Set(actualFiles.keys()), allExpectedFiles)) {
    const missing = [...allExpectedFiles].filter(path => !actualFiles.has(path));
    const extra = [...actualFiles.keys()].filter(path => !allExpectedFiles.has(path));
    throw new Error(`Publication artifact file set differs from its manifest (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`);
  }
  if (!sameSet(actualDirectories, expectedDirectories(allExpectedFiles))) {
    throw new Error('Publication artifact directory set does not exactly match its declared file tree.');
  }

  const rawManifestSha256 = sha256(manifestBytes);
  if (deployment.schemaVersion !== 1 || deployment.provider !== 'cloudflare-static-assets' ||
      !SHA40.test(deployment.sourceCommit ?? '') || deployment.sourceCommit.toLowerCase() !== source.headSha ||
      deployment.sourceCommit.toLowerCase() !== sourceGitSHA.toLowerCase()) {
    throw new Error('Publication deployment sourceCommit does not match the clean site-source Git HEAD.');
  }
  if (!SHA64.test(deployment.publicArtifactDigest ?? '') || deployment.publicArtifactDigest !== rawManifestSha256) {
    throw new Error('Publication deployment digest does not match the raw publication manifest bytes.');
  }
  if (!Number.isSafeInteger(deployment.publicFileCount) || deployment.publicFileCount !== payloadPaths.length) {
    throw new Error('Publication deployment file count does not match the payload manifest.');
  }
  if (publication.publicRecordCount !== undefined &&
      (!Number.isSafeInteger(publication.publicRecordCount) || publication.publicRecordCount < 0 ||
       deployment.publicRecordCount !== publication.publicRecordCount)) {
    throw new Error('Publication manifest and deployment record counts do not match.');
  }
  if (publication.version !== undefined && !Number.isSafeInteger(publication.version)) {
    throw new Error('Publication manifest version is invalid.');
  }

  const payloads = [];
  let payloadBytes = 0;
  for (const path of payloadPaths) {
    const declaredSha256 = declaredFiles[path];
    if (typeof declaredSha256 !== 'string' || !SHA64.test(declaredSha256)) {
      throw new Error(`Publication manifest contains an invalid payload SHA-256: ${path}`);
    }
    const bytes = await readRegularFileWithoutFollowingLinks(actualFiles.get(path).absolutePath, 'Publication payload');
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith('.json') || lowerPath.endsWith('.jsonc')) assertSecretFree(path, bytes);
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== declaredSha256) throw new Error(`Publication payload SHA-256 mismatch: ${path}`);
    payloadBytes += bytes.length;
    if (!Number.isSafeInteger(payloadBytes)) throw new Error('Publication payload byte count exceeds the safe integer range.');
    payloads.push({ path, sha256: actualSha256, bytes: bytes.length });
  }
  const wrapperFiles = {};
  for (const [path, bytes] of [
    ['deployment.json', deploymentBytes],
    ['_headers', headersBytes],
    ['_redirects', redirectsBytes],
    ['publication-manifest.json', manifestBytes],
  ]) {
    wrapperFiles[path] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const payloadInventorySha256 = sha256(Buffer.from(stableStringify(payloads)));
  const wrapperInventorySha256 = sha256(Buffer.from(stableStringify(wrapperFiles)));
  return {
    status: 'VERIFIED',
    servedRootRole: 'publication-artifact',
    sourceGitSHA: source.headSha,
    deploymentSourceCommit: deployment.sourceCommit.toLowerCase(),
    publicArtifactDigest: deployment.publicArtifactDigest,
    rawManifestSha256,
    payloadFileCount: payloads.length,
    publicFileCount: deployment.publicFileCount,
    payloadBytes,
    payloadInventorySha256,
    payloads,
    wrapperInventorySha256,
    wrapperFiles,
    artifactRoot: artifact,
  };
}

export function assertSamePublicationArtifact(before, after) {
  if (!before || !after || before.status !== 'VERIFIED' || after.status !== 'VERIFIED' ||
      before.servedRootRole !== 'publication-artifact' || after.servedRootRole !== 'publication-artifact' ||
      before.sourceGitSHA !== after.sourceGitSHA ||
      before.deploymentSourceCommit !== after.deploymentSourceCommit ||
      before.publicArtifactDigest !== after.publicArtifactDigest ||
      before.rawManifestSha256 !== after.rawManifestSha256 ||
      before.payloadFileCount !== after.payloadFileCount || before.publicFileCount !== after.publicFileCount ||
      before.payloadBytes !== after.payloadBytes ||
      before.payloadInventorySha256 !== after.payloadInventorySha256 ||
      before.wrapperInventorySha256 !== after.wrapperInventorySha256 ||
      before.artifactRoot !== after.artifactRoot) {
    throw new Error('Publication artifact integrity changed during A-05 capture.');
  }
}

export function publicationMetadataIdentity(attestation) {
  if (!attestation) return null;
  return {
    status: attestation.status,
    servedRootRole: attestation.servedRootRole,
    sourceGitSHA: attestation.sourceGitSHA,
    deploymentSourceCommit: attestation.deploymentSourceCommit,
    publicArtifactDigest: attestation.publicArtifactDigest,
    rawManifestSha256: attestation.rawManifestSha256,
    publicFileCount: attestation.publicFileCount,
    payloadFileCount: attestation.payloadFileCount,
    payloadBytes: attestation.payloadBytes,
    payloadInventorySha256: attestation.payloadInventorySha256,
    wrapperInventorySha256: attestation.wrapperInventorySha256,
    wrapperFiles: attestation.wrapperFiles,
  };
}

export function validatePublicationIdentityRecord(record, expectedSourceGitSHA) {
  const artifact = record?.publicationArtifact;
  if (record?.siteSourceKind !== 'publication' || record?.servedRootRole !== 'publication-artifact' ||
      !artifact || artifact.status !== 'VERIFIED' || artifact.servedRootRole !== 'publication-artifact' ||
      artifact.sourceGitSHA !== expectedSourceGitSHA || artifact.deploymentSourceCommit !== expectedSourceGitSHA ||
      artifact.publicArtifactDigest !== artifact.rawManifestSha256 || !SHA64.test(artifact.rawManifestSha256 ?? '') ||
      !Number.isSafeInteger(artifact.publicFileCount) || artifact.publicFileCount <= 0 ||
      artifact.payloadFileCount !== artifact.publicFileCount || !Number.isSafeInteger(artifact.payloadBytes) || artifact.payloadBytes < 0 ||
      !SHA64.test(artifact.payloadInventorySha256 ?? '') || !SHA64.test(artifact.wrapperInventorySha256 ?? '') ||
      !artifact.wrapperFiles || PUBLICATION_WRAPPERS.some(path =>
        !SHA64.test(artifact.wrapperFiles[path]?.sha256 ?? '') || !Number.isSafeInteger(artifact.wrapperFiles[path]?.bytes) || artifact.wrapperFiles[path].bytes < 0) ||
      Object.keys(artifact.wrapperFiles).length !== PUBLICATION_WRAPPERS.length ||
      sha256(Buffer.from(stableStringify(artifact.wrapperFiles))) !== artifact.wrapperInventorySha256) {
    return false;
  }
  if (record.sourceGitSHA !== expectedSourceGitSHA || record.sourceSHA !== expectedSourceGitSHA ||
      record.siteSourceSHA !== expectedSourceGitSHA) return false;
  if (record.publicationPayloads !== undefined) {
    if (!Array.isArray(record.publicationPayloads) || record.publicationPayloads.length !== artifact.payloadFileCount) return false;
    const seen = new Set();
    let totalBytes = 0;
    let previousPath = '';
    for (const payload of record.publicationPayloads) {
      try { safeRelativePath(payload.path); } catch { return false; }
      if (seen.has(payload.path) || payload.path <= previousPath || !SHA64.test(payload.sha256 ?? '') || !Number.isSafeInteger(payload.bytes) || payload.bytes < 0) return false;
      seen.add(payload.path);
      previousPath = payload.path;
      totalBytes += payload.bytes;
    }
    if (totalBytes !== artifact.payloadBytes ||
        sha256(Buffer.from(stableStringify(record.publicationPayloads))) !== artifact.payloadInventorySha256) return false;
  }
  return true;
}

export function siteSourceKind(record) {
  return record?.siteSourceKind ?? 'git-canonical-root';
}

export function validateSiteSourceKindRecord(record, expectedSourceGitSHA = record?.siteSourceSHA ?? record?.sourceSHA) {
  const kind = siteSourceKind(record);
  if (kind === 'git-canonical-root') {
    return (record?.servedRootRole === undefined || record.servedRootRole === 'git-canonical-root') &&
      (record?.sourceGitSHA === undefined || record.sourceGitSHA === expectedSourceGitSHA) &&
      (record?.sourceSHA === undefined || record.sourceSHA === expectedSourceGitSHA) &&
      (record?.siteSourceSHA === undefined || record.siteSourceSHA === expectedSourceGitSHA);
  }
  if (kind !== 'publication') return false;
  return validatePublicationIdentityRecord(record, expectedSourceGitSHA);
}

export function validatePublicationManifestRecord(manifest) {
  const kind = siteSourceKind(manifest);
  if (!validateSiteSourceKindRecord(manifest, manifest?.siteSourceSHA ?? manifest?.sourceSHA)) return false;
  if (kind !== 'publication') return kind === 'git-canonical-root';
  if (!Array.isArray(manifest.captures) || !Array.isArray(manifest.publicationPayloads)) return false;
  const summary = stableStringify(manifest.publicationArtifact);
  const payloads = stableStringify(manifest.publicationPayloads);
  return manifest.captures.every(capture =>
    validatePublicationIdentityRecord(capture, manifest.sourceGitSHA) &&
    stableStringify(capture.publicationArtifact) === summary &&
    stableStringify(capture.publicationPayloads) === payloads);
}
