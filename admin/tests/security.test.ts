import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { owner, runner, csrf, boundedJSON, sha256 } from "../src/security.ts";
import { validate } from "../src/validation.ts";
const env = {
  ACCESS_ISSUER: "https://identity.example",
  ACCESS_AUD: "aud",
  OWNER_EMAIL_SHA256: await sha256("owner@example.com"),
  GITHUB_REPOSITORY: "Hong1998tw/chen-huiwen-website",
  GITHUB_REPOSITORY_ID: "1360942570",
  GITHUB_OWNER_ID: "126787497",
  PUBLISHER_ORIGIN: "https://cms-publisher.huiwen.tw",
};
const { privateKey, publicKey } = await generateKeyPair("RS256");
const key = async () => publicKey;
async function signed(
  payload,
  issuer = env.ACCESS_ISSUER,
  audience = env.ACCESS_AUD,
  expiry = "2m",
) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(privateKey);
}
const req = (t) =>
  new Request("https://admin.huiwen.tw/api/session", {
    headers: { "Cf-Access-Jwt-Assertion": t },
  });
test("owner requires valid signature, audience, expiry and exact allowlisted identity", async () => {
  assert.equal(
    (
      await owner(
        req(await signed({ type: "app", email: "owner@example.com" })),
        env,
        key,
      )
    ).id,
    "github:126787497",
  );
  for (const token of [
    await signed({ type: "app", email: "other@example.com" }),
    await signed(
      { type: "app", email: "owner@example.com" },
      env.ACCESS_ISSUER,
      "wrong",
    ),
    await signed(
      { type: "app", email: "owner@example.com" },
      env.ACCESS_ISSUER,
      env.ACCESS_AUD,
      "-1m",
    ),
    "invalid",
  ])
    await assert.rejects(() => owner(req(token), env, key));
  await assert.rejects(() =>
    owner(new Request("https://admin.huiwen.tw"), env, key),
  );
});
const claims = {
  repository: env.GITHUB_REPOSITORY,
  repository_id: env.GITHUB_REPOSITORY_ID,
  repository_owner_id: env.GITHUB_OWNER_ID,
  ref: "refs/heads/main",
  workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/cms-publisher.yml@refs/heads/main`,
  environment: "notion-publisher",
  event_name: "schedule",
  run_id: "123",
};
test("OIDC rejects fork, pull request, wrong workflow, repository transfer and other environment", async () => {
  const invoke = async (c) =>
    runner(
      new Request(env.PUBLISHER_ORIGIN, {
        headers: {
          Authorization:
            "Bearer " +
            (await signed(
              c,
              "https://token.actions.githubusercontent.com",
              env.PUBLISHER_ORIGIN,
            )),
        },
      }),
      env,
      key,
    );
  assert.equal(await invoke(claims), "123");
  for (const patch of [
    { repository_id: "9" },
    { repository_owner_id: "9" },
    { repository: "attacker/website" },
    { ref: "refs/pull/1/merge" },
    { workflow_ref: "other" },
    { event_name: "pull_request" },
    { environment: "other" },
  ])
    await assert.rejects(() => invoke({ ...claims, ...patch }));
});
test("CSRF requires same origin and session-derived nonce", () => {
  const request = (origin, token) =>
    new Request("https://admin.huiwen.tw/api/documents", {
      method: "POST",
      headers: {
        Origin: origin,
        "X-CSRF-Token": token,
        "Content-Type": "application/json",
      },
    });
  assert.doesNotThrow(() =>
    csrf(
      request("https://admin.huiwen.tw", "nonce"),
      "https://admin.huiwen.tw",
      "nonce",
    ),
  );
  assert.throws(() =>
    csrf(
      request("https://evil.example", "nonce"),
      "https://admin.huiwen.tw",
      "nonce",
    ),
  );
  assert.throws(() =>
    csrf(
      request("https://admin.huiwen.tw", "wrong"),
      "https://admin.huiwen.tw",
      "nonce",
    ),
  );
});
test("request size is bounded even without Content-Length", async () => {
  await assert.rejects(() =>
    boundedJSON(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ x: "a".repeat(65536) }),
      }),
    ),
  );
});
const event = {
  name: "公開活動",
  start: "2026-10-01T10:00:00+08:00",
  end: "2026-10-01T12:00:00+08:00",
  content: "活動內容",
  registration: "無需報名",
  sourceUrl: "https://www.kcc.gov.tw/",
  verifiedAt: "2026-09-27",
  updatedAt: "2026-09-27",
  reviewDueAt: "2026-09-30",
  status: "scheduled",
  changeNote: null,
};
test("editor rejects XSS, private sources, reversed time and unknown fields", () => {
  assert.equal(validate("events", event).name, "公開活動");
  for (const patch of [
    { name: "<script>alert(1)</script>" },
    { sourceUrl: "https://" + "notion.so/private" },
    { sourceUrl: "javascript:alert(1)" },
    { end: "2026-10-01T09:00:00+08:00" },
    { role: "owner" },
    { verifiedAt: "2026-02-31" },
  ])
    assert.throws(() => validate("events", { ...event, ...patch }));
});
test("monthly schedule rejects duplicate days and out-of-month appointments", () => {
  const legal = {
    month: "2026-10",
    observedAt: "2026-09-27",
    sourceUrl: "https://www.kcc.gov.tw/",
    sourceTitle: "公開月表",
    nextReviewAt: "2026-10-05",
    sessions: [{ date: "2026-10-01", start: "19:30", end: "21:00" }],
  };
  assert.equal(validate("legal-schedule", legal).month, "2026-10");
  assert.throws(() =>
    validate("legal-schedule", {
      ...legal,
      sessions: [...legal.sessions, ...legal.sessions],
    }),
  );
  assert.throws(() =>
    validate("legal-schedule", {
      ...legal,
      sessions: [{ date: "2026-11-01", start: "19:30", end: "21:00" }],
    }),
  );
});

import {canAdvancePublication} from '../src/index.ts';
test('publication polling accepts a completed deployment between polls without permitting regression',()=>{
 assert(canAdvancePublication('pr_created','deployed'));
 assert(canAdvancePublication('pr_created','verified'));
 assert(canAdvancePublication('merged','verified'));
 assert(!canAdvancePublication('deployed','pr_created'));
 assert(!canAdvancePublication('verified','processing'));
 assert(!canAdvancePublication('closed','merged'));
});
