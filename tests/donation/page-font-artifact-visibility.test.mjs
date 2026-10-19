import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isVisibleInViewport } from './page-font-artifact-visibility.mjs';

const browserVisibility = runInNewContext(`(${isVisibleInViewport.toString()})`);

function makeTree() {
  const view = {
    innerWidth: 1365,
    innerHeight: 950,
    getComputedStyle: (element) => element.computedStyle,
  };
  const document = { defaultView: view };
  const create = (localName, { style = {}, attributes = [], rect = {
    left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30,
  }, open = undefined } = {}) => ({
    localName,
    children: [],
    parentElement: null,
    ownerDocument: document,
    isConnected: true,
    open,
    computedStyle: {
      display: 'block', visibility: 'visible', contentVisibility: 'visible', opacity: '1', ...style,
    },
    hasAttribute: (name) => attributes.includes(name),
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
    getClientRects: () => rect ? [rect] : [],
  });
  const append = (parent, child) => {
    child.parentElement = parent;
    parent.children.push(child);
    return child;
  };
  const html = create('html');
  const body = append(html, create('body'));
  return { append, body, create };
}

test('CMS visibility helper rejects content inside a closed details ancestor', () => {
  const tree = makeTree();
  const details = tree.append(tree.body, tree.create('details', { open: false }));
  const summary = tree.append(details, tree.create('summary'));
  const paragraph = tree.append(details, tree.create('p'));

  assert.equal(browserVisibility(summary), true);
  assert.equal(browserVisibility(paragraph), false);
});

test('CMS visibility helper rejects hidden attributes and hidden computed ancestors', () => {
  const hiddenAttributeTree = makeTree();
  const hiddenAttributeParent = hiddenAttributeTree.append(hiddenAttributeTree.body,
    hiddenAttributeTree.create('section', { attributes: ['hidden'] }));
  assert.equal(browserVisibility(hiddenAttributeTree.append(hiddenAttributeParent,
    hiddenAttributeTree.create('p'))), false);

  const hiddenStyleTree = makeTree();
  const hiddenStyleParent = hiddenStyleTree.append(hiddenStyleTree.body,
    hiddenStyleTree.create('section', { style: { visibility: 'hidden' } }));
  assert.equal(browserVisibility(hiddenStyleTree.append(hiddenStyleParent,
    hiddenStyleTree.create('p'))), false);
});

test('CMS visibility helper rejects display:none ancestors', () => {
  const tree = makeTree();
  const parent = tree.append(tree.body, tree.create('section', { style: { display: 'none' } }));

  assert.equal(browserVisibility(tree.append(parent, tree.create('p'))), false);
});

test('CMS visibility helper rejects boxes outside the viewport', () => {
  const tree = makeTree();
  const paragraph = tree.append(tree.body, tree.create('p', { rect: {
    left: 10, top: 950, right: 110, bottom: 980, width: 100, height: 30,
  } }));

  assert.equal(browserVisibility(paragraph), false);
});

test('CMS visibility helper accepts a rendered element inside the viewport', () => {
  const tree = makeTree();
  const paragraph = tree.append(tree.body, tree.create('p'));

  assert.equal(browserVisibility(paragraph), true);
});

test('CMS preview title and paragraph observations use the same visibility helper', async () => {
  const runner = await readFile(new URL('./page-font-artifact.mjs', import.meta.url), 'utf8');
  assert.match(runner, /import \{ isVisibleInViewport \} from '\.\/page-font-artifact-visibility\.mjs'/);
  assert.match(runner, /failureTitleLocator\.first\(\)\.evaluate\(isVisibleInViewport\)/);
  assert.match(runner, /failureParagraphLocator\.evaluate\(isVisibleInViewport\)/);
  assert.match(runner, /previewTitleLocator\.evaluate\(isVisibleInViewport\)/);
  assert.match(runner, /previewParagraphLocator\.evaluate\(isVisibleInViewport\)/);
  assert.match(runner, /postFocusParagraphLocator\.evaluate\(isVisibleInViewport\)/);
});
