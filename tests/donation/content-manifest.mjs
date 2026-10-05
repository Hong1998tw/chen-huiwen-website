/** Content manifest of the tree a Lighthouse run measures.
 * The digest covers every file the static server could hand out (same hidden-path rules as
 * static-server.mjs): sorted `path NUL size NUL sha256 LF` lines hashed with SHA-256.
 * It identifies the measured site content; it is not a hash of any report file.
 * Symlinks that resolve outside the root are never served, so they are listed separately
 * and left out of the digest.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const MANIFEST_VERSION = 1;
export const HIDDEN_NAMES = new Set(['_headers', '_redirects']);

const hidden = name => name.startsWith('.') || HIDDEN_NAMES.has(name);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export const digestFiles = files => sha256([...files].sort(byPath).map(file => `${file.path}\0${file.size}\0${file.sha256}\n`).join(''));

/** @param {string} root directory to measure
 * @param {{ skipDirectories?: string[], skipPaths?: string[] }} options names or absolute paths left out (recorded in the manifest) */
export async function buildContentManifest(root, { skipDirectories = ['node_modules'], skipPaths = [] } = {}) {
 const base = resolve(root);
 const realBase = await realpath(base);
 const skipAbsolute = skipPaths.map(path => resolve(path));
 const files = [];
 const skippedSymlinks = [];
 const walk = async (directory, prefix) => {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
   if (hidden(entry.name)) continue;
   const absolute = resolve(directory, entry.name);
   const relative = prefix + entry.name;
   if (skipAbsolute.includes(absolute)) continue;
   let info = entry;
   if (entry.isSymbolicLink()) {
    const real = await realpath(absolute).catch(() => null);
    if (!real || !(real === realBase || real.startsWith(realBase + sep))) { skippedSymlinks.push(relative); continue; }
    info = await stat(absolute);
   }
   if (info.isDirectory()) {
    if (skipDirectories.includes(entry.name)) continue;
    await walk(absolute, relative + '/');
   } else if (info.isFile()) {
    const bytes = await readFile(absolute);
    files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
   }
  }
 };
 await walk(base, '');
 files.sort(byPath);
 return {
  version: MANIFEST_VERSION,
  root: base,
  algorithm: 'sha256 over sorted "path NUL size NUL sha256 LF" lines',
  skipDirectories,
  skipPaths: skipAbsolute,
  skippedSymlinksOutsideRoot: skippedSymlinks.sort(),
  fileCount: files.length,
  totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  digest: digestFiles(files),
  files
 };
}

/** Compares two manifests by file content, ignoring where the root lives. */
export function diffManifests(a, b) {
 const left = new Map(a.files.map(file => [file.path, file]));
 const right = new Map(b.files.map(file => [file.path, file]));
 const changed = [], onlyA = [], onlyB = [];
 for (const [path, file] of left) {
  const other = right.get(path);
  if (!other) onlyA.push(path);
  else if (other.sha256 !== file.sha256 || other.size !== file.size) changed.push(path);
 }
 for (const path of right.keys()) if (!left.has(path)) onlyB.push(path);
 return { changed: changed.sort(), onlyA: onlyA.sort(), onlyB: onlyB.sort() };
}

/** Re-computes the digest from the file list so a hand-edited summary cannot claim another digest. */
export const manifestDigestMatchesFiles = manifest => Array.isArray(manifest?.files) && manifest.digest === digestFiles(manifest.files);
