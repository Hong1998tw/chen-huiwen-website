import assert from 'node:assert/strict';
import vm from 'node:vm';

export const MENU_ANCHOR_TOLERANCE_PX = 0.75;

export function evaluateMenuAnchor(headerBottom, menuTop) {
  const expectedMenuTop = Math.ceil(headerBottom + 12);
  const anchorDelta = menuTop - expectedMenuTop;
  return {
    expectedMenuTop,
    anchorDelta,
    withinTolerance: Math.abs(anchorDelta) <= MENU_ANCHOR_TOLERANCE_PX,
  };
}

export function evaluateRequiredCheckGate(checks) {
  const requiredChecks = checks.filter(check => check.required === true);
  const pendingChecks = requiredChecks.filter(check => check.status === 'Pending').map(check => check.name);
  const nonPassingChecks = requiredChecks.filter(check => check.status !== 'Passed').map(check => check.name);
  const failedChecks = requiredChecks.filter(check => check.status !== 'Passed' && check.status !== 'Pending');
  return {
    status: failedChecks.length ? 'Failed' : pendingChecks.length ? 'Pending' : 'Passed',
    pendingChecks,
    nonPassingChecks,
    shouldExitNonZero: nonPassingChecks.length > 0,
  };
}

/** Install an init-script probe for the first deferred site.js header scroll RAF. */
export function installEarlyHeaderAnimationProbe() {
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const nativeAddEventListener = window.addEventListener.bind(window);
  const probe = {
    controllerRafQueued: false,
    controllerRafQueuedAt: null,
    queuedWhileDocumentLoading: false,
    readyStateAtQueued: null,
    queuedBeforeDCL: false,
    controllerScriptMatched: false,
    controllerScriptURLPath: null,
    controllerScriptType: null,
    controllerScriptTypeAttribute: null,
    controllerScriptDeferred: false,
    controllerScriptAsync: false,
    domContentLoadedSeen: false,
    domContentLoadedAt: null,
    releasedAt: null,
    firstSampleStartedAt: null,
    firstSampleScrollY: null,
    firstSampleState: null,
    inputSource: 'programmatic focus() and HTMLElement.click() in DOMContentLoaded listener; not human input',
    programmaticFocusInvoked: false,
    programmaticClickInvoked: false,
    clickIsTrusted: null,
    unsupportedReason: null,
  };
  let domContentLoadedSeen = false;
  let controllerScrollListenerActive = false;
  let heldControllerCallback = null;

  const isDeferredClassicSiteScript = script => {
    if (!script?.src || !script.defer || script.async) return null;
    if (!Array.from(document.scripts ?? []).includes(script)) return null;
    const type = String(script.type || '').trim().toLowerCase();
    if (type && type !== 'text/javascript') return null;
    const actual = new URL(script.src, document.baseURI);
    const expected = new URL('site.js', window.location.href);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return null;
    return actual;
  };

  window.__earlyHeaderAnimationProbe = probe;
  document.addEventListener('DOMContentLoaded', () => {
    domContentLoadedSeen = true;
    probe.domContentLoadedSeen = true;
  }, { once: true, capture: true });

  window.addEventListener = function (type, listener, options) {
    const scriptURL = type === 'scroll' && typeof listener === 'function'
      ? isDeferredClassicSiteScript(document.currentScript)
      : null;
    if (!scriptURL || domContentLoadedSeen) return nativeAddEventListener(type, listener, options);

    const currentScript = document.currentScript;
    probe.controllerScriptMatched = true;
    probe.controllerScriptURLPath = scriptURL.pathname;
    probe.controllerScriptType = currentScript.type || 'classic';
    probe.controllerScriptTypeAttribute = currentScript.type || '';
    probe.controllerScriptDeferred = currentScript.defer === true;
    probe.controllerScriptAsync = currentScript.async === true;
    const trackedControllerScrollListener = function (...args) {
      const beforeDOMContentLoaded = !domContentLoadedSeen &&
        (document.readyState === 'loading' || document.readyState === 'interactive');
      if (!beforeDOMContentLoaded) return listener.apply(this, args);
      controllerScrollListenerActive = true;
      try {
        return listener.apply(this, args);
      } finally {
        controllerScrollListenerActive = false;
      }
    };
    return nativeAddEventListener(type, trackedControllerScrollListener, options);
  };

  window.requestAnimationFrame = callback => {
    const readyState = document.readyState;
    const beforeDOMContentLoaded = !domContentLoadedSeen &&
      (readyState === 'loading' || readyState === 'interactive');
    if (controllerScrollListenerActive && beforeDOMContentLoaded && !probe.controllerRafQueued) {
      probe.controllerRafQueued = true;
      probe.controllerRafQueuedAt = performance.now();
      probe.readyStateAtQueued = readyState;
      probe.queuedBeforeDCL = true;
      probe.queuedWhileDocumentLoading = readyState === 'loading';
      heldControllerCallback = callback;
      return nativeRequestAnimationFrame(() => {});
    }
    return nativeRequestAnimationFrame(callback);
  };

  document.addEventListener('DOMContentLoaded', () => {
    probe.domContentLoadedAt = performance.now();
    if (!heldControllerCallback) {
      probe.unsupportedReason = 'The deferred site.js header controller did not expose a queued first RAF before DOMContentLoaded.';
      return;
    }
    const toggle = document.querySelector('.menu-toggle');
    const navigation = document.querySelector('#navigation');
    const header = document.querySelector('.site-header');
    if (!toggle || !navigation || !header) {
      probe.unsupportedReason = 'The existing header, menu toggle, or navigation selector was missing at DOMContentLoaded.';
      return;
    }

    window.scrollTo({ top: 600, behavior: 'instant' });
    probe.scrollYBeforeControllerSample = window.scrollY;
    toggle.addEventListener('click', event => { probe.clickIsTrusted = event.isTrusted; }, { once: true });
    toggle.focus({ preventScroll: true });
    probe.programmaticFocusInvoked = document.activeElement === toggle;
    toggle.click();
    probe.programmaticClickInvoked = true;
    probe.ariaExpandedBeforeControllerSample = toggle.getAttribute('aria-expanded');
    probe.menuOpenBeforeControllerSample = navigation.classList.contains('is-open');

    const controllerCallback = heldControllerCallback;
    heldControllerCallback = null;
    probe.releasedAt = performance.now();
    nativeRequestAnimationFrame(timestamp => {
      probe.firstSampleStartedAt = performance.now();
      probe.firstSampleScrollY = window.scrollY;
      controllerCallback(timestamp);
      // site.js dispatches its initial layout-change event synchronously for this nonzero-scroll sample.
      const headerRect = header.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      probe.firstSampleState = {
        compact: header.classList.contains('is-compact'),
        headerHeight: headerRect.height,
        headerBottom: headerRect.bottom,
        menuTop: navigationRect.top,
        headerBottomForAnchor: headerRect.bottom,
        menuTopForAnchor: navigationRect.top,
        menuLeft: navigationRect.left,
        menuRight: navigationRect.right,
        viewportWidth: window.innerWidth,
        ariaExpanded: toggle.getAttribute('aria-expanded'),
        activeElementInsideMenu: navigation.contains(document.activeElement),
        activeElement: document.activeElement ? {
          tagName: document.activeElement.tagName,
          id: document.activeElement.id || null,
          className: typeof document.activeElement.className === 'string' ? document.activeElement.className : null,
          href: document.activeElement.getAttribute?.('href') ?? null,
        } : null,
      };
    });
  }, { once: true });
}

