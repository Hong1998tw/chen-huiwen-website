import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../src/index.ts";
import { boundedJSON, clearRemoteKeys, BODY_MAX_BYTES, SYNC_MAX_BYTES, SYNC_MAX_PAGES } from "../src/security.ts";

// The real Worker router, GitHub OIDC runner check, body bound and sync validation. Only the GitHub
// JWKS fetch is answered by a local key and D1 is a statement recorder.
const PUBLISHER = "https://publisher.example.test";
const COMMIT = "a".repeat(40);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// The exact bytes the publisher sends: its own encoder over the committed catalogue and sources.
const realBody = execFileSync("python3", ["-c",
  "import sys; sys.path.insert(0, 'scripts'); import publish_from_cms as c; " +
  `sys.stdout.buffer.write(c.encode_body(c.sync_body('${COMMIT}')))`], { cwd: repoRoot, maxBuffer: 4 << 20 });
const real = JSON.parse(new TextDecoder().decode(realBody));
const env = {
  ADMIN_ORIGIN: "https://admin.example.test", PUBLISHER_ORIGIN: PUBLISHER,
  GITHUB_REPOSITORY: "Hong1998tw/chen-huiwen-website", GITHUB_REPOSITORY_ID: "1360942570", GITHUB_OWNER_ID: "126787497",
};
let token: string;
let realFetch: typeof fetch;

