import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Deterministic UI-state tests. No Worker, credentials, live API or publication.
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const consoleScript = readFileSync(new URL("../public/console.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

function sourceBetween(start: string, end: string) {
  const first = app.indexOf(start);
  const last = app.indexOf(end, first);
  assert.ok(first >= 0 && last > first, "tested function boundaries must exist");
  return app.slice(first, last);
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(api: (path: string, method?: string, body?: unknown) => Promise<unknown>) {
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      hidden: false, textContent: "", disabled: false, attributes: {},
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      removeAttribute(name: string) { delete this.attributes[name]; },
    });
    return nodes.get(selector);
  };
  const noOp = () => {};
  const context = vm.createContext({
    api, $: node, document: { getElementById: node }, structuredClone,
    confirm: () => true, isPageEditable: () => true, isCasePage: () => false,
    pageStatusLabel: () => "正式頁面", setPageStatus: (value: string) => { node("#page-draft-status").textContent = value; },
    pageControls: noOp, renderCaseEditor: noOp, renderHomeEditor: noOp,
    renderSeoEditor: noOp, renderEditorialEditor: noOp, renderExtraBlocksEditor: noOp,
    renderPages: noOp, renderPageHistory: noOp, applyCurrentPageEdits: noOp,
    validateRequiredFields: () => true, cleanCaseDraft: () => null,
    loadPages: async () => {}, defaultCaseSectionOrder: [],
    render: noOp, history: async () => {}, notice: noOp, read: () => ({ name: "saved value" }),
  });
  vm.runInContext(app.slice(0, app.indexOf("const defaultCaseSectionOrder")), context);
  vm.runInContext(sourceBetween("async function selectPage(page)", "\nfunction renderPageHistory"), context);
  vm.runInContext(sourceBetween("async function savePageDraft()", "\nasync function submitPageOperation"), context);
  vm.runInContext(sourceBetween("async function save()", "\nasync function history()"), context);
  return { context, node, read: (expression: string) => vm.runInContext(expression, context) };
}
const pageA = { path: "a.html", title: "A", editor_scope: "partial", source_kind: "static", source_path: "a.html" };
const pageB = { ...pageA, path: "b.html", title: "B", source_path: "b.html" };
const draft = (value: string) => ({ draft: { version: 1, payload: JSON.stringify({ fields: { title: { value } } }) } });

test("latest page selection wins when previous request resolves last", async () => {
  const a = deferred(), b = deferred();
  const h = harness(async path => path.startsWith("/api/page-draft?")
    ? (path.includes("a.html") ? a.promise : b.promise)
    : path.includes("/history") ? { versions: [] } : { blocks: [] });
  h.context.a = pageA; h.context.b = pageB;
  const first = h.read("selectPage(a)");
  const second = h.read("selectPage(b)");
  b.resolve(draft("B")); await second;
  a.resolve(draft("A")); await first;
  assert.equal(h.read("selectedPage.path"), "b.html");
  assert.equal(h.read("pageFields.get('title').value"), "B");
  assert.equal(h.node("#page-editor-title").textContent, "B");
  assert.equal(h.read("pageLoading"), false);
});

test("stale request failure does not turn the newer page into an error", async () => {
  const a = deferred();
  const h = harness(async path => path.startsWith("/api/page-draft?")
    ? (path.includes("a.html") ? a.promise : draft("B"))
    : path.includes("/history") ? { versions: [] } : { blocks: [] });
  h.context.a = pageA; h.context.b = pageB;
  const first = h.read("selectPage(a)");
  await h.read("selectPage(b)");
  a.reject(new Error("old connection failed"));
  assert.equal(await first, false);
  assert.equal(h.read("pageLoadFailed"), false);
  assert.equal(h.read("pageFields.get('title').value"), "B");
});

