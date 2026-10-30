import { HttpError } from "./security.ts";
import { fetchBoundedJSON, revisionURL, describeUpstream, UpstreamError } from "./bounded-fetch.ts";
import { validateHomeDraft, validateLatestFeed, type HomeDraft, type LatestFeedItem } from "./home-draft.ts";

// UTF-8 byte limits measured from current sources with headroom
// (2026-10: achievements-public 1,376,979; home-case-options 261,813; latest-info ~40KB).
export const CASE_SOURCE_MAX_BYTES = 2_000_000;
export const CASE_OPTIONS_MAX_BYTES = 400_000;
export const HOME_SOURCE_MAX_BYTES = 20_000;
export const LATEST_FEED_MAX_BYTES = 600_000;

type Options = { fetcher?: typeof fetch; timeoutMs?: number };

export type HomeSources = {
  home: HomeDraft; cases: Array<Record<string, unknown>>; revision: string;
  latest: { revision: string; items: LatestFeedItem[] } | null;
  latestStatus: "ready" | "not-synced" | "unavailable" | "inconsistent";
};

/** Every homepage editor source is read from the one committed revision recorded for index.html. */
export async function loadHomeSources(commit: string, options: Options = {}): Promise<HomeSources> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new HttpError(502, "首頁來源版本不正確");
  const read = (path: string, max: number, label: string) => fetchBoundedJSON(revisionURL(commit, path), max, label, options);
  const [homeResult, casesResult, latestResult] = await Promise.allSettled([
    read("data/civic-home.json", HOME_SOURCE_MAX_BYTES, "首頁設定"),
    read("data/home-case-options.json", CASE_OPTIONS_MAX_BYTES, "首頁專題選項"),
    read("data/latest-info.json", LATEST_FEED_MAX_BYTES, "最新資訊清單"),
  ]);
  for (const result of [homeResult, casesResult]) {
    if (result.status === "fulfilled") continue;
    const error = result.reason;
    if (error instanceof UpstreamError && error.kind === "missing")
      throw new HttpError(503, `網站來源尚未同步到新版（${error.label}不在此版本），請稍後再試；目前草稿已保留。`);
    if (error instanceof UpstreamError) throw new HttpError(502, `首頁來源暫時無法載入：${describeUpstream(error)}`);
    throw error;
  }
  let home: HomeDraft;
  try { home = validateHomeDraft((homeResult as PromiseFulfilledResult<unknown>).value); }
  catch { throw new HttpError(502, "首頁設定格式不正確"); }
  const cases = (casesResult as PromiseFulfilledResult<unknown>).value;
  if (!Array.isArray(cases) || cases.length > 2000 ||
      cases.some(row => !row || typeof row !== "object" || typeof (row as Record<string, unknown>).id !== "string" ||
        typeof (row as Record<string, unknown>).title !== "string"))
    throw new HttpError(502, "首頁專題選項格式不正確");
  const ids = new Set(cases.map(row => (row as Record<string, unknown>).id));
  if ([home.featured, ...home.reading].some(id => !ids.has(id))) throw new HttpError(502, "首頁專題與公開資料不一致");
  home = { ...home, latestPinned: home.latestPinned ?? [] };
  // A missing or invalid feed only disables the pin controls; existing pins are kept.
  let latest: HomeSources["latest"] = null;
  let latestStatus: HomeSources["latestStatus"] = "ready";
  if (latestResult.status === "rejected") {
    const error = latestResult.reason;
    latestStatus = error instanceof UpstreamError && error.kind === "missing" ? "not-synced" : "unavailable";
  } else {
    try {
      const items = validateLatestFeed(latestResult.value);
      if (home.latestPinned!.every(id => items.some(item => item.id === id))) latest = { revision: commit, items };
      else latestStatus = "inconsistent";
    } catch { latestStatus = "unavailable"; }
  }
  return { home, cases: cases as Array<Record<string, unknown>>, latest, latestStatus, revision: commit };
}

/** One full public record from the page's committed revision (bounded by measured bytes). */
export async function loadCaseRecord(commit: string, id: string, options: Options = {}) {
  let rows: unknown;
  try {
    rows = await fetchBoundedJSON(revisionURL(commit, "data/achievements-public.json"), CASE_SOURCE_MAX_BYTES, "政績資料", options);
  } catch (error) {
    if (error instanceof UpstreamError) throw new HttpError(error.kind === "missing" ? 503 : 502, describeUpstream(error));
    throw error;
  }
  if (!Array.isArray(rows)) throw new HttpError(502, "政績資料：格式不正確");
  const row = rows.find((item) => item?.id === id);
  if (!row) throw new HttpError(404, "找不到這筆政績資料");
  return row as Record<string, unknown>;
}

export const FEED_PAGE = /^page-(?:news|press|daily)-[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
export const PINNED_UNPUBLISH_MESSAGE = "這則專頁目前在首頁「最新資訊」置頂。請先到首頁取消置頂並發布，再下架或刪除這則專頁。";

/** Published latest pins at a revision; null when the source cannot be read (the publisher re-checks). */
export async function loadPublishedPins(commit: string, options: Options = {}): Promise<string[] | null> {
  try {
    const home = validateHomeDraft(await fetchBoundedJSON(revisionURL(commit, "data/civic-home.json"), HOME_SOURCE_MAX_BYTES, "首頁設定", options));
    return home.latestPinned ?? [];
  } catch { return null; }
}

/** Small committed CMS sources (editorial pages, page states) keep their original 1MB byte limit. */
export const PAGE_SOURCE_MAX_BYTES = 1_000_000;
export async function readCommittedJSON(commit: string, path: string, label: string, options: Options = {}) {
  try {
    return await fetchBoundedJSON(revisionURL(commit, path), PAGE_SOURCE_MAX_BYTES, label, options);
  } catch (error) {
    if (error instanceof UpstreamError) throw new HttpError(error.kind === "missing" ? 503 : 502, describeUpstream(error));
    throw error;
  }
}
