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

/** Install an init-script probe for site.js's first compact-header RAF. */
export function installEarlyHeaderAnimationProbe() {
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const nativeAddEventListener = window.addEventListener.bind(window);
  const probe = {
    controllerRafQueued: false,
    controllerRafQueuedAt: null,
    queuedWhileDocumentLoading: false,
    readyStateAtQueued: null,
    queuedBeforeDCL: false,
    queuedDuringDOMContentLoaded: false,
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
  let domContentLoadedFinished = false;
  let controllerScript = null;
  let controllerScrollListenerRegistered = false;
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
    probe.domContentLoadedAt = performance.now();
    queueMicrotask(() => { domContentLoadedFinished = true; });
  }, { once: true, capture: true });

  window.addEventListener = function (type, listener, options) {
    const currentScript = type === 'scroll' && typeof listener === 'function'
      ? document.currentScript
      : null;
    const scriptURL = isDeferredClassicSiteScript(currentScript);
    if (!scriptURL) return nativeAddEventListener(type, listener, options);

    if (!controllerScript) {
      controllerScript = currentScript;
      controllerScrollListenerRegistered = true;
      probe.controllerScriptMatched = true;
      probe.controllerScriptURLPath = scriptURL.pathname;
      probe.controllerScriptType = currentScript.type || 'classic';
      probe.controllerScriptTypeAttribute = currentScript.type || '';
      probe.controllerScriptDeferred = currentScript.defer === true;
      probe.controllerScriptAsync = currentScript.async === true;
    }
    return nativeAddEventListener(type, listener, options);
  };

  window.requestAnimationFrame = callback => {
    const currentScript = document.currentScript;
    const scriptURL = isDeferredClassicSiteScript(currentScript);
    if (controllerScrollListenerRegistered && currentScript === controllerScript &&
        scriptURL && !probe.controllerRafQueued) {
      const readyState = document.readyState;
      probe.controllerRafQueued = true;
      probe.controllerRafQueuedAt = performance.now();
      probe.readyStateAtQueued = readyState;
      probe.queuedBeforeDCL = !domContentLoadedSeen;
      probe.queuedDuringDOMContentLoaded = domContentLoadedSeen && !domContentLoadedFinished;
      probe.queuedWhileDocumentLoading = !domContentLoadedSeen && readyState === 'loading';
      heldControllerCallback = callback;
      return nativeRequestAnimationFrame(() => {});
    }
    return nativeRequestAnimationFrame(callback);
  };

  document.addEventListener('DOMContentLoaded', () => {
    queueMicrotask(() => {
      if (!heldControllerCallback) {
        probe.unsupportedReason = 'The deferred site.js header controller startup RAF was not captured before its first sample.';
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
    });
  }, { once: true });
}