test.before(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "sync-fixture", alg: "RS256", use: "sig" };
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://token.actions.githubusercontent.com/.well-known/jwks")) return Promise.resolve(Response.json({ keys: [jwk] }));
    return realFetch(input, init);
  }) as typeof fetch;
  token = await new SignJWT({
    repository: env.GITHUB_REPOSITORY, repository_id: env.GITHUB_REPOSITORY_ID, repository_owner_id: env.GITHUB_OWNER_ID,
    ref: "refs/heads/main", workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/cms-publisher.yml@refs/heads/main`,
    environment: "notion-publisher", event_name: "workflow_dispatch", run_id: "41037284771",
  }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(PUBLISHER).setSubject(`repo:Hong1998tw@${env.GITHUB_OWNER_ID}/chen-huiwen-website@${env.GITHUB_REPOSITORY_ID}:environment:notion-publisher`)
    .setIssuedAt().setExpirationTime("10m").sign(privateKey);
});
test.after(() => { globalThis.fetch = realFetch; clearRemoteKeys(); });

function recorder(catalog: { count: number; first_sha: string | null; last_sha: string | null } = { count: 157, first_sha: "b".repeat(40), last_sha: "b".repeat(40) }) {
  const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  const others: string[] = [];
  const DB = {
    prepare(sql: string) {
      const statement = {
        sql, args: [] as unknown[],
        bind(...values: unknown[]) { statement.args = values; return statement; },
        async first() { others.push(sql); if (/FROM published_pages/.test(sql)) return catalog; throw new Error("unexpected read " + sql); },
        async run() { others.push(sql); throw new Error("sync must write only through one batch"); },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) { batches.push(statements.map(({ sql, args }) => ({ sql, args }))); return []; },
  };
  return { batches, others, env: { ...env, DB } as unknown as Env };
}
const post = (body: BodyInit, target: Env, path = "/internal/sync", authorized = true) =>
  worker.fetch(new Request(PUBLISHER + path, {
    method: "POST", body, duplex: "half",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
  } as RequestInit), target);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function stream(bytes: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { state.pulled += 1; controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)); if (state.pulled * 64 * 1024 >= bytes) controller.close(); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 }); // pull only when a reader actually asks for bytes
  return { body, state };
}

type Snapshot = { commit: string; sources: Array<Record<string, unknown>>; pages: Array<Record<string, string>> };
// Assert an accepted sync: one batch, only catalogue/source tables, the whole catalogue replaced.
async function assertAccepted(snapshot: Snapshot, body: BodyInit = encode(snapshot)) {
  const { batches, others, env: target } = recorder();
  const response = await post(body, target);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { synced: snapshot.sources.length, pages: snapshot.pages.length });
  assert.equal(batches.length, 1, "sources and the catalogue are written in one D1 batch");
  assert.deepEqual(others, ["SELECT COUNT(*) AS count,MIN(commit_sha) AS first_sha,MAX(commit_sha) AS last_sha FROM published_pages"]);
  const [statements] = batches;
  assert(statements.every(({ sql }) => /^(?:INSERT (?:OR IGNORE )?INTO (?:published_sources|documents|published_pages)|DELETE FROM published_pages)\b/.test(sql)),
    "the sync never touches drafts, page publications or accounts");
  const prune = statements.findIndex(({ sql }) => sql === "DELETE FROM published_pages");
  const inserts = statements.map((s, index) => ({ ...s, index })).filter(({ sql }) => sql.startsWith("INSERT INTO published_pages"));
  assert(prune >= 0 && inserts.every(({ index }) => index > prune), "the catalogue is replaced inside the same batch");
  assert.deepEqual(inserts.map(({ args }) => args[0]), snapshot.pages.map((page) => page.path));
  assert(inserts.every(({ args }) => args[5] === snapshot.commit && args.length === 7));
  return inserts;
}
// A fixed, legal catalogue of any size built from one real page row (Chinese titles, mixed sources).
const pageTemplate = real.pages.find((page: { path: string }) => page.path === "index.html");
const fixturePages = (count: number) => Array.from({ length: count }, (_, i) => ({
  ...pageTemplate, path: `fixture-page-${i}.html`, title: `測試頁面第 ${i} 號｜陳慧文・高雄市議員`,
  source: ["data/editorial-pages.json", "island/island-data.json", `fixture-page-${i}.html`][i % 3],
}));

test("the publisher's current real snapshot is accepted within the sync caps", async (t) => {
  assert(real.pages.length >= 1 && real.pages.length <= SYNC_MAX_PAGES, `${real.pages.length} pages`);
  assert(realBody.byteLength <= SYNC_MAX_BYTES, `${realBody.byteLength} bytes`);
  t.diagnostic(`measured real snapshot: ${real.pages.length} pages, ${real.sources.length} sources, ${realBody.byteLength} bytes`);
  const inserts = await assertAccepted(real, realBody);
  const island = inserts.find(({ args }) => args[0] === "public-records.html");
  if (island) assert.equal(island.args[2], "island/island-data.json");
});

test("a controlled snapshot over the old 64 KiB and 200-page limits is rejected by the old guard and accepted by the sync caps", async () => {
  const snapshot = { ...real, pages: fixturePages(600) };
  const body = encode(snapshot);
  // Fixed fixture properties, independent of how much real content exists.
  assert(body.byteLength > BODY_MAX_BYTES && snapshot.pages.length > 200, `${body.byteLength} bytes, ${snapshot.pages.length} pages`);
  await assert.rejects(boundedJSON(new Request(PUBLISHER, { method: "POST", body })), (error: { status?: number }) => error.status === 413,
    "the general 64 KiB guard that /internal/sync used before rejects it");
  const inserts = await assertAccepted(snapshot, body);
  assert.deepEqual(inserts[1].args.slice(0, 5), ["fixture-page-1.html", "測試頁面第 1 號｜陳慧文・高雄市議員", "island/island-data.json", pageTemplate.kind, pageTemplate.editorScope]);
  // The page cap is the real limit: exactly 1,000 legal pages are accepted.
  await assertAccepted({ ...real, pages: fixturePages(SYNC_MAX_PAGES) });
});

test("new legal content (one more event source, one more daily page) keeps syncing", async () => {
  const event = real.sources.find((source: { domain: string }) => source.domain === "events");
  const grown = {
    ...real,
    sources: [...real.sources, { ...event, id: "fixture-new-event", record_key: "fixture-new-event", hash: "sha256:" + "e".repeat(64) }],
    pages: [...real.pages, { path: "page-daily-fixture-new.html", title: "新增日常｜陳慧文", source: "data/editorial-pages.json",
      kind: "generated", editorScope: "partial", publicationStatus: "published" }],
  };
  await assertAccepted(grown);
});

test("a retry at the same commit does not rewrite the catalogue", async () => {
  const { batches, env: target } = recorder({ count: real.pages.length, first_sha: COMMIT, last_sha: COMMIT });
  assert.equal((await post(realBody, target)).status, 200);
  assert(batches[0].every(({ sql }) => !/published_pages/.test(sql)), "only the idempotent source upserts run");
});

test("authentication happens before any body byte is read and caps stay per route", async () => {
  const unauthenticated = stream(SYNC_MAX_BYTES * 2);
  const { batches, env: target } = recorder();
  assert.equal((await post(unauthenticated.body, target, "/internal/sync", false)).status, 401);
  assert.equal(unauthenticated.state.pulled, 0, "an unauthenticated request body is never read");

  const oversized = stream(SYNC_MAX_BYTES * 4);
  const response = await post(oversized.body, target);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /512 KB/);
  assert(oversized.state.cancelled && oversized.state.pulled <= SYNC_MAX_BYTES / (64 * 1024) + 2, `${oversized.state.pulled} pulls`);

  // Every other internal route keeps the general 64 KiB limit, even for the authenticated runner.
  const general = await post(encode({ id: "x", message: "a".repeat(BODY_MAX_BYTES) }), target, "/internal/receipt");
  assert.equal(general.status, 413);
  assert.match((await general.json()).error, /64 KB/);
  assert.equal(batches.length, 0);
});

test("invalid snapshots are rejected before any write", async () => {
  const page = fixturePages(2)[1]; // a fixed legal row with an island/ JSON source
  const cases: Array<[string, unknown]> = [
    ["too many pages", { ...real, pages: Array.from({ length: SYNC_MAX_PAGES + 1 }, (_, i) => ({ ...page, path: `p-${i}.html` })) }],
    ["private source", { ...real, pages: [{ ...page, source: "secrets/island-data.json" }] }],
    ["traversal source", { ...real, pages: [{ ...page, source: "island/../data/x.json" }] }],
    ["nested island source", { ...real, pages: [{ ...page, source: "island/private/x.json" }] }],
    ["non-JSON island source", { ...real, pages: [{ ...page, source: "island/island-data.js" }] }],
    ["unknown field", { ...real, pages: [{ ...page, payload: "x" }] }],
    ["duplicate path", { ...real, pages: [page, page] }],
    ["invalid commit", { ...real, commit: "HEAD" }],
    ["invalid source id", { ...real, sources: [{ ...real.sources[0], id: "../x" }] }],
  ];
  for (const [label, value] of cases) {
    const { batches, env: target } = recorder();
    assert.equal((await post(encode(value), target)).status, 400, label);
    assert.equal(batches.length, 0, `${label}: nothing written`);
  }
});
