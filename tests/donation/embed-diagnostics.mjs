/** Bounded, reproducible parent-page / third-party-iframe diagnostics (manual tool, not part of CI).
 * Question it answers with evidence: when an embedded third-party iframe (e.g. the Facebook page plugin)
 * shows "refused to connect", is it (a) the third party's own framing policy, (b) this site's CSP,
 * (c) the browser environment, or (d) still unknown?
 *
 *   PARENT_URL=https://www.huiwen.tw/news.html node tests/donation/embed-diagnostics.mjs
 *   EMBED_URL=<iframe src>   override the iframe URL (default: first <template><iframe> found in the parent)
 *   CHROME_PATH=<binary>     browser to use (default: Playwright's Chromium)
 *   OUT_DIR=<dir>            default tests/donation/results/embed-diagnostics
 *   WAIT_MS=15000            how long to watch after the iframe is attached
 *
 * Per condition it records: every response/failure for the iframe URL (status, framing-related headers),
 * Chromium `blockedReason`, `securitypolicyviolation` events (parent and frames), console and page errors,
 * the frame's final URL (chrome-error:// means the browser refused), cookies and storage-related browser
 * state, and the browser conditions (version, UA, headless, locale). It then opens the same URL as a
 * top-level page for comparison. Nothing is submitted and no credentials are used; the browser starts
 * with a fresh, empty profile (logged-out), which is itself a condition to compare against a real session.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FRAMING_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'permissions-policy', 'referrer-policy', 'set-cookie'];
const pick = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => FRAMING_HEADERS.includes(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), name.toLowerCase() === 'set-cookie' ? `(${String(value).split('\n').length} cookie(s); values not recorded)` : value]));

const frameAncestorsAllow = (csp, parentOrigin, frameOrigin) => {
 const directive = String(csp || '').split(';').map(item => item.trim()).find(item => item.toLowerCase().startsWith('frame-ancestors'));
 if (!directive) return null;
 const sources = directive.split(/\s+/).slice(1);
 if (sources.includes("'none'")) return false;
 return sources.some(source => source === '*' || source === "'self'" && parentOrigin === frameOrigin || source === parentOrigin || (source.startsWith('https://*.') && new URL(parentOrigin).hostname.endsWith(source.slice(9))));
};

/** Evidence-only classification. Returns { verdict, because[] }; "unknown" is a valid, honest answer. */
export function classify(condition, parentOrigin) {
 const because = [];
 const frameOrigin = new URL(condition.embedUrl).origin;
 const main = condition.iframeResponses.find(row => row.resourceType === 'Document' && row.url.split('?')[0] === condition.embedUrl.split('?')[0]);
 const parentCsp = condition.violations.filter(row => row.where === 'parent' && /frame-src|child-src|default-src/.test(row.violatedDirective));
 if (parentCsp.length) { because.push(`parent page reported ${parentCsp.length} CSP violation(s): ${[...new Set(parentCsp.map(row => row.violatedDirective))].join(', ')}`); return { verdict: 'site-csp', because }; }
 const xfo = main?.headers['x-frame-options'];
 const ancestors = main ? frameAncestorsAllow(main.headers['content-security-policy'], parentOrigin, frameOrigin) : null;
 if (xfo && /^(deny|sameorigin)$/i.test(xfo.trim())) because.push(`third-party response has X-Frame-Options: ${xfo}`);
 if (ancestors === false) because.push(`third-party Content-Security-Policy frame-ancestors does not allow ${parentOrigin}`);
 const blocked = condition.iframeFailures.find(row => /BLOCKED_BY_RESPONSE|blocked/i.test(`${row.errorText} ${row.blockedReason || ''}`));
 if (blocked) because.push(`Chromium blocked the frame navigation (${blocked.errorText}${blocked.blockedReason ? ', blockedReason=' + blocked.blockedReason : ''})`);
 if (because.some(item => item.startsWith('third-party'))) return { verdict: 'third-party-framing-policy', because };
 if (blocked) { because.push('no framing header was visible for the blocked navigation, so the blocking rule is not attributable'); return { verdict: 'blocked-by-response-unattributed', because }; }
 if (condition.frameUrl?.startsWith('chrome-error://')) { because.push('frame ended on chrome-error:// without a recorded blocking response (network failure or browser/proxy policy)'); return { verdict: 'browser-or-network', because }; }
 if (!main) { because.push('no response was observed for the iframe document (not requested, or network blocked before any response)'); return { verdict: 'unknown', because }; }
 because.push(`iframe document answered ${main.status} with no framing restriction and no violation in this condition`);
 return { verdict: 'loaded-or-no-restriction-observed', because };
}

