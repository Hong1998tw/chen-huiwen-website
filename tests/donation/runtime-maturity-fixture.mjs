import {readFile} from 'node:fs/promises';
import {extname, resolve} from 'node:path';
import {createHash} from 'node:crypto';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export async function resolveRuntimeMaturityFixtureResponse({
  root,
  pathname,
  requestURL,
  failOptional = false,
  failRequired = false,
  noStore = false,
  legacyWorkerVersion,
  readFileImpl = readFile,
}) {
  if (failRequired && pathname === '/offline.html') {
    return {status: 503, headers: {}, body: 'fixture unavailable', delayMs: 150};
  }
  if (failOptional && /\.(css|svg)$/.test(pathname)) {
    return {status: 503, headers: {}, body: 'fixture unavailable'};
  }

  try {
    let data;
    if (pathname === '/worker-upgrade-legacy.html') {
      data = Buffer.from(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>Legacy worker fixture</title><script defer src="digital.js?v=${legacyWorkerVersion}"></script></head><body><main>Legacy worker upgrade fixture</main></body></html>`);
    } else if (pathname === '/worker-upgrade-current.html') {
      const digital = await readFileImpl(resolve(root, 'digital.js'));
      const hash = createHash('sha256').update(digital).digest('hex').slice(0, 12);
      data = Buffer.from(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>Current worker fixture</title><script defer src="digital.js?v=${hash}"></script></head><body><main>Current worker upgrade fixture</main></body></html>`);
    } else {
      const path = resolve(root, `.${pathname === '/' || pathname === '/without-markers.html' ? '/index.html' : pathname}`);
      if (!path.startsWith(root)) return {status: 403, headers: {}, body: ''};
      data = await readFileImpl(path);
    }

    if (pathname === '/without-markers.html') {
      data = Buffer.from(data.toString().replace(/ data-digital-civic="[^"]+"/g, ''));
    }
    if (pathname === '/digital.js' && requestURL.includes(`v=${legacyWorkerVersion}`)) {
      data = Buffer.from(data.toString().replace(/const SERVICE_WORKER_VERSION = '[^']+'/, `const SERVICE_WORKER_VERSION = '${legacyWorkerVersion}'`));
    }
    if (pathname === '/sw.js' && requestURL.includes(`v=${legacyWorkerVersion}`)) {
      data = Buffer.from("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");
    }

    return {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[extname(pathname)] || 'application/octet-stream',
        // Match the repository's documented Cloudflare Static Assets default.
        // In particular, the production worker must be able to cache offline.html.
        'Cache-Control': pathname === '/deployment.json' || noStore ? 'no-store' : STATIC_ASSET_CACHE_CONTROL,
      },
      body: data,
    };
  } catch {
    return {status: 404, headers: {'Content-Type': 'text/html'}, body: '<h1>Not found</h1>'};
  }
}
