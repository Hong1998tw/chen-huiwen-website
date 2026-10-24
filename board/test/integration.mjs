// 真的 workerd（wrangler dev）+ 本機 D1（套用 admin/migrations）+ 本機假 Turnstile 驗證端點。
// 執行：node board/test/integration.mjs（需先 npm ci --prefix admin，共用其 wrangler）。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const board = fileURLToPath(new URL("../", import.meta.url));
const admin = fileURLToPath(new URL("../../admin/", import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/huiwen-board-test-`);
const port = 18796, verifyPort = 18797;
const api = `http://127.0.0.1:${port}/api/board`;
const site = "http://localhost:8765";

let verifyCalls = 0;
const verifier = createServer((request, response) => {
  let body = "";
  request.on("data", (c) => (body += c));
  request.on("end", () => {
    verifyCalls++;
    const ok = body.includes("good-token") && body.includes("integration-secret");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ success: ok, hostname: "localhost", action: "board_note", "error-codes": ok ? [] : ["invalid-input-response"] }));
  });
});
await new Promise((resolve) => verifier.listen(verifyPort, "127.0.0.1", resolve));

const config = JSON.parse(readFileSync(board + "wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
delete config.routes;
delete config.$schema;
config.main = board + "src/index.js";
config.d1_databases[0].migrations_dir = admin + "migrations";
writeFileSync(dir + "/wrangler.json", JSON.stringify(config));
const wrangler = [admin + "node_modules/wrangler/bin/wrangler.js", "--config", dir + "/wrangler.json"];
const d1 = (sql) => execFileSync(process.execPath, [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir, "--json", "--command", sql], { cwd: board, stdio: "pipe" }).toString();

let server, log = "";
try {
  execFileSync(process.execPath, [...wrangler, "d1", "migrations", "apply", "huiwen-cms", "--local", "--persist-to", dir], { cwd: board, stdio: "pipe" });
  d1("INSERT INTO board_notes(id,nickname,body,status,created_at) VALUES('seed-published','','人行道變好走了','published','2026-10-19T01:00:00.000Z'),('seed-pending','阿明','還沒審','pending','2026-10-20T01:00:00.000Z')");
  server = spawn(process.execPath, [
    ...wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", dir, "--test-scheduled",
    "--var", "TURNSTILE_SECRET:integration-secret",
    "--var", "ALLOW_DEV_ORIGIN:true",
    "--var", "IP_SALT:integration-salt-0123456789",
    "--var", `TURNSTILE_VERIFY_URL:http://127.0.0.1:${verifyPort}/siteverify`,
  ], { cwd: board, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (v) => (log += v));
  server.stderr.on("data", (v) => (log += v));
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    try { ready = (await fetch(api)).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert(ready, log);

  const list = await fetch(api, { headers: { Origin: site } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("access-control-allow-origin"), site);
  assert.deepEqual((await list.json()).notes.map((n) => [n.id, n.nickname]), [["seed-published", "鳳山鄉親"]]);

  const preflight = await fetch(api, { method: "OPTIONS", headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), site);

  const send = (body, origin = site) => fetch(api, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const rejected = await send({ body: "我的電話 0912345678", turnstileToken: "good-token" });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /電話/);
  assert.equal(verifyCalls, 0, "content is checked before Turnstile");
  const robot = await send({ body: "我是機器人", turnstileToken: "bad-token" });
  assert.equal(robot.status, 403);
  const created = await send({ nickname: "", body: "謝謝慧文議員修好路燈！", turnstileToken: "good-token" });
  assert.equal(created.status, 201, await created.clone().text());
  const receipt = await created.json();
  assert.equal(receipt.status, "pending");
  const again = await send({ body: "再一則", turnstileToken: "good-token" });
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get("retry-after")) > 500);
  assert.equal((await send({ body: "x", turnstileToken: "good-token" }, "https://evil.example")).status, 403);

  const stored = JSON.parse(d1(`SELECT status,nickname,length(ip_hash) AS hash_length FROM board_notes WHERE id='${receipt.id}'`))[0].results[0];
  assert.deepEqual(stored, { status: "pending", nickname: "", hash_length: 64 });
  assert.equal((await fetch(api).then((r) => r.json())).notes.length, 1, "the new note waits for review");

  const scheduled = await fetch(`http://127.0.0.1:${port}/__scheduled?cron=17+*+*+*+*`);
  assert.equal(scheduled.status, 200, "the hourly cron handler runs");
  console.log("PASS: board Worker on workerd + local D1: CORS, filters, Turnstile, rate limit, pending-only storage, cron");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((r) => server.once("exit", r)), new Promise((r) => setTimeout(r, 1000))]);
  }
  verifier.close();
  rmSync(dir, { recursive: true, force: true });
}
