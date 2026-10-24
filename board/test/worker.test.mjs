// 公開 API Worker 的請求測試：真的 Request/Response、node:sqlite 模擬 D1（套用正式遷移檔）、攔截 Turnstile。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import worker, { maintain } from "../src/index.js";
import { BOARD_PURGE_AT, RATE_LIMIT_MS } from "../src/rules.js";
import { createFakeD1 } from "./fake-d1.mjs";

const SITE = "https://www.huiwen.tw";
const API = "https://board.huiwen.tw/api/board";
const realFetch = globalThis.fetch;
const realNow = Date.now;
let env, verifyCalls, verifyResult;

beforeEach(() => {
  env = { DB: createFakeD1(), TURNSTILE_SECRET: "test-secret", IP_SALT: "0123456789abcdef-test-salt" };
  verifyCalls = [];
  verifyResult = { success: true, hostname: "www.huiwen.tw", action: "board_note" };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const form = init?.body;
    verifyCalls.push({ url, secret: form?.get?.("secret"), response: form?.get?.("response"), remoteip: form?.get?.("remoteip") });
    if (verifyResult === "network") throw new TypeError("network down");
    return Response.json(verifyResult);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

const call = (init = {}, url = API) => worker.fetch(new Request(url, init), env, { waitUntil() {} });
const post = (body, { origin = SITE, ip = "203.0.113.7", headers = {} } = {}) =>
  call({
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...(ip ? { "CF-Connecting-IP": ip } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const note = (extra = {}) => ({ nickname: "阿明", body: "謝謝議員修好路燈", turnstileToken: "token-ok", ...extra });
const rows = () => env.DB.raw.prepare("SELECT * FROM board_notes ORDER BY created_at").all();
const insert = (id, status, createdAt, nickname = "", body = "留言") =>
  env.DB.raw.prepare("INSERT INTO board_notes(id,nickname,body,status,created_at) VALUES(?,?,?,?,?)").run(id, nickname, body, status, createdAt);

test("送出留言：201 pending，只存雜湊 IP，不會出現在公開清單", async () => {
  const response = await post(note());
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, "pending");
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const [row] = rows();
  assert.equal(row.status, "pending");
  assert.equal(row.nickname, "阿明");
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(rows()), /203\.0\.113\.7/, "the raw IP is never stored");
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(verifyCalls[0].secret, "test-secret");
  assert.equal(verifyCalls[0].response, "token-ok");
  const list = await (await call({ headers: { Origin: SITE } })).json();
  assert.deepEqual(list.notes, [], "pending notes are not public");
});

test("公開清單：只列已刊登、最新 60 則、空暱稱顯示鳳山鄉親、不含 IP 雜湊", async () => {
  for (let i = 0; i < 65; i++) insert(`p-${String(i).padStart(3, "0")}`, "published", new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), i % 2 ? "阿明" : "");
  insert("pending-1", "pending", "2026-10-30T00:00:00.000Z");
  insert("archived-1", "archived", "2026-10-30T00:00:00.000Z");
  env.ALLOW_DEV_ORIGIN = "true";
  const response = await call({ headers: { Origin: "http://localhost:8765" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:8765");
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.match(response.headers.get("Cache-Control"), /max-age=30/);
  const { notes, closed, purgeAt } = await response.json();
  assert.equal(closed, false);
  assert.equal(purgeAt, BOARD_PURGE_AT);
  assert.equal(notes.length, 60);
  assert.equal(notes[0].id, "p-064", "newest first");
  assert.deepEqual(Object.keys(notes[0]).sort(), ["body", "created_at", "id", "nickname"]);
  assert.equal(notes.find((n) => n.id === "p-064").nickname, "鳳山鄉親");
  assert.ok(!notes.some((n) => n.id === "pending-1" || n.id === "archived-1"));
});

test("內容違規：清楚的中文原因與欄位，不會呼叫 Turnstile 也不會寫入", async () => {
  for (const [input, code, field] of [
    [note({ body: "打給我 0912-345-678" }), "phone", "body"],
    [note({ body: "我住中山路123號" }), "address", "body"],
    [note({ body: "看 https://x.example" }), "link", "body"],
    [note({ body: "A123456789" }), "national_id", "body"],
    [note({ body: "a@b.co" }), "email", "body"],
    [note({ body: "幹你娘" }), "profanity", "body"],
    [note({ body: "" }), "body_empty", "body"],
    [note({ body: "好".repeat(81) }), "body_too_long", "body"],
    [note({ nickname: "一個非常非常長的暱稱啊" }), "nickname_too_long", "nickname"],
  ]) {
    const response = await post(input);
    assert.equal(response.status, 400, code);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(body.field, field);
    assert.match(body.error, /[一-鿿]/);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), SITE, "errors stay readable by the island page");
  }
  assert.equal(verifyCalls.length, 0);
  assert.equal(rows().length, 0);
});

test("Turnstile：缺 token 400、未通過 403、服務中斷 503，都不寫入", async () => {
  assert.equal((await post(note({ turnstileToken: "" }))).status, 400);
  assert.equal((await post(note({ turnstileToken: "has space" }))).status, 400);
  verifyResult = { success: false, "error-codes": ["invalid-input-response"] };
  const failed = await post(note());
  assert.equal(failed.status, 403);
  assert.equal((await failed.json()).code, "turnstile_failed");
  verifyResult = "network";
  assert.equal((await post(note())).status, 503);
  assert.equal(rows().length, 0);
});

test("Turnstile：正式環境要求 hostname 與 action 相符；開發模式才接受本機主機名稱", async () => {
  for (const [result, label] of [
    [{ success: true, hostname: "evil.example", action: "board_note" }, "other hostname"],
    [{ success: true, hostname: "www.huiwen.tw", action: "other_widget" }, "other action"],
    [{ success: true, hostname: "www.huiwen.tw" }, "missing action"],
    [{ success: true, hostname: "localhost", action: "board_note" }, "localhost in production"],
    [{ success: true }, "no hostname"],
  ]) {
    verifyResult = result;
    const response = await post(note());
    assert.equal(response.status, 403, label);
    assert.equal((await response.json()).code, "turnstile_failed", label);
  }
  assert.equal(rows().length, 0);
  env.ALLOW_DEV_ORIGIN = "true";
  verifyResult = { success: true, hostname: "localhost", action: "board_note" };
  assert.equal((await post(note(), { ip: "198.51.100.30" })).status, 201);
  verifyResult = { success: true, hostname: "evil.example", action: "board_note" };
  assert.equal((await post(note(), { ip: "198.51.100.31" })).status, 403, "dev mode still rejects foreign hostnames");
});

test("缺少 CF-Connecting-IP：拒收，不把所有人算成同一個限流鍵", async () => {
  const response = await post(note(), { ip: null });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "client_ip_missing");
  assert.equal(verifyCalls.length, 0);
  assert.equal(rows().length, 0);
});

test("驗證網址只能覆寫成本機（測試用），其他值一律使用 Cloudflare 官方端點", async () => {
  env.TURNSTILE_VERIFY_URL = "https://evil.example/siteverify";
  assert.equal((await post(note())).status, 201);
  assert.equal(verifyCalls.at(-1).url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  env.TURNSTILE_VERIFY_URL = "http://127.0.0.1:9/siteverify";
  assert.equal((await post(note(), { ip: "198.51.100.1" })).status, 201);
  assert.equal(verifyCalls.at(-1).url, "http://127.0.0.1:9/siteverify");
});

test("限流：同一 IP（IPv6 同一 /64）10 分鐘一則，回 429 與 Retry-After", async () => {
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  Date.now = () => base;
  assert.equal((await post(note())).status, 201);
  const limited = await post(note({ body: "第二則" }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), String(RATE_LIMIT_MS / 1000));
  assert.match((await limited.json()).error, /10 分鐘/);
  assert.equal(verifyCalls.length, 1, "rate-limited requests do not spend a Turnstile verification");
  assert.equal((await post(note(), { ip: "198.51.100.9" })).status, 201, "another IP is independent");
  assert.equal((await post(note(), { ip: "2001:db8:1:2::10" })).status, 201);
  assert.equal((await post(note(), { ip: "2001:db8:1:2:ffff::1" })).status, 429, "same IPv6 /64 shares the limit");
  Date.now = () => base + RATE_LIMIT_MS + 1000;
  assert.equal((await post(note({ body: "十分鐘後" }))).status, 201);
});

test("限流在寫入時再檢查一次（同時送出兩則只會成功一則）", async () => {
  const [a, b] = await Promise.all([post(note({ body: "同時一" })), post(note({ body: "同時二" }))]);
  assert.deepEqual([a.status, b.status].sort(), [201, 429]);
  assert.equal(rows().length, 1);
});

test("CORS 與來源：正式環境只允許官網；本機 8765 僅在 ALLOW_DEV_ORIGIN=true 時允許", async () => {
  const devGet = await call({ headers: { Origin: "http://localhost:8765" } });
  assert.equal(devGet.status, 403, "production rejects the dev origin");
  assert.equal(devGet.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await post(note(), { origin: "http://localhost:8765" })).status, 403);
  const preflight = await call({ method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  const evil = await call({ method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await call({ headers: { Origin: "https://huiwen.tw" } })).status, 403);
  assert.equal((await post(note(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(note(), { origin: null })).status, 403);
  assert.equal(rows().length, 0);
  const plain = await call();
  assert.equal(plain.status, 200, "server-side GET without Origin may read the public list");
  assert.equal(plain.headers.get("Access-Control-Allow-Origin"), null);
});

test("只收 JSON、限制大小、其他路徑與方法回應中文錯誤", async () => {
  assert.equal((await post("nickname=a", { headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await post("{bad json")).status, 400);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post(JSON.stringify({ ...note(), pad: "x".repeat(5000) }))).status, 413);
  const streamed = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(5000))); c.close(); } });
  assert.equal((await call({ method: "POST", headers: { Origin: SITE, "Content-Type": "application/json" }, body: streamed, duplex: "half" })).status, 413);
  const missing = await call({}, "https://board.huiwen.tw/");
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /找不到/);
  const put = await call({ method: "PUT", headers: { Origin: SITE } });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get("Allow"), "GET, POST, OPTIONS");
});

