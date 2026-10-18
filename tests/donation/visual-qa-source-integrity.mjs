import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

const NOFOLLOW = fsConstants.O_NOFOLLOW;

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertMetadataPath(root, metadataPath, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) ||
      typeof metadataPath !== 'string' || metadataPath !== `${id}.json` || basename(metadataPath) !== metadataPath) {
    throw new Error('Capture metadata path must be a flat id.json file in the current output directory.');
  }
  const target = resolve(root, metadataPath);
  if (dirname(target) !== root || !isWithin(root, target)) {
    throw new Error('Capture metadata path escaped the current output directory.');
  }
  return target;
}

export function createMetadataPathRegistry({ runOutput, outputRoot }) {
  const root = resolve(runOutput);
  const parent = resolve(outputRoot);
  if (root === parent || dirname(root) !== parent || !['local-http-uncompressed', 'cloudflare-production'].includes(basename(root))) {
    throw new Error('Capture metadata registry must be scoped to one environment output directory.');
  }
  const entries = new Map();
  return {
    runOutput: root,
    outputRoot: parent,
    register(id, metadataPath) {
      assertMetadataPath(root, metadataPath, id);
      const existing = entries.get(metadataPath);
      if (existing && existing.id !== id) throw new Error('Capture metadata path was registered to multiple captures.');
      entries.set(metadataPath, { id, metadataPath });
    },
    list() {
      return [...entries.values()].map(entry => ({ ...entry }));
    },
  };
}

async function ensureDirectoryTreeWithoutSymlinks(target) {
  const wanted = resolve(target);
  const missing = [];
  let cursor = wanted;
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Capture output directory is not a real directory: ${cursor}`);
      }
      const canonical = await realpath(cursor);
      if (canonical !== cursor) throw new Error(`Capture output directory resolves through a symlink: ${cursor}`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  for (const part of missing) {
    cursor = resolve(cursor, part);
    try {
      await mkdir(cursor);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(cursor) !== cursor) {
      throw new Error(`Capture output directory is not a safe new directory: ${cursor}`);
    }
  }
  return wanted;
}

async function ensureRegistryOutput(registry) {
  await ensureDirectoryTreeWithoutSymlinks(registry.outputRoot);
  await ensureDirectoryTreeWithoutSymlinks(registry.runOutput);
}

export async function prepareCaptureOutput(registry) {
  await ensureRegistryOutput(registry);
}

async function writeFileWithoutFollowingSymlinks(path, bytes) {
  if (typeof NOFOLLOW !== 'number') throw new Error('This runtime does not support no-follow metadata writes.');
  try {
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
      throw new Error(`Refusing to write unsafe capture metadata file: ${path}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Refusing to write unsafe capture metadata file: ${path}`);
    await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function readFileWithoutFollowingSymlinks(path) {
  if (typeof NOFOLLOW !== 'number') throw new Error('This runtime does not support no-follow metadata reads.');
  const pathInfo = await lstat(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
    throw new Error(`Refusing to read unsafe capture metadata file: ${path}`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Refusing to read unsafe capture metadata file: ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function writeCaptureMetadata({ registry, id, metadataPath, record }) {
  if (!registry || typeof registry.register !== 'function') throw new Error('Capture metadata registry is required.');
  registry.register(id, metadataPath);
  await ensureRegistryOutput(registry);
  const path = assertMetadataPath(registry.runOutput, metadataPath, id);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await writeFileWithoutFollowingSymlinks(path, bytes);
  return sha256(bytes);
}

export async function invalidateSourceMetadata({
  registry,
  captures,
  expectedHeadSha,
  claimedSourceSHAAtStart,
  reason,
  captureError = null,
}) {
  const errors = [];
  try {
    await ensureRegistryOutput(registry);
  } catch (error) {
    errors.push(error);
    return errors;
  }

  const invalidatedMetadata = [];
  for (const entry of registry.list()) {
    const path = assertMetadataPath(registry.runOutput, entry.metadataPath, entry.id);
    let priorBytes;
    try {
      priorBytes = await readFileWithoutFollowingSymlinks(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      errors.push(error);
      continue;
    }

    const capture = captures.find(item => item.metadataPath === entry.metadataPath) ?? null;
    let prior = null;
    try {
      prior = JSON.parse(priorBytes.toString('utf8'));
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) prior = null;
    } catch {}
    const baseRecord = prior ?? capture ?? { id: entry.id, metadataPath: entry.metadataPath };
    const claimedAtStart = claimedSourceSHAAtStart ?? baseRecord.claimedSourceSHAAtStart ??
      baseRecord.siteSourceSHA ?? baseRecord.sourceSHA ?? null;
    const invalidated = {
      ...baseRecord,
      sourceSHA: null,
      siteSourceSHA: null,
      claimedSourceSHAAtStart: claimedAtStart,
      siteSourceIntegrityStatus: 'FAILED',
      sourceIntegrity: {
        status: 'FAILED',
        expectedHeadSha: expectedHeadSha ?? null,
        claimedSourceSHAAtStart: claimedAtStart,
        sourceSHA: null,
        siteSourceSHA: null,
        reason: String(reason?.message ?? reason),
      },
    };
    delete invalidated.metadataSha256;
    try {
      const metadataSha256 = await (async () => {
        const bytes = Buffer.from(`${JSON.stringify(invalidated, null, 2)}\n`);
        await writeFileWithoutFollowingSymlinks(path, bytes);
        return sha256(bytes);
      })();
      if (capture) {
        Object.assign(capture, invalidated, { metadataSha256 });
      }
      invalidatedMetadata.push({ path: entry.metadataPath, metadataSha256 });
    } catch (error) {
      errors.push(error);
    }
  }

  const failureReport = {
    status: 'FAILED',
    sourceSHA: null,
    siteSourceSHA: null,
    claimedSourceSHAAtStart: claimedSourceSHAAtStart ?? null,
    sourceIntegrity: {
      status: 'FAILED',
      expectedHeadSha: expectedHeadSha ?? null,
      claimedSourceSHAAtStart: claimedSourceSHAAtStart ?? null,
      sourceSHA: null,
      siteSourceSHA: null,
      reason: String(reason?.message ?? reason),
    },
    captureFailure: captureError ? String(captureError?.message ?? captureError) : null,
    metadataPathsAttempted: registry.list().map(item => item.metadataPath),
    invalidatedMetadata,
    invalidationFailures: errors.map(error => String(error?.message ?? error)),
  };
  try {
    const reportPath = assertMetadataPath(registry.runOutput, 'site-source-integrity-failure.json', 'site-source-integrity-failure');
    const reportBytes = Buffer.from(`${JSON.stringify(failureReport, null, 2)}\n`);
    await writeFileWithoutFollowingSymlinks(reportPath, reportBytes);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

export function combineCaptureAndSourceIntegrityErrors(captureError, sourceIntegrityError, reportErrors = []) {
  if (!captureError && reportErrors.length === 0) return sourceIntegrityError;
  const errors = captureError ? [captureError, sourceIntegrityError, ...reportErrors] : [sourceIntegrityError, ...reportErrors];
  const message = captureError
    ? `A-05 capture failed (${captureError.message}); source integrity verification or mode restoration also failed (${sourceIntegrityError.message})${reportErrors.length ? `; source identity invalidation reporting also failed (${reportErrors.map(error => error.message).join('; ')})` : ''}.`
    : `A-05 source integrity failed (${sourceIntegrityError.message})${reportErrors.length ? `; source identity invalidation reporting also failed (${reportErrors.map(error => error.message).join('; ')})` : ''}.`;
  return new AggregateError(errors, message);
}