function makeEarlyHeaderProbeMock({
  readyState = 'interactive',
  script = { src: 'http://127.0.0.1:8765/site.js?v=test', type: '', defer: true },
} = {}) {
  let currentScript = null;
  const documentListeners = new Map();
  const windowListeners = new Map();
  const nativeAnimationFrames = [];
  const document = {
    readyState,
    baseURI: 'http://127.0.0.1:8765/service.html',
    scripts: [script],
    activeElement: null,
    addEventListener(type, listener, options) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push({ listener, options });
      documentListeners.set(type, listeners);
    },
    querySelector() { return null; },
  };
  Object.defineProperty(document, 'currentScript', { get: () => currentScript });
  const window = {
    location: { href: 'http://127.0.0.1:8765/service.html' },
    requestAnimationFrame(callback) {
      nativeAnimationFrames.push(callback);
      return nativeAnimationFrames.length;
    },
    addEventListener(type, listener, options) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push({ listener, options });
      windowListeners.set(type, listeners);
    },
  };
  const context = vm.createContext({ document, window, URL, performance: { now: () => 10 } });
  vm.runInContext(`(${installEarlyHeaderAnimationProbe.toString()})()`, context);

  const controllerCallback = () => {};
  currentScript = script;
  window.addEventListener('scroll', () => window.requestAnimationFrame(controllerCallback), { passive: true });
  currentScript = null;

  return {
    document,
    documentListeners,
    nativeAnimationFrames,
    probe: window.__earlyHeaderAnimationProbe,
    controllerCallback,
    dispatchDOMContentLoaded() {
      const listeners = documentListeners.get('DOMContentLoaded') ?? [];
      for (const { listener, options } of listeners.filter(item => item.options?.capture)) listener.call(document, { type: 'DOMContentLoaded' });
      for (const { listener, options } of listeners.filter(item => !item.options?.capture)) listener.call(document, { type: 'DOMContentLoaded' });
    },
    dispatchControllerScroll() {
      const listener = windowListeners.get('scroll')?.[0]?.listener;
      assert.equal(typeof listener, 'function');
      listener.call(window, { type: 'scroll' });
    },
  };
}