test("安全標頭", async () => {
  const response = await call({ headers: { Origin: SITE } });
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-site");
});

test("未設定機密時拒收（不會用空的鹽或空的 Turnstile 金鑰）", async () => {
  env.IP_SALT = "short";
  assert.equal((await post(note())).status, 503);
  env.IP_SALT = "0123456789abcdef-test-salt";
  delete env.TURNSTILE_SECRET;
  assert.equal((await post(note())).status, 503);
  assert.equal(rows().length, 0);
});

test("保存期限：2026-12-28 00:00（台北）起停止收件、清單為空、排程刪除全部資料", async () => {
  insert("p-1", "published", "2026-12-01T00:00:00.000Z");
  insert("a-1", "archived", "2026-12-01T00:00:00.000Z");
  Date.now = () => Date.parse(BOARD_PURGE_AT) - 1;
  assert.equal((await (await call()).json()).notes.length, 1);
  Date.now = () => Date.parse(BOARD_PURGE_AT);
  const list = await (await call()).json();
  assert.deepEqual(list.notes, []);
  assert.equal(list.closed, true);
  const closed = await post(note());
  assert.equal(closed.status, 410);
  assert.match((await closed.json()).error, /結束收件/);
  let waited;
  await worker.scheduled({ cron: "17 * * * *" }, env, { waitUntil(p) { waited = p; } });
  await waited;
  assert.equal(rows().length, 0, "scheduled cleanup deletes every note including archived ones");
});

test("排程：滿 1 天的 ip_hash 清空，留言本身保留", async () => {
  const now = Date.parse("2026-11-10T00:00:00.000Z");
  env.DB.raw.prepare("INSERT INTO board_notes(id,body,status,created_at,ip_hash) VALUES('old','舊','published','2026-11-08T00:00:00.000Z',?),('new','新','pending','2026-11-09T12:00:00.000Z',?)")
    .run("a".repeat(64), "b".repeat(64));
  assert.deepEqual(await maintain(env, now), { purged: false });
  assert.deepEqual(rows().map((r) => [r.id, r.ip_hash]), [["old", null], ["new", "b".repeat(64)]]);
});

test("資料庫隔離：board Worker 的 SQL 只碰 board_notes", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const tables = [...source.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+([a-z_]+)/gi)].map((m) => m[1]);
  assert.ok(tables.length >= 4);
  assert.deepEqual([...new Set(tables)], ["board_notes"]);
});
