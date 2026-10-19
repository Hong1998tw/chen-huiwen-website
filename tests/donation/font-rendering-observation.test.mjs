import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { visibleHanObservationInPage } from './font-rendering-observation.mjs';

function makeFixture(definitions) {
  let elements = [];
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'body *');
      return elements.filter(element => element.isConnected && element.ownerDocument === document);
    },
  };
  const window = { innerWidth: 390, innerHeight: 844 };
  const fixture = {
    document,
    window,
    setElements(next) { elements = next; },
    invoke(options) {
      const source = `(${visibleHanObservationInPage.toString()})(options)`;
      return runInNewContext(source, {
        options,
        document,
        window,
        Node: { TEXT_NODE: 3 },
        getComputedStyle: element => element.style,
      }, { timeout: 1000 });
    },
  };
  fixture.setElements(definitions.map(definition => makeElement(document, definition)));
  return fixture;
}

function makeElement(document, {
  tagName = 'P',
  id = '',
  text = '',
  rect = { left: 4, top: 8, right: 180, bottom: 36, width: 176, height: 28 },
  style = { display: 'block', visibility: 'visible', opacity: '1', clipPath: 'none', clip: 'auto' },
  attributes = {},
  connected = true,
} = {}) {
  const values = new Map(Object.entries(attributes));
  const element = {
    tagName,
    id,
    isConnected: connected,
    ownerDocument: document,
    childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    style,
    closest() { return null; },
    matches(selector) { return selector === 'summary' && tagName.toLowerCase() === 'summary'; },
    getBoundingClientRect() { return { ...rect }; },
    getAttribute(name) { return values.has(name) ? values.get(name) : null; },
    setAttribute(name, value) { values.set(name, String(value)); },
    removeAttribute(name) { values.delete(name); },
  };
  return element;
}

const captureOptions = markerPrefix => ({ action: 'capture', markerPrefix });
const validateOptions = (markerPrefix, expectedRows) => ({
  action: 'validate', markerPrefix, expectedRows,
});
const cleanupOptions = markerPrefix => ({ action: 'cleanup', markerPrefix });

test('the page collector records visible direct-text Han elements once and validates full coverage', () => {
  const fixture = makeFixture([
    { tagName: 'DIV', text: '父層中文' },
    { tagName: 'P', id: 'heading', text: '可見的中文標題' },
    { tagName: 'SPAN', text: '另一個可見中文標籤' },
    { tagName: 'P', text: '隱藏中文', style: { display: 'none', visibility: 'visible', opacity: '1', clipPath: 'none', clip: 'auto' } },
  ]);
  const snapshot = fixture.invoke(captureOptions('fixture-a-'));

  assert.equal(snapshot.visibleHanCount, 3);
  assert.deepEqual(Array.from(snapshot.rows, row => [row.index, row.tagName, row.id]), [
    [0, 'div', ''],
    [1, 'p', 'heading'],
    [2, 'span', ''],
  ]);
  assert.equal(fixture.invoke(validateOptions('fixture-a-', snapshot.rows)).completeCoverage, true);
});

test('a replaced element with the same marker is unstable and cannot count as covered', () => {
  const fixture = makeFixture([
    { tagName: 'P', text: '中文文字' },
    { tagName: 'SPAN', text: '第二段中文' },
  ]);
  const originalElements = fixture.document.querySelectorAll('body *');
  const snapshot = fixture.invoke(captureOptions('fixture-b-'));
  const replacement = makeElement(fixture.document, { tagName: 'P', text: '中文文字' });
  replacement.setAttribute('data-font-render-check', snapshot.rows[0].marker);
  originalElements[0].isConnected = false;
  fixture.setElements([replacement, originalElements[1]]);

  const validation = fixture.invoke(validateOptions('fixture-b-', snapshot.rows));
  assert.equal(validation.completeCoverage, false);
  assert.deepEqual(Array.from(validation.issues.disconnectedIndices), [0]);
  assert.deepEqual(Array.from(validation.issues.identityMismatchIndices), [0]);
  assert.equal(validation.currentVisibleHanCount, snapshot.visibleHanCount);
});

test('new visible Han text and changed text or viewport make the captured batch incomplete', () => {
  const fixture = makeFixture([{ tagName: 'P', text: '初始中文' }]);
  const snapshot = fixture.invoke(captureOptions('fixture-c-'));
  const first = fixture.document.querySelectorAll('body *')[0];
  first.childNodes[0].textContent = '變更後的中文';
  const added = makeElement(fixture.document, { tagName: 'STRONG', text: '新增可見中文' });
  fixture.setElements([first, added]);
  fixture.window.innerWidth = 400;

  const validation = fixture.invoke(validateOptions('fixture-c-', snapshot.rows));
  assert.equal(validation.completeCoverage, false);
  assert.deepEqual(Array.from(validation.issues.textMismatchIndices), [0]);
  assert.equal(validation.issues.viewportMismatch, true);
  assert.equal(validation.currentVisibleHanCount, 2);
  assert.equal(validation.issues.untrackedVisibleHanCount, 1);
});

test('cleanup restores a pre-existing marker and removes the observation registry', () => {
  const fixture = makeFixture([{
    tagName: 'P',
    text: '中文文字',
    attributes: { 'data-font-render-check': 'pre-existing-value' },
  }]);
  fixture.invoke(captureOptions('fixture-d-'));
  const element = fixture.document.querySelectorAll('body *')[0];
  assert.equal(element.getAttribute('data-font-render-check'), 'fixture-d-0');

  const cleanup = fixture.invoke(cleanupOptions('fixture-d-'));
  assert.equal(cleanup.clean, true);
  assert.equal(element.getAttribute('data-font-render-check'), 'pre-existing-value');
  assert.equal(cleanup.registryRemoved, true);
});
