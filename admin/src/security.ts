import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
      key ||
        createRemoteJWKSet(new URL("/cdn-cgi/access/certs", env.ACCESS_ISSUER)),
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
        createRemoteJWKSet(
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
