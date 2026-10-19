import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SHA40 = /^[a-f0-9]{40}$/i;

function runGit(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function pathsOverlap(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

async function resolvePotentialPath(target) {
  let cursor = resolve(target);
  const missing = [];
  while (true) {
    try {
      const canonical = await realpath(cursor);
      return resolve(canonical, ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertPathComponentsStayWithin(target, scopeRoot, label) {
  const requested = isAbsolute(target) ? resolve(target) : resolve(scopeRoot, target);
  if (!isWithin(scopeRoot, requested) || requested === scopeRoot) {
    throw new Error(`${label} must be inside the capture tool checkout.`);
  }
  let cursor = scopeRoot;
  for (const part of relative(scopeRoot, requested).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      let targetRoot;
      try {
        targetRoot = await realpath(cursor);
      } catch {
        throw new Error(`${label} contains a broken or unresolvable symlink.`);
      }
      if (!isWithin(scopeRoot, targetRoot)) {
        throw new Error(`${label} symlink resolves outside the capture tool checkout.`);
      }
      cursor = targetRoot;
    }
  }
}

function hashJsonLines(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest('hex');
}

async function trackedContentDigest(repositoryRoot) {
  const rawEntries = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '--stage', '-z'], {
    encoding: 'buffer',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const entries = rawEntries.toString('utf8').split('\0').filter(Boolean);
  const contentRows = [];
  for (const record of entries) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('Site source tracked-file index could not be parsed.');
    const [mode, blobSha, stage] = record.slice(0, separator).split(' ');
    const relativePath = record.slice(separator + 1);
    if (!mode || !blobSha || stage !== '0' || !relativePath || relativePath.startsWith('/')) {
      throw new Error('Site source tracked-file index is invalid.');
    }
    const pathParts = relativePath.split('/');
    let cursor = repositoryRoot;
    for (const part of pathParts.slice(0, -1)) {
      cursor = join(cursor, part);
      const parentInfo = await lstat(cursor);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        throw new Error(`Site source tracked path has an unsafe parent: ${relativePath}`);
      }
    }
    const absolutePath = join(repositoryRoot, ...pathParts);
    let contentSha;
    if (mode === '120000') {
      const info = await lstat(absolutePath);
      if (!info.isSymbolicLink()) throw new Error(`Site source tracked symlink changed type: ${relativePath}`);
      contentSha = createHash('sha256').update(await readlink(absolutePath)).digest('hex');
    } else if (mode === '160000') {
      contentSha = blobSha;
    } else if (mode === '100644' || mode === '100755') {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Site source tracked file changed type: ${relativePath}`);
      contentSha = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
    } else {
      throw new Error(`Site source contains an unsupported tracked mode: ${mode}`);
    }
    contentRows.push([relativePath, mode, contentSha]);
  }
  return hashJsonLines(contentRows);
}

async function readSourceState(sourceRoot) {
  const identity = await readGitCheckoutIdentity(sourceRoot, 'site source');
  const status = runGit(identity.root, ['status', '--porcelain=v1', '-uall']);
  return {
    headSha: identity.headSha,
    clean: status === '',
    status,
    trackedContentSha256: await trackedContentDigest(identity.root),
  };
}

export async function snapshotGitSource(sourceRoot, expectedHeadSha) {
  const state = await readSourceState(sourceRoot);
  if (state.headSha !== expectedHeadSha || !state.clean) {
    throw new Error('Site source must match its actual Git HEAD and have a clean worktree before capture.');
  }
  return { root: resolve(sourceRoot), ...state };
}

export async function verifyGitSourceSnapshot(snapshot) {
  const after = await readSourceState(snapshot.root);
  const errors = [];
  if (after.headSha !== snapshot.headSha) {
    errors.push(new Error(`Site source HEAD changed from ${snapshot.headSha} to ${after.headSha}.`));
  }
  if (!after.clean) errors.push(new Error(`Site source worktree is no longer clean: ${after.status.trim() || 'status unavailable'}.`));
  if (after.trackedContentSha256 !== snapshot.trackedContentSha256) {
    errors.push(new Error('Site source tracked content changed during capture.'));
  }
  if (errors.length) throw new AggregateError(errors, `Site source integrity failed: ${errors.map(error => error.message).join('; ')}`);
  return {
    headSha: after.headSha,
    cleanBeforeCapture: snapshot.clean,
    cleanAfterCapture: after.clean,
    trackedContentSha256Before: snapshot.trackedContentSha256,
    trackedContentSha256After: after.trackedContentSha256,
  };
}

async function trackedProtectionTargets(repositoryRoot) {
  const rawEntries = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '--stage', '-z'], {
    encoding: 'buffer',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const entries = rawEntries.toString('utf8').split('\0').filter(Boolean);
  const targets = new Map([['.', { kind: 'directory' }]]);
  let skippedSymlinkCount = 0;
  for (const record of entries) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('Site source tracked-file index could not be parsed.');
    const [mode, , stage] = record.slice(0, separator).split(' ');
    const relativePath = record.slice(separator + 1);
    if (!mode || stage !== '0' || !relativePath || relativePath.startsWith('/')) {
      throw new Error('Site source tracked-file index is invalid.');
    }
    const parts = relativePath.split('/');
    let cursor = repositoryRoot;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Site source tracked path has an unsafe parent: ${relativePath}`);
      }
      targets.set(parts.slice(0, index + 1).join('/'), { kind: 'directory' });
    }
    if (mode === '160000') continue;
    const absolutePath = join(repositoryRoot, ...parts);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      skippedSymlinkCount += 1;
      continue;
    }
    if (!info.isFile() || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`Site source tracked entry is not a regular file: ${relativePath}`);
    }
    targets.set(relativePath, { kind: 'file' });
  }
  return { targets, skippedSymlinkCount };
}

