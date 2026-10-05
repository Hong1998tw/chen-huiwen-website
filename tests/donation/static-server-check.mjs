/** Contract test for the Lighthouse static server (no browser needed).
 * Checks compression negotiation, byte-exact round trips, Vary/Content-Length,
 * the 404 body and path handling against a synthetic tree plus real site files.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { CACHE_CONTROL, startStaticServer } from './static-server.mjs';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), 'lh-static-'));
const outside = await mkdtemp(join(tmpdir(), 'lh-outside-'));
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('ok -', name); };

const get = (server, path, { method = 'GET', encoding } = {}) => new Promise((ok, fail) => {
 const headers = encoding === undefined ? {} : { 'Accept-Encoding': encoding };
 const req = request(new URL(path, server.url), { method, headers, agent: false }, response => {
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  response.on('end', () => ok({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
 });
 req.on('error', fail); req.end();
});
const decode = ({ headers, body }) => headers['content-encoding'] === 'br' ? brotliDecompressSync(body)
 : headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;

try {
 const text = (name, size) => writeFile(join(fixture, name), `/* ${name} */\n` + 'abcdefghij 0123456789 '.repeat(size));
 await mkdir(join(fixture, 'dir'));
 await mkdir(join(fixture, '.git'));
 await mkdir(join(fixture, 'bare'));
 await text('index.html', 200); await text('404.html', 80); await text('dir/index.html', 50);
 await text('styles.css', 300); await text('site.js', 300); await text('data.json', 300);
 await text('sitemap.xml', 300); await text('manifest.webmanifest', 100); await text('robots.txt', 20);
 await text('_headers', 5); await text('_redirects', 5); await text('.env', 5); await text('.git/config', 5);
 await writeFile(join(fixture, 'img.webp'), Buffer.alloc(4096, 7));
 await writeFile(join(fixture, 'font.woff2'), Buffer.alloc(4096, 9));
 await writeFile(join(fixture, 'bare/page.html'), 'x');
 await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
 await symlink(join(outside, 'secret.txt'), join(fixture, 'link.txt'));
 await symlink(outside, join(fixture, 'linkdir'));

 const auto = await startStaticServer({ root: fixture, compression: 'auto' });
 const none = await startStaticServer({ root: fixture, compression: 'none' });
 const real = await startStaticServer({ root: repo, compression: 'auto' });
 try {
  await check('HTML, CSS, JS, JSON, XML, manifest and text use brotli when br is accepted', async () => {
   for (const [path, type] of [['/index.html', 'text/html'], ['/styles.css', 'text/css'], ['/site.js', 'text/javascript'], ['/data.json', 'application/json'],
     ['/sitemap.xml', 'application/xml'], ['/manifest.webmanifest', 'application/manifest+json'], ['/robots.txt', 'text/plain']]) {
    const identity = await readFile(join(fixture, path.slice(1)));
    const response = await get(auto, path, { encoding: 'br, gzip' });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], type, path);
    assert.equal(response.headers['content-encoding'], 'br', path);
    assert.ok(response.body.length < identity.length / 2, path + ' should be much smaller on the wire');
    assert.equal(Number(response.headers['content-length']), response.body.length, path);
    assert.equal(response.headers['cache-control'], CACHE_CONTROL, path);
    assert.equal(response.headers.vary, undefined, path + ' must not add Vary (production sends none)');
    assert.deepEqual(decode(response), identity, path + ' must round-trip byte for byte');
   }
  });
  await check('gzip is used when only gzip is accepted, identity when nothing is accepted', async () => {
   const identity = await readFile(join(fixture, 'styles.css'));
   const gz = await get(auto, '/styles.css', { encoding: 'gzip' });
   assert.equal(gz.headers['content-encoding'], 'gzip');
   assert.deepEqual(decode(gz), identity);
   for (const encoding of [undefined, '', 'identity', 'br;q=0, gzip;q=0']) {
    const plain = await get(auto, '/styles.css', { encoding });
    assert.equal(plain.headers['content-encoding'], undefined, String(encoding));
    assert.deepEqual(plain.body, identity, String(encoding));
    assert.equal(Number(plain.headers['content-length']), identity.length);
   }
   assert.equal((await get(auto, '/styles.css', { encoding: 'gzip, br;q=0' })).headers['content-encoding'], 'gzip');
   assert.equal((await get(auto, '/styles.css', { encoding: '*' })).headers['content-encoding'], 'br');
  });
  await check('images and fonts are never compressed', async () => {
   for (const [path, type, size] of [['/img.webp', 'image/webp', 4096], ['/font.woff2', 'font/woff2', 4096]]) {
    const response = await get(auto, path, { encoding: 'br, gzip' });
    assert.equal(response.status, 200); assert.equal(response.headers['content-type'], type);
    assert.equal(response.headers['content-encoding'], undefined); assert.equal(response.body.length, size);
   }
  });
  await check('COMPRESSION=none serves identity bytes for every type (legacy reference condition)', async () => {
   const identity = await readFile(join(fixture, 'index.html'));
   const response = await get(none, '/index.html', { encoding: 'br, gzip' });
   assert.equal(response.headers['content-encoding'], undefined);
   assert.deepEqual(response.body, identity);
   assert.equal(response.headers.vary, undefined);
  });
  await check('real site files: HTML, CSS and JS decode to the exact repository bytes', async () => {
   for (const file of ['index.html', 'achievements.html', 'styles.css', 'civic.css', 'site.js']) {
    const identity = await readFile(join(repo, file));
    const response = await get(real, '/' + file, { encoding: 'br, gzip' });
    assert.equal(response.status, 200, file); assert.equal(response.headers['content-encoding'], 'br', file);
    assert.deepEqual(decode(response), identity, file);
    assert.ok(response.body.length < identity.length * 0.5, `${file}: ${response.body.length} of ${identity.length}`);
   }
  });
  await check('404: unknown path returns status 404 with the compressed /404.html body', async () => {
   const identity = await readFile(join(fixture, '404.html'));
   const response = await get(auto, '/no-such-page.html', { encoding: 'br' });
   assert.equal(response.status, 404);
   assert.equal(response.headers['content-type'], 'text/html');
   assert.equal(response.headers['content-encoding'], 'br');
   assert.deepEqual(decode(response), identity);
   const plain = await get(none, '/no-such-page.html', { encoding: 'br' });
   assert.equal(plain.status, 404); assert.deepEqual(plain.body, identity);
   const asset = await get(auto, '/missing.css', { encoding: 'br' });
   assert.equal(asset.status, 404); assert.equal(asset.headers['content-type'], 'text/html');
  });
  await check('path handling: "/" and "dir/" serve index.html, "dir" is 404 (no redirect), query and fragment are ignored', async () => {
   const root = await get(auto, '/', { encoding: 'identity' });
   assert.equal(root.status, 200); assert.deepEqual(root.body, await readFile(join(fixture, 'index.html')));
   const dir = await get(auto, '/dir/', { encoding: 'identity' });
   assert.equal(dir.status, 200); assert.deepEqual(dir.body, await readFile(join(fixture, 'dir/index.html')));
   const noSlash = await get(auto, '/dir', { encoding: 'identity' });
   assert.equal(noSlash.status, 404); assert.equal(noSlash.headers.location, undefined);
   assert.equal((await get(auto, '/bare/', { encoding: 'identity' })).status, 404);
   assert.equal((await get(auto, '/styles.css?v=abc123', { encoding: 'identity' })).status, 200);
   assert.equal((await get(auto, '/index.html?x=1#top', { encoding: 'identity' })).status, 200);
  });
  await check('path handling: traversal, encoded traversal, backslash, NUL, dotfiles and edge control files are 404', async () => {
   // Raw sockets keep the request target byte for byte; URL parsers would normalise "..".
   const raw = (target) => new Promise((ok, fail) => {
    const socket = createConnection(auto.port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`));
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => ok(data)); socket.on('error', fail);
   });
   const manifest = await readFile(join(repo, 'package.json')).catch(() => null);
   const targets = ['/../package.json', '/../../etc/passwd', '/%2e%2e/package.json', '/%2E%2E/%2e%2e/etc/passwd', '/dir/../../x', '/..%2fpackage.json',
    '/dir/%2e%2e/index.html', '/%5c..%5cpackage.json', '/a%00.html', '/.env', '/.git/config', '/%2eenv', '/%2egit/config', '/_headers', '/_redirects',
    '/%5Fheaders', '/%zz', '//etc/passwd'];
   for (const target of targets) {
    const response = await raw(target);
    assert.match(response, /^HTTP\/1\.1 404 /, target + ' -> ' + response.split('\r\n')[0]);
    assert.match(response, /\/\* 404\.html \*\//, target + ' must return the 404 page body');
    assert.doesNotMatch(response, /root:|\/\* (index|styles|_headers|_redirects|\.env|config)/, target + ' leaked file content');
    if (manifest) assert.ok(!response.includes(manifest.toString().slice(0, 40)), target);
   }
  });
  await check('path handling: a request target without a leading slash is rejected by the HTTP layer (400) or the server (404)', async () => {
   const response = await new Promise((ok, fail) => {
    const socket = createConnection(auto.port, '127.0.0.1', () => socket.write('GET index.html HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => ok(data)); socket.on('error', fail);
   });
   assert.match(response, /^HTTP\/1\.1 (400|404) /);
  });
  await check('path handling: symlinks that point outside the root are 404', async () => {
   for (const path of ['/link.txt', '/linkdir/secret.txt']) {
    const response = await get(auto, path, { encoding: 'identity' });
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.includes('TOP-SECRET-OUTSIDE'), path);
   }
  });
  await check('methods: HEAD mirrors GET headers without a body, other methods are 405', async () => {
   const head = await get(auto, '/styles.css', { method: 'HEAD', encoding: 'br' });
   const full = await get(auto, '/styles.css', { encoding: 'br' });
   assert.equal(head.status, 200); assert.equal(head.body.length, 0);
   assert.equal(head.headers['content-encoding'], 'br');
   assert.equal(head.headers['content-length'], full.headers['content-length']);
   const post = await get(auto, '/styles.css', { method: 'POST' });
   assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
  });
  await check('request log records encoding, Vary (null), identity and transfer bytes', async () => {
   const entry = auto.log.find(row => row.path === '/index.html' && row.contentEncoding === 'br');
   assert.ok(entry);
   assert.equal(entry.vary, null);
   assert.equal(entry.status, 200);
   assert.ok(entry.identityBytes > entry.transferBytes && entry.transferBytes > 0);
   const legacy = none.log.find(row => row.path === '/index.html');
   assert.equal(legacy.contentEncoding, null); assert.equal(legacy.identityBytes, legacy.transferBytes);
  });
 } finally {
  await Promise.all([auto.close(), none.close(), real.close()]);
 }
 console.log(`static-server-check: ${checks.length} checks passed`);
} finally {
 await rm(fixture, { recursive: true, force: true });
 await rm(outside, { recursive: true, force: true });
}
