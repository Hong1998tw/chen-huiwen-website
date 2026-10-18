import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureInlineStyleAttribute,
  classifyOverflowRect,
  codePointOffsets,
  inlineStyleAttributeMatches,
  isActualOverflowingHeading,
  restoreInlineStyleAttribute
} from './target-size-overflow.mjs';

class FakeElement {
  constructor(styleAttribute = null) {
    this.attributes = new Map();
    if (styleAttribute !== null) this.attributes.set('style', styleAttribute);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

test('codepoint ranges preserve DOM Range UTF-16 offsets for astral characters', () => {
  assert.deepEqual(codePointOffsets('A😀文').map(({ codePointOffset, utf16Start, utf16End, codePoint }) => ({
    codePointOffset, utf16Start, utf16End, codePoint
  })), [
    { codePointOffset: 0, utf16Start: 0, utf16End: 1, codePoint: 'U+0041' },
    { codePointOffset: 1, utf16Start: 1, utf16End: 3, codePoint: 'U+1F600' },
    { codePointOffset: 2, utf16Start: 3, utf16End: 4, codePoint: 'U+6587' }
  ]);
});

test('codepoint scanning can enforce the diagnostic cap before allocating full-node offsets', () => {
  assert.deepEqual(codePointOffsets('甲乙丙丁', 2).map(point => point.character), ['甲', '乙']);
});

test('overflow classification distinguishes viewport overflow from heading-frame overflow', () => {
  const frame = { viewportWidth: 390, headingLeft: 16, headingRight: 374 };
  assert.deepEqual(classifyOverflowRect({ left: 370, right: 402 }, frame), {
    outsideViewportLeft: false,
    outsideViewportRight: true,
    outsideHeadingLeft: false,
    outsideHeadingRight: true
  });
  assert.deepEqual(classifyOverflowRect({ left: 350, right: 380 }, frame), {
    outsideViewportLeft: false,
    outsideViewportRight: false,
    outsideHeadingLeft: false,
    outsideHeadingRight: true
  });
});

test('diagnostic eligibility requires document overflow attributable to the heading', () => {
  assert.deepEqual(isActualOverflowingHeading({
    documentScrollWidth: 404, documentClientWidth: 390, headingScrollWidth: 388, headingClientWidth: 358
  }), { documentOverflows: true, headingOverflows: true, eligible: true });
  assert.equal(isActualOverflowingHeading({
    documentScrollWidth: 404, documentClientWidth: 390, headingScrollWidth: 358, headingClientWidth: 358
  }).eligible, false);
  assert.equal(isActualOverflowingHeading({
    documentScrollWidth: 390, documentClientWidth: 390, headingScrollWidth: 388, headingClientWidth: 358
  }).eligible, false);
});

test('restoring an absent style attribute removes the temporary attribute', () => {
  const element = new FakeElement();
  const original = captureInlineStyleAttribute(element);
  element.setAttribute('style', 'overflow-wrap: anywhere !important');
  restoreInlineStyleAttribute(element, original);
  assert.equal(element.getAttribute('style'), null);
  assert.equal(inlineStyleAttributeMatches(element, original), true);
});

test('restoring a present style attribute preserves every original inline declaration exactly', () => {
  const original = 'color: rgb(1, 2, 3); --keep: a b; overflow-wrap: break-word !important;';
  const element = new FakeElement(original);
  const snapshot = captureInlineStyleAttribute(element);
  element.setAttribute('style', 'color: red; word-break: break-all !important');
  restoreInlineStyleAttribute(element, snapshot);
  assert.equal(element.getAttribute('style'), original);
  assert.equal(inlineStyleAttributeMatches(element, original), true);
});
