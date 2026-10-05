/** Self-test for embed-diagnostics.mjs against local mock "third parties" with known framing policies.
 * Proves the tool attributes a refusal correctly (third-party header, site CSP, nothing) before it is trusted
 * on a real third party. Needs a Chromium (Playwright's, or CHROME_PATH). Not part of CI.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { classify, diagnose } from './embed-diagnostics.mjs';

const listen = handler => new Promise(done => { const server = createServer(handler); server.listen(0, '127.0.0.1', () => done(server)); });
const origin = server => `http://127.0.0.1:${server.address().port}`;
const close = server => new Promise(done => { server.closeAllConnections?.(); server.close(done); });

let parentCsp = null;
let thirdOrigin;
const third = await listen((request, response) => {
 const headers = { 'Content-Type': 'text/html' };
 if (request.url.startsWith('/xfo-deny')) headers['X-Frame-Options'] = 'DENY';
 if (request.url.startsWith('/csp-none')) headers['Content-Security-Policy'] = "frame-ancestors 'none'";
 if (request.url.startsWith('/csp-allow')) headers['Content-Security-Policy'] = `frame-ancestors ${parentOrigin()}`;
 response.writeHead(200, headers); response.end('<h1>third party</h1>');
});
let parentServer;
const parentOrigin = () => origin(parentServer);
parentServer = await listen((request, response) => {
 const headers = { 'Content-Type': 'text/html' };
 if (parentCsp && request.url.startsWith('/csp')) headers['Content-Security-Policy'] = parentCsp;
 response.writeHead(200, headers);
 response.end(`<!doctype html><title>parent</title><body><template><iframe src="${thirdOrigin}/ok"></iframe></template>`);
});
thirdOrigin = origin(third);

try {
 const run = async (path, parentPath = '/', csp = null) => {
  parentCsp = csp;
  const report = await diagnose({ parentUrl: parentOrigin() + parentPath, embedUrl: thirdOrigin + path, chromePath: process.env.CHROME_PATH, waitMs: 1200,
   conditions: [{ name: path, description: 'self-test', referrerPolicy: 'strict-origin-when-cross-origin' }] });
  return report.conditions[0];
 };
 const cases = [
  ['third party without framing headers', '/ok', '/', null, 'loaded-or-no-restriction-observed'],
  ['third party X-Frame-Options: DENY', '/xfo-deny', '/', null, 'third-party-framing-policy'],
  ["third party CSP frame-ancestors 'none'", '/csp-none', '/', null, 'third-party-framing-policy'],
  ['third party CSP frame-ancestors lists the parent', '/csp-allow', '/', null, 'loaded-or-no-restriction-observed'],
  ["parent CSP frame-src 'none'", '/ok', '/csp', "frame-src 'none'", 'site-csp']
 ];
 for (const [name, path, parentPath, csp, expected] of cases) {
  const condition = await run(path, parentPath, csp);
  assert.equal(condition.classification.verdict, expected, `${name}: ${JSON.stringify(condition.classification)}`);
  assert.ok(condition.topLevel.status === 200, `${name}: the URL itself opens top-level`);
  console.log('ok -', name, '->', condition.classification.verdict);
 }
 // Honest "unknown": nothing answers for the iframe URL at all.
 const dead = await run('/ok');
 assert.equal(classify({ ...dead, iframeResponses: [], iframeFailures: [], violations: [], frameUrl: null }, parentOrigin()).verdict, 'unknown');
 console.log('ok - no observation at all is reported as unknown, not guessed');
 console.log('embed-diagnostics-check: passed');
} finally {
 await Promise.all([close(third), close(parentServer)]);
}
