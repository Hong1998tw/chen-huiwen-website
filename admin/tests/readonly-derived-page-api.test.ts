import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../src/index.ts";
import { clearRemoteKeys, sha256 } from "../src/security.ts";

// Exercise the actual worker/auth/CSRF/router. Only D1 is a bounded in-memory spy.
const ORIGIN = "https://admin.example.test";
const COMMIT = "a".repeat(40);
const EMAIL = "readonly-api-test@example.test";
let issuer: ReturnType<typeof createServer>;
let envAuth: Record<string, string>;
let token: string;
let nonce: string;

test.before(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const key = { ...(await exportJWK(publicKey)), kid: "readonly-fixture", alg: "RS256", use: "sig" };
  issuer = createServer((request, response) => {
    if (request.url !== "/cdn-cgi/access/certs") { response.statusCode = 404; response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [key] }));
  });
  await new Promise<void>(resolve => issuer.listen(0, "127.0.0.1", resolve));
  const accessIssuer = `http://127.0.0.1:${(issuer.address() as { port: number }).port}`;
  envAuth = { ADMIN_ORIGIN: ORIGIN, PUBLISHER_ORIGIN: "https://publisher.example.test",
    ACCESS_ISSUER: accessIssuer, ACCESS_AUD: "readonly-api-fixture", OWNER_EMAIL_SHA256: await sha256(EMAIL) };
  token = await new SignJWT({ type: "app", email: EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: key.kid }).setSubject("fixture-owner")
    .setIssuer(accessIssuer).setAudience(envAuth.ACCESS_AUD).setIssuedAt().setExpirationTime("2m").sign(privateKey);
  nonce = await sha256(`huiwen-cms-csrf:${token}`);
});
test.after(() => { clearRemoteKeys(); issuer?.closeAllConnections(); issuer?.close(); });

function fixture() {
  const reads: string[] = [], writes: string[] = [];
  let queued = false;
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first() {
          if (!/^SELECT\b/i.test(sql.trim())) throw new Error("Unexpected first() mutation in fixture");
          reads.push(sql);
          if (sql.includes("FROM accounts")) return { role: "owner", disabled: 0 };
          if (sql.includes("FROM published_pages")) return {
            source_kind: "generated", commit_sha: COMMIT,
            editor_scope: args[0] === "public-records.html" ? "none" : "partial",
          };
          if (sql.includes("FROM page_edits")) return { payload: '{"fields":{}}', version: 1 };
          if (sql.includes("FROM page_publications")) return queued ? { id: "fixture-queue", status: "queued" } : null;
          throw new Error("Unrecognized read: " + sql);
        },
        async run() {
          writes.push(sql);
          if (sql.includes("INSERT OR IGNORE INTO page_publications")) queued = true;
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() { throw new Error("Unexpected batch in bounded API paths"); },
  };
  const env = { ...envAuth, DB } as unknown as Env;
  async function invoke(route: string, method: string, payload: Record<string, unknown>) {
    return worker.fetch(new Request(ORIGIN + route, { method,
      headers: { "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN,
        "X-CSRF-Token": nonce, "Content-Type": "application/json" }, body: JSON.stringify(payload) }), env);
  }
  return { reads, writes, invoke };
}

for (const operation of ["publish", "unpublish", "delete", "restore"]) {
  test(`derived collection refuses ${operation} before D1 mutation or queue insertion`, async () => {
    const f = fixture();
    const response = await f.invoke("/api/page-draft/publish", "POST", {
      path: "public-records.html", operation, version: 1,
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /不開放內容編輯/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.reads.some(sql => sql.includes("FROM accounts")), true, "owner authentication reached D1");
    assert.equal(f.reads.some(sql => sql.includes("published_pages") || sql.includes("page_edits") || sql.includes("page_publications")), false,
      "reject the exact derived route before consulting editable/draft/queue state");
  });
}

test("derived collection refuses direct draft PUT before D1 mutation", async () => {
  const f = fixture();
  const response = await f.invoke("/api/page-draft", "PUT", {
    path: "public-records.html", baseCommit: COMMIT, version: 1, fields: [],
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /不開放內容編輯/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads.some(sql => sql.includes("published_pages") || sql.includes("page_edits")), false);
});

test("existing editable page still saves its draft using the same authenticated API", async () => {
  const f = fixture();
  const response = await f.invoke("/api/page-draft", "PUT", {
    path: "service-guides.html", baseCommit: COMMIT, version: 1, fields: [],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: "service-guides.html", version: 2 });
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], /^UPDATE page_edits SET/);
});

test("existing editable page still queues publication using the same authenticated API", async () => {
  const f = fixture();
  const response = await f.invoke("/api/page-draft/publish", "POST", {
    path: "service-guides.html", operation: "publish", version: 1,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: "fixture-queue", status: "queued" });
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], /^INSERT OR IGNORE INTO page_publications/);
});