export async function diagnose({ parentUrl, embedUrl, chromePath, waitMs = 15000, conditions }) {
 const { chromium } = await import(pathToFileURL(resolve(fileURLToPath(new URL('.', import.meta.url)), 'node_modules/playwright/index.mjs')).href);
 const browser = await chromium.launch({ executablePath: chromePath || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
 const parentOrigin = new URL(parentUrl).origin;
 const report = { generatedAt: new Date().toISOString(), parentUrl, parentOrigin, browser: { version: browser.version(), executable: chromePath || chromium.executablePath(), headless: true, profile: 'fresh, empty, logged out' }, node: process.version, conditions: [] };
 try {
  for (const spec of conditions) {
   const context = await browser.newContext({ locale: spec.locale || 'zh-TW', ignoreHTTPSErrors: Boolean(spec.ignoreHTTPSErrors) });
   const page = await context.newPage();
   const cdp = await context.newCDPSession(page);
   await cdp.send('Network.enable');
   const entry = { name: spec.name, description: spec.description, embedUrl: null, iframeResponses: [], iframeFailures: [], violations: [], console: [], pageErrors: [], frameUrl: null };
   const track = new Map();
   cdp.on('Network.requestWillBeSent', event => track.set(event.requestId, { url: event.request.url, type: event.type }));
   const matches = url => entry.embedUrl && url.split('?')[0] === entry.embedUrl.split('?')[0];
   cdp.on('Network.responseReceived', event => { if (matches(event.response.url)) entry.iframeResponses.push({ url: event.response.url, resourceType: event.type, status: event.response.status, protocol: event.response.protocol, remoteIPAddress: event.response.remoteIPAddress, headers: pick(event.response.headers) }); });
   cdp.on('Network.loadingFailed', event => { const known = track.get(event.requestId); if (known && matches(known.url)) entry.iframeFailures.push({ url: known.url, resourceType: event.type, errorText: event.errorText, blockedReason: event.blockedReason, corsErrorStatus: event.corsErrorStatus }); });
   page.on('console', message => entry.console.push({ type: message.type(), text: message.text().slice(0, 500), location: message.location()?.url }));
   page.on('pageerror', error => entry.pageErrors.push(String(error.message || error).slice(0, 500)));
   await page.exposeBinding('__reportViolation', ({ frame }, row) => { entry.violations.push({ ...row, where: frame === page.mainFrame() ? 'parent' : 'frame:' + frame.url().slice(0, 120) }); });
   await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', event => window.__reportViolation({ violatedDirective: event.violatedDirective, effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI, documentURI: event.documentURI, disposition: event.disposition }), true); });
   await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => entry.pageErrors.push('parent navigation: ' + error.message));
   entry.parent = { finalUrl: page.url(), title: await page.title().catch(() => null) };
   const found = embedUrl || await page.evaluate(() => document.querySelector('template iframe[src*="facebook.com"], template iframe[src], iframe[src*="facebook.com"]')?.getAttribute('src') || document.querySelector('template')?.content.querySelector('iframe')?.getAttribute('src') || null);
   if (!found) { entry.error = 'no iframe URL found in the parent page; pass EMBED_URL'; report.conditions.push(entry); await context.close(); continue; }
   entry.embedUrl = new URL(found, parentUrl).href;
   const attrs = await page.evaluate(({ src, referrerPolicy }) => {
    const frame = document.createElement('iframe');
    frame.src = src; frame.width = '500'; frame.height = '600'; frame.title = 'diagnostic embed';
    frame.setAttribute('allow', 'encrypted-media; picture-in-picture; web-share');
    if (referrerPolicy) frame.referrerPolicy = referrerPolicy;
    document.body.append(frame);
    return { referrerPolicy: frame.referrerPolicy || '(default)', documentReferrerPolicy: document.referrerPolicy || '(default)' };
   }, { src: entry.embedUrl, referrerPolicy: spec.referrerPolicy || null });
   entry.iframeAttributes = attrs;
   await page.waitForTimeout(waitMs);
   entry.frameUrl = page.frames().filter(frame => frame !== page.mainFrame()).map(frame => frame.url()).find(url => url && url !== 'about:blank') || null;
   entry.cookies = (await context.cookies()).map(cookie => ({ domain: cookie.domain, name: cookie.name, sameSite: cookie.sameSite, secure: cookie.secure, httpOnly: cookie.httpOnly, valuesRecorded: false }));
   entry.browserState = await page.evaluate(() => ({ userAgent: navigator.userAgent, cookieEnabled: navigator.cookieEnabled, webdriver: navigator.webdriver, language: navigator.language, thirdPartyCookiesApi: typeof document.hasStorageAccess, topLevelIsSecure: isSecureContext }));
   entry.classification = classify(entry, parentOrigin);
   // Same URL as a top-level document: separates "the URL works" from "the URL works when framed".
   const direct = await context.newPage();
   const directResult = { url: entry.embedUrl };
   await direct.goto(entry.embedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).then(response => { directResult.status = response?.status(); directResult.headers = pick(response?.headers() || {}); }).catch(error => { directResult.error = error.message.split('\n')[0]; });
   directResult.finalUrl = direct.url();
   entry.topLevel = directResult;
   report.conditions.push(entry);
   await context.close();
  }
 } finally { await browser.close(); }
 return report;
}

export const DEFAULT_CONDITIONS = [
 { name: 'default', description: 'what the site ships: iframe with referrerPolicy strict-origin-when-cross-origin set by embeds.js', referrerPolicy: 'strict-origin-when-cross-origin' },
 { name: 'no-referrer', description: 'same iframe but referrer withheld; differs only in what the third party sees', referrerPolicy: 'no-referrer' }
];

async function main() {
 const parentUrl = process.env.PARENT_URL || 'https://www.huiwen.tw/news.html';
 const out = resolve(process.env.OUT_DIR || fileURLToPath(new URL('./results/embed-diagnostics/', import.meta.url)));
 const report = await diagnose({ parentUrl, embedUrl: process.env.EMBED_URL, chromePath: process.env.CHROME_PATH, waitMs: Number(process.env.WAIT_MS || 15000), conditions: DEFAULT_CONDITIONS });
 await mkdir(out, { recursive: true });
 await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
 for (const condition of report.conditions) console.log(`[${condition.name}] ${condition.classification?.verdict || condition.error}: ${(condition.classification?.because || []).join(' | ')}`);
 console.log(`report: ${resolve(out, 'report.json')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