function modeString(mode) {
  return `0${(mode & 0o7777).toString(8)}`;
}

async function inspectProtectedPath(repositoryRoot, relativePath) {
  const parts = relativePath === '.' ? [] : relativePath.split('/');
  let cursor = repositoryRoot;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    const parentInfo = await lstat(cursor);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error(`A-05 PR base path has an unsafe parent: ${relativePath}`);
    }
  }
  const targetPath = parts.length ? join(repositoryRoot, ...parts) : repositoryRoot;
  const info = await lstat(targetPath);
  if (info.isSymbolicLink() || !isWithin(repositoryRoot, await realpath(targetPath))) {
    throw new Error(`A-05 PR base path resolves outside its verified root: ${relativePath}`);
  }
  return { path: targetPath, info };
}

async function restoreModes(changedModes, repositoryRoot) {
  const errors = [];
  const ordered = [...changedModes].sort((first, second) => {
    const depthDifference = first.relativePath.split('/').length - second.relativePath.split('/').length;
    if (depthDifference) return depthDifference;
    if (first.kind !== second.kind) return first.kind === 'directory' ? -1 : 1;
    return first.relativePath.localeCompare(second.relativePath);
  });
  for (const entry of ordered) {
    try {
      const { path, info } = await inspectProtectedPath(repositoryRoot, entry.relativePath);
      const expectedType = entry.kind === 'directory' ? info.isDirectory() : info.isFile();
      if (!expectedType) {
        throw new Error(`Cannot safely restore source mode for replaced path: ${entry.relativePath}`);
      }
      if ((info.mode & 0o7777) !== entry.originalMode) {
        await chmod(path, entry.originalMode);
        const { info: restoredInfo } = await inspectProtectedPath(repositoryRoot, entry.relativePath);
        if ((restoredInfo.mode & 0o7777) !== entry.originalMode) {
          throw new Error(`Source mode restoration did not persist for path: ${entry.relativePath}`);
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function protectedModeRows(repositoryRoot, protectedEntries) {
  const rows = [];
  const writablePaths = [];
  for (const entry of protectedEntries) {
    const { info } = await inspectProtectedPath(repositoryRoot, entry.relativePath);
    const expectedType = entry.kind === 'directory' ? info.isDirectory() : info.isFile();
    if (!expectedType) {
      throw new Error(`A-05 PR base protected path changed type: ${entry.relativePath}`);
    }
    const actualMode = info.mode & 0o7777;
    if ((actualMode & 0o222) !== 0) writablePaths.push({ relativePath: entry.relativePath, mode: actualMode });
    rows.push([entry.relativePath, entry.kind, modeString(actualMode)]);
  }
  return { rows, writablePaths };
}

export async function protectReadOnlyBaseSource({ root, runnerTemp, baseRoot }) {
  if (typeof runnerTemp !== 'string' || !runnerTemp.trim() || typeof baseRoot !== 'string' || !baseRoot.trim()) {
    throw new Error('A-05 PR base protection requires RUNNER_TEMP and its designated BASE_ROOT.');
  }
  const canonicalRunnerTemp = await realpath(resolve(runnerTemp));
  const expectedBaseRoot = resolve(canonicalRunnerTemp, 'a05-main-reference');
  if (resolve(baseRoot) !== resolve(runnerTemp, 'a05-main-reference')) {
    throw new Error('A-05 PR base protection accepts only RUNNER_TEMP/a05-main-reference.');
  }
  const source = await readGitCheckoutIdentity(root, 'site source');
  const canonicalBaseRoot = await realpath(resolve(baseRoot));
  if (canonicalBaseRoot !== expectedBaseRoot || source.root !== canonicalBaseRoot || !isWithin(canonicalRunnerTemp, canonicalBaseRoot)) {
    throw new Error('A-05 PR base must be the verified RUNNER_TEMP/a05-main-reference worktree.');
  }
  const before = await readSourceState(source.root);
  if (before.headSha !== source.headSha || !before.clean) {
    throw new Error('A-05 PR base must have the exact captured HEAD and a clean tracked worktree before capture.');
  }

  const { targets, skippedSymlinkCount } = await trackedProtectionTargets(source.root);
  const modeRows = [];
  const protectedEntries = [];
  let expectedProtectedDigest = null;
  const orderedTargets = [...targets.entries()].sort(([first], [second]) => first.localeCompare(second));
  try {
    for (const [relativePath, target] of orderedTargets) {
      const { path: protectedPath, info } = await inspectProtectedPath(source.root, relativePath);
      if (target.kind === 'directory' ? !info.isDirectory() : !info.isFile()) {
        throw new Error(`A-05 PR base tracked path changed type before read-only protection: ${relativePath}`);
      }
      const originalMode = info.mode & 0o7777;
      const readOnlyMode = originalMode & ~0o222;
      modeRows.push([relativePath, modeString(originalMode), modeString(readOnlyMode)]);
      const entry = { relativePath, kind: target.kind, originalMode, protectedMode: readOnlyMode };
      protectedEntries.push(entry);
      if (readOnlyMode !== originalMode) {
        await chmod(protectedPath, readOnlyMode);
      }
      const { info: protectedInfo } = await inspectProtectedPath(source.root, relativePath);
      if ((protectedInfo.mode & 0o7777) !== readOnlyMode || (protectedInfo.mode & 0o222) !== 0) {
        throw new Error(`A-05 PR base path remained writable after protection: ${relativePath}`);
      }
    }
    const initialProtectedModes = await protectedModeRows(source.root, protectedEntries);
    if (initialProtectedModes.writablePaths.length) {
      throw new Error(`A-05 PR base paths remained writable after protection: ${initialProtectedModes.writablePaths.map(item => `${item.relativePath} (${modeString(item.mode)})`).join(', ')}.`);
    }
    expectedProtectedDigest = hashJsonLines(initialProtectedModes.rows);
  } catch (error) {
    const restoreErrors = await restoreModes(protectedEntries, source.root);
    if (restoreErrors.length) {
      throw new AggregateError([error, ...restoreErrors], `A-05 PR base protection failed (${error.message}) and mode restoration also failed (${restoreErrors.map(item => item.message).join('; ')}).`);
    }
    throw error;
  }

  const modeDigest = hashJsonLines(modeRows);
  let completed = false;
  return {
    initialState: before,
    modeRecord: {
      enforced: true,
      protectedEntryCount: modeRows.length,
      protectedFileCount: [...targets.values()].filter(item => item.kind === 'file').length,
      protectedDirectoryCount: [...targets.values()].filter(item => item.kind === 'directory').length,
      skippedSymlinkCount,
      sha256: modeDigest,
      expectedProtectedDigest,
      sameUidThreatModel: 'Mode bits deter accidental writes by the reviewed capture tool; same-UID code can change them, so this is not a strong sandbox.',
    },
    get completed() { return completed; },
    async verifyAndRestore() {
      if (completed) throw new Error('A-05 PR base protection was already finalized.');
      const errors = [];
      let after = null;
      let postCaptureModeDigest = null;
      try {
        const postCaptureModes = await protectedModeRows(source.root, protectedEntries);
        postCaptureModeDigest = hashJsonLines(postCaptureModes.rows);
        if (postCaptureModeDigest !== expectedProtectedDigest) {
          errors.push(new Error(`A-05 PR base protected mode digest changed during capture (expected ${expectedProtectedDigest}, received ${postCaptureModeDigest}).`));
        }
        for (const entry of postCaptureModes.writablePaths) {
          errors.push(new Error(`A-05 PR base protected path became writable during capture: ${entry.relativePath} (${modeString(entry.mode)}).`));
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        after = await readSourceState(source.root);
        if (after.headSha !== before.headSha) errors.push(new Error(`A-05 PR base HEAD changed from ${before.headSha} to ${after.headSha}.`));
        if (!after.clean) errors.push(new Error(`A-05 PR base worktree is no longer clean: ${after.status.trim() || 'status unavailable'}.`));
        if (after.trackedContentSha256 !== before.trackedContentSha256) errors.push(new Error('A-05 PR base tracked content changed during capture.'));
      } catch (error) {
        errors.push(error);
      }
      const restoreErrors = await restoreModes(protectedEntries, source.root);
      errors.push(...restoreErrors);
      completed = true;
      if (errors.length) {
        throw new AggregateError(errors, `A-05 PR base integrity check or mode restoration failed: ${errors.map(item => item.message).join('; ')}`);
      }
      return {
        headSha: after.headSha,
        cleanBeforeCapture: before.clean,
        cleanAfterCapture: after.clean,
        trackedContentSha256Before: before.trackedContentSha256,
        trackedContentSha256After: after.trackedContentSha256,
        readOnlyMode: { ...this.modeRecord, postCaptureModeDigest },
      };
    },
  };
}

export async function readGitCheckoutIdentity(repositoryPath, label = 'repository') {
  const requestedRoot = resolve(repositoryPath);
  let requestedInfo;
  try {
    requestedInfo = await lstat(requestedRoot);
  } catch {
    throw new Error(`${label} root is unavailable.`);
  }
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
    throw new Error(`${label} root must be a real directory.`);
  }

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch {
    throw new Error(`${label} root is unavailable.`);
  }
  const info = await lstat(canonicalRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} root must be a real directory.`);

  let gitRoot;
  let headSha;
  try {
    gitRoot = await realpath(runGit(canonicalRoot, ['rev-parse', '--show-toplevel']));
    headSha = runGit(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    throw new Error(`${label} root must be an available Git checkout with HEAD.`);
  }
  if (gitRoot !== canonicalRoot || !SHA40.test(headSha)) {
    throw new Error(`${label} path must be the Git checkout root with a full 40-character HEAD SHA.`);
  }
  return { root: canonicalRoot, headSha: headSha.toLowerCase() };
}

export async function resolveCaptureRoots({ runnerRoot, siteRoot, publicArtifact, outputDir, defaultOutput }) {
  const runner = await readGitCheckoutIdentity(runnerRoot, 'capture tool');
  const runnerStatus = runGit(runner.root, ['status', '--porcelain=v1', '-uall']);
  if (runnerStatus) throw new Error('Capture tool worktree must be clean before capture.');
  const sitePath = siteRoot == null ? null : isAbsolute(siteRoot) ? siteRoot : resolve(runner.root, siteRoot);
  const site = sitePath == null ? runner : await readGitCheckoutIdentity(sitePath, 'site source');
  const siteStatus = runGit(site.root, ['status', '--porcelain=v1', '-uall']);
  if (siteStatus) throw new Error('Site source worktree must be clean before capture.');

  let outputRoot;
  if (outputDir != null) {
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('--output-dir requires a path.');
    const requested = isAbsolute(outputDir) ? outputDir : resolve(runner.root, outputDir);
    outputRoot = await resolvePotentialPath(requested);
    try {
      await lstat(requested);
      throw new Error('Explicit capture output directory must not already exist.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (pathsOverlap(outputRoot, site.root)) {
      throw new Error('Capture output directory must not overlap the site source checkout.');
    }
    if (pathsOverlap(outputRoot, runner.root)) {
      const rawDefaultOutput = isAbsolute(defaultOutput) ? resolve(defaultOutput) : resolve(runner.root, defaultOutput);
      const suppliedRunnerRoot = resolve(runnerRoot);
      const requestedDefaultOutput = isWithin(suppliedRunnerRoot, rawDefaultOutput)
        ? resolve(runner.root, relative(suppliedRunnerRoot, rawDefaultOutput))
        : rawDefaultOutput;
      await assertPathComponentsStayWithin(requestedDefaultOutput, runner.root, 'Default capture output directory');
      const generatedRoot = await resolvePotentialPath(requestedDefaultOutput);
      if (!isWithin(generatedRoot, outputRoot) || outputRoot === generatedRoot) {
        throw new Error('An explicit output inside the capture tool checkout must be a new subdirectory of tests/donation/results/visual-qa/.');
      }
    }
  } else {
    const rawDefaultOutput = isAbsolute(defaultOutput) ? resolve(defaultOutput) : resolve(runner.root, defaultOutput);
    const suppliedRunnerRoot = resolve(runnerRoot);
    const requestedDefaultOutput = isWithin(suppliedRunnerRoot, rawDefaultOutput)
      ? resolve(runner.root, relative(suppliedRunnerRoot, rawDefaultOutput))
      : rawDefaultOutput;
    await assertPathComponentsStayWithin(requestedDefaultOutput, runner.root, 'Default capture output directory');
    outputRoot = await resolvePotentialPath(requestedDefaultOutput);
    if (!isWithin(runner.root, outputRoot) || outputRoot === runner.root) {
      throw new Error('Default capture output directory must resolve within the capture tool checkout.');
    }
  }

  let publicArtifactRoot = null;
  if (publicArtifact != null) {
    if (typeof publicArtifact !== 'string' || !publicArtifact.trim()) {
      throw new Error('--public-artifact requires a built publication directory path.');
    }
    const requestedArtifact = isAbsolute(publicArtifact) ? resolve(publicArtifact) : resolve(runner.root, publicArtifact);
    const requestedArtifactInfo = await lstat(requestedArtifact);
    if (requestedArtifactInfo.isSymbolicLink() || !requestedArtifactInfo.isDirectory()) {
      throw new Error('--public-artifact must name an existing real publication directory.');
    }
    publicArtifactRoot = await realpath(requestedArtifact);
    const artifactInfo = await lstat(publicArtifactRoot);
    if (artifactInfo.isSymbolicLink() || !artifactInfo.isDirectory()) {
      throw new Error('--public-artifact must name an existing real publication directory.');
    }
    if (pathsOverlap(publicArtifactRoot, site.root) || pathsOverlap(publicArtifactRoot, runner.root)) {
      throw new Error('Publication artifact must be separate from both Git source roots.');
    }
    if (pathsOverlap(publicArtifactRoot, outputRoot)) {
      throw new Error('Publication artifact and capture output directories must be separate.');
    }
  }

  return {
    runnerRoot: runner.root,
    siteRoot: site.root,
    siteSourceSHA: site.headSha,
    captureToolSHA: runner.headSha,
    outputRoot,
    publicArtifactRoot,
    independentSiteSource: site.root !== runner.root,
  };
}

export function assertAllowedOptions(command, options) {
  const allowed = command === 'capture'
    ? new Set(['environment', 'base-url', 'site-root', 'public-artifact', 'output-dir'])
    : command === 'cross-compare'
      ? new Set(['candidate-manifest', 'reference-manifest', 'output-dir'])
    : command === 'compare'
      ? new Set(['candidate-manifest', 'baseline-selection', 'baseline-manifest', 'baseline-sha256', 'baseline-source-sha', 'output'])
      : new Set();
  const unsupported = Object.keys(options).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported ${command} option: --${unsupported[0]}`);
}