test("current load failure offers retry and leaves editing gated", async () => {
  const h = harness(async () => { throw new Error("offline"); });
  h.context.a = pageA;
  await assert.rejects(h.read("selectPage(a)"), /offline/);
  assert.equal(h.read("pageLoading"), false);
  assert.equal(h.read("pageLoadFailed"), true);
  assert.equal(h.node("#page-retry").hidden, false);
  assert.equal(await h.read("savePageDraft()"), false);
});

test("saving a page preserves input made during the request and rejects double save", async () => {
  const saved = deferred(); let writes = 0;
  const h = harness(async (path, method) => {
    if (method === "PUT") { writes++; return saved.promise; }
    return path.includes("/history") ? { versions: [] } : { draft: { version: 2, payload: "{}" } };
  });
  h.context.a = pageA;
  h.read("selectedPage=a; pageDraft={version:1}; pageDirty=true; pageEditRevision=1");
  const pending = h.read("savePageDraft()");
  assert.equal(await h.read("savePageDraft()"), false);
  h.read("pageEditRevision++; pageFields.set('title',{value:'new typing'}); pageDirty=true");
  saved.resolve({ version: 2 });
  assert.equal(await pending, false);
  assert.equal(writes, 1);
  assert.equal(h.read("pageDraft.version"), 2);
  assert.equal(h.read("pageDirty"), true);
  assert.equal(h.read("pageFields.get('title').value"), "new typing");
  assert.equal(h.read("pageSaveBusy"), false);
});

test("old page save completion does not repaint a newer selection", async () => {
  const saved = deferred();
  const h = harness(async () => saved.promise);
  h.context.a = pageA; h.context.b = pageB;
  h.read("selectedPage=a; pageDraft={version:1}; pageDirty=true");
  const pending = h.read("savePageDraft()");
  h.read("selectedPage=b; pageSelectionRequest++; pageDraft={version:7}; pageDirty=true");
  saved.resolve({ version: 2 });
  assert.equal(await pending, false);
  assert.equal(h.read("pageDraft.version"), 7);
  assert.equal(h.read("pageDirty"), true);
});

test("document save preserves newer typing and updates its saved version", async () => {
  const saved = deferred();
  const h = harness(async () => saved.promise);
  h.context.load = async () => h.read("documents=[{id:1,version:2,payload:'{}'}]");
  h.read("selected={id:1,version:1,payload:'{}'};dirty=true;documentEditRevision=1");
  const pending = h.read("save()");
  h.read("documentEditRevision++;dirty=true");
  saved.resolve({ id: 1 }); await pending;
  assert.equal(h.read("selected.version"), 2);
  assert.equal(h.read("dirty"), true);
  assert.equal(h.node("#preview").disabled, true);
  assert.equal(h.node("#save").disabled, false);
});

test("document save completion does not replace a different selected record", async () => {
  const saved = deferred();
  const h = harness(async () => saved.promise);
  h.context.load = async () => {};
  h.read("selected={id:1,version:1,payload:'{}'};dirty=true");
  const pending = h.read("save()");
  h.read("selected={id:2,version:5,payload:'{}'};dirty=true");
  saved.resolve({ id: 1 }); await pending;
  assert.equal(h.read("selected.id"), 2);
  assert.equal(h.read("selected.version"), 5);
  assert.equal(h.read("dirty"), true);
});

test("review targets and mobile accessibility protections remain wired", () => {
  assert.ok(app.includes("selected !== reviewingDocument || dirty || revision !== documentEditRevision"));
  assert.ok(app.includes('api(`/api/documents/${previewDocument.id}/publish`'));
  assert.ok(consoleScript.includes("pageReviewTarget.request !== pageSelectionRequest"));
  assert.ok(consoleScript.includes('window.matchMedia("(max-width: 860px)")'));
  assert.ok(consoleScript.includes('if (document.querySelector("dialog[open]")) return'));
  assert.ok(consoleScript.includes('node.inert = previous'));
  assert.ok(html.includes('id="page-editor-title" tabindex="-1"'));
  assert.ok(html.includes('id="page-retry"'));
  assert.ok(css.includes('body[data-page-drawer="open"] { overflow: hidden; }'));
  assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"));
});