function makeEarlyHeaderProbeMock({
  readyState = 'interactive',
  script = { src: 'http://127.0.0.1:8765/site.js?v=test', type: '', defer: true },
} = {}) {
  let currentScript = null;
  let currentY = 0;
  let clock = 0;
  let controllerSample = null;
  const documentListeners = new Map();
  const windowListeners = new Map();
  const nativeAnimationFrames = [];
  const microtasks = [];
  const clickListeners = [];
  const toggleAttributes = new Map([['aria-expanded', 'false']]);
  const headerClasses = new Set();
  const navigationClasses = new Set();
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
    querySelector(selector) {
      return selector === '.menu-toggle' ? toggle
        : selector === '#navigation' ? navigation
          : selector === '.site-header' ? header
            : null;
    },
  };
  Object.defineProperty(document, 'currentScript', { get: () => currentScript });

  const body = {};
  const menuLink = { tagName: 'A', id: 'menu-link', className: '', getAttribute: () => null };
  const toggle = {
    tagName: 'BUTTON',
    id: 'menu-toggle',
    className: 'menu-toggle',
    addEventListener(type, listener) {
      if (type === 'click') clickListeners.push(listener);
    },
    focus() { document.activeElement = this; },
    click() {
      toggleAttributes.set('aria-expanded', 'true');
      navigationClasses.add('is-open');
      document.activeElement = menuLink;
      for (const listener of clickListeners) listener.call(this, { isTrusted: false });
    },
    getAttribute(name) { return toggleAttributes.get(name) ?? null; },
  };
  const header = {
    classList: {
      add(name) { headerClasses.add(name); },
      remove(name) { headerClasses.delete(name); },
      contains(name) { return headerClasses.has(name); },
    },
    getBoundingClientRect() {
      const height = headerClasses.has('is-compact') ? 52 : 64;
      return { top: 0, bottom: height, left: 0, right: 390, width: 390, height };
    },
  };
  const navigation = {
    classList: {
      add(name) { navigationClasses.add(name); },
      remove(name) { navigationClasses.delete(name); },
      contains(name) { return navigationClasses.has(name); },
    },
    contains(node) { return node === menuLink; },
    getBoundingClientRect() {
      const top = (headerClasses.has('is-compact') ? 52 : 64) + 12;
      return { top, bottom: top + 200, left: 10, right: 380, width: 370, height: 200 };
    },
  };
  document.activeElement = body;

  const window = {
    location: { href: 'http://127.0.0.1:8765/service.html' },
    innerWidth: 390,
    get scrollY() { return currentY; },
    scrollTo({ top }) { currentY = top; },
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
  const context = vm.createContext({
    document,
    window,
    URL,
    performance: { now: () => ++clock },
    queueMicrotask: callback => microtasks.push(callback),
  });
  vm.runInContext('(' + installEarlyHeaderAnimationProbe.toString() + ')()', context);

  const controllerCallback = () => {
    if (window.scrollY > 8) header.classList.add('is-compact');
    controllerSample = {
      scrollY: window.scrollY,
      domContentLoadedSeen: window.__earlyHeaderAnimationProbe.domContentLoadedSeen,
      ariaExpanded: toggle.getAttribute('aria-expanded'),
      menuOpen: navigation.classList.contains('is-open'),
      focusedInsideMenu: navigation.contains(document.activeElement),
    };
  };
  const queueControllerStartupRaf = () => {
    currentScript = script;
    window.addEventListener('scroll', () => window.requestAnimationFrame(controllerCallback), { passive: true });
    // site.js calls onScroll() once as the header controller initializes.
    window.requestAnimationFrame(controllerCallback);
    currentScript = null;
  };
  const queueSiteRafBeforeControllerRegistration = () => {
    currentScript = script;
    window.requestAnimationFrame(() => {});
    currentScript = null;
  };
  const queueUnrelatedRaf = () => {
    const unrelatedScript = { src: 'http://127.0.0.1:8765/civic.js?v=test', type: '', defer: true };
    document.scripts.push(unrelatedScript);
    currentScript = unrelatedScript;
    window.requestAnimationFrame(() => {});
    currentScript = null;
  };
  const flushMicrotasks = () => {
    while (microtasks.length) microtasks.shift()();
  };
  return {
    document,
    nativeAnimationFrames,
    probe: window.__earlyHeaderAnimationProbe,
    controllerCallback,
    get controllerSample() { return controllerSample; },
    queueControllerStartupRaf,
    queueSiteRafBeforeControllerRegistration,
    queueUnrelatedRaf,
    simulateControllerInitializationDuringDOMContentLoaded() {
      document.addEventListener('DOMContentLoaded', queueControllerStartupRaf);
    },
    dispatchDOMContentLoaded() {
      document.readyState = 'interactive';
      const listeners = documentListeners.get('DOMContentLoaded') ?? [];
      for (const { listener, options } of listeners.filter(item => item.options?.capture)) listener.call(document, { type: 'DOMContentLoaded' });
      for (const { listener, options } of listeners.filter(item => !item.options?.capture)) listener.call(document, { type: 'DOMContentLoaded' });
      flushMicrotasks();
    },
    flushAnimationFrames() {
      let iterations = 0;
      while (nativeAnimationFrames.length) {
        assert(iterations++ < 10, 'animation-frame fixture did not settle');
        const callbacks = nativeAnimationFrames.splice(0);
        for (const callback of callbacks) callback(++clock);
      }
    },
  };
}

function assertFirstSampleReleasedAfterDOMContentLoaded(fixture, { queuedBeforeDCL, queuedDuringDOMContentLoaded }) {
  const { probe } = fixture;
  assert.equal(probe.domContentLoadedSeen, true);
  assert.equal(probe.queuedBeforeDCL, queuedBeforeDCL);
  assert.equal(probe.queuedDuringDOMContentLoaded, queuedDuringDOMContentLoaded);
  assert.equal(probe.programmaticFocusInvoked, true);
  assert.equal(probe.programmaticClickInvoked, true);
  assert.equal(probe.clickIsTrusted, false);
  assert.equal(probe.scrollYBeforeControllerSample, 600);
  assert.equal(probe.ariaExpandedBeforeControllerSample, 'true');
  assert.equal(probe.menuOpenBeforeControllerSample, true);
  assert.equal(probe.firstSampleStartedAt, null);
  assert.equal(fixture.controllerSample, null);

  fixture.flushAnimationFrames();

  assert(probe.firstSampleStartedAt > probe.domContentLoadedAt);
  assert.equal(probe.firstSampleScrollY, 600);
  assert.equal(probe.firstSampleState.compact, true);
  assert.equal(probe.firstSampleState.ariaExpanded, 'true');
  assert.equal(probe.firstSampleState.activeElementInsideMenu, true);
  assert.equal(evaluateMenuAnchor(
    probe.firstSampleState.headerBottomForAnchor,
    probe.firstSampleState.menuTopForAnchor,
  ).withinTolerance, true);
  assert.equal(probe.firstSampleState.menuRight <= probe.firstSampleState.viewportWidth + 0.5, true);
  assert.deepEqual(fixture.controllerSample, {
    scrollY: 600,
    domContentLoadedSeen: true,
    ariaExpanded: 'true',
    menuOpen: true,
    focusedInsideMenu: true,
  });
}

