// Bounded reads of committed source files. Sizes are UTF-8 bytes on the wire after any
// transfer decoding, counted while streaming; headers can only reject early, never admit.
export type UpstreamFailure = "network" | "timeout" | "missing" | "rate-limited" | "server" | "status" | "too-large" | "format";

export class UpstreamError extends Error {
  readonly kind: UpstreamFailure;
  readonly label: string;
  readonly status?: number;
  constructor(kind: UpstreamFailure, label: string, status?: number) {
    super(`${label}:${kind}${status ? `:${status}` : ""}`);
    this.kind = kind; this.label = label; this.status = status;
  }
}

export const RAW_SOURCE = "https://raw.githubusercontent.com/Hong1998tw/chen-huiwen-website";

export function revisionURL(commit: string, path: string) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^(?:data|island)\/[a-z0-9-]+\.json$/.test(path))
    throw new UpstreamError("format", path);
  return `${RAW_SOURCE}/${commit}/${path}`;
}

export async function fetchBoundedText(url: string, maxBytes: number, label: string,
  { timeoutMs = 10000, fetcher = fetch }: { timeoutMs?: number; fetcher?: typeof fetch } = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    throw new UpstreamError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", label);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const kind: UpstreamFailure = response.status === 404 ? "missing" : response.status === 429 ? "rate-limited"
      : response.status >= 500 ? "server" : "status";
    throw new UpstreamError(kind, label, response.status);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError("too-large", label);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError("too-large", label);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const name = (error as { name?: string })?.name;
    throw new UpstreamError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", label);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UpstreamError("format", label);
  }
}

export async function fetchBoundedJSON(url: string, maxBytes: number, label: string,
  options?: { timeoutMs?: number; fetcher?: typeof fetch }): Promise<unknown> {
  const text = await fetchBoundedText(url, maxBytes, label, options);
  try { return JSON.parse(text); } catch { throw new UpstreamError("format", label); }
}

const KIND_TEXT: Record<UpstreamFailure, string> = {
  network: "無法連線", timeout: "讀取逾時", missing: "此版本尚無這個來源檔", "rate-limited": "來源暫時限制讀取（HTTP 429）",
  server: "來源伺服器暫時錯誤", status: "來源回應異常", "too-large": "超出大小限制", format: "格式不正確",
};

/** Plain-language diagnostic with the failing source and status, never a URL or secret. */
export function describeUpstream(error: UpstreamError) {
  return `${error.label}：${KIND_TEXT[error.kind]}${error.status && error.kind !== "rate-limited" ? `（HTTP ${error.status}）` : ""}`;
}
