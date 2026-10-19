import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  buildCmsFixtureHtml,
  buildCmsFixtureHtmlFulfill,
  buildCmsPreviewDraft,
  CMS_FIXTURE_HTML_CONTENT_TYPE,
  serializeCmsFixtureScriptValue,
} from './cms-preview-fixture.mjs';

const adminOrigin = 'https://admin.huiwen.tw';
const nonce = 'g02-fixture-nonce';

function makeRuntimeHarness() {
  const parentMessages = [];
  const parent = {
    postMessage(message, targetOrigin) { parentMessages.push({ message, targetOrigin }); },
  };
  const messageListeners = [];
  const clickListeners = [];
  const bodyChildren = [];
  const draftNodes = [];
  const heading = { textContent: '正式頁面' };
  const body = {
    querySelector() { return null; },
    prepend(...nodes) { bodyChildren.unshift(...nodes); },
  };
  const latestWrap = {
    replaceChildren() {},
    removeAttribute() {},
  };
  const loader = { dataset: { cmsPagePath: 'achievement-ci-fixture.html', cmsAdminOrigin: adminOrigin } };

  function makeNode(tagName) {
    const item = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      children: [],
      append(...nodes) { this.children.push(...nodes); },
      remove() { this.removed = true; },
    };
    draftNodes.push(item);
    return item;
  }

  const document = {
    documentElement: { dataset: {} },
    head: { querySelector() { return null; } },
    title: 'CMS fixture',
    querySelector(selector) {
      if (selector === 'script[data-cms-editor-loader]') return loader;
      if (selector === '.case-body') return body;
      if (selector === '.case-latest-wrap') return latestWrap;
      if (selector === '.case-head h1') return heading;
      return null;
    },
    querySelectorAll() { return []; },
    createElement: makeNode,
    addEventListener(type, listener, capture) {
      if (type === 'click') clickListeners.push({ listener, capture });
    },
  };
  const registerMessageListener = (type, listener) => {
    if (type === 'message') messageListeners.push(listener);
  };
  const window = { parent, addEventListener: registerMessageListener };
  const context = {
    URL,
    URLSearchParams,
    Element: class Element {},
    document,
    location: { search: '?cmsEdit=1', pathname: '/achievement-ci-fixture.html' },
    window,
    addEventListener: registerMessageListener,
  };
  const source = readFile(new URL('../../cms-page-editor.js', import.meta.url), 'utf8');

  return source.then((runtime) => {
    runInNewContext(runtime, context, { filename: 'cms-page-editor.js', timeout: 1000 });
    return {
      bodyChildren,
      clickListeners,
      dispatchMessage(event) { for (const listener of messageListeners) listener(event); },
      draftNodes,
      Element: context.Element,
      heading,
      parent,
      parentMessages,
    };
  });
}

test('builds UTF-8 HTML fixture headers, metadata, and exact non-ASCII response bytes', () => {
  const bodyMarkup = '<h1>CI草稿黑</h1><p>負面測試草稿：黑</p>';
  const response = buildCmsFixtureHtmlFulfill(bodyMarkup, { status: 404 });
  const document = response.body.toString('utf8');

  assert.equal(response.status, 404);
  assert.equal(response.headers['content-type'], CMS_FIXTURE_HTML_CONTENT_TYPE);
  assert.equal(response.body.byteLength, Buffer.byteLength(document, 'utf8'));
  assert.equal(document, buildCmsFixtureHtml(bodyMarkup));
  assert.match(document, /<meta charset="utf-8">/i);
  assert.ok(document.includes(bodyMarkup));
});

test('assembles the CI draft glyph into the visible title and paragraph payload safely', () => {
  const draft = buildCmsPreviewDraft('黑');
  const serialized = serializeCmsFixtureScriptValue(draft);
  const scriptSafe = serializeCmsFixtureScriptValue({ title: '</script>\u2028測試' });

  assert.equal(draft.title, 'CI草稿黑');
  assert.deepEqual(draft.paragraphs, ['CI草稿新增字：黑']);
  assert.deepEqual(JSON.parse(serialized), draft);
  assert.ok(!serialized.includes('</script>'));
  assert.ok(!scriptSafe.includes('</script>'));
  assert.ok(!scriptSafe.includes('\u2028'));
});

test('the actual CMS runtime captures a summary click, prevents expansion, and sends focus to its owner', async () => {
  const harness = await makeRuntimeHarness();
  const summary = new harness.Element();
  summary.closest = (selector) => selector === '.case-background' ? summary : null;
  harness.dispatchMessage({
    source: harness.parent,
    origin: adminOrigin,
    data: { type: 'huiwen-cms-init', nonce },
  });

  assert.equal(harness.clickListeners.length, 1);
  assert.equal(harness.clickListeners[0].capture, true);
  const event = { target: summary, prevented: false, preventDefault() { this.prevented = true; } };
  harness.clickListeners[0].listener(event);

  assert.equal(event.prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.parentMessages.at(-1))), {
    message: {
      type: 'huiwen-cms-case-focus',
      nonce,
      path: '/achievement-ci-fixture.html',
      section: 'paragraphs',
    },
    targetOrigin: adminOrigin,
  });
});

test('the actual CMS runtime rejects a wrong origin, source, or nonce before applying a draft', async () => {
  const harness = await makeRuntimeHarness();
  const payload = { title: '未授權草稿黑', paragraphs: ['黑'], history: [], media: [] };
  const previewMessage = { type: 'huiwen-cms-case-preview', nonce, case: payload };
  harness.dispatchMessage({ source: harness.parent, origin: 'https://evil.test', data: { type: 'huiwen-cms-init', nonce } });
  harness.dispatchMessage({ source: {}, origin: adminOrigin, data: { type: 'huiwen-cms-init', nonce } });
  assert.equal(harness.clickListeners.length, 0);

  harness.dispatchMessage({ source: harness.parent, origin: adminOrigin, data: { type: 'huiwen-cms-init', nonce } });
  harness.dispatchMessage({ source: harness.parent, origin: 'https://evil.test', data: previewMessage });
  harness.dispatchMessage({ source: {}, origin: adminOrigin, data: previewMessage });
  harness.dispatchMessage({ source: harness.parent, origin: adminOrigin,
    data: { ...previewMessage, nonce: 'wrong-nonce' } });

  assert.equal(harness.heading.textContent, '正式頁面');
  assert.deepEqual(harness.bodyChildren, []);

  harness.dispatchMessage({ source: harness.parent, origin: adminOrigin, data: previewMessage });
  assert.equal(harness.heading.textContent, '未授權草稿黑');
  assert.equal(harness.bodyChildren[0].tagName, 'DETAILS');
  assert.ok(harness.draftNodes.some((node) => node.tagName === 'P' && node.textContent === '黑'));
});
