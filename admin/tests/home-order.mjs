import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "../../tests/donation/node_modules/playwright/index.mjs";

const root = new URL("../public/", import.meta.url);
const [html, script, style, dateTimeScript] = await Promise.all([
  readFile(new URL("index.html", root)), readFile(new URL("app.js", root)),
  readFile(new URL("style.css", root)), readFile(new URL("date-time.js", root)),
]);
const home = { featured: "a", reading: ["b", "c", "d"], summaries: { a: "摘要 A", b: "摘要 B", c: "摘要 C", d: "摘要 D" } };
const cases = ["a", "b", "c", "d"].map(id => ({ id, title: `專題 ${id.toUpperCase()}`, summary: `摘要 ${id}`, status: "持續追蹤", categories: ["地方專題"], updated: "2026-09-27", images: [] }));
const pages = [{ path: "index.html", title: "首頁", source_path: "data/civic-home.json", source_kind: "generated", editor_scope: "partial", commit_sha: "a".repeat(40), publication_status: "published", draft_version: 0 }];
let draft = null, saved = null;
const send = (res, body, type = "application/json") => { res.writeHead(200, { "content-type": type }); res.end(body); };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/") return send(res, html, "text/html; charset=utf-8");
  if (path === "/app.js") return send(res, script, "application/javascript");
  if (path === "/style.css") return send(res, style, "text/css");
  if (path === "/date-time.js") return send(res, dateTimeScript, "application/javascript");
  if (path === "/api/page-preview") return send(res, "<!doctype html><html><body><main><div class='civic-story-grid'></div></main></body></html>", "text/html; charset=utf-8");
  if (path === "/api/session") return send(res, JSON.stringify({ login: "owner@example.test", csrf: "test" }));
  if (path === "/api/documents") return send(res, JSON.stringify({ documents: [] }));
  if (path === "/api/pages") return send(res, JSON.stringify({ pages }));
  if (path === "/api/publications") return send(res, JSON.stringify({ publications: [] }));
  if (path === "/api/home") return send(res, JSON.stringify({ home, cases }));
  if (path === "/api/page-draft/history") return send(res, JSON.stringify({ versions: [] }));
  if (path === "/api/page-draft" && req.method === "GET") return send(res, JSON.stringify({ draft }));
  if (path === "/api/page-draft" && req.method === "PUT") {
    let body = ""; for await (const chunk of req) body += chunk;
    saved = JSON.parse(body);
    draft = { version: 1, payload: JSON.stringify({ fields: {}, home: saved.home, homeBase: saved.homeBase }), publication_status: "published" };
    pages[0].draft_version = 1;
    return send(res, JSON.stringify({ version: 1 }));
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => { throw error; });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator("#page-tree .tree-page").click();
  await page.locator('[data-home-index="0"] select').selectOption("2");
  assert.deepEqual(await page.locator("#home-editor-fields .case-editor-row p").allTextContents(),
    ["專題 B", "專題 C", "專題 A", "專題 D"]);
  await page.locator('[data-home-index="3"] [data-home-action="up"]').click();
  await page.locator("#page-save").click();
  await page.getByText("草稿 v1 已儲存；正式頁面尚未變更。", { exact: true }).waitFor();
  assert.equal(saved.home.featured, "b");
  assert.deepEqual(saved.home.reading, ["c", "d", "a"]);
  assert.deepEqual(saved.homeBase, home);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log("PASS: homepage featured story and numbered reading cards reorder in CMS");
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
