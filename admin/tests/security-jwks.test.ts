// Shared remote key set: one JWKS cache per issuer, with every JWT check still enforced.
// Each test builds its own local "issuer" (a JWKS server on a free port), so key sets never leak between tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  HttpError,
  JWKS_CACHE_MAX_AGE_MS,
  JWKS_COOLDOWN_MS,
  clearRemoteKeys,
  owner,
  runner,
  sha256,
} from "../src/security.ts";

const EMAIL = "owner@example.test";
const AUD = "access-aud";

// jose measures cache age and cooldown with Date.now(); shifting it moves time without sleeping.
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const advance = (ms: number) => {
  shift += ms;
};
const cleanups: Array<() => void> = [];
test.after(() => {
  Date.now = realNow;
  for (const cleanup of cleanups) cleanup();
});

async function newKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}
type Key = Awaited<ReturnType<typeof newKey>>;

/** A stand-in for https://<team>.cloudflareaccess.com: serves /cdn-cgi/access/certs and counts fetches. */
async function newIssuer(keys: Key[]) {
  const state = { keys, mode: "ok", hits: 0 };
  const server = createServer((req, res) => {
    if (req.url !== "/cdn-cgi/access/certs") {
      res.statusCode = 404;
      return res.end();
    }
    state.hits++;
    if (state.mode === "http500") {
      res.statusCode = 500;
      return res.end("unavailable");
    }
    if (state.mode === "reset") return req.socket.destroy();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const handle = {
    origin,
    get hits() {
      return state.hits;
    },
    resetHits() {
      state.hits = 0;
    },
    setKeys(next: Key[]) {
      state.keys = next;
    },
    setMode(mode: string) {
      state.mode = mode;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
  cleanups.push(handle.close);
  return handle;
}
type Issuer = Awaited<ReturnType<typeof newIssuer>>;

async function ownerEnv(issuer: Issuer) {
  return {
    ACCESS_ISSUER: issuer.origin,
    ACCESS_AUD: AUD,
    OWNER_EMAIL_SHA256: await sha256(EMAIL),
  } as unknown as Env;
}
function accessToken(
  key: Key,
  env: Env,
  over: { iss?: string; aud?: string; sub?: string | null; type?: string; email?: string; exp?: number | string } = {},
) {
  const jwt = new SignJWT({ type: over.type ?? "app", email: over.email ?? EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(over.iss ?? env.ACCESS_ISSUER)
    .setAudience(over.aud ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "1h");
  if (over.sub !== null) jwt.setSubject(over.sub ?? "access-user");
  return jwt.sign(key.privateKey);
}
const asOwner = (env: Env, jwt: string, keys?: Parameters<typeof owner>[2]) =>
  owner(new Request("https://admin.example.test/api/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, keys);

async function status(call: () => Promise<unknown>) {
  try {
    await call();
    return "ok";
  } catch (error) {
    return error instanceof HttpError ? String(error.status) : `ERR:${(error as Error)?.message}`;
  }
}

test("repeated requests reuse one JWKS fetch", async () => {
  const key = await newKey("k1");
  const issuer = await newIssuer([key]);
  const env = await ownerEnv(issuer);
  const jwt = await accessToken(key, env);
  for (let i = 0; i < 20; i++) assert.equal(await status(() => asOwner(env, jwt)), "ok");
  assert.equal(issuer.hits, 1);
  issuer.close();
});

test("concurrent cold requests do not each refetch (Node; Workers cannot share an in-flight fetch across requests)", async () => {
  const key = await newKey("k1");
  const issuer = await newIssuer([key]);
  const env = await ownerEnv(issuer);
  const jwt = await accessToken(key, env);
  const results = await Promise.all(Array.from({ length: 20 }, () => status(() => asOwner(env, jwt))));
  assert.deepEqual(new Set(results), new Set(["ok"]));
  assert.equal(issuer.hits, 1);
  issuer.close();
});

test("different issuers keep separate caches, even with the same kid", async () => {
  const keyA = await newKey("k1");
  const keyB = await newKey("k1"); // same kid, different key material
  const issuerA = await newIssuer([keyA]);
  const issuerB = await newIssuer([keyB]);
  const envA = await ownerEnv(issuerA);
  const envB = await ownerEnv(issuerB);
  const tokenA = await accessToken(keyA, envA);
  const tokenB = await accessToken(keyB, envB);
  for (let i = 0; i < 10; i++) {
    assert.equal(await status(() => asOwner(envA, tokenA)), "ok");
    assert.equal(await status(() => asOwner(envB, tokenB)), "ok");
  }
  assert.deepEqual([issuerA.hits, issuerB.hits], [1, 1]);
  // B's key claiming issuer A, and B's token presented to A, are both rejected and do not poison A's cache.
  assert.equal(await status(async () => asOwner(envA, await accessToken(keyB, envA))), "401");
  assert.equal(await status(() => asOwner(envA, tokenB)), "401");
  assert.equal(await status(() => asOwner(envA, tokenA)), "ok");
  issuerA.close();
  issuerB.close();
});

test("unknown kid floods are rejected and refetches are bounded by the cooldown", async () => {
  const key = await newKey("k1");
  const rogue = await newKey("rogue");
  const issuer = await newIssuer([key]);
  const env = await ownerEnv(issuer);
  for (let i = 0; i < 50; i++) {
    assert.equal(await status(async () => asOwner(env, await accessToken({ ...rogue, kid: `rogue-${i}` }, env))), "401");
  }
  assert.equal(issuer.hits, 1);
  advance(JWKS_COOLDOWN_MS + 1);
  assert.equal(await status(async () => asOwner(env, await accessToken({ ...rogue, kid: "rogue-later" }, env))), "401");
  assert.equal(issuer.hits, 2, "one refetch per cooldown, not one per request");
  issuer.close();
});

test("key rotation: a newly published kid is accepted once the cooldown has passed, without a restart", async () => {
  const k1 = await newKey("k1");
  const k2 = await newKey("k2");
  const issuer = await newIssuer([k1]);
  const env = await ownerEnv(issuer);
  const t1 = await accessToken(k1, env);
  const t2 = await accessToken(k2, env);
  assert.equal(await status(() => asOwner(env, t1)), "ok");
  issuer.setKeys([k1, k2]);
  assert.equal(await status(() => asOwner(env, t2)), "401"); // inside the cooldown window
  advance(JWKS_COOLDOWN_MS + 1);
  assert.equal(await status(() => asOwner(env, t2)), "ok");
  assert.equal(await status(() => asOwner(env, t1)), "ok");
  assert.equal(issuer.hits, 2);
  issuer.close();
});

test("revocation: a removed kid keeps working for at most cacheMaxAge, then stops", async () => {
  const k1 = await newKey("k1");
  const k2 = await newKey("k2");
  const issuer = await newIssuer([k1, k2]);
  const env = await ownerEnv(issuer);
  const t1 = await accessToken(k1, env);
  const t2 = await accessToken(k2, env);
  assert.equal(await status(() => asOwner(env, t1)), "ok");
  issuer.setKeys([k2]);
  advance(JWKS_CACHE_MAX_AGE_MS - 1_000);
  assert.equal(await status(() => asOwner(env, t1)), "ok", "still inside the cache window");
  advance(2_000);
  assert.equal(await status(() => asOwner(env, t1)), "401", "rejected once the cache expires");
  assert.equal(await status(() => asOwner(env, t2)), "ok");
  issuer.close();
});

test("fetch failure: a cold failure is not cached and recovery is immediate", async () => {
  for (const mode of ["http500", "reset"]) {
    const key = await newKey("k1");
    const issuer = await newIssuer([key]);
    const env = await ownerEnv(issuer);
    const jwt = await accessToken(key, env);
    issuer.setMode(mode);
    for (let i = 0; i < 3; i++) assert.equal(await status(() => asOwner(env, jwt)), "401", mode);
    issuer.setMode("ok");
    assert.equal(await status(() => asOwner(env, jwt)), "ok", `${mode}: first request after recovery succeeds`);
    issuer.resetHits();
    for (let i = 0; i < 5; i++) assert.equal(await status(() => asOwner(env, jwt)), "ok");
    assert.equal(issuer.hits, 0);
    issuer.close();
  }
});

test("fetch failure: a warm cache rides out an outage until it expires, then fails closed", async () => {
  const key = await newKey("k1");
  const issuer = await newIssuer([key]);
  const env = await ownerEnv(issuer);
  const jwt = await accessToken(key, env);
  assert.equal(await status(() => asOwner(env, jwt)), "ok");
  issuer.setMode("http500");
  issuer.resetHits();
  for (let i = 0; i < 5; i++) assert.equal(await status(() => asOwner(env, jwt)), "ok");
  assert.equal(issuer.hits, 0);
  advance(JWKS_CACHE_MAX_AGE_MS + 1_000);
  assert.equal(await status(() => asOwner(env, jwt)), "401"); // no stale-if-error
  issuer.setMode("ok");
  assert.equal(await status(() => asOwner(env, jwt)), "ok");
  issuer.close();
});

test("a warm cache never relaxes issuer, audience, algorithm, expiry or role checks", async () => {
  const key = await newKey("k1");
  const issuer = await newIssuer([key]);
  const env = await ownerEnv(issuer);
  assert.equal(await status(async () => asOwner(env, await accessToken(key, env))), "ok"); // warm the cache
  issuer.resetHits();
  const expired = Math.floor(realNow() / 1000) - 120; // real clock: Date.now() is shifted by earlier tests
  const cases: [string, Promise<string>, string][] = [
    ["wrong issuer", accessToken(key, env, { iss: "https://evil.example.test" }), "401"],
    ["wrong audience", accessToken(key, env, { aud: "another-aud" }), "401"],
    ["expired", accessToken(key, env, { exp: expired }), "401"],
    ["missing sub", accessToken(key, env, { sub: null }), "401"],
    ["wrong token type", accessToken(key, env, { type: "service" }), "403"],
    ["another account", accessToken(key, env, { email: "someone-else@example.test" }), "403"],
  ];
  for (const [name, jwt, expected] of cases) assert.equal(await status(async () => asOwner(env, await jwt)), expected, name);
  // HS256 with a shared secret must be refused by the algorithm allow-list, before any key is looked up.
  const hs256 = await new SignJWT({ type: "app", email: EMAIL })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUD)
    .setSubject("access-user")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("0123456789abcdef0123456789abcdef"));
  assert.equal(await status(() => asOwner(env, hs256)), "401", "HS256");
  assert.equal(issuer.hits, 0, "none of these rejections needed a JWKS fetch");
  issuer.close();
});

test("an injected key getter still takes priority over the shared cache", async () => {
  const key = await newKey("k1");
  const issuer = await newIssuer([key]);
  const env = await ownerEnv(issuer);
  const local = createLocalJWKSet({ keys: [key.jwk] });
  for (let i = 0; i < 5; i++) assert.equal(await status(async () => asOwner(env, await accessToken(key, env), local)), "ok");
  assert.equal(issuer.hits, 0);
  issuer.close();
});

test("runner(): forged bearer tokens cannot force a GitHub JWKS fetch per request, and claims stay enforced", async () => {
  clearRemoteKeys(); // the GitHub JWKS URL is fixed, so start this test from a cold cache
  const key = await newKey("gh1");
  const rogue = await newKey("rogue");
  const env = {
    GITHUB_REPOSITORY: "Hong1998tw/chen-huiwen-website",
    GITHUB_REPOSITORY_ID: "1360942570",
    GITHUB_OWNER_ID: "126787497",
    PUBLISHER_ORIGIN: "https://huiwen-cms.lihong.workers.dev",
  } as unknown as Env;
  const claims = (over: Record<string, unknown> = {}) => ({
    repository: env.GITHUB_REPOSITORY,
    repository_id: env.GITHUB_REPOSITORY_ID,
    repository_owner_id: env.GITHUB_OWNER_ID,
    ref: "refs/heads/main",
    workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/cms-publisher.yml@refs/heads/main`,
    environment: "notion-publisher",
    event_name: "schedule",
    run_id: "42",
    ...over,
  });
  const githubToken = (signer: Key, over: Record<string, unknown> = {}, aud = env.PUBLISHER_ORIGIN) =>
    new SignJWT(claims(over))
      .setProtectedHeader({ alg: "RS256", kid: signer.kid })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience(aud)
      .setSubject(`repo:Hong1998tw@${env.GITHUB_OWNER_ID}/chen-huiwen-website@${env.GITHUB_REPOSITORY_ID}:environment:notion-publisher`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signer.privateKey);
  const run = (jwt: string) => runner(new Request("https://huiwen-cms.lihong.workers.dev/internal/claim", { headers: { Authorization: `Bearer ${jwt}` } }), env);

  const realFetch = globalThis.fetch;
  let githubHits = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://token.actions.githubusercontent.com/.well-known/jwks")) {
      githubHits++;
      return Promise.resolve(Response.json({ keys: [key.jwk] }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal(await status(async () => run(await githubToken({ ...rogue, kid: `rogue-${i}` }))), "401");
    }
    assert.equal(await status(async () => run(await githubToken(key))), "ok");
    assert.equal(await status(async () => run(await githubToken(key, { repository: "someone/else" }))), "403", "repository claim");
    assert.equal(await status(async () => run(await githubToken(key, { ref: "refs/heads/feature" }))), "403", "ref claim");
    assert.equal(await status(async () => run(await githubToken(key, { event_name: "push" }))), "403", "event claim");
    assert.equal(await status(async () => run(await githubToken(key, {}, "https://another-audience.example.test"))), "401", "audience");
    assert.equal(githubHits, 1, "56 requests, one JWKS fetch");
  } finally {
    globalThis.fetch = realFetch;
    clearRemoteKeys();
  }
});
