import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SHA40 = /^[a-f0-9]{40}$/i;

function runGit(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
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

export async function resolveCaptureRoots({ runnerRoot, siteRoot, outputDir, defaultOutput }) {
  const runner = await readGitCheckoutIdentity(runnerRoot, 'capture tool');
  const runnerStatus = runGit(runner.root, ['status', '--porcelain=v1', '-uall']);
  if (runnerStatus) throw new Error('Capture tool worktree must be clean before capture.');
  const sitePath = siteRoot == null ? null : isAbsolute(siteRoot) ? siteRoot : resolve(runner.root, siteRoot);
  const site = sitePath == null ? runner : await readGitCheckoutIdentity(sitePath, 'site source');
  const siteStatus = runGit(site.root, ['status', '--porcelain=v1', '-uall']);
  if (siteStatus) throw new Error('Site source worktree must be clean before capture.');

  let outputRoot = await resolvePotentialPath(defaultOutput);
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
      const generatedRoot = await resolvePotentialPath(defaultOutput);
      if (!isWithin(generatedRoot, outputRoot) || outputRoot === generatedRoot) {
        throw new Error('An explicit output inside the capture tool checkout must be a new subdirectory of tests/donation/results/visual-qa/.');
      }
    }
  }

  return {
    runnerRoot: runner.root,
    siteRoot: site.root,
    siteSourceSHA: site.headSha,
    captureToolSHA: runner.headSha,
    outputRoot,
    independentSiteSource: site.root !== runner.root,
  };
}

export function assertAllowedOptions(command, options) {
  const allowed = command === 'capture'
    ? new Set(['environment', 'base-url', 'site-root', 'output-dir'])
    : command === 'cross-compare'
      ? new Set(['candidate-manifest', 'reference-manifest', 'output-dir'])
    : command === 'compare'
      ? new Set(['candidate-manifest', 'baseline-selection', 'baseline-manifest', 'baseline-sha256', 'baseline-source-sha', 'output'])
      : new Set();
  const unsupported = Object.keys(options).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported ${command} option: --${unsupported[0]}`);
}
