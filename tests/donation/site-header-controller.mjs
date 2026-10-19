/** Execute the shipped compact-header and menu IIFEs in a pure Node VM. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(resolve(root, 'site.js'), 'utf8');
const compactMarker = '// Keep the native sticky header calm while scrolling:';
const menuMarker = '// Progressive enhancement: navigation remains usable when JavaScript is disabled.';
const menuEndMarker = '\n(() => {\n  const search = document.getElementById(\'record-search\');';

function sourceSection(startMarker, endMarker, startAt = 0) {
  const start = source.indexOf(startMarker, startAt);
  assert.notEqual(start, -1, `site.js source locator missing: ${startMarker}`);
  assert.equal(source.indexOf(startMarker, start + startMarker.length), -1, `site.js source locator is ambiguous: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `site.js source end locator missing: ${endMarker}`);
  return source.slice(start, end);
}

const compactSource = sourceSection(compactMarker, menuMarker);
const menuSource = sourceSection(menuMarker, menuEndMarker);
const sourceHash = createHash('sha256').update(compactSource).update('\0').update(menuSource).digest('hex');
assert.match(compactSource, /window\.addEventListener\('scroll', onScroll, \{passive:true\}\)/);
assert.match(compactSource, /pendingMediaReset/);
assert.match(menuSource, /site:header-layout-change/);
assert.match(menuSource, /event\.propertyName === 'min-height'/);

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.target = null;
    this.currentTarget = null;
    this.bubbles = init.bubbles ?? false;
    this.propertyName = init.propertyName;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    if (event.target === null) event.target = this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}

class FakeElement extends FakeEventTarget {
  constructor(name, document) {
    super();
    this.name = name;
    this.tagName = name.toUpperCase();
    this.document = document;
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.children = [];
    this.styleValues = new Map();
    this.style = {
      setProperty: (key, value) => this.styleValues.set(key, String(value)),
      getPropertyValue: key => this.styleValues.get(key) || '',
    };
    this.hidden = false;
    this.inert = false;
    this.open = false;
    this.disabled = false;
    this.boxBottom = 65;
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(child) { this.children.push(child); child.parentElement = this; }
  after(child) {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, child);
    child.parentElement = this.parentElement;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { this.document.activeElement = this; }
  getClientRects() { return []; }
  getBoundingClientRect() { return {top:0, bottom:this.boxBottom, left:0, right:390, width:390, height:this.boxBottom}; }
  querySelector(selector) {
    if (this.name === 'navigation' && selector === '.global-search-trigger') return this.document.search;
    return null;
  }
  querySelectorAll() { return []; }
}

class FakeMediaQuery extends FakeEventTarget {
  constructor(query, matches) {
    super();
    this.media = query;
    this.matches = matches;
  }
  change(matches) {
    this.matches = matches;
    this.dispatchEvent(new FakeEvent('change'));
  }
}

function makeHarness({mobile = true, scrollY = 0} = {}) {
  let currentY = scrollY;
  let scrollReads = 0;
  const registrationOrder = [];
  const frames = [];
  const document = new FakeEventTarget();
  const html = new FakeElement('html', document);
  const body = new FakeElement('body', document);
  const header = new FakeElement('header', document);
  const navWrap = new FakeElement('nav-wrap', document);
  const toggle = new FakeElement('menu-toggle', document);
  const navigation = new FakeElement('navigation', document);
  const search = new FakeElement('global-search-trigger', document);
  const main = new FakeElement('main', document);
  document.documentElement = html;
  document.body = body;
  document.header = header;
  document.toggle = toggle;
  document.navigation = navigation;
  document.search = search;
  document.activeElement = body;
  header.append(navWrap);
  navWrap.append(toggle);
  navWrap.append(navigation);
  body.append(header);
  body.append(main);
  document.querySelector = selector => selector === '.site-header' ? header
    : selector === '.site-header .nav-wrap' ? navWrap
    : selector === '.menu-toggle' ? toggle
      : null;
  document.getElementById = id => id === 'navigation' ? navigation : null;
  document.createElement = name => new FakeElement(name, document);

  const mobileQuery = new FakeMediaQuery('(max-width: 780px)', mobile);
  const desktopQuery = new FakeMediaQuery('(min-width: 781px)', !mobile);
  const window = new FakeEventTarget();
  window.matchMedia = query => query === '(max-width: 780px)' ? mobileQuery : desktopQuery;
  window.requestAnimationFrame = callback => {
    registrationOrder.push('raf');
    frames.push(callback);
    return frames.length;
  };
  window.addEventListener = (type, listener, options) => {
    if (type === 'scroll') {
      registrationOrder.push(options?.passive ? 'scroll-passive' : 'scroll');
    }
    FakeEventTarget.prototype.addEventListener.call(window, type, listener);
  };
  mobileQuery.addEventListener = (type, listener) => {
    if (type === 'change') registrationOrder.push('media');
    FakeEventTarget.prototype.addEventListener.call(mobileQuery, type, listener);
  };
  Object.defineProperty(window, 'scrollY', {get() { scrollReads++; return currentY; }});

  const context = vm.createContext({window, document, Event:FakeEvent});
  const runCompact = () => vm.runInContext(compactSource, context, {filename:'site.js#compact-controller'});
  const runMenu = () => vm.runInContext(menuSource, context, {filename:'site.js#menu-controller'});
  const flushFrame = () => {
    assert.equal(frames.length, 1, `expected one queued frame, found ${frames.length}`);
    frames.shift()(16);
  };
  const scroll = y => {
    currentY = y;
    window.dispatchEvent(new FakeEvent('scroll'));
  };
  return {
    context, document, window, header, navWrap, toggle, navigation, search, mobileQuery,
    registrationOrder, frames, runCompact, runMenu, flushFrame, scroll,
    setY: y => { currentY = y; },
    get scrollReads() { return scrollReads; },
  };
}

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
}

check('constructs without reading scrollY and coalesces startup plus early scrolls', () => {
  const h = makeHarness({scrollY:250});
  h.runCompact();
  assert.equal(h.scrollReads, 0);
  assert.deepEqual(h.registrationOrder, ['scroll-passive','media','raf']);
  assert.equal(h.frames.length, 1);
  h.scroll(246);
  h.scroll(250);
  assert.equal(h.scrollReads, 0);
  assert.equal(h.frames.length, 1);
  h.flushFrame();
  assert.equal(h.scrollReads, 1);
  assert.equal(h.header.classList.contains('is-compact'), true);
});

check('restored nonzero seed keeps the original cumulative 8px up/down thresholds', () => {
  const h = makeHarness({scrollY:250});
  h.runCompact();
  h.flushFrame();
  h.scroll(246); h.flushFrame();
  assert.equal(h.header.classList.contains('is-compact'), true);
  h.scroll(242); h.flushFrame();
  assert.equal(h.header.classList.contains('is-compact'), false);
  h.scroll(250); h.flushFrame();
  assert.equal(h.header.classList.contains('is-compact'), true);
});

check('the first sample uses the latest pre-frame position without inventing its unseen history', () => {
  const h = makeHarness({scrollY:250});
  h.runCompact();
  h.scroll(240);
  assert.equal(h.scrollReads, 0);
  assert.equal(h.frames.length, 1);
  h.flushFrame();
  assert.equal(h.scrollReads, 1);
  assert.equal(h.header.classList.contains('is-compact'), true);
});

check('zero/top behavior and desktop expansion remain intact', () => {
  const top = makeHarness({scrollY:0});
  top.runCompact(); top.flushFrame();
  assert.equal(top.header.classList.contains('is-compact'), false);
  top.scroll(4); top.flushFrame();
  assert.equal(top.header.classList.contains('is-compact'), false);
  top.scroll(12); top.flushFrame();
  assert.equal(top.header.classList.contains('is-compact'), true);
  top.scroll(8); top.flushFrame();
  assert.equal(top.header.classList.contains('is-compact'), false);

  const desktop = makeHarness({mobile:false, scrollY:250});
  desktop.runCompact(); desktop.flushFrame();
  assert.equal(desktop.header.classList.contains('is-compact'), false);
  desktop.scroll(400); desktop.flushFrame();
  assert.equal(desktop.header.classList.contains('is-compact'), false);
});

check('a pre-ready media reset wins over restored compact initialization', () => {
  const h = makeHarness({scrollY:250});
  h.runCompact();
  h.mobileQuery.change(false);
  h.mobileQuery.change(true);
  assert.equal(h.scrollReads, 0);
  h.flushFrame();
  assert.equal(h.scrollReads, 1);
  assert.equal(h.header.classList.contains('is-compact'), false);
});

check('ready media changes reset immediately and reseed direction from real scrollY', () => {
  const h = makeHarness({scrollY:250});
  h.runCompact(); h.flushFrame();
  assert.equal(h.header.classList.contains('is-compact'), true);
  h.setY(500);
  h.mobileQuery.change(false);
  assert.equal(h.scrollReads, 2);
  assert.equal(h.header.classList.contains('is-compact'), false);
  h.mobileQuery.change(true);
  assert.equal(h.scrollReads, 3);
  h.scroll(508); h.flushFrame();
  assert.equal(h.header.classList.contains('is-compact'), true);
});

check('early menu focus survives restored initialization and the header min-height end updates menu top after the child end', () => {
  const h = makeHarness({scrollY:250});
  h.runCompact(); h.runMenu();
  h.toggle.dispatchEvent(new FakeEvent('click'));
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, h.search);
  assert.equal(h.navigation.style.getPropertyValue('--menu-top'), '77px');
  assert.equal(h.frames.length, 1);

  h.flushFrame();
  assert.equal(h.header.classList.contains('is-compact'), true);
  assert.equal(h.document.activeElement, h.search);
  assert.equal(h.navigation.classList.contains('is-open'), true);
  assert.equal(h.navigation.style.getPropertyValue('--menu-top'), '77px');

  h.navWrap.dispatchEvent(new FakeEvent('transitionend', {propertyName:'min-height', bubbles:true}));
  assert.equal(h.navigation.style.getPropertyValue('--menu-top'), '77px');

  h.header.boxBottom = 52;
  h.header.dispatchEvent(new FakeEvent('transitionend', {propertyName:'min-height'}));
  assert.equal(h.navigation.style.getPropertyValue('--menu-top'), '64px');
  assert.equal(h.document.activeElement, h.search);
});

console.log(JSON.stringify({source:'site.js', sourceHash, checks:checks.map(name => ({name,status:'PASS'}))}, null, 2));
