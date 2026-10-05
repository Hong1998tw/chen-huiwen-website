/** Static server for the Lighthouse gate that mirrors the Cloudflare Static
 * Assets edge the site is served from (observed on www.huiwen.tw, 2026-10-05):
 *  - text assets are compressed per Accept-Encoding: br, else gzip, else identity
 *    (production brotli output is within ~1 % of Node brotli quality 4);
 *  - images and fonts are never re-compressed;
 *  - no Vary header is emitted (production sends none; recorded as null);
 *  - Cache-Control: public, max-age=0, must-revalidate;
 *  - exact-file routing: "/" and "dir/" serve index.html, "dir" without a slash
 *    is 404 (no redirect), unknown paths return the /404.html body with status 404;
 *  - Accept-Encoding follows q-values: the highest q among br/gzip wins (ties go to br),
 *    q=0 removes a coding, "*" covers codings not named, a malformed q is not acceptable.
 * Everything it serves, including the 404.html fallback, must resolve (realpath) inside root.
 * Test environment only: it is not used to build, publish or serve the site.
 * COMPRESSION=none reproduces the historical `python3 -m http.server` condition
 * (identity bodies) so old and new measurements can be compared on the same build.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { extname, resolve, sep } from 'node:path';

export const BROTLI_QUALITY = 4;
export const GZIP_LEVEL = 6;
export const CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const CONTENT_TYPES = {
 '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
 '.json': 'application/json', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
 '.txt': 'text/plain', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
 '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
 '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf'
};
const COMPRESSIBLE = new Set(['text/html', 'text/css', 'text/javascript', 'application/json', 'application/xml',
 'application/manifest+json', 'text/plain', 'image/svg+xml']);
export const COMPRESSION_MODES = ['auto', 'none'];

const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Accept-Encoding parsing with q-values: returns the q of br and gzip (0 = not acceptable). */
export function acceptedEncodings(header = '') {
 const accepted = new Map();
 for (const part of String(header).split(',')) {
  const [name, ...params] = part.trim().toLowerCase().split(';').map(item => item.trim());
  if (!name) continue;
  const q = params.find(item => item.startsWith('q='));
  const value = q === undefined ? 1 : Q_VALUE.test(q.slice(2)) ? Number(q.slice(2)) : 0;
  accepted.set(name, value);
 }
 const weight = name => (accepted.has(name) ? accepted.get(name) : accepted.get('*') ?? 0);
 return { br: weight('br'), gzip: weight('gzip') };
}

/** The coding to use: highest q wins, a tie goes to br, null means identity. */
export function chooseEncoding(header) {
 const { br, gzip } = acceptedEncodings(header);
 if (br <= 0 && gzip <= 0) return null;
 return br >= gzip ? 'br' : 'gzip';
}

/** Maps a request target to a file path under root, or null for 404. Never leaves root. */
export function resolveTarget(root, rawUrl) {
 const rawPath = String(rawUrl).split('?')[0].split('#')[0];
 if (!rawPath.startsWith('/')) return null;
 let decoded;
 try { decoded = decodeURIComponent(rawPath); } catch { return null; }
 if (decoded.includes('\0') || decoded.includes('\\')) return null;
 const segments = decoded.split('/').slice(1);
 const trailingSlash = decoded.endsWith('/');
 // "//x" and "/a//b" are not collapsed: the production edge redirects them (307), this server 404s.
 if (segments.slice(0, -1).some(segment => segment === '')) return null;
 // Dotfiles, parent segments and the edge control files are never public assets.
 if (segments.some(segment => segment.startsWith('.') || segment === '_headers' || segment === '_redirects')) return null;
 const relative = segments.filter(Boolean).join('/');
 const target = trailingSlash || !relative ? resolve(root, relative, 'index.html') : resolve(root, relative);
 if (target !== root && !target.startsWith(root + sep)) return null;
 return target;
}

export async function startStaticServer({ root, compression = 'auto', port = 0, host = '127.0.0.1' }) {
 if (!COMPRESSION_MODES.includes(compression)) throw new Error(`COMPRESSION must be one of ${COMPRESSION_MODES.join(', ')}`);
 const base = resolve(root);
 const realBase = await realpath(base);
 const inside = real => real === realBase || real.startsWith(realBase + sep);
 const cache = new Map();
 const log = [];
 const send = async (request, response, status, file, notFound = false) => {
  const method = request.method;
  const type = CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  let entry = cache.get(file);
  if (!entry) {
   const identity = await readFile(file);
   entry = { identity, sha256: createHash('sha256').update(identity).digest('hex'), br: null, gzip: null };
   cache.set(file, entry);
  }
  const wanted = compression === 'auto' && COMPRESSIBLE.has(type) ? chooseEncoding(request.headers['accept-encoding']) : null;
  let encoding = null;
  let body = entry.identity;
  if (wanted === 'br') {
   entry.br ||= brotliCompressSync(entry.identity, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: entry.identity.length } });
   encoding = 'br'; body = entry.br;
  } else if (wanted === 'gzip') {
   entry.gzip ||= gzipSync(entry.identity, { level: GZIP_LEVEL });
   encoding = 'gzip'; body = entry.gzip;
  }
  const headers = { 'Content-Type': type, 'Cache-Control': CACHE_CONTROL, 'Content-Length': body.length };
  if (encoding) headers['Content-Encoding'] = encoding;
  response.writeHead(status, headers);
  response.end(method === 'HEAD' ? undefined : body);
  log.push({ method, path: request.url, status, contentType: type, contentEncoding: encoding, vary: null,
   cacheControl: CACHE_CONTROL, acceptEncoding: request.headers['accept-encoding'] || null,
   identityBytes: entry.identity.length, identitySha256: entry.sha256, transferBytes: method === 'HEAD' ? 0 : body.length, notFound });
 };
 const server = createServer(async (request, response) => {
  try {
   if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 }); response.end();
    log.push({ method: request.method, path: request.url, status: 405 }); return;
   }
   const target = resolveTarget(base, request.url);
   const info = target && await stat(target).catch(() => null);
   // A symlink inside root must not expose files outside it.
   const real = info?.isFile() ? await realpath(target).catch(() => null) : null;
   if (real && inside(real)) return await send(request, response, 200, target);
   // The 404 page is subject to the same root boundary: a 404.html symlink that leaves root is not served.
   const missing = resolve(base, '404.html');
   const missingReal = (await stat(missing).catch(() => null))?.isFile() ? await realpath(missing).catch(() => null) : null;
   if (missingReal && inside(missingReal)) return await send(request, response, 404, missing, true);
   response.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': 9 }); response.end('Not Found');
   log.push({ method: request.method, path: request.url, status: 404, notFound: true });
  } catch (error) {
   response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end('Server error');
   log.push({ method: request.method, path: request.url, status: 500, error: String(error.message || error) });
  }
 });
 await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
 const address = server.address();
 return {
  url: `http://${host}:${address.port}/`,
  port: address.port,
  compression,
  log,
  close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })
 };
}
