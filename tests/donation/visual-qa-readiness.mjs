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

// A page evaluation bounded by a Node-side deadline, so a renderer that never answers (for example
// no animation frame is ever delivered) cannot outlive the capture timeout. The race keeps a handler
// on the pending evaluation, so a rejection arriving after the deadline (closed context) is handled.
export const EVALUATION_TIMED_OUT = Symbol('EVALUATION_TIMED_OUT');
export async function boundedEvaluate(pending, remainingMs) {
  let timer;
  try {
    return await Promise.race([pending, new Promise(done => { timer = setTimeout(() => done(EVALUATION_TIMED_OUT), Math.max(0, remainingMs)); })]);
  } finally {
    clearTimeout(timer);
  }
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
  const evidence = (status, state, extra = {}) => ({
    status,
    waitedMs: now() - started,
    polls,
    timeoutMs,
    components: state.components,
    stylesheets: state.stylesheets.map(({ url, sameOrigin, loaded, performanceEntry }) => ({ url, sameOrigin, loaded, performanceEntry })),
    ...extra
  });
  for (;;) {
    const state = await boundedEvaluate(page.evaluate(probeInitialUi, components.map(({ id, selector }) => ({ id, selector }))),
      timeoutMs - (now() - started));
    if (state === EVALUATION_TIMED_OUT) {
      throw new InitialUiReadinessError('INITIAL_UI_READINESS_TIMEOUT', evidence('TIMEOUT', { components: [], stylesheets: [] }, { probeTimedOut: true }));
    }
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

// First-party request settlement. After initial UI readiness, every first-party request the browser
// actually issued must finish before DOM, performance and the screenshot are sampled. Each poll first
// waits for two real layout frames so lazy work scheduled by the latest layout is issued, then
// requires a quiet window with no first-party request in flight or newly started. Third-party
// requests are recorded but never waited for. Nothing is forced to load, blocked or ignored.
export const SETTLEMENT_QUIET_MS = 300;
export const SETTLEMENT_TIMEOUT_MS = 10000;
export const SETTLEMENT_POLL_MS = 50;

export function summarizeRequests(records, targetOrigin) {
  const summary = { firstPartyStarted: 0, firstPartyInFlight: [], thirdPartyInFlight: 0 };
  for (const item of records) {
    if (!item.url || !/^https?:/.test(item.url)) continue;
    const sameOrigin = new URL(item.url).origin === targetOrigin;
    const done = Number.isFinite(item.encodedDataLength) || Boolean(item.failed);
    if (sameOrigin) {
      summary.firstPartyStarted += 1;
      if (!done) summary.firstPartyInFlight.push(new URL(item.url).pathname);
    } else if (!done) summary.thirdPartyInFlight += 1;
  }
  return summary;
}

export class FirstPartySettlementError extends Error {
  constructor(reason, evidence) {
    super(`${reason}: ${evidence.firstPartyInFlight.join(', ')}`);
    this.name = 'FirstPartySettlementError';
    this.reason = reason;
    this.evidence = evidence;
  }
}

const twoFrames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));

export async function waitForFirstPartySettled(page, {
  requests,
  quietMs = SETTLEMENT_QUIET_MS,
  timeoutMs = SETTLEMENT_TIMEOUT_MS,
  pollMs = SETTLEMENT_POLL_MS,
  now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms))
}) {
  const started = now();
  let polls = 0;
  let quietSince = null;
  let lastStarted = -1;
  const evidence = (status, state, extra = {}) => ({
    status, waitedMs: now() - started, polls, framesPerPoll: 2, quietMs, timeoutMs,
    firstPartyStarted: state.firstPartyStarted, firstPartyInFlight: state.firstPartyInFlight, thirdPartyInFlight: state.thirdPartyInFlight,
    ...extra
  });
  for (;;) {
    // The frame wait itself is bounded: no animation frame within the deadline fails closed.
    if (await boundedEvaluate(page.evaluate(twoFrames), timeoutMs - (now() - started)) === EVALUATION_TIMED_OUT) {
      throw new FirstPartySettlementError('FIRST_PARTY_SETTLEMENT_TIMEOUT', evidence('TIMEOUT', requests(), { frameTimedOut: true }));
    }
    polls += 1;
    const state = requests();
    if (state.firstPartyInFlight.length === 0 && state.firstPartyStarted === lastStarted) {
      quietSince ??= now();
      if (now() - quietSince >= quietMs) return evidence('SETTLED', state);
    } else {
      quietSince = null;
      lastStarted = state.firstPartyStarted;
    }
    if (now() - started >= timeoutMs) throw new FirstPartySettlementError('FIRST_PARTY_SETTLEMENT_TIMEOUT', evidence('TIMEOUT', state));
    await sleep(pollMs);
  }
}

// Runs in the page after settlement: where each lazy image sits in the settled layout. An image with
// no layout box (for example display:none) has no distance. Content of a closed <details> keeps its
// box in Chromium but is skipped for painting and lazy loading, so it still reports a distance.
export function probeLazyImages() {
  return [...document.images].filter(image => image.loading === 'lazy').slice(0, 100).map(image => {
    const url = new URL(image.currentSrc || image.src, location.href);
    const rendered = image.getClientRects().length > 0;
    return {
      url: `${url.origin}${url.pathname}`,
      sameOrigin: url.origin === location.origin,
      rendered,
      settledDistancePx: rendered ? Math.round(image.getBoundingClientRect().top - innerHeight) : null
    };
  });
}

/** Settlement evidence must be complete and cover every finished first-party request the network saw. */
export function firstPartySettlementFailures(capture) {
  const settlement = capture.firstPartySettlement;
  if (!settlement || typeof settlement !== 'object' || !Array.isArray(settlement.sampledSameOriginUrls)) {
    return ['FIRST_PARTY_SETTLEMENT_MISSING'];
  }
  const failures = [];
  if (settlement.status !== 'SETTLED' || (settlement.firstPartyInFlight ?? []).length) failures.push('FIRST_PARTY_NOT_SETTLED');
  const sampled = new Set(settlement.sampledSameOriginUrls);
  const firstParty = (capture.network ?? []).filter(item => item.originClass === 'same-origin' && item.resourceType !== 'Document');
  if (firstParty.some(item => !item.failed && !Number.isFinite(item.encodedDataLength))) failures.push('FIRST_PARTY_REQUEST_UNFINISHED');
  if (firstParty.some(item => !item.failed && Number.isFinite(item.encodedDataLength) && Number.isFinite(item.status) &&
      item.status < 400 && !sampled.has(item.url))) {
    failures.push('MEASUREMENT_SAMPLED_BEFORE_REQUEST_COMPLETED');
  }
  return failures;
}
