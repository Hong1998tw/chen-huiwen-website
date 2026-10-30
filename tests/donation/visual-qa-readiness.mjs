// Initial owned UI readiness for A-05 captures.
// Some first-party UI finishes after `load` (small Q appends its stylesheet from idle callbacks and
// only unhides itself in that stylesheet's onload). DOM, performance and the screenshot must be
// sampled after that UI is complete, otherwise a capture can count fewer bytes than it shows.

// Each component reports ready with its own existing signal; no product code is changed for A-05.
export const INITIAL_UI_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'small-q', selector: '#small-q' })
]);
export const INITIAL_UI_TIMEOUT_MS = 10000;
export const INITIAL_UI_POLL_MS = 50;

// Runs in the page; must stay self-contained.
export function probeInitialUi(components) {
  return {
    readyState: document.readyState,
    components: components.map(component => {
      const element = document.querySelector(component.selector);
      return element
        ? { id: component.id, present: true, mounted: element.dataset.mounted === 'true', visible: !element.hidden }
        : { id: component.id, present: false, mounted: false, visible: false };
    }),
    stylesheets: [...document.querySelectorAll('link[rel~="stylesheet"]')].map(link => {
      const url = new URL(link.href, location.href);
      const entry = performance.getEntriesByName(url.href, 'resource').at(-1);
      return {
        href: url.href,
        url: `${url.origin}${url.pathname}`,
        sameOrigin: url.origin === location.origin,
        loaded: Boolean(link.sheet),
        performanceEntry: Boolean(entry && entry.responseEnd > 0)
      };
    })
  };
}

export function initialUiReady(state) {
  return state.readyState === 'complete' &&
    state.components.every(component => !component.present || (component.mounted && component.visible)) &&
    state.stylesheets.every(sheet => sheet.loaded && (!sheet.sameOrigin || sheet.performanceEntry));
}

export class InitialUiReadinessError extends Error {
  constructor(reason, evidence) {
    super(`${reason}: ${JSON.stringify(evidence.components)}`);
    this.name = 'InitialUiReadinessError';
    this.reason = reason;
    this.evidence = evidence;
  }
}

/** Poll until every present component and stylesheet is complete; timeout or a failed stylesheet fails closed. */
export async function waitForInitialUi(page, {
  components = INITIAL_UI_COMPONENTS,
  timeoutMs = INITIAL_UI_TIMEOUT_MS,
  pollMs = INITIAL_UI_POLL_MS,
  requestFailed = () => false,
  now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms))
} = {}) {
  const started = now();
  let polls = 0;
  const evidence = (status, state) => ({
    status,
    waitedMs: now() - started,
    polls,
    timeoutMs,
    components: state.components,
    stylesheets: state.stylesheets.map(({ url, sameOrigin, loaded, performanceEntry }) => ({ url, sameOrigin, loaded, performanceEntry }))
  });
  for (;;) {
    const state = await page.evaluate(probeInitialUi, components.map(({ id, selector }) => ({ id, selector })));
    polls += 1;
    if (state.stylesheets.some(sheet => !sheet.loaded && requestFailed(sheet.href))) {
      throw new InitialUiReadinessError('INITIAL_UI_STYLESHEET_FAILED', evidence('FAILED', state));
    }
    if (initialUiReady(state)) return evidence('READY', state);
    if (now() - started >= timeoutMs) throw new InitialUiReadinessError('INITIAL_UI_READINESS_TIMEOUT', evidence('TIMEOUT', state));
    await sleep(pollMs);
  }
}

/** Capture-quality reasons; recorded evidence must also cover every stylesheet the network saw. */
export function initialUiReadinessFailures(capture) {
  const readiness = capture.initialUiReadiness;
  if (!readiness || typeof readiness !== 'object' || !Array.isArray(readiness.components) || !Array.isArray(readiness.stylesheets)) {
    return ['INITIAL_UI_READINESS_MISSING'];
  }
  const failures = [];
  if (readiness.status !== 'READY' ||
      readiness.components.some(component => component.present && !(component.mounted && component.visible))) {
    failures.push('INITIAL_UI_NOT_READY');
  }
  if (readiness.stylesheets.some(sheet => !sheet.loaded || (sheet.sameOrigin && !sheet.performanceEntry))) {
    failures.push('INITIAL_UI_STYLESHEET_NOT_MEASURED');
  }
  const measured = new Set(readiness.stylesheets.filter(sheet => sheet.loaded).map(sheet => sheet.url));
  const late = (capture.network ?? []).filter(item => item.originClass === 'same-origin' && item.resourceType === 'Stylesheet' &&
    !item.failed && Number.isFinite(item.status) && item.status < 400 && !measured.has(item.url));
  if (late.length) failures.push('MEASUREMENT_SAMPLED_BEFORE_STYLESHEET');
  return failures;
}
