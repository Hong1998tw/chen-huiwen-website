import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "../../tests/donation/node_modules/playwright/index.mjs";

const root = new URL("../public/", import.meta.url);
const [html, script, consoleScript, style, dateTimeScript] = await Promise.all([
  readFile(new URL("index.html", root)),
  readFile(new URL("app.js", root)),
  readFile(new URL("console.js", root)),
  readFile(new URL("style.css", root)),
  readFile(new URL("date-time.js", root)),
]);
let published = {
  title: "A 專頁", summary: "公開紀錄", updated: "2026-09-27",
  paragraphs: ["第一段", "第二段"],
  history: [
    { date: "2026-01-01", title: "第一步", text: "第一筆紀錄" },
    { date: "2026-02-01", title: "第二步", text: "第二筆紀錄" },
  ],
  sources: [
    { title: "來源一", url: "https://www.kcg.gov.tw/one", sourceDate: "2026-01-01" },
    { title: "來源二", url: "https://www.kcg.gov.tw/two", sourceDate: "2026-02-01" },
  ],
  media: [
    { kind: "photo", url: "https://example.com/one.jpg", alt: "照片一", caption: "第一張", credit: "服務處", publicAccessConfirmed: true },
    { kind: "video", url: "https://example.com/two.mp4", alt: "影片二", caption: "第二段", credit: "服務處", publicAccessConfirmed: true },
  ],
  images: ["first.jpg", "second.jpg"], imageMetadata: {},
};
const pages = [
  { path: "achievement-a.html", title: "Z 專頁", source_path: "data/achievements.json", source_kind: "generated", editor_scope: "partial", commit_sha: "a".repeat(40), publication_status: "published", draft_version: 0 },
  { path: "achievement-z.html", title: "A 專頁", source_path: "data/achievements.json", source_kind: "generated", editor_scope: "partial", commit_sha: "a".repeat(40), publication_status: "published", draft_version: 0 },
];
let saved = null;
const drafts = new Map();
let savedDocument = null;
let rejectMediaCredit = false;
let releaseList = [];
let publishRequestCount = 0;
const documents = [
  { id: 1, domain: "events", version: 1, updated_at: "2026-09-27T00:00:00Z", payload: JSON.stringify({
    name: "日期測試活動", start: "2026-10-01T19:30:00+08:00", end: "2026-10-01T21:00:00+08:00",
    content: "活動說明", registration: "免報名", sourceUrl: "https://example.com/event",
    verifiedAt: "2026-09-27", updatedAt: "2026-09-27", reviewDueAt: "2026-09-30", status: "scheduled", changeNote: null,
  }) },
  { id: 2, domain: "legal-schedule", version: 1, updated_at: "2026-09-27T00:00:00Z", payload: JSON.stringify({
    month: "2026-10", observedAt: "2026-09-27", sourceUrl: "https://example.com/legal",
    sourceTitle: "月表", nextReviewAt: "2026-10-15", sessions: [{ date: "2026-10-01", start: "19:30", end: "21:00" }],
  }) },
];
const publishedEventPayload = JSON.stringify({...JSON.parse(documents[0].payload),start:"2026-10-01T10:00:00+08:00"});
const send = (res, data, type = "application/json") => {
  res.writeHead(200, { "content-type": type });
  res.end(data);
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/") return send(res, html, "text/html; charset=utf-8");
  if (path === "/app.js") return send(res, script, "application/javascript");
  if (path === "/console.js") return send(res, consoleScript, "application/javascript");
  if (path === "/date-time.js") return send(res, dateTimeScript, "application/javascript");
  if (path === "/style.css") return send(res, style, "text/css");
  if (path === "/api/page-preview") return send(res, "<!doctype html><html><head></head><body><main><article class='case-body'></article><div class='case-latest-wrap'></div></main></body></html>", "text/html; charset=utf-8");
  if (path === "/api/session") return send(res, JSON.stringify({ login: "owner@example.test", csrf: "test" }));
  if (path === "/api/documents") return send(res, JSON.stringify({ documents }));
  if (/^\/api\/documents\/\d+$/.test(path) && req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const id = Number(path.split("/").pop());
    savedDocument = { id, ...JSON.parse(body) };
    const document = documents.find(item => item.id === id);
    document.payload = JSON.stringify(savedDocument.payload);
    document.version++;
    return send(res, JSON.stringify({ id }));
  }
  if (/^\/api\/documents\/\d+\/history$/.test(path)) return send(res, JSON.stringify({ versions: [] }));
  if (/^\/api\/documents\/\d+\/published$/.test(path)) return send(res, JSON.stringify({ source: { payload: publishedEventPayload, source_hash: "fixture" } }));
  if (path === "/api/pages") return send(res, JSON.stringify({ pages }));
  if (path === "/api/page-blocks") return send(res, JSON.stringify({ blocks: [] }));
  if (path === "/api/publications") return send(res, JSON.stringify({ publications: releaseList }));
  if (path === "/api/case") return send(res, JSON.stringify({ case: published }));
  if (path === "/api/page-draft/history") return send(res, JSON.stringify({ versions: [] }));
  if (path === "/api/page-draft" && req.method === "GET") {
    const requestedPath = new URL(req.url, "http://127.0.0.1").searchParams.get("path");
    return send(res, JSON.stringify({ draft: drafts.get(requestedPath) || null }));
  }
  if (path === "/test/fixture" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const fixture = JSON.parse(body);
    if (Object.hasOwn(fixture, "published")) published = fixture.published;
    if (Object.hasOwn(fixture, "draft")) drafts.set(fixture.path, fixture.draft);
    return send(res, JSON.stringify({ ok: true }));
  }
  if (path === "/api/page-draft" && req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (rejectMediaCredit) {
      rejectMediaCredit = false;
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "媒體來源 內容或長度不正確", field: "case.media.0.credit" }));
    }
    saved = JSON.parse(body);
    const version = (drafts.get(saved.path)?.version || 0) + 1;
    drafts.set(saved.path, { version, payload: JSON.stringify(saved), publication_status: "published" });
    pages[1].draft_version = version;
    return send(res, JSON.stringify({ version }));
  }
  if (path === "/api/page-draft/publish" && req.method === "POST") {
    publishRequestCount++;
    return send(res, JSON.stringify({ status: "queued" }));
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => console.error("CMS editor pageerror:", error.message));
  await page.route("https://www.huiwen.tw/assets/**", route => route.abort());
  await page.goto(origin);
  console.log("CMS order test: dashboard loaded");
  await page.locator('.primary-nav [data-workspace-target="content"]').click();
  await page.locator('#open-page-drawer').click();
  await page.locator("#page-tree .tree-page").first().waitFor();
  assert.match(await page.locator("#page-tree .tree-page").first().textContent(), /Z 專頁/);
  await page.locator("#page-sort").selectOption("title");
  assert.match(await page.locator("#page-tree .tree-page").first().textContent(), /A 專頁/);
  await page.getByRole("button", { name: /A 專頁/ }).click();
  console.log("CMS order test: page selected");
  await page.locator('[data-case-section="overview"]').waitFor();
  assert.equal(await page.locator('[data-validation-path="case.summary"] .required-marker').count(), 0, "optional case summary has no required marker");
  assert.equal(await page.locator('[data-validation-path="case.history.0.text"] .required-marker').count(), 0, "optional history explanation has no required marker");
  assert.equal(await page.locator('[data-validation-path="case.sources.0.sourceDate"] .required-marker').count(), 0, "optional source date has no required marker");
  await page.locator('[data-case-group="history"]').getByRole("button", { name: /新增推動歷程/ }).click();
  const emptyHistory = page.locator('[data-case-list="history"][data-case-index="2"]');
  assert.equal(await emptyHistory.locator(".required-marker").count(), 0, "an untouched optional history row stays blank without stars");
  const mediaCredit = page.locator('[data-validation-path="case.media.0.credit"] input');
  assert.equal(await page.locator('[data-validation-path="case.media.0.credit"] .required-marker').textContent(), "＊");
  await mediaCredit.fill("");
  await page.locator("#page-save").click();
  assert.equal(await page.locator('[data-validation-path="case.media.0.credit"] .field-error').textContent(), "此欄位為必填。");
  assert.equal(saved, null, "client validation prevents an invalid draft request");
  await mediaCredit.fill("服務處");
  rejectMediaCredit = true;
  await page.locator("#page-save").click();
  await page.locator('[data-validation-path="case.media.0.credit"] .field-error').waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-validation-path="case.media.0.credit"] .field-error').textContent(), "媒體來源 內容或長度不正確");
  assert.equal(await page.locator('[data-validation-path="case.media.0.credit"]').evaluate(node => node.classList.contains("has-error")), true, "server validation errors highlight the exact field in red");
  assert.equal(await mediaCredit.getAttribute("aria-invalid"), "true", "inline error is associated with the invalid control");
  assert.equal(await page.locator("#notice").getAttribute("role"), "alert");
  assert.equal(await page.locator("#notice").evaluate(node => node.classList.contains("notice-error")), true, "server validation errors use the red error treatment");
  assert.match(await page.locator("#notice").textContent(), /媒體來源 內容或長度不正確/);
  await mediaCredit.fill("");
  await mediaCredit.fill("服務處");
  await page.locator('[data-case-list="paragraphs"][data-case-index="1"] .case-row-menu > summary').click();
  await page.locator('[data-case-list="paragraphs"][data-case-index="1"] [data-case-action="up"]').click();
  assert.equal(await page.locator('[data-case-list="paragraphs"][data-case-index="0"] textarea').inputValue(), "第二段");
  await page.locator('[data-case-list="sources"][data-case-index="1"] .case-row-menu > summary').click();
  await page.locator('[data-case-list="sources"][data-case-index="1"] [data-case-action="position"]').selectOption("0");
  await page.locator('[data-case-list="media"][data-case-index="1"] .case-row-menu > summary').click();
  await page.locator('[data-case-list="media"][data-case-index="1"] [data-case-action="up"]').click();
  await page.locator('[data-case-list="images"][data-case-index="1"] .case-row-menu > summary').click();
  await page.locator('[data-case-list="images"][data-case-index="1"] [data-case-action="up"]').click();
  await page.locator('[data-case-section="sources"] [data-case-section-action="up"]').click();
  const caseUpdated = page.locator('#case-editor-fields > .field:nth-child(3) input[type=date]');
  assert.equal(await caseUpdated.getAttribute('type'), 'date', 'content date opens a native calendar picker');
  await caseUpdated.fill('2023-09-27');
  const historyDate = page.locator('[data-case-list="history"][data-case-index="0"] .date-period-controls');
  assert.equal(await historyDate.locator('input').getAttribute('type'), 'date', 'full timeline dates use a native calendar picker');
  await historyDate.locator('input').fill('2023-06-21');
  const sourceDate = page.locator('[data-case-list="sources"][data-case-index="0"] .date-period-controls');
  await sourceDate.locator('select').selectOption('month');
  assert.equal(await sourceDate.locator('input').getAttribute('type'), 'month', 'source periods can use a native month picker');
  await sourceDate.locator('input').fill('2023-06');
  assert.equal(await historyDate.locator('input').inputValue(), '2023-06-21');
  assert.equal(await sourceDate.locator('input').inputValue(), '2023-06');
  console.log("CMS order test: reordered");
  await page.locator("#page-save").click();
  console.log("CMS order test: save clicked");
  await page.getByText("草稿 v1 已儲存；正式頁面尚未變更。", { exact: true }).waitFor();
  assert.deepEqual(saved.case.paragraphs, ["第二段", "第一段"]);
  assert.deepEqual(saved.case.sources.map(item => item.title), ["來源二", "來源一"]);
  assert.deepEqual(saved.case.media.map(item => item.alt), ["影片二", "照片一"]);
  assert.deepEqual(saved.case.images, ["second.jpg", "first.jpg"]);
  assert.deepEqual(saved.case.sectionOrder, ["overview", "media", "sources", "history"]);
  assert.equal(saved.case.updated, '2023-09-27');
  assert.equal(saved.case.history[0].date, '2023-06-21');
  assert.equal(saved.case.sources[0].sourceDate, '2023-06');
  assert.deepEqual(saved.caseBase.images, ["first.jpg", "second.jpg"]);

  const seoBase = { title: "A 專頁 | 慧文", description: "原始說明", image: "https://www.huiwen.tw/assets/og/default.png", imageAlt: "原始圖片說明" };
  const seoDraft = { ...seoBase, imageAlt: "更新後圖片說明" };
  const conflictDraft = {
    version: 2,
    publication_status: "published",
    payload: JSON.stringify({ fields: {}, case: saved.case, caseBase: saved.caseBase, seo: seoDraft, seoBase }),
  };
  const setFixture = async (fixture) => page.evaluate(async (value) => {
    await fetch("/test/fixture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  }, fixture);
  await setFixture({ path: "achievement-z.html", published, draft: conflictDraft });
  await page.locator("#open-page-drawer").click();
  await page.getByRole("button", { name: /Z 專頁/ }).click();
  await page.waitForFunction(() => document.body.dataset.pageDrawer === "closed");
  await page.locator("#open-page-drawer").click();
  await page.getByRole("button", { name: /A 專頁/ }).click();
  await page.waitForFunction(() => document.body.dataset.pageDrawer === "closed");
  await page.locator("#content-publish-conflict").waitFor({ state: "visible" });
  await page.locator("#tab-seo").click();
  await page.locator("#seo-publish-conflict").waitFor({ state: "visible" });
  assert.match(await page.locator("#content-publish-conflict").textContent(), /政績內容與 SEO 必須分次發布/);
  assert.match(await page.locator("#seo-publish-conflict").textContent(), /政績內容與 SEO 必須分次發布/);
  assert.equal(await page.locator("#page-publish").isDisabled(), true, "mixed structured content and SEO cannot be queued");
  await page.evaluate(() => window.submitPageOperation("publish", true));
  assert.equal(publishRequestCount, 0, "invalid mixed release is rejected before the publishing API");

  await setFixture({ path: "achievement-z.html", published: saved.case, draft: conflictDraft });
  await page.locator("#open-page-drawer").click();
  await page.getByRole("button", { name: /Z 專頁/ }).click();
  await page.waitForFunction(() => document.body.dataset.pageDrawer === "closed");
  await page.locator("#open-page-drawer").click();
  await page.getByRole("button", { name: /A 專頁/ }).click();
  await page.getByText(/基準已安全對齊/).waitFor();
  await page.waitForFunction(() => document.body.dataset.pageDrawer === "closed");
  assert.equal(await page.locator("#content-publish-conflict").isHidden(), true, "content already live no longer conflicts with SEO");
  assert.equal(await page.locator("#page-save").isDisabled(), false, "safe baseline rebase requires a draft save");
  assert.equal(await page.locator("#page-publish").isDisabled(), true, "rebased baseline is not publishable until saved");
  await page.locator("#page-save").click();
  await page.getByText(/已儲存；正式頁面尚未變更。/).waitFor();
  assert.deepEqual(saved.caseBase, published, "safe rebase records the exact live canonical case as the new base");
  assert.equal(await page.locator("#page-publish").isDisabled(), false, "only the remaining SEO change is publishable after save");

  await page.locator('.primary-nav [data-workspace-target="services"]').click();
  await page.locator('#documents button.document').first().click();
  for (const key of ["content", "registration", "updatedAt", "reviewDueAt"])
    assert.equal(await page.locator(`#field-${key}`).evaluate(node => node.closest(".field").querySelectorAll(".required-marker").length), 0, `${key} is optional for a scheduled activity`);
  assert.equal(await page.locator('#field-start').getAttribute('type'), 'datetime-local', 'activity start uses a local date and time picker');
  assert.equal(await page.locator('#field-end').getAttribute('type'), 'datetime-local', 'activity end uses a local date and time picker');
  assert.equal(await page.locator('#field-verifiedAt').getAttribute('type'), 'date', 'activity verification date uses a native calendar picker');
  assert.equal(await page.locator('#field-updatedAt').getAttribute('type'), 'date', 'activity update date uses a native calendar picker');
  assert.equal(await page.locator('#field-reviewDueAt').getAttribute('type'), 'date', 'activity review date uses a native calendar picker');
  await page.locator('#field-status').selectOption("rescheduled");
  assert.equal(await page.locator('#field-changeNote').evaluate(node => node.closest(".field").querySelectorAll(".required-marker").length), 1, "rescheduled activity requires a reason");
  assert.equal(await page.locator('#field-updatedAt').evaluate(node => node.closest(".field").querySelectorAll(".required-marker").length), 1, "rescheduled activity requires the source update date");
  await page.locator('#field-status').selectOption("scheduled");
  await page.locator('#field-start').fill('2026-10-01T19:30');
  await page.locator('[data-validation-path="document.end"] .compact-date-entry summary').click();
  await page.locator('[data-validation-path="document.end"] .compact-date-entry input').fill('202610012100');
  await page.locator('[data-validation-path="document.end"] .compact-date-entry input').blur();
  await page.locator('[data-validation-path="document.verifiedAt"] .compact-date-entry summary').click();
  await page.locator('[data-validation-path="document.verifiedAt"] .compact-date-entry input').fill('20260927');
  await page.locator('[data-validation-path="document.verifiedAt"] .compact-date-entry input').blur();
  await page.locator('#field-content').fill('');
  await page.locator('#field-registration').fill('');
  await page.locator('#field-updatedAt').fill('');
  await page.locator('#field-reviewDueAt').fill('');
  await page.locator('#field-reviewDueAt').blur();
  assert.equal(await page.locator('#field-start').inputValue(), '2026-10-01T19:30');
  assert.equal(await page.locator('#field-verifiedAt').inputValue(), '2026-09-27');
  await page.locator('#save').click();
  await page.getByText('草稿已儲存，官網尚未變更。', { exact: true }).waitFor();
  assert.equal(savedDocument.payload.start, '2026-10-01T19:30:00+08:00');
  assert.equal(savedDocument.payload.end, '2026-10-01T21:00:00+08:00');
  assert.equal(savedDocument.payload.verifiedAt, '2026-09-27');
  assert.equal(savedDocument.payload.content, null);
  assert.equal(savedDocument.payload.registration, null);
  assert.equal(savedDocument.payload.updatedAt, "");
  assert.equal(savedDocument.payload.reviewDueAt, "");
  await page.locator('#preview').click();
  await page.locator('#preview-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#preview-content').textContent(),/發布 [1-9]\d* 項變更/);
  assert.match(await page.locator('#preview-content').textContent(),/2026\/10\/1 19:30/);
  assert.match(await page.locator('#preview-content').textContent(),/NOT CHECKED/);
  await page.locator('#close-preview').click();
  await page.locator('#documents button.document').last().click();
  assert.equal(await page.locator('#field-sourceTitle').evaluate(node => node.closest(".field").querySelectorAll(".required-marker").length), 0, "legal source label is optional");
  assert.equal(await page.locator('#field-nextReviewAt').evaluate(node => node.closest(".field").querySelectorAll(".required-marker").length), 0, "legal next review date is optional");
  assert.equal(await page.locator('#field-month').getAttribute('type'), 'month', 'legal schedule month uses a native month picker');
  assert.equal(await page.locator('#field-observedAt').getAttribute('type'), 'date', 'source check date uses a native calendar picker');
  assert.equal(await page.locator('#field-nextReviewAt').getAttribute('type'), 'date', 'optional review date uses a native calendar picker');
  await page.locator('#field-month').fill('2026-10');
  await page.locator('#field-observedAt').fill('2026-09-27');
  await page.locator('#field-nextReviewAt').fill('2026-10-15');
  await page.locator('#field-nextReviewAt').fill('');
  await page.locator('#field-sourceTitle').fill('');
  const sessions = page.locator('#field-sessions');
  assert.equal(await sessions.locator('select[data-legal-date]').count(),23,'October has 23 Tuesday-to-Saturday dates');
  await sessions.locator('[data-legal-date="2026-10-01"]').selectOption("林岡輝");
  await sessions.locator('[data-legal-date="2026-10-03"]').selectOption("鄭明達");
  assert.equal(await sessions.getByLabel("週四開始時間",{exact:true}).getAttribute("type"),"time");
  await sessions.getByLabel("週四開始時間",{exact:true}).fill("19:30");
  await sessions.getByLabel("週四結束時間",{exact:true}).fill("21:00");
  await sessions.getByRole("button",{name:"待填日期全部設為無／停辦",exact:true}).click();
  await page.locator('#save').click();
  await page.getByText('草稿已儲存，官網尚未變更。', { exact: true }).waitFor();
  assert.equal(savedDocument.payload.month,'2026-10');
  assert.deepEqual(savedDocument.payload.sessions,[
    {date:'2026-10-01',start:'19:30',end:'21:00',lawyer:'林岡輝'},
    {date:'2026-10-03',start:'10:00',end:'11:30',lawyer:'鄭明達'},
  ],'published fields use the selected lawyers and weekday times');
  assert.equal(savedDocument.payload.closedDates.length,21);
  assert.deepEqual(savedDocument.payload.unconfirmedDates,[]);
  await page.locator('#field-month').fill('2026-11');
  await page.locator('#field-month').dispatchEvent('change');
  assert.equal(await page.locator('[data-legal-date^="2026-10"]').count(),0,'changing month rebuilds dates');
  assert.equal(await page.locator('[data-legal-date="2026-11-03"]').inputValue(),"",'future names are not inferred');
  await page.locator('#save').click();
  await page.getByText('草稿已儲存，官網尚未變更。', { exact: true }).waitFor();
  assert.equal(savedDocument.payload.sessions.length,0);
  assert(savedDocument.payload.unconfirmedDates.length>0,'incomplete monthly planning remains a private saved draft');
  await page.locator('#preview').click();
  assert.equal(await page.locator('#preview-dialog').evaluate(el=>el.open),false,'pending dates cannot advance to publication review');
  pages[1].pending_operation = "publish";
  pages[1].pending_status = "queued";
  pages[1].pending_since = "2026-09-27T00:00:00.000Z";
  releaseList = [{ id: "release-fixture", path: "achievement-z.html", operation: "publish", version: 1, status: "queued", created_at: "2026-09-27T00:00:00.000Z", message: "" }];
  await page.evaluate(() => document.querySelector("#reload").click());
  await page.locator('.primary-nav [data-workspace-target="content"]').click();
  await page.locator("#open-page-drawer").click();
  await page.getByRole("button", { name: /A 專頁/ }).click();
  await page.waitForFunction(() => /等待發布/.test(document.querySelector("#page-status").textContent));
  assert.match(await page.locator("#page-status").textContent(), /等待發布 · 執行器尚未領取/);
  assert.match(await page.locator("#page-release-state").textContent(), /發布執行器尚未領取/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 768, height: 1024 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "tablet workspace fits without horizontal overflow");
  assert.equal(await page.locator("#page-explorer").evaluate(node => getComputedStyle(node).display), "none", "tablet page selector uses the drawer workflow");
  await page.locator("#open-page-drawer").click();
  assert.notEqual(await page.locator("#page-explorer").evaluate(node => getComputedStyle(node).display), "none");
  await page.locator("#close-page-drawer").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "wide workspace fits without horizontal overflow");
  assert.ok(await page.locator(".page-workspace").evaluate(node => node.getBoundingClientRect().width) > 1300, "desktop editor expands into available space");
  await page.close();
  console.log("PASS: mobile CMS ordering, native date/time pickers, structured legal sessions, inline validation, split publishing, and safe baseline rebase");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
