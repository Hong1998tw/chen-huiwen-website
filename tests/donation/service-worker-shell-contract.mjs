import {createHash} from 'node:crypto';

const ARTIFACT_ORIGIN = 'https://www.huiwen.tw';
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINTED_ASSET = /^.+\.([0-9a-f]{64})\.(css|js)$/;
const VERSION_QUERY = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/i;
const PRIVATE_QUERY_KEY = /^(?:cms[a-z0-9_-]*|draft|private|preview[a-z0-9_-]*|[a-z0-9_-]*(?:token|session)[a-z0-9_-]*)$/i;
const PRIVATE_SEGMENT = new Set(['admin', 'api', 'cms', 'draft', 'drafts', 'preview', 'previews', 'runtime']);

function parseArrayConstant(source, name) {
  const declarations = [...source.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=`, 'g'))];
  if (declarations.length !== 1) {
    throw new Error(`Emitted Service Worker must define exactly one ${name} array`);
  }

  let start = declarations[0].index + declarations[0][0].length;
  while (/\s/.test(source[start] || '')) start += 1;
  if (source[start] !== '[') throw new Error(`Emitted Service Worker ${name} must be a JSON array`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`Emitted Service Worker ${name} array is incomplete`);
  let terminator = end;
  while (/\s/.test(source[terminator] || '')) terminator += 1;
  if (source[terminator] !== ';') throw new Error(`Emitted Service Worker ${name} array must end with a semicolon`);

  let value;
  try {
    value = JSON.parse(source.slice(start, end));
  } catch (error) {
    throw new Error(`Emitted Service Worker ${name} array is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Emitted Service Worker ${name} must contain only URL strings`);
  }
  return value;
}

function resolvePublicAssetUrl(value) {
  if (typeof value !== 'string' || !value) throw new Error('SHELL asset URL must be a non-empty string');
  const rawPath = value.split(/[?#]/, 1)[0].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  let decodedRawPath;
  let url;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
    url = new URL(value, ARTIFACT_ORIGIN + '/');
  } catch (error) {
    throw new Error(`SHELL asset URL is invalid: ${value} (${error.message})`);
  }
  if (decodedRawPath.split('/').includes('..') || decodedRawPath.includes('\\') || decodedRawPath.includes('\0')) {
    throw new Error(`SHELL asset URL has an unsafe path: ${value}`);
  }
  if (url.origin !== ARTIFACT_ORIGIN || url.username || url.password || url.hash) {
    throw new Error(`SHELL asset URL must be a same-origin public artifact URL: ${value}`);
  }

  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(1));
  } catch (error) {
    throw new Error(`SHELL asset path is not valid URL encoding: ${value} (${error.message})`);
  }
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`SHELL asset URL has an unsafe artifact path: ${value}`);
  }
  return {url, path};
}

function assertPublicShellPath(path, url) {
  const segments = path.toLowerCase().split('/');
  const basename = segments.at(-1) || '';
  if (segments.some(segment => PRIVATE_SEGMENT.has(segment) || segment.startsWith('cms-'))
      || /^(?:cms|runtime)[-_.]/i.test(basename)
      || /^(?:cms-page-editor|sw)\./i.test(basename)
      || [...url.searchParams.keys()].some(key => PRIVATE_QUERY_KEY.test(key))) {
    throw new Error(`SHELL CSS/JS asset is private or excluded from public caching: ${path}`);
  }
}

export function parseServiceWorkerShell(workerSource) {
  if (typeof workerSource !== 'string') throw new Error('Emitted Service Worker source must be text');
  return {
    shell: parseArrayConstant(workerSource, 'SHELL'),
    requiredShell: parseArrayConstant(workerSource, 'REQUIRED_SHELL'),
  };
}

export async function verifyVersionedShellAssets(shell, publicationFiles, readAssetBytes) {
  if (!Array.isArray(shell)) throw new Error('Emitted Service Worker SHELL must be an array');
  if (!publicationFiles || typeof publicationFiles !== 'object' || Array.isArray(publicationFiles)) {
    throw new Error('Publication manifest files map is missing');
  }
  if (typeof readAssetBytes !== 'function') throw new Error('SHELL artifact byte reader is required');

  const assets = [];
  for (const value of shell) {
    const {url, path} = resolvePublicAssetUrl(value);
    const extension = path.toLowerCase().endsWith('.css') ? 'css'
      : path.toLowerCase().endsWith('.js') ? 'js' : null;
    if (!extension) continue;
    assertPublicShellPath(path, url);

    if (!Object.hasOwn(publicationFiles, path)) {
      throw new Error(`SHELL CSS/JS asset is not owned by publication manifest: ${path}`);
    }
    const declaredSha256 = publicationFiles[path];
    if (typeof declaredSha256 !== 'string' || !SHA256.test(declaredSha256)) {
      throw new Error(`Publication manifest has no valid SHA-256 for SHELL asset: ${path}`);
    }
    const bytes = Buffer.from(await readAssetBytes(path));
    const bodySha256 = createHash('sha256').update(bytes).digest('hex');
    if (bodySha256 !== declaredSha256) {
      throw new Error(`SHELL asset bytes differ from publication manifest SHA-256: ${path}`);
    }

    const basename = path.split('/').at(-1);
    const fingerprint = FINGERPRINTED_ASSET.exec(basename);
    const versionValues = url.searchParams.getAll('v');
    if (versionValues.length > 1) {
      throw new Error(`SHELL asset has an ambiguous v query: ${path}`);
    }
    if (fingerprint) {
      if (fingerprint[2] !== extension || fingerprint[1] !== bodySha256) {
        throw new Error(`SHELL asset filename hash differs from its publication bytes: ${path}`);
      }
    } else if (versionValues.length !== 1) {
      throw new Error(`SHELL CSS/JS asset needs a full SHA-256 filename or one matching v query: ${path}`);
    }

    if (versionValues.length > 0) {
      const version = versionValues[0];
      if (!VERSION_QUERY.test(version) || !bodySha256.startsWith(version.toLowerCase())) {
        throw new Error(`SHELL asset v query does not match its publication bytes: ${path}`);
      }
    }

    assets.push({
      url: value,
      path,
      extension,
      sha256: bodySha256,
      versioning: fingerprint ? 'sha256-filename' : 'sha256-v-query',
    });
  }
  if (assets.length === 0) throw new Error('Artifact SHELL must contain a versioned CSS or JavaScript URL');
  return assets;
}
