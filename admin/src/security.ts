import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
export class HttpError extends Error {
  status: number;
  field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}
export const sha256 = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
// A remote key set caches its keys per instance, so it must outlive a single request: building
// one inside each request meant an empty cache and one outbound JWKS fetch per request, including
// for forged tokens. Key sets are shared per JWKS URL (one per issuer) for the life of the isolate.
// The URLs come from configuration constants, never from request data, so the map stays tiny.
//
// - cacheMaxAge: a signing key removed from the JWKS is still accepted for at most this long, so it
//   is also the worst-case delay before a rotated-out or revoked key stops working. It does not
//   affect session revocation: Access invalidates sessions itself and every JWT keeps its own `exp`.
// - cooldownDuration: an unknown `kid` triggers a refetch at most this often per key set, which
//   bounds unauthenticated token floods to six fetches per minute per isolate and bounds the window
//   in which a newly published key is rejected.
// A failed fetch is not cached (the next request retries) and there is no stale-if-error: once the
// cache expires during a JWKS outage, verification fails closed with 401.
export const JWKS_CACHE_MAX_AGE_MS = 5 * 60_000;
export const JWKS_COOLDOWN_MS = 10_000;
const remoteKeySets = new Map<string, JWTVerifyGetKey>();
export function remoteKeys(url: URL): JWTVerifyGetKey {
  let keys = remoteKeySets.get(url.href);
  if (!keys) {
    keys = createRemoteJWKSet(url, {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
    });
    remoteKeySets.set(url.href, keys);
  }
  return keys;
}
/** Test hook: forget every shared key set so a test starts from a cold cache. */
export function clearRemoteKeys() {
  remoteKeySets.clear();
}
export function enforceOwner(
  payload: JWTPayload,
  hash: string,
  actualHash: string,
) {
  if (
    payload.type !== "app" ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    !hash ||
    actualHash !== hash
  )
    throw new HttpError(403, "此帳號沒有後台權限");
}
export async function owner(request: Request, env: Env, key?: JWTVerifyGetKey) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new HttpError(401, "請使用 Google 登入");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(
      token,
      key || remoteKeys(new URL("/cdn-cgi/access/certs", env.ACCESS_ISSUER)),
      {
        issuer: env.ACCESS_ISSUER,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub"],
      },
    ));
  } catch {
    throw new HttpError(401, "登入已失效，請重新登入");
  }
  enforceOwner(
    payload,
    env.OWNER_EMAIL_SHA256,
    await sha256(String(payload.email || "").toLowerCase()),
  );
  return {
    // Stable internal account ID: preserve ownership and audit history across IdP changes.
    // The legacy prefix is not an accepted login provider; Access controls the provider.
    id: "github:126787497",
    csrf: await sha256(`huiwen-cms-csrf:${token}`),
  };
}
export function enforceRunner(
  payload: JWTPayload,
  env: Pick<
    Env,
    "GITHUB_REPOSITORY" | "GITHUB_REPOSITORY_ID" | "GITHUB_OWNER_ID"
  >,
) {
  const [ownerName, repoName] = env.GITHUB_REPOSITORY.split("/");
  // This repository uses GitHub's immutable default subject (read back from its
  // OIDC configuration). Environment context is signed in sub; the separate
  // environment claim is optional. Never accept a conflicting explicit claim.
  const subject = `repo:${ownerName}@${env.GITHUB_OWNER_ID}/${repoName}@${env.GITHUB_REPOSITORY_ID}:environment:notion-publisher`;
  const checks = {
    repository: payload.repository === env.GITHUB_REPOSITORY,
    repository_id: payload.repository_id === env.GITHUB_REPOSITORY_ID,
    repository_owner_id: payload.repository_owner_id === env.GITHUB_OWNER_ID,
    ref: payload.ref === "refs/heads/main",
    workflow_ref: payload.workflow_ref === `${env.GITHUB_REPOSITORY}/.github/workflows/cms-publisher.yml@refs/heads/main`,
    sub: payload.sub === subject,
    environment: payload.environment === undefined || payload.environment === "notion-publisher",
    event_name: ["schedule", "workflow_dispatch"].includes(String(payload.event_name)),
    run_id: /^\d+$/.test(String(payload.run_id)),
  };
  const fields = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (fields.length) {
    // Field names only: no token, claim values, request headers or draft data.
    console.warn(JSON.stringify({ event: "cms_runner_claim_mismatch", fields }));
    throw new HttpError(403, "執行器身分不符");
  }
}
export async function runner(
  request: Request,
  env: Env,
  key?: JWTVerifyGetKey,
) {
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new HttpError(401, "需要執行器驗證");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(
      token,
      key ||
        remoteKeys(
          new URL(
            "https://token.actions.githubusercontent.com/.well-known/jwks",
          ),
        ),
      {
        issuer: "https://token.actions.githubusercontent.com",
        audience: env.PUBLISHER_ORIGIN,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub"],
      },
    ));
  } catch {
    throw new HttpError(401, "執行器驗證失效");
  }
  enforceRunner(payload, env);
  return String(payload.run_id);
}
export function csrf(request: Request, origin: string, expected: string) {
  if (
    request.headers.get("Origin") !== origin ||
    request.headers.get("X-CSRF-Token") !== expected ||
    request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
  )
    throw new HttpError(403, "操作來源驗證失敗，請重新載入頁面");
}
export async function boundedJSON(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "缺少內容");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new HttpError(413, "內容超過 64 KB");
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let pos = 0;
    for (const c of chunks) {
      bytes.set(c, pos);
      pos += c.length;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "內容格式不正確");
  }
}