export function assertEarlyHeaderAnimationProbeFixtures() {
  for (const readyState of ['loading', 'interactive']) {
    const fixture = makeEarlyHeaderProbeMock({ readyState });
    fixture.queueSiteRafBeforeControllerRegistration();
    fixture.queueUnrelatedRaf();
    assert.equal(fixture.probe.controllerRafQueued, false);

    fixture.queueControllerStartupRaf();
    assert.equal(fixture.probe.controllerScriptMatched, true);
    assert.equal(fixture.probe.controllerScriptURLPath, '/site.js');
    assert.equal(fixture.probe.controllerScriptType, 'classic');
    assert.equal(fixture.probe.controllerScriptTypeAttribute, '');
    assert.equal(fixture.probe.controllerScriptDeferred, true);
    assert.equal(fixture.probe.controllerScriptAsync, false);
    assert.equal(fixture.probe.controllerRafQueued, true);
    assert.equal(fixture.probe.readyStateAtQueued, readyState);
    assert.equal(fixture.probe.queuedBeforeDCL, true);
    assert.equal(fixture.probe.queuedDuringDOMContentLoaded, false);
    assert.equal(fixture.probe.queuedWhileDocumentLoading, readyState === 'loading');
    assert.equal(fixture.nativeAnimationFrames.includes(fixture.controllerCallback), false);
    assert.equal(fixture.controllerSample, null);

    fixture.dispatchDOMContentLoaded();
    assertFirstSampleReleasedAfterDOMContentLoaded(fixture, {
      queuedBeforeDCL: true,
      queuedDuringDOMContentLoaded: false,
    });
  }

  const duringDOMContentLoaded = makeEarlyHeaderProbeMock();
  duringDOMContentLoaded.simulateControllerInitializationDuringDOMContentLoaded();
  duringDOMContentLoaded.dispatchDOMContentLoaded();
  assert.equal(duringDOMContentLoaded.probe.controllerRafQueued, true);
  assert.equal(duringDOMContentLoaded.probe.readyStateAtQueued, 'interactive');
  assertFirstSampleReleasedAfterDOMContentLoaded(duringDOMContentLoaded, {
    queuedBeforeDCL: false,
    queuedDuringDOMContentLoaded: true,
  });

  const missingFirstRaf = makeEarlyHeaderProbeMock();
  missingFirstRaf.dispatchDOMContentLoaded();
  assert.equal(missingFirstRaf.probe.controllerRafQueued, false);
  assert.match(missingFirstRaf.probe.unsupportedReason, /startup RAF was not captured/);
  const missingGate = evaluateRequiredCheckGate([
    {
      name: 'early header observation',
      required: true,
      status: missingFirstRaf.probe.controllerRafQueued && missingFirstRaf.probe.firstSampleStartedAt !== null
        ? 'Passed'
        : 'Pending',
    },
  ]);
  assert.equal(missingGate.status, 'Pending');
  assert.deepEqual(missingGate.pendingChecks, ['early header observation']);
  assert.equal(missingGate.shouldExitNonZero, true);

  const unrelatedScript = makeEarlyHeaderProbeMock({
    script: { src: 'http://127.0.0.1:8765/civic.js?v=test', type: 'text/javascript', defer: true },
  });
  unrelatedScript.queueControllerStartupRaf();
  assert.equal(unrelatedScript.probe.controllerScriptMatched, false);
  assert.equal(unrelatedScript.probe.controllerRafQueued, false);
  assert.equal(unrelatedScript.nativeAnimationFrames[0], unrelatedScript.controllerCallback);

  for (const script of [
    { src: 'http://127.0.0.1:8765/site.js?v=test', type: 'module', defer: true },
    { src: 'http://127.0.0.1:8765/site.js?v=test', type: '', defer: false },
  ]) {
    const unsupportedScript = makeEarlyHeaderProbeMock({ script });
    unsupportedScript.queueControllerStartupRaf();
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
