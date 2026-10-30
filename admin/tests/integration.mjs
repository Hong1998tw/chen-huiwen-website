import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { readCmsEditorLoaderSource } from "./cms-editor-loader-source.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/huiwen-cms-test-`);
const port = 18794,
  issuerPort = 18795,
  origin = `http://127.0.0.1:${port}`,
  issuer = `http://127.0.0.1:${issuerPort}`;
const email = "cms-test@example.com",
  emailHash = createHash("sha256").update(email).digest("hex");
const boardIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const retryablePageFailure = "網站剛有其他更新；本輪不建立發布請求，下一輪會以最新版本重新檢查。";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
let jwksFetches = 0; // the Worker must cache the Access JWKS across requests, not refetch it per request
const keys = createServer((q, r) => {
  jwksFetches++;
  r.setHeader("Content-Type", "application/json");
  r.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => keys.listen(issuerPort, "127.0.0.1", resolve));
const realFetch = globalThis.fetch;
let accessRequests = 0; // requests that carry the Access JWT, i.e. that make the Worker verify a token
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(origin) && init?.headers && new Headers(init.headers).has("Cf-Access-Jwt-Assertion")) accessRequests++;
  return realFetch(input, init);
};
const token = await new SignJWT({ type: "app", email })
  .setProtectedHeader({ alg: "RS256", kid: "fixture" })
  .setIssuer(issuer)
  .setAudience("fixture")
  .setSubject("fixture-owner")
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);
const config = JSON.parse(readFileSync(root + "wrangler.jsonc", "utf8"));
delete config.routes;
delete config.$schema;
config.main = root + "src/index.ts";
config.assets.directory = root + "public";
config.d1_databases[0].migrations_dir = root + "migrations";
Object.assign(config.vars, {
  ADMIN_ORIGIN: origin,
  ACCESS_ISSUER: issuer,
  ACCESS_AUD: "fixture",
  OWNER_EMAIL_SHA256: emailHash,
});
writeFileSync(dir + "/wrangler.json", JSON.stringify(config));
const wrangler = [
  "node_modules/wrangler/bin/wrangler.js",
  "--config",
  dir + "/wrangler.json",
];
let server;
let log = "";
try {
  execFileSync(
    process.execPath,
    [
      ...wrangler,
      "d1",
      "migrations",
      "apply",
      "huiwen-cms",
      "--local",
      "--persist-to",
      dir,
    ],
    { cwd: root, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir,
      "--command", "INSERT INTO published_pages VALUES('index.html','首頁','data/civic-home.json','composite','partial','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-09-27T00:00:00Z'),('service-guides.html','市民服務指南','data/service-guides.json','generated','partial','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-09-27T00:00:00Z')"],
    { cwd: root, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir,
      "--command", `INSERT INTO page_edits(path,payload,base_commit,version,publication_status,updated_at,actor) VALUES('service-guides.html','{"fields":{}}','${"a".repeat(40)}',1,'published','2026-09-27T00:00:00Z','github:126787497'); INSERT INTO page_publications(id,path,version,payload,base_commit,operation,status,created_at,updated_at,actor,lease,lease_until,attempts,pr_number,message,commit_sha) VALUES('stale-release','service-guides.html',1,'{"fields":{}}','${"a".repeat(40)}','publish','failed','2026-09-27T00:00:00Z','2026-09-27T00:01:00Z','github:126787497',NULL,NULL,1,NULL,'${retryablePageFailure}',NULL);`],
    { cwd: root, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir,
      "--command", `INSERT INTO board_notes(id,nickname,body,status,created_at,reviewed_at,ip_hash) VALUES('${boardIds[0]}','','謝謝議員修好路燈','pending','2026-10-20T01:00:00.000Z',NULL,'${"a".repeat(64)}'),('${boardIds[1]}','阿明','人行道變好走了','published','2026-10-19T01:00:00.000Z','2026-10-19T02:00:00.000Z',NULL),('${boardIds[2]}','五甲鄰居','公園很漂亮','pending','2026-10-21T01:00:00.000Z',NULL,NULL);`],
    { cwd: root, stdio: "pipe" },
  );
  server = spawn(
    process.execPath,
    [
      ...wrangler,
      "dev",
      "--port",
      String(port),
      "--persist-to",
      dir,
      "--var",
      `ADMIN_ORIGIN:${origin}`,
      "--var",
      `ACCESS_ISSUER:${issuer}`,
      "--var",
      "ACCESS_AUD:fixture",
      "--var",
      `OWNER_EMAIL_SHA256:${emailHash}`,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (v) => (log += v));
  server.stderr.on("data", (v) => (log += v));
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin)).status === 401) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, log);
  const headers = { "Cf-Access-Jwt-Assertion": token };
  const session = await fetch(origin + "/api/session", { headers }).then((r) =>
    r.json(),
  );
  assert.equal(session.role, "owner");
  assert.equal((await fetch(origin + "/api/documents")).status, 401);
  assert.equal((await fetch(origin + "/api/pages")).status, 401);
  assert.equal((await fetch(origin + "/api/page-preview?path=index.html")).status, 401,
    "the published-page preview must require the authenticated owner");
  assert.equal((await fetch(origin + "/api/page-draft/retry", { method: "POST" })).status, 401,
    "failed page publication retry must require the authenticated owner");
  const pageCatalog = await fetch(origin + "/api/pages", { headers }).then((r) => r.json());
  assert.equal(pageCatalog.pages.length, 2);
  assert.equal(pageCatalog.pages[0].source_path, "data/civic-home.json");
  assert.equal((await fetch(origin + "/api/page-preview?path=" + encodeURIComponent("../index.html"), { headers })).status, 400,
    "the preview route must reject traversal paths");
  assert.equal((await fetch(origin + "/api/page-preview?path=missing.html", { headers })).status, 404,
    "the preview route must reject paths outside the published catalogue");
  if (process.env.CMS_LIVE_PREVIEW === "1") {
    const livePreview = await fetch(origin + "/api/page-preview?path=service-guides.html", { headers });
    const liveHTML = await livePreview.text();
    assert.equal(livePreview.status, 200, liveHTML);
    assert.match(livePreview.headers.get("content-type") || "", /text\/html/);
    assert.equal(livePreview.headers.get("cache-control"), "no-store");
    assert.equal(livePreview.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(livePreview.headers.get("content-security-policy") || "", new RegExp(`frame-ancestors ${origin.replaceAll(".", "\\.")}`));
    assert.match(liveHTML, /data-cms-page-path="service-guides\.html"/);
    assert.match(liveHTML, /data-cms-admin-origin="http:\/\/127\.0\.0\.1:18794"/);
    assert.match(liveHTML, /<main\b/);
    assert.doesNotMatch(liveHTML, /rocket-loader(?:\.min)?\.js|data-cf-settings=/i,
      "the sandboxed preview must not execute Cloudflare's Rocket Loader wrapper");
    assert.doesNotMatch(liveHTML, /type="[a-f0-9]{8,}-text\/javascript"/i,
      "Rocket Loader's deferred script type must be restored in the preview");
    assert.match(liveHTML, /data-cfasync="false"\s+src=/i,
      "preview scripts must retain their source execution order at Cloudflare's edge");
  }
  assert.equal(
    (await fetch(origin + "/style.css")).status,
    401,
    "static assets also require authentication",
  );
  const mutate = (path, method, body, extra = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        ...headers,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  // 布告欄審核：沿用 owner()、帳號角色與 CSRF；只有確認、封存、刪除三個動作。
  assert.equal((await fetch(origin + "/api/board-notes")).status, 401, "board review requires the authenticated owner");
  assert.equal((await fetch(origin + "/board")).status, 401, "board review page requires the authenticated owner");
  let boardNotes = await fetch(origin + "/api/board-notes", { headers }).then((r) => r.json());
  assert.deepEqual(boardNotes.notes.map((n) => n.id), [boardIds[2], boardIds[0], boardIds[1]], "pending notes first, newest first");
  assert.equal(boardNotes.notes[1].nickname, "鳳山鄉親", "blank nickname shows the default");
  assert.equal("ip_hash" in boardNotes.notes[0], false, "the review list never exposes the IP hash");
  assert.equal((await mutate(`/api/board-notes/${boardIds[0]}/publish`, "POST", {}, { "X-CSRF-Token": "forged" })).status, 403, "board actions require CSRF");
  assert.equal((await mutate(`/api/board-notes/${boardIds[0]}/publish`, "POST", {}, { Origin: "https://evil.example" })).status, 403, "board actions require the admin origin");
  const approved = await mutate(`/api/board-notes/${boardIds[0]}/publish`, "POST", {});
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal((await approved.json()).status, "published");
  const archived = await mutate(`/api/board-notes/${boardIds[2]}/archive`, "POST", {}).then((r) => r.json());
  assert.equal(archived.status, "archived");
  assert.equal((await mutate(`/api/board-notes/${boardIds[1]}`, "DELETE", {})).status, 200);
  assert.equal((await mutate(`/api/board-notes/${boardIds[1]}`, "DELETE", {})).status, 404, "a deleted note is gone permanently");
  assert.equal((await mutate("/api/board-notes/not-a-uuid/publish", "POST", {})).status, 404);
  assert.equal((await mutate(`/api/board-notes/${boardIds[0]}/hide`, "POST", {})).status, 404, "no extra moderation actions exist");
  boardNotes = await fetch(origin + "/api/board-notes", { headers }).then((r) => r.json());
  assert.deepEqual(boardNotes.notes.map((n) => [n.id, n.status]), [[boardIds[2], "archived"], [boardIds[0], "published"]]);
  const boardPage = await fetch(origin + "/board", { headers });
  assert.equal(boardPage.status, 200);
  assert.match(await boardPage.text(), /布告欄審核/);
  const retryReceipt = await mutate("/api/page-draft/retry", "POST", {id:"stale-release",version:1});
  assert.equal(retryReceipt.status,202,await retryReceipt.clone().text());
  const retriedRelease = await retryReceipt.json();
  assert.equal(retriedRelease.version,2);
  assert.equal(retriedRelease.status,"queued");
  assert.notEqual(retriedRelease.id,"stale-release");
  const duplicateRetry = await mutate("/api/page-draft/retry", "POST", {id:"stale-release",version:1}).then(r=>r.json());
  assert.equal(duplicateRetry.id,retriedRelease.id,"duplicate retry clicks return the same new release instead of creating another attempt");
  const retryDraft = await fetch(origin + "/api/page-draft?path=service-guides.html",{headers}).then(r=>r.json());
  assert.equal(retryDraft.draft.version,2);
  assert.equal(retryDraft.draft.base_commit,"a".repeat(40),"retry must preserve the source baseline for publisher conflict checks");
  assert.deepEqual(JSON.parse(retryDraft.draft.payload),{fields:{}},"retry must preserve the exact original draft payload");
  const retryRecords = await fetch(origin + "/api/publications",{headers}).then(r=>r.json());
  const pageRetryRecords = retryRecords.publications.filter(row=>row.path==="service-guides.html");
  assert.deepEqual(pageRetryRecords.map(row=>row.status).sort(),["failed","queued"],"old failed record and new queued retry both remain auditable");
  assert.equal((await mutate("/api/page-draft/retry", "POST", {id:pageRetryRecords.find(row=>row.status==="queued").id,version:2})).status,409,
    "only the specific retryable stale-checkout failure can be retried");
  const createdPage = await mutate("/api/page-create", "POST", {section:"news",slug:"local-test",title:"本機新聞專頁"});
  assert.equal(createdPage.status,201);
  const createdPath = "page-news-local-test.html";
  const newDraft = await fetch(origin + `/api/page-draft?path=${createdPath}`,{headers}).then(r=>r.json());
  assert.equal(newDraft.draft.version,1);
  assert((await fetch(origin + "/api/pages",{headers}).then(r=>r.json())).pages.some(row=>row.path===createdPath));
  if (process.env.CMS_LIVE_PREVIEW === "1") {
    const preview = await fetch(origin + `/api/page-preview?path=${createdPath}`,{headers});
    const markup = await preview.text();
    assert.equal(preview.status,200,markup);
    assert.match(markup,/data-cms-page-path="page-news-local-test\.html"/);
    assert.match(markup,/<article class="wrap section editorial-body"><\/article>/);
  }
  const content = JSON.parse(newDraft.draft.payload).editorial;
  content.summary = "本機測試摘要"; content.seo.description = "本機測試搜尋說明";
  content.blocks[0].text = "本機測試內容";
  const savedEditorial = await mutate("/api/page-draft","PUT",{path:createdPath,version:1,baseCommit:"a".repeat(40),fields:[],editorial:content,editorialBase:null});
  assert.equal(savedEditorial.status,200);
  assert.equal((await mutate("/api/page-create","POST",{section:"news",slug:"local-test",title:"重複"})).status,409);
  assert.equal((await fetch(origin + "/api/page-draft?path=index.html", { headers })).status, 200);
  const pageField = { id: "main>p:nth-of-type(1)", sourceHash: "a".repeat(64), value: "首頁草稿第一版" };
  assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version: 0, baseCommit: "a".repeat(40), fields: [pageField] })).status, 200);
  assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version: 0, baseCommit: "a".repeat(40), fields: [{ ...pageField, value: "首頁草稿過時寫入" }] })).status, 409);
  const savedPage = await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json());
  assert.equal(savedPage.draft.version, 1);
  let pageHistory = await fetch(origin + "/api/page-draft/history?path=index.html", { headers }).then((r) => r.json());
  assert.equal(pageHistory.versions.length, 1);
  const restoredPage = await mutate("/api/page-draft/restore", "POST", { path: "index.html", version: 1, restoreVersion: 1 }).then((r) => r.json());
  assert.equal(restoredPage.version, 2);
  pageHistory = await fetch(origin + "/api/page-draft/history?path=index.html", { headers }).then((r) => r.json());
  assert.equal(pageHistory.versions.length, 2);
  const pagePublish = await mutate("/api/page-draft/publish", "POST", { path: "index.html", version: 2, operation: "publish" }).then((r) => r.json());
  const duplicatePagePublish = await mutate("/api/page-draft/publish", "POST", { path: "index.html", version: 2, operation: "publish" }).then((r) => r.json());
  assert.equal(pagePublish.id, duplicatePagePublish.id, "page publication requests are idempotent");
  for (const operation of ["unpublish", "delete", "restore"]) {
    const receipt = await mutate("/api/page-draft/publish", "POST", { path: "index.html", version: 2, operation });
    assert.equal(receipt.status, 202);
  }
  {
    // Homepage draft with latest pins keeps optimistic versions, explicit [] and older-shape payloads.
    const homeBase = { featured: "a", reading: ["b"], summaries: { a: "首頁主題", b: "延伸閱讀" } };
    const current = await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json());
    const version = current.draft.version;
    const pinned = await mutate("/api/page-draft", "PUT", { path: "index.html", version, baseCommit: "a".repeat(40), fields: [],
      home: { ...homeBase, latestPinned: ["event-campaign-headquarters-opening-2026-10-31"] }, homeBase: { ...homeBase, latestPinned: [] } });
    assert.equal(pinned.status, 200);
    assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version, baseCommit: "a".repeat(40), fields: [],
      home: { ...homeBase, latestPinned: [] }, homeBase: { ...homeBase, latestPinned: [] } })).status, 409, "stale pin save keeps the version conflict");
    let stored = JSON.parse((await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json())).draft.payload);
    assert.deepEqual(stored.home.latestPinned, ["event-campaign-headquarters-opening-2026-10-31"]);
    assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version: version + 1, baseCommit: "a".repeat(40), fields: [],
      home: { ...homeBase, latestPinned: ["a", "b", "c", "d"] }, homeBase })).status, 400, "more than three pins is rejected");
    const cleared = await mutate("/api/page-draft", "PUT", { path: "index.html", version: version + 1, baseCommit: "a".repeat(40), fields: [],
      home: { ...homeBase, latestPinned: [] }, homeBase: { ...homeBase, latestPinned: ["event-campaign-headquarters-opening-2026-10-31"] } });
    assert.equal(cleared.status, 200);
    stored = JSON.parse((await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json())).draft.payload);
    assert.deepEqual(stored.home.latestPinned, [], "an explicit clear is stored as []");
    // Re-pin, then an older client (no latestPinned) saves the same version: saved pins survive.
    const repinned = await mutate("/api/page-draft", "PUT", { path: "index.html", version: version + 2, baseCommit: "a".repeat(40), fields: [],
      home: { ...homeBase, latestPinned: ["media-20260909-1f376635"] }, homeBase: { ...homeBase, latestPinned: [] } });
    assert.equal(repinned.status, 200);
    const older = await mutate("/api/page-draft", "PUT", { path: "index.html", version: version + 3, baseCommit: "a".repeat(40), fields: [],
      home: { ...homeBase, summaries: { a: "舊客戶端修改", b: "延伸閱讀" } }, homeBase });
    assert.equal(older.status, 200);
    stored = JSON.parse((await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json())).draft.payload);
    assert.deepEqual(stored.home.latestPinned, ["media-20260909-1f376635"], "unpublished draft pins survive an older payload");
    assert.deepEqual(stored.homeBase.latestPinned, [], "the saved pin baseline is kept too");
    assert.equal(stored.home.summaries.a, "舊客戶端修改");
    // A racing older payload on a stale version is still rejected and changes nothing.
    assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version: version + 3, baseCommit: "a".repeat(40), fields: [],
      home: homeBase, homeBase })).status, 409);
    // Saving only page text keeps the stored homepage draft.
    const textOnly = await mutate("/api/page-draft", "PUT", { path: "index.html", version: version + 4, baseCommit: "a".repeat(40), fields: [] });
    assert.equal(textOnly.status, 200);
    stored = JSON.parse((await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json())).draft.payload);
    assert.deepEqual(stored.home.latestPinned, ["media-20260909-1f376635"]);
  }
  const event = {
    name: "本機測試草稿",
    start: "2026-10-01T10:00:00+08:00",
    end: "2026-10-01T12:00:00+08:00",
    content: "只存在本機測試資料庫",
    registration: "無需報名",
    sourceUrl: "https://www.kcc.gov.tw/",
    verifiedAt: "2026-09-27",
    updatedAt: "2026-09-27",
    reviewDueAt: "2026-09-30",
    status: "scheduled",
    changeNote: null,
  };
  assert.equal(
    (
      await mutate(
        "/api/documents",
        "POST",
        { domain: "events", payload: event },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const created = await mutate("/api/documents", "POST", {
    domain: "events",
    payload: event,
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const path = `/api/documents/${id}`;
  assert.equal((await fetch(origin + path + "/published")).status,401,"published baseline remains owner-only");
  assert.deepEqual(await fetch(origin + path + "/published",{headers}).then(r=>r.json()),{source:null},
    "new drafts have no published baseline and must not invent a comparison");
  assert.equal(
    (
      await mutate(path, "PUT", {
        version: 1,
        payload: { ...event, name: "第二版" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await mutate(path, "PUT", {
        version: 1,
        payload: { ...event, name: "過時覆蓋" },
      })
    ).status,
    409,
  );
  let history = await fetch(origin + path + "/history", { headers }).then((r) =>
    r.json(),
  );
  assert.equal(history.versions.length, 2);
  assert.equal(JSON.parse(history.versions[0].payload).name, "第二版");
  const first = await mutate(path + "/publish", "POST", { version: 2 }).then(
    (r) => r.json(),
  );
  const again = await mutate(path + "/publish", "POST", { version: 2 }).then(
    (r) => r.json(),
  );
  assert.equal(first.id, again.id, "duplicate click is idempotent");
  assert.equal(
    (await mutate(path + "/restore", "POST", { version: 2, restoreVersion: 1 }))
      .status,
    200,
  );
  history = await fetch(origin + path + "/history", { headers }).then((r) =>
    r.json(),
  );
  assert.equal(history.versions.length, 3);
  assert.equal(JSON.parse(history.versions[0].payload).name, event.name);
  assert.equal(
    (await mutate(path + "/publish", "POST", { version: 99 })).status,
    409,
  );
  const pending = await fetch(origin + "/api/publications", { headers }).then(
    (r) => r.json(),
  );
  assert.equal(pending.publications.length, 7);
  assert.equal(pending.publications.filter((row) => row.path === "index.html").length, 4);
  assert.equal(
    (await fetch(origin + "/internal/claim", { headers })).status,
    404,
    "admin identity cannot access runner route",
  );
  const html = await fetch(origin, { headers });
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("Cache-Control"), "no-store");
  assert.match(await html.text(), /內容管理/);
  console.log(`JWKS fetches: ${jwksFetches} for ${accessRequests} requests with an Access JWT`);
  assert.ok(accessRequests >= 30, `expected many verified requests, saw ${accessRequests}`);
  assert.ok(jwksFetches >= 1 && jwksFetches <= 2, `Access JWKS fetched ${jwksFetches} times for ${accessRequests} requests; it must be cached`);
  if (process.env.CMS_BROWSER === '1') {
    const {chromium} = await import(process.env.CMS_PLAYWRIGHT_PATH || '../../tests/donation/node_modules/playwright/index.mjs');
    console.log('CMS_BROWSER: launching Chromium');
    const browser = await chromium.launch({headless:true});
    console.log('CMS_BROWSER: Chromium ready');
    try {
      const context=await browser.newContext({extraHTTPHeaders:headers});
      const page=await context.newPage();
      page.on('pageerror',error=>console.error(`CMS_BROWSER pageerror: ${error.message}`));
      page.on('console',message=>{if(message.type()==='error')console.error(`CMS_BROWSER console: ${message.text()}`);});
      page.on('requestfailed',request=>console.error(`CMS_BROWSER requestfailed: ${request.url()} · ${request.failure()?.errorText||'unknown'}`));
      let editorRuntimeRequests=0, editorManifestRequests=0;
      const manifestPath = "/cms-editor-manifests/index.html.a1b2c3d4e5f6.json";
      const editorLoader = readCmsEditorLoaderSource();
      const editorFixture = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><base href="https://www.huiwen.tw/index.html"><title>Test page</title><style>body{font:20px sans-serif;padding:24px;color:#173e35}main{max-width:720px;margin:auto}</style><script data-cfasync="false" data-cms-editor-loader data-cms-editor-src="/cms-page-editor.0123456789ab.js" data-cms-editor-enabled="true" data-cms-page-path="index.html" data-cms-admin-origin="${origin}" data-cms-manifest="https://www.huiwen.tw${manifestPath}">${editorLoader}</script></head><body><main><h1>測試正式頁面</h1></main></body></html>`;
      const editorManifest = JSON.stringify({schemaVersion:1,path:"index.html",fields:[{id:"main>h1:nth-of-type(1)",sourceHash:"a".repeat(64),valueHash:"a".repeat(64)}]});
      const editorRuntime = readFileSync(root + "../cms-page-editor.js", "utf8");
      const axeScript = readFileSync(root + "../tests/donation/node_modules/axe-core/axe.min.js", "utf8");
      await page.route(`${origin}/axe.min.js`, route=>route.fulfill({status:200,contentType:"application/javascript",body:axeScript}));
      await page.route(`${origin}/api/home`, route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
        home:{featured:"a",reading:["b"],summaries:{a:"首頁主題",b:"延伸閱讀"}},
        cases:[{id:"a",title:"專題 A",summary:"首頁主題",status:"持續追蹤",categories:["地方專題"],updated:"2026-09-27",images:[]},
          {id:"b",title:"專題 B",summary:"延伸閱讀",status:"持續追蹤",categories:["地方專題"],updated:"2026-09-27",images:[]}]
      })}));
      context.on('request',request=>{const path=new URL(request.url()).pathname;if(/^\/cms-page-editor\.[a-f0-9]{12}\.js$/.test(path))editorRuntimeRequests++;if(path===manifestPath)editorManifestRequests++;});
      await context.route("https://www.huiwen.tw/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (/^\/cms-page-editor\.[a-f0-9]{12}\.js$/.test(path)) return route.fulfill({status:200,contentType:"application/javascript",body:editorRuntime});
        if (path === manifestPath) return route.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:editorManifest});
        return route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:editorFixture});
      });
      await page.route(`${origin}/api/page-preview**`, route => route.fulfill({
        status:200,
        headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-frame-options":"SAMEORIGIN","content-security-policy":`default-src 'none'; base-uri https://www.huiwen.tw; script-src https://www.huiwen.tw 'unsafe-inline'; style-src https://www.huiwen.tw 'unsafe-inline'; connect-src https://www.huiwen.tw; frame-ancestors ${origin}`},
        body:editorFixture,
      }));
      const publicVisitor=await context.newPage();
      await publicVisitor.goto('https://www.huiwen.tw/');
      assert.equal(editorRuntimeRequests,0,'ordinary public visits must not download the CMS editor runtime');
      assert.equal(editorManifestRequests,0,'ordinary public visits must not download editor manifests');
      assert.equal(await publicVisitor.locator('[data-cms-edit-id]').count(),0,'public HTML must not carry editor selectors');
      await publicVisitor.setContent('<!doctype html><iframe src="https://www.huiwen.tw/index.html"></iframe>');
      await publicVisitor.frameLocator('iframe').locator('h1').waitFor();
      assert.equal(editorRuntimeRequests,0,'an iframe without cmsEdit=1 must not download the CMS editor runtime');
      assert.equal(editorManifestRequests,0,'an iframe without cmsEdit=1 must not download editor manifests');
      await publicVisitor.close();
      const screenshotDir=process.env.CMS_SCREENSHOTS;
      if(screenshotDir)mkdirSync(screenshotDir,{recursive:true});
      const capture=async name=>{if(screenshotDir)await page.screenshot({path:`${screenshotDir}/${name}.png`,fullPage:!name.startsWith('mobile-')});};
      for(const [width,height] of [[390,844],[430,932],[768,1024],[1440,900]]) {
        await page.setViewportSize({width,height});
        await page.goto(origin);
        console.log(`CMS_BROWSER: dashboard loaded at ${width}px`);
        assert(await page.getByRole('heading',{name:'今天要更新什麼？'}).isVisible());
        if(width===390 || width===1440){
          await page.addScriptTag({url:`${origin}/axe.min.js`});
          const report=await page.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));
          console.log(`CMS_AXE dashboard ${width}px: ${report.violations.map(item=>item.id+':'+item.nodes.length).join(',')||'0 violations'}`);
        }
        if(width===1440)await capture('desktop-dashboard');
        await page.locator('.primary-nav [data-workspace-target="content"]').click();
        assert(await page.getByRole('heading',{name:'內容',exact:true}).isVisible());
        if(width===1440){
          await page.locator('#open-command').click();
          await page.locator('#command-query').fill('service');
          assert(await page.locator('#command-results button').count()>0,'command search finds pages by path');
          await page.keyboard.press('Escape');
          await page.locator('#command-dialog').waitFor({state:'hidden'});
          assert.equal(await page.evaluate(()=>document.activeElement?.id),'open-command','dialog restores focus');
        }
        if(width<=860){
          await page.locator('#open-page-drawer').click();
          assert(await page.locator('#page-explorer').isVisible());
          if(width===390)await capture('mobile-page-drawer-390');
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#page-explorer').isVisible(),false,'Escape closes page drawer');
          assert.equal(await page.evaluate(()=>document.activeElement?.id),'open-page-drawer','drawer restores focus');
          await page.locator('#open-page-drawer').click();
        }
        await page.locator('#page-filter').fill('首頁');
        await page.waitForFunction(()=>document.querySelector('#page-list-status')?.textContent?.startsWith('顯示 1 /'));
        const priorRuntimeRequests=editorRuntimeRequests;
        await page.locator('#page-tree .tree-page').first().click();
        console.log('CMS_BROWSER: page selected');
        assert(await page.getByRole('heading',{name:'首頁',exact:true}).isVisible());
        if(width<=860) assert.equal(await page.locator('#page-explorer').isVisible(),false,'compact drawer closes after selecting a page');
        await page.waitForFunction(()=>!document.querySelector('#page-draft-status')?.textContent?.includes('正在讀取'));
        await page.locator('#tab-seo').click();
        assert.equal(await page.locator('#tab-seo').getAttribute('aria-selected'),'true');
        if(width===1440)await capture('desktop-seo');
        await page.locator('#tab-versions').click();
        await page.locator('#tab-content').click();
        await page.waitForFunction(()=>document.querySelector('#page-frame')?.getAttribute('src')?.startsWith('/api/page-preview?'));
        const previewUrl = new URL(await page.locator('#page-frame').getAttribute('src'),origin);
        assert.equal(previewUrl.pathname,'/api/page-preview');
        assert.equal(previewUrl.searchParams.get('cmsEdit'),'1','the authenticated CMS iframe must opt into editor loading explicitly');
        assert.equal((await page.locator('#page-frame').getAttribute('sandbox')).includes('allow-same-origin'),false,
          'published page scripts must not share the authenticated admin origin');
        const frame=page.frameLocator('#page-frame');
        await frame.locator('h1[contenteditable="true"]').waitFor();
        await frame.locator('script[data-cms-editor-loader]').evaluate(loader=>{
          const duplicate=document.createElement('script');
          for(const attribute of loader.attributes)duplicate.setAttribute(attribute.name,attribute.value);
          duplicate.textContent=loader.textContent;
          loader.after(duplicate);
        });
        await page.waitForTimeout(100);
        if(width===390)await capture('mobile-content-390');
        if(width===1440)await capture('desktop-content');
        if(width===390 || width===1440){
          const report=await page.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));
          console.log(`CMS_AXE content ${width}px: ${report.violations.map(item=>item.id+':'+item.nodes.length).join(',')||'0 violations'}`);
        }
        await page.evaluate(()=>window.scrollTo(0,800));
        await page.waitForTimeout(50);
        const toolbarBox=await page.locator('.visual-toolbar').boundingBox();
        if(width<=430)assert(toolbarBox.y>=-2 && toolbarBox.y<=4,`selected-page toolbar must remain sticky at ${width}px: ${toolbarBox.y}`);
        await page.evaluate(()=>window.scrollTo(0,0));
        assert.equal(editorRuntimeRequests,priorRuntimeRequests+1,'admin iframe must load the editor runtime');
        assert.equal(editorManifestRequests,editorRuntimeRequests,'admin iframe must load its page-specific editor manifest');
        await frame.locator('h1[contenteditable="true"]').fill('測試已修改');
        await page.getByText('頁面文字有變更 · 儲存後才會進入發布流程',{exact:true}).waitFor();
        assert.equal(await page.locator('#page-save').isEnabled(),true,'editing the rendered page enables draft save');
        if(width===390)await capture('mobile-editor-390');
        await page.locator('.primary-nav [data-workspace-target="services"]').click();
        console.log('CMS_BROWSER: structured editor opened');
        await page.getByRole('button',{name:/本機測試草稿/}).click();
        assert(await page.getByLabel('活動名稱',{exact:true}).isVisible());
        if(width===1440)await capture('desktop-activity');
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editor must fit viewport');
        await page.getByRole('button',{name:'預覽發布內容',exact:true}).click();
        await page.locator('#preview-dialog').waitFor({state:'visible'});
        assert(await page.getByRole('button',{name:/確認發布/}).isVisible());
        await page.getByRole('button',{name:'關閉',exact:true}).click();
        await page.locator('.primary-nav [data-workspace-target="publishing"]').click();
        assert(await page.getByRole('heading',{name:'從草稿到上線'}).isVisible());
        assert.match(await page.locator('#publications').textContent(),/HTTP 驗證.*Snapshot 驗證.*Native 驗證/s);
        assert.match(await page.locator('#publications').textContent(),/NOT CHECKED/);
        await page.locator('[data-release-filter="queued"]').click();
        assert.equal(await page.locator('#publications .publication:not([hidden]):not([data-status="queued"])').count(),0);
        await page.locator('[data-release-filter="all"]').click();
        if(width===1440)await capture('desktop-publishing');
        await page.locator('.primary-nav [data-workspace-target="system"]').click();
        assert(await page.getByRole('heading',{name:'目前權限'}).isVisible());
        await page.evaluate(()=>window.scrollTo(0,0));
        if(screenshotDir)await capture(`viewport-${width}`);
      }
      const indexCards = Array.from({length: 11}, (_, index) =>
        `<article data-news-categories="public"><h2>項目 ${index + 1}</h2></article>`).join("");
      for (const [script, section, grid] of [["news.js", 'id="news-reports"', "data-news-grid"], ["press.js", "data-press-index", "data-press-grid"]]) {
        const runtime = readFileSync(root + "../" + script, "utf8");
        for (const editing of [false, true]) {
          const indexPage = await context.newPage();
          await indexPage.setContent(`<!doctype html><html><head>${editing ? '<script data-cms-editor-loader data-cms-editor-enabled="true"></script>' : ''}</head><body><main><section ${section}><div ${grid}>${indexCards}</div></section></main></body></html>`);
          await indexPage.addScriptTag({content: runtime});
          assert.equal(await indexPage.locator(`[${grid}] article`).count(), editing ? 11 : 10,
            editing ? `${script} CMS preview must preserve every source-order card for manifest selectors` : `${script} public pagination must keep working`);
          await indexPage.close();
        }
      }
      await context.close();
    } finally { await browser.close(); }
    console.log('PASS: mobile and desktop live editor runtime, copy editing and publication preview browser flow');
  }
  console.log(
    "PASS: real local Worker + D1 auth, CSRF, CRUD, optimistic concurrency, restore, immutable publish snapshot, duplicate clicks and protected assets",
  );

  // Pinned latest items: the early unpublish/delete check reads pins from the homepage revision,
  // even when the page itself is recorded at an older revision. Same Worker, same local D1;
  // only outbound reads of committed sources are answered by a fixture.
  server.kill("SIGTERM");
  await Promise.race([new Promise((r) => server.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
  const homeCommit = "c".repeat(40), pageCommit = "b".repeat(40);
  const civic = JSON.parse(readFileSync(root + "../data/civic-home.json", "utf8"));
  const civicAt = { [homeCommit]: { ...civic, latestPinned: ["page-daily-pinned"] }, [pageCommit]: civic };
  execFileSync(process.execPath, [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir, "--command",
    `UPDATE published_pages SET commit_sha='${homeCommit}' WHERE path='index.html';
     INSERT INTO published_pages VALUES('page-daily-pinned.html','置頂日常','data/editorial-pages.json','generated','partial','${pageCommit}','2026-10-30T00:00:00Z'),
       ('page-daily-free.html','一般日常','data/editorial-pages.json','generated','partial','${pageCommit}','2026-10-30T00:00:00Z');
     INSERT INTO page_edits(path,payload,base_commit,version,publication_status,updated_at,actor) VALUES
       ('page-daily-pinned.html','{"fields":{}}','${pageCommit}',1,'published','2026-10-30T00:00:00Z','github:126787497'),
       ('page-daily-free.html','{"fields":{}}','${pageCommit}',1,'published','2026-10-30T00:00:00Z','github:126787497');`],
    { cwd: root, stdio: "pipe" });
  const sourceReads = [];
  const { unstable_startWorker } = await import("wrangler");
  const pinWorker = await unstable_startWorker({
    config: dir + "/wrangler.json",
    dev: {
      server: { hostname: "127.0.0.1", port }, persist: dir, inspector: false, watch: false,
      outboundService: async (request) => {
        const match = /^https:\/\/raw\.githubusercontent\.com\/Hong1998tw\/chen-huiwen-website\/([a-f0-9]{40})\/(.+)$/.exec(request.url);
        if (!match) return realFetch(request.url, { method: request.method, headers: request.headers });
        sourceReads.push({ commit: match[1], path: match[2] });
        const body = match[2] === "data/civic-home.json" ? civicAt[match[1]] : undefined;
        return body ? new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }) : new Response("missing", { status: 404 });
      },
    },
  });
  try {
    await pinWorker.ready;
    const publications = async (path) => (await fetch(origin + "/api/publications", { headers }).then((r) => r.json()))
      .publications.filter((row) => row.path === path);
    for (const operation of ["unpublish", "delete"]) {
      const response = await mutate("/api/page-draft/publish", "POST", { path: "page-daily-pinned.html", version: 1, operation });
      assert.equal(response.status, 409, `${operation} of a homepage-pinned page is stopped before queueing`);
      assert.match((await response.json()).error, /先到首頁取消置頂/);
    }
    assert.deepEqual(await publications("page-daily-pinned.html"), [], "no publication request is written for the pinned page");
    assert(sourceReads.some((read) => read.commit === homeCommit && read.path === "data/civic-home.json"), "pins come from the homepage revision");
    assert(!sourceReads.some((read) => read.commit === pageCommit), "the older page revision is not used for homepage pins");
    // Unpinned pages still go straight to the queue; version conflicts keep their meaning.
    const allowed = await mutate("/api/page-draft/publish", "POST", { path: "page-daily-free.html", version: 1, operation: "unpublish" });
    assert.equal(allowed.status, 202);
    assert.equal((await publications("page-daily-free.html")).length, 1);
    const stale = await mutate("/api/page-draft/publish", "POST", { path: "page-daily-free.html", version: 2, operation: "delete" });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /草稿版本已更新/);
    // Restoring the pinned page is not blocked by the pin rule.
    assert.equal((await mutate("/api/page-draft/publish", "POST", { path: "page-daily-pinned.html", version: 1, operation: "restore" })).status, 202);
  } finally {
    await pinWorker.dispose();
  }
  console.log("PASS: pinned latest pages are held before queueing using the homepage revision; unpinned pages and version conflicts unchanged");

  // Source sync: the publisher's real snapshot (full public catalogue) through the real GitHub OIDC
  // runner check into the same local D1. Only the GitHub JWKS fetch is answered by a fixture key.
  const syncCommit = "d".repeat(40);
  writeFileSync(dir + "/wrangler-sync.json", JSON.stringify({ ...config, vars: { ...config.vars, PUBLISHER_ORIGIN: origin, ADMIN_ORIGIN: "https://admin.invalid" } }));
  const d1 = (sql) => JSON.parse(execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "--config", dir + "/wrangler-sync.json",
    "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir, "--json", "--command", sql], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString())[0].results;
  const syncBody = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'scripts'); import publish_from_cms as c; " +
    `sys.stdout.buffer.write(c.encode_body(c.sync_body('${syncCommit}')))`], { cwd: root + "..", maxBuffer: 4 << 20 });
  const snapshot = JSON.parse(syncBody.toString("utf8"));
  const github = await generateKeyPair("RS256");
  const githubJwk = { ...(await exportJWK(github.publicKey)), kid: "github-fixture", alg: "RS256", use: "sig" };
  const runnerToken = await new SignJWT({
    repository: config.vars.GITHUB_REPOSITORY, repository_id: config.vars.GITHUB_REPOSITORY_ID, repository_owner_id: config.vars.GITHUB_OWNER_ID,
    ref: "refs/heads/main", workflow_ref: `${config.vars.GITHUB_REPOSITORY}/.github/workflows/cms-publisher.yml@refs/heads/main`,
    environment: "notion-publisher", event_name: "workflow_dispatch", run_id: "1",
  }).setProtectedHeader({ alg: "RS256", kid: githubJwk.kid }).setIssuer("https://token.actions.githubusercontent.com").setAudience(origin)
    .setSubject(`repo:Hong1998tw@${config.vars.GITHUB_OWNER_ID}/chen-huiwen-website@${config.vars.GITHUB_REPOSITORY_ID}:environment:notion-publisher`)
    .setIssuedAt().setExpirationTime("10m").sign(github.privateKey);
  const owned = () => JSON.stringify([
    d1("SELECT * FROM page_edits ORDER BY path"), d1("SELECT * FROM page_publications ORDER BY id"), d1("SELECT * FROM documents ORDER BY id"),
  ]);
  const catalogState = () => d1("SELECT COUNT(*) AS count, MIN(commit_sha) AS first_sha, MAX(commit_sha) AS last_sha, MAX(observed_at) AS observed FROM published_pages")[0];
  const draftsBefore = owned();
  const catalogBefore = catalogState();
  assert(snapshot.commit === syncCommit && Array.isArray(snapshot.sources) && snapshot.sources.length <= 300 &&
    Array.isArray(snapshot.pages) && snapshot.pages.length >= 1 && snapshot.pages.length <= 1000 && syncBody.byteLength <= 512 * 1024,
    "the real snapshot is a valid sync body within the API limits");
  const syncWorker = await unstable_startWorker({
    config: dir + "/wrangler-sync.json",
    dev: {
      server: { hostname: "127.0.0.1", port }, persist: dir, inspector: false, watch: false,
      outboundService: async (request) => request.url.startsWith("https://token.actions.githubusercontent.com/.well-known/jwks")
        ? Response.json({ keys: [githubJwk] })
        : new Response("unexpected outbound request", { status: 599 }),
    },
  });
  try {
    await syncWorker.ready;
    // A fresh connection per request: D1 readbacks between requests can outlast the dev server's keep-alive.
    const sync = (body) => fetch(origin + "/internal/sync", { method: "POST", body,
      headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json", Connection: "close" } });
    const tooMany = { ...snapshot, pages: Array.from({ length: 1001 }, (_, index) => ({ ...snapshot.pages[0], path: `page-${index}.html` })) };
    assert.equal((await sync(JSON.stringify(tooMany))).status, 400, "more than 1000 pages is rejected");
    assert.equal((await sync(new Uint8Array(512 * 1024 + 1).fill(0x20))).status, 413, "the sync body stays bounded");
    const badLast = { ...snapshot, pages: [...snapshot.pages.slice(0, -1), { ...snapshot.pages.at(-1), source: "island/../secrets.json" }] };
    assert.equal((await sync(JSON.stringify(badLast))).status, 400, "one invalid row rejects the whole snapshot");
    assert.deepEqual(catalogState(), catalogBefore, "rejected snapshots write nothing");
    assert.equal(owned(), draftsBefore);

    const accepted = await sync(syncBody);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.deepEqual(await accepted.json(), { synced: snapshot.sources.length, pages: snapshot.pages.length });
    const synced = catalogState();
    assert.deepEqual([synced.count, synced.first_sha, synced.last_sha], [snapshot.pages.length, syncCommit, syncCommit], "the whole catalogue is replaced at one revision");
    assert.deepEqual(d1("SELECT path FROM published_pages ORDER BY path").map((row) => row.path), snapshot.pages.map((page) => page.path).sort());
    assert.deepEqual(d1("SELECT path,title,source_path,source_kind,editor_scope FROM published_pages ORDER BY path"),
      snapshot.pages.map((page) => ({ path: page.path, title: page.title, source_path: page.source, source_kind: page.kind, editor_scope: page.editorScope }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)), "every catalogue row is stored as sent");
    assert.equal(JSON.stringify(JSON.parse(owned()).slice(0, 2)), JSON.stringify(JSON.parse(draftsBefore).slice(0, 2)), "page drafts and publication requests are unchanged");
    const documentsBefore = JSON.parse(draftsBefore)[2];
    const documentsAfter = JSON.parse(owned())[2];
    assert(documentsBefore.every((row) => JSON.stringify(documentsAfter.find((after) => after.id === row.id)) === JSON.stringify(row)), "existing documents keep payload, version and dates");

    assert.equal((await sync(syncBody)).status, 200);
    assert.equal(catalogState().observed, synced.observed, "a retry at the same revision does not rewrite the catalogue");
  } finally {
    await syncWorker.dispose();
  }
  console.log(`PASS: real ${snapshot.pages.length}-page source sync (${syncBody.byteLength} bytes) is bounded, authenticated, atomic and leaves drafts unchanged`);
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => server.once("exit", r)),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }
  keys.close();
  rmSync(dir, { recursive: true, force: true });
}
