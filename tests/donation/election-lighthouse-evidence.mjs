import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const REQUIRED_ELECTION_PATHS = [
  'election.html',
  'site.js',
  'election.js',
  'styles.css',
  'mobile.css',
  'layout.css',
  'campaign.css',
  'civic.css',
  'digital.css',
  'digital.js',
];

const FONT_URL = /url\(\s*["']?(\/assets\/fonts\/huiwen-site-sans\/generated\/huiwen-election-(core|full)-[0-9a-f]{12}\.woff2)["']?\s*\)/g;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fontPathsFromStylesheet(stylesheet) {
  const byVariant = new Map();
  for (const match of stylesheet.matchAll(FONT_URL)) {
    const [, absolutePath, variant] = match;
    const path = absolutePath.slice(1);
    const previous = byVariant.get(variant);
    if (previous && previous !== path) throw new Error(`Election stylesheet references multiple ${variant} font files`);
    byVariant.set(variant, path);
  }
  for (const variant of ['core', 'full']) {
    if (!byVariant.has(variant)) throw new Error(`Election stylesheet is missing the ${variant} font source`);
  }
  return [...byVariant.values()];
}

export function electionResourceEntries(manifest, stylesheet) {
  if (!Array.isArray(manifest?.files) || typeof manifest.digest !== 'string') {
    throw new Error('Election evidence requires a content manifest with file rows and a digest');
  }
  const byPath = new Map(manifest.files.map(file => [file.path, file]));
  const paths = [...REQUIRED_ELECTION_PATHS, ...fontPathsFromStylesheet(stylesheet)];
  const uniquePaths = [...new Set(paths)];
  for (const path of uniquePaths) {
    if (!byPath.has(path)) throw new Error(`Allowlisted election resource is missing from content manifest: ${path}`);
  }
  return uniquePaths.map(path => byPath.get(path));
}

function relativeRequestPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  try {
    return decodeURIComponent(new URL(rawPath, 'https://election-evidence.invalid/').pathname).replace(/^\//, '');
  } catch {
    return null;
  }
}

export function correlateBrowserRequests(items, requests, baseOrigin) {
  const origin = new URL(baseOrigin).origin;
  const sent = new Map(requests.filter(row => row.status === 200).map(row => [row.path, row]));
  return items.map(item => {
    const url = new URL(item.url, `${origin}/`);
    const path = url.pathname + url.search;
    const row = url.origin === origin ? sent.get(path) : null;
    return {
      url: url.href,
      origin: url.origin,
      path,
      statusCode: item.statusCode,
      mimeType: item.mimeType,
      resourceType: item.resourceType,
      chromeTransferSize: item.transferSize,
      chromeResourceSize: item.resourceSize,
      contentEncoding: row?.contentEncoding ?? null,
      vary: row?.vary ?? null,
      serverIdentityBytes: row?.identityBytes ?? null,
      serverIdentitySha256: row?.identitySha256 ?? null,
      serverBodyBytes: row?.transferBytes ?? null,
    };
  });
}

function compactServerRequest(row) {
  return Object.fromEntries([
    'page', 'run', 'path', 'status', 'contentType', 'contentEncoding', 'identityBytes',
    'identitySha256', 'transferBytes', 'notFound',
  ].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

function compactBrowserRequest(row) {
  return Object.fromEntries([
    'url', 'origin', 'path', 'statusCode', 'mimeType', 'resourceType', 'chromeTransferSize', 'chromeResourceSize',
    'contentEncoding', 'serverIdentityBytes', 'serverIdentitySha256', 'serverBodyBytes',
  ].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

export async function writeElectionResourceSnapshot({ root, outDir, manifest, stylesheet, baseOrigin, sourceCommit = null, checkedOutCommit = null, serverLog = [], results = [] }) {
  const origin = new URL(baseOrigin).origin;
  const entries = electionResourceEntries(manifest, stylesheet);
  const base = resolve(root);
  const files = [];

  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe allowlisted election resource path: ${entry.path}`);
    }
    const source = resolve(base, ...entry.path.split('/'));
    if (source !== base && !source.startsWith(base + sep)) throw new Error(`Election resource leaves public artifact root: ${entry.path}`);
    const bytes = await readFile(source);
    const fileSha256 = sha256(bytes);
    if (bytes.length !== entry.size || fileSha256 !== entry.sha256) {
      throw new Error(`Election resource changed after content manifest creation: ${entry.path}`);
    }
    const snapshotPath = `files/${entry.path}`;
    const destination = resolve(outDir, ...snapshotPath.split('/'));
    if (destination !== resolve(outDir) && !destination.startsWith(resolve(outDir) + sep)) {
      throw new Error(`Election snapshot destination leaves output directory: ${snapshotPath}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    const serverRequests = serverLog.filter(row => row.page === 'election.html' && relativeRequestPath(row.path) === entry.path);
    const browserRequests = results
      .filter(result => result.page === 'election.html')
      .map(result => {
        const matching = (result.pageRequests || []).filter(row => {
          try {
            const requestUrl = new URL(row.url);
            return requestUrl.origin === origin && relativeRequestPath(requestUrl.href) === entry.path;
          } catch {
            return false;
          }
        });
        for (const row of matching) {
          if (row.statusCode === 200 && (row.serverIdentitySha256 !== fileSha256 || row.serverIdentityBytes !== bytes.length)) {
            throw new Error(`Same-origin 200 Lighthouse request lacks matching server bytes for ${entry.path}`);
          }
        }
        return { run: result.run, requests: matching.map(compactBrowserRequest) };
      });
    files.push({
      path: entry.path,
      snapshotPath,
      size: bytes.length,
      sha256: fileSha256,
      source: `public-site content manifest: ${entry.path}`,
      sourceCommit,
      checkedOutCommit,
      contentDigest: manifest.digest,
      serverRequests: serverRequests.map(compactServerRequest),
      lighthouseRequests: browserRequests,
    });
  }

  const snapshot = {
    version: 1,
    scope: 'positive allowlist of public election HTML, CSS, JavaScript, and the page Core/Full fonts',
    sourceCommit,
    checkedOutCommit,
    contentDigest: manifest.digest,
    files,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(snapshot, null, 2));
  return { manifestFile: 'election-snapshot/manifest.json', files: files.length, sourceCommit, contentDigest: manifest.digest };
}

export function serializeRawTrace(trace) {
  const events = trace?.traceEvents;
  if (!Array.isArray(events)) throw new Error('Lighthouse did not return a raw Chrome trace event list');
  const bytes = Buffer.from(JSON.stringify(trace));
  return { bytes, sha256: sha256(bytes), traceEventCount: events.length };
}
