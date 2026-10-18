import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInlineTextException } from './target-size-inline.mjs';

class FakeText {
  constructor(value, rendered = true, top = 100, left = 0) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.rendered = rendered;
    this.top = top;
    this.left = left;
    this.parentElement = null;
  }
}

class FakeElement {
  constructor(localName, { attrs = {}, style = {}, className = '' } = {}) {
    this.nodeType = 1;
    this.localName = localName;
    this.attrs = new Map(Object.entries(attrs));
    this.style = { display: 'block', visibility: 'visible', contentVisibility: 'visible', opacity: '1', ...style };
    this.className = className;
    this.childNodes = [];
    this.parentElement = null;
    this.ownerDocument = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      node.ownerDocument = this.ownerDocument;
      if (node.nodeType === 1) node.setOwnerDocument(this.ownerDocument);
      this.childNodes.push(node);
    }
    return this;
  }

  setOwnerDocument(ownerDocument) {
    this.ownerDocument = ownerDocument;
    for (const child of this.childNodes) {
      child.ownerDocument = ownerDocument;
      if (child.nodeType === 1) child.setOwnerDocument(ownerDocument);
    }
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  matches(selectorList) {
    return selectorList.split(',').some(rawSelector => {
      const selector = rawSelector.trim();
      const role = selector.match(/^\[role="([^"]+)"\]$/);
      const attribute = selector.match(/^\[([^=\]]+)\]$/);
      if (role) return this.attrs.get('role') === role[1];
      if (attribute) return this.attrs.has(attribute[1]);
      if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
      return this.localName === selector;
    });
  }

  closest(selectorList) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selectorList)) return current;
    }
    return null;
  }

  getClientRects() {
    return this.rects || [{ left: 40, right: 80, top: 100, bottom: 116, width: 40, height: 16 }];
  }
}

function fixture(build) {
  const document = {
    defaultView: { getComputedStyle: element => element.style },
    createRange() {
      let selected;
      return {
        selectNodeContents(node) { selected = node; },
        getClientRects() {
          return selected.rendered
            ? [{ left: selected.left, right: selected.left + 40, top: selected.top, bottom: selected.top + 16, width: 40, height: 16 }]
            : [];
        }
      };
    }
  };
  const target = new FakeElement('a', { attrs: { href: '#action' }, style: { display: 'inline' } });
  target.append(new FakeElement('span').append(new FakeText('動作連結')));
  const context = build(target);
  context.setOwnerDocument(document);
  return { target, context };
}

test('獨立 li 或 heading 只有一個 link 時不豁免', () => {
  for (const tag of ['li', 'h2']) {
    const { target } = fixture(link => new FakeElement(tag).append(link));
    assert.equal(isInlineTextException(target), false, `${tag} only-link must remain a target`);
  }
});

test('句中連結旁有可見非 target 文字時可豁免', () => {
  const { target } = fixture(link => new FakeElement('p').append(new FakeText('閱讀 ', true, 100, 0), link, new FakeText(' 後續說明', true, 100, 80)));
  assert.equal(isInlineTextException(target), true);
});

test('同一容器另一行的文字不構成句中上下文', () => {
  const { target } = fixture(link => new FakeElement('li').append(link, new FakeElement('div').append(new FakeText('另一行文字', true, 140))));
  assert.equal(isInlineTextException(target), false);
});

test('同一行但視覺上與目標相隔甚遠的文字不構成句中上下文', () => {
  const { target } = fixture(link => new FakeElement('p').append(link, new FakeText('遠處文字', true, 100, 200)));
  assert.equal(isInlineTextException(target), false);
});

test('hidden、script、其他 link 與巢狀 target 的文字不構成上下文', () => {
  const cases = [
    ['hidden attribute', new FakeElement('span', { attrs: { hidden: '' } }).append(new FakeText('隱藏文字'))],
    ['display none', new FakeElement('span', { style: { display: 'none' } }).append(new FakeText('隱藏文字'))],
    ['screen-reader clipping', new FakeElement('span', { style: { clip: 'rect(0px, 0px, 0px, 0px)' } }).append(new FakeText('裁切文字'))],
    ['script', new FakeElement('script').append(new FakeText('程式內容'))],
    ['another link', new FakeElement('a', { attrs: { href: '#other' } }).append(new FakeText('另一個目標'))]
  ];
  for (const [label, extra] of cases) {
    const { target } = fixture(link => new FakeElement('p').append(link, extra));
    assert.equal(isInlineTextException(target), false, `${label} must not exempt the target`);
  }
});

test('target 自身巢狀包裹的文字仍不視為非 target 上下文', () => {
  const { target } = fixture(link => new FakeElement('h2').append(link));
  assert.equal(isInlineTextException(target), false);
});

test('保留幾何但經零 opacity filter 隱藏的文字不構成上下文', () => {
  for (const filter of ['opacity(0)', 'opacity(0%)', 'brightness(1) opacity(0.0)']) {
    const { target } = fixture(link => new FakeElement('p').append(
      link, new FakeElement('span', { style: { filter } }).append(new FakeText('透明文字'))
    ));
    assert.equal(isInlineTextException(target), false, filter);
  }
});

test('沒有可見幾何的文字不能豁免', () => {
  const { target } = fixture(link => new FakeElement('p').append(link, new FakeText('裁切文字', false)));
  assert.equal(isInlineTextException(target), false);
});