export function assertEarlyHeaderAnimationProbeFixtures() {
  for (const readyState of ['loading', 'interactive']) {
    const fixture = makeEarlyHeaderProbeMock({ readyState });
    fixture.dispatchControllerScroll();
    assert.equal(fixture.probe.controllerScriptMatched, true);
    assert.equal(fixture.probe.controllerScriptURLPath, '/site.js');
    assert.equal(fixture.probe.controllerScriptType, 'classic');
    assert.equal(fixture.probe.controllerScriptTypeAttribute, '');
    assert.equal(fixture.probe.controllerScriptDeferred, true);
    assert.equal(fixture.probe.controllerScriptAsync, false);
    assert.equal(fixture.probe.controllerRafQueued, true);
    assert.equal(fixture.probe.readyStateAtQueued, readyState);
    assert.equal(fixture.probe.queuedBeforeDCL, true);
    assert.equal(fixture.probe.queuedWhileDocumentLoading, readyState === 'loading');
    assert.equal(fixture.nativeAnimationFrames.length, 1);
    assert.notEqual(fixture.nativeAnimationFrames[0], fixture.controllerCallback);
  }

  const afterDOMContentLoaded = makeEarlyHeaderProbeMock({ readyState: 'interactive' });
  afterDOMContentLoaded.dispatchDOMContentLoaded();
  afterDOMContentLoaded.dispatchControllerScroll();
  assert.equal(afterDOMContentLoaded.probe.domContentLoadedSeen, true);
  assert.equal(afterDOMContentLoaded.probe.controllerRafQueued, false);
  assert.equal(afterDOMContentLoaded.probe.queuedBeforeDCL, false);
  assert.equal(afterDOMContentLoaded.probe.readyStateAtQueued, null);
  assert.equal(afterDOMContentLoaded.nativeAnimationFrames.length, 1);
  assert.equal(afterDOMContentLoaded.nativeAnimationFrames[0], afterDOMContentLoaded.controllerCallback);

  const unrelatedScript = makeEarlyHeaderProbeMock({
    script: { src: 'http://127.0.0.1:8765/civic.js?v=test', type: 'text/javascript', defer: true },
  });
  unrelatedScript.dispatchControllerScroll();
  assert.equal(unrelatedScript.probe.controllerScriptMatched, false);
  assert.equal(unrelatedScript.probe.controllerRafQueued, false);
  assert.equal(unrelatedScript.nativeAnimationFrames[0], unrelatedScript.controllerCallback);

  for (const script of [
    { src: 'http://127.0.0.1:8765/site.js?v=test', type: 'module', defer: true },
    { src: 'http://127.0.0.1:8765/site.js?v=test', type: '', defer: false },
  ]) {
    const unsupportedScript = makeEarlyHeaderProbeMock({ script });
    unsupportedScript.dispatchControllerScroll();
    assert.equal(unsupportedScript.probe.controllerScriptMatched, false);
    assert.equal(unsupportedScript.probe.controllerRafQueued, false);
    assert.equal(unsupportedScript.nativeAnimationFrames[0], unsupportedScript.controllerCallback);
  }
}

export function assertHeaderAnimationContractFixtures() {
  const requiredPending = evaluateRequiredCheckGate([
    { name: 'early header observation', required: true, status: 'Pending' },
  ]);
  assert.equal(requiredPending.status, 'Pending');
  assert.deepEqual(requiredPending.pendingChecks, ['early header observation']);
  assert.equal(requiredPending.shouldExitNonZero, true);

  const capturePending = evaluateRequiredCheckGate([
    { name: 'WCAG 2.2 AA target-size baseline', status: 'Pending' },
  ]);
  assert.equal(capturePending.status, 'Passed');
  assert.deepEqual(capturePending.pendingChecks, []);
  assert.equal(capturePending.shouldExitNonZero, false);

  const anchoredEndpoint = evaluateMenuAnchor(52.1, 65);
  assert.equal(anchoredEndpoint.expectedMenuTop, 65);
  assert.equal(anchoredEndpoint.anchorDelta, 0);
  assert.equal(anchoredEndpoint.withinTolerance, true);

  assert.equal(evaluateMenuAnchor(52.1, 65.75).withinTolerance, true);
  assert.equal(evaluateMenuAnchor(52.1, 65.751).withinTolerance, false);

  assertEarlyHeaderAnimationProbeFixtures();
}
