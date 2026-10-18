/* Shared by the generated Service Worker and the pure Node policy tests. */
(function exposePolicy(root, createPolicy) {
  const policy = createPolicy();
  if (typeof module !== 'undefined' && module && module.exports) module.exports = policy;
  if (root) root.HuiwenServiceWorkerCachePolicy = policy;
})(typeof self !== 'undefined' ? self : globalThis, function createPolicy() {
  const privateQueryKey = /^(?:cms[a-z0-9_-]*|draft|private|preview[a-z0-9_-]*|[a-z0-9_-]*(?:token|session)[a-z0-9_-]*)$/i;
  const privateSegments = new Set(['admin', 'api', 'cms', 'draft', 'drafts', 'preview', 'previews', 'runtime']);

  function sensitivePath(url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      return true;
    }
    const segments = pathname.split('/').filter(Boolean);
    const basename = segments.at(-1) || '';
    if (segments.some(segment => privateSegments.has(segment) || segment.startsWith('cms-'))) return true;
    if (/^(?:cms|runtime)[-_.]/i.test(basename)) return true;
    if (pathname === '/sw.js'
        || pathname === '/data/achievements.json'
        || pathname === '/deployment.json'
        || pathname === '/publication-manifest.json') return true;
    return false;
  }

  function isCacheableRequest(request) {
    if (!request || !request.url || (request.method && request.method !== 'GET')) return false;
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(url.protocol) || sensitivePath(url)) return false;
    for (const key of url.searchParams.keys()) {
      if (privateQueryKey.test(key)) return false;
    }
    const headers = request.headers;
    return !(headers && (headers.has('authorization') || headers.has('cookie')));
  }

  function isCacheableResponse(response) {
    if (!response || response.ok !== true) return false;
    const cacheControl = response.headers?.get('Cache-Control') || '';
    return !cacheControl.split(',').some(directive => /^(?:private|no-store)(?:\s*=|$)/i.test(directive.trim()));
  }

  function canCache(request, response) {
    return isCacheableRequest(request) && isCacheableResponse(response);
  }

  return Object.freeze({isCacheableRequest, isCacheableResponse, canCache});
});
