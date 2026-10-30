import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fetchBoundedText, UpstreamError } from "../src/bounded-fetch.ts";
import { loadHomeSources, loadCaseRecord, CASE_SOURCE_MAX_BYTES, CASE_OPTIONS_MAX_BYTES, LATEST_FEED_MAX_BYTES, HOME_SOURCE_MAX_BYTES } from "../src/home-sources.ts";

const repo = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, repo));
const [cases, options, civic, latest, pageContent] = await Promise.all([
  read("data/achievements-public.json"), read("data/home-case-options.json"), read("data/civic-home.json"), read("data/latest-info.json"), read("data/page-content.json"),
]);
const SHA = "a".repeat(40), OTHER = "b".repeat(40);
const files: Record<string, Uint8Array> = {
  "data/achievements-public.json": cases, "data/home-case-options.json": options,
  "data/civic-home.json": civic, "data/latest-info.json": latest, "data/page-content.json": pageContent,
};

type Behaviour = { status?: number; headers?: Record<string, string>; chunk?: number; body?: Uint8Array; throws?: string };
function streamOf(bytes: Uint8Array, chunk = 65536) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += chunk));
    },
  });
}
function fakeFetch(overrides: Record<string, Behaviour> = {}, seen: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const match = /^https:\/\/raw\.githubusercontent\.com\/Hong1998tw\/chen-huiwen-website\/([a-f0-9]{40})\/(.+)$/.exec(url);
    if (!match) throw new Error("unexpected upstream " + url);
    const [, commit, path] = match;
    const behaviour = overrides[path] ?? {};
    if (behaviour.throws) { const error = new Error(behaviour.throws); error.name = behaviour.throws; throw error; }
    if (commit !== SHA) return new Response("missing", { status: 404 });
    const body = behaviour.body ?? files[path];
    if (!body) return new Response("missing", { status: 404 });
    return new Response(streamOf(body, behaviour.chunk), { status: behaviour.status ?? 200, headers: behaviour.headers ?? {} });
  }) as typeof fetch;
}

test("real source sizes fit the measured limits with headroom", () => {
  assert.ok(cases.byteLength > 1_000_000, "the full public record file exceeds the old 1MB header guard");
  assert.ok(cases.byteLength < CASE_SOURCE_MAX_BYTES * 0.75, `cases ${cases.byteLength}`);
  assert.ok(options.byteLength < CASE_OPTIONS_MAX_BYTES * 0.75, `options ${options.byteLength}`);
  assert.ok(latest.byteLength < LATEST_FEED_MAX_BYTES * 0.25, `latest ${latest.byteLength}`);
  assert.ok(civic.byteLength < HOME_SOURCE_MAX_BYTES / 4, `civic ${civic.byteLength}`);
});

test("homepage sources load from one revision with the complete 435-record option set", async () => {
  const seen: string[] = [];
  // The old live failure: a full uncompressed 1.38MB body with an honest content-length.
  const result = await loadHomeSources(SHA, { fetcher: fakeFetch({}, seen) });
  const full = JSON.parse(new TextDecoder().decode(cases)) as Array<{ id: string }>;
  assert.equal(result.cases.length, 435);
  assert.deepEqual(result.cases.map(row => row.id), full.map(row => row.id));
  for (const row of result.cases)
    assert.deepEqual(Object.keys(row).filter(key => !["id", "title", "summary", "status", "villages", "scope", "categories", "funding", "updated"].includes(key)), []);
  assert.equal(result.revision, SHA);
  assert.equal(result.latest?.revision, SHA);
  assert.equal(result.latest?.items.length, 47);
  assert.equal(result.latestStatus, "ready");
  assert.deepEqual(result.home.latestPinned, []);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(url => url.includes(`/${SHA}/`)), "every source URL uses the same revision");
  assert.ok(!seen.some(url => url.includes("www.huiwen.tw")), "no read from the deployed site");
});

test("missing new projection at an older revision reports not-synced instead of falling back", async () => {
  const seen: string[] = [];
  await assert.rejects(loadHomeSources(OTHER, { fetcher: fakeFetch({}, seen) }),
    (error: any) => error.status === 503 && /尚未同步/.test(error.message));
  assert.ok(seen.every(url => url.includes(`/${OTHER}/`)));
  const noFeed = await loadHomeSources(SHA, { fetcher: fakeFetch({ "data/latest-info.json": { status: 404 } }) });
  assert.equal(noFeed.latest, null);
  assert.equal(noFeed.latestStatus, "not-synced");
  assert.equal(noFeed.cases.length, 435, "home story editing still works without the feed");
});

test("each upstream failure is identified without a generic message", async () => {
  for (const [path, label] of [["data/civic-home.json", "首頁設定"], ["data/home-case-options.json", "首頁專題選項"]]) {
    for (const [behaviour, pattern] of [
      [{ status: 429 }, /429/], [{ status: 500 }, /伺服器暫時錯誤（HTTP 500）/], [{ status: 503 }, /HTTP 503/],
      [{ throws: "TimeoutError" }, /逾時/], [{ throws: "TypeError" }, /無法連線/], [{ status: 404 }, /尚未同步/],
    ] as Array<[Behaviour, RegExp]>) {
      await assert.rejects(loadHomeSources(SHA, { fetcher: fakeFetch({ [path]: behaviour }) }),
        (error: any) => error.status >= 500 && error.message.includes(label) && pattern.test(error.message), `${path} ${JSON.stringify(behaviour)}`);
    }
  }
  for (const behaviour of [{ status: 429 }, { status: 500 }, { throws: "TimeoutError" }] as Behaviour[]) {
    const result = await loadHomeSources(SHA, { fetcher: fakeFetch({ "data/latest-info.json": behaviour }) });
    assert.equal(result.latest, null);
    assert.equal(result.latestStatus, "unavailable");
  }
});

test("byte limits use streamed UTF-8 bytes regardless of headers", async () => {
  const big = new Uint8Array(CASE_OPTIONS_MAX_BYTES + 1).fill(0x20);
  for (const headers of [{}, { "content-length": "10" }, { "transfer-encoding": "chunked" }]) {
    await assert.rejects(loadHomeSources(SHA, { fetcher: fakeFetch({ "data/home-case-options.json": { body: big, headers, chunk: 4096 } }) }),
      (error: any) => /超出大小限制/.test(error.message), JSON.stringify(headers));
  }
  await assert.rejects(loadHomeSources(SHA, { fetcher: fakeFetch({ "data/home-case-options.json": { headers: { "content-length": String(CASE_OPTIONS_MAX_BYTES + 1) } } }) }),
    (error: any) => /超出大小限制/.test(error.message));
  // Multi-byte text is measured in bytes, not UTF-16 length.
  const chinese = new TextEncoder().encode("中".repeat(400));
  assert.equal(chinese.byteLength, 1200);
  await assert.rejects(fetchBoundedText("https://example.test/x", 1199, "測試", { fetcher: (async () => new Response(streamOf(chinese, 100))) as typeof fetch }),
    (error: any) => error instanceof UpstreamError && error.kind === "too-large");
  assert.equal((await fetchBoundedText("https://example.test/x", 1200, "測試", { fetcher: (async () => new Response(streamOf(chinese, 7))) as typeof fetch })).length, 400);
});

test("the oversize read is cancelled instead of buffered to the end", async () => {
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchBoundedText("https://example.test/x", 200_000, "測試", { fetcher: (async () => new Response(endless)) as typeof fetch }),
    (error: any) => error.kind === "too-large");
  assert.equal(cancelled, true);
  assert.ok(pulled < 10, `pulled ${pulled}`);
});

test("case editor reads the full real record from the page revision and keeps a bounded limit", async () => {
  const seen: string[] = [];
  const row = await loadCaseRecord(SHA, "wende-school-center", { fetcher: fakeFetch({}, seen) });
  assert.equal(row.id, "wende-school-center");
  assert.ok(Array.isArray(row.history));
  assert.deepEqual(seen, [`https://raw.githubusercontent.com/Hong1998tw/chen-huiwen-website/${SHA}/data/achievements-public.json`]);
  await assert.rejects(loadCaseRecord(SHA, "not-a-record", { fetcher: fakeFetch() }), (error: any) => error.status === 404);
  const tooBig = new Uint8Array(CASE_SOURCE_MAX_BYTES + 1).fill(0x20);
  await assert.rejects(loadCaseRecord(SHA, "wende-school-center", { fetcher: fakeFetch({ "data/achievements-public.json": { body: tooBig } }) }),
    (error: any) => error.status === 502 && /超出大小限制/.test(error.message));
  for (const [behaviour, status] of [[{ status: 404 }, 503], [{ status: 429 }, 502], [{ status: 502 }, 502], [{ throws: "TimeoutError" }, 502]] as Array<[Behaviour, number]>)
    await assert.rejects(loadCaseRecord(SHA, "wende-school-center", { fetcher: fakeFetch({ "data/achievements-public.json": behaviour }) }),
      (error: any) => error.status === status && error.message.startsWith("政績資料"));
});

test("published pins drive the two-step unpublish rule and unreadable sources defer to the publisher", async () => {
  const { loadPublishedPins, FEED_PAGE, PINNED_UNPUBLISH_MESSAGE, readCommittedJSON, PAGE_SOURCE_MAX_BYTES } = await import("../src/home-sources.ts");
  const pinned = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(civic)), latestPinned: ["page-daily-market"] }));
  assert.deepEqual(await loadPublishedPins(SHA, { fetcher: fakeFetch({ "data/civic-home.json": { body: pinned } }) }), ["page-daily-market"]);
  assert.deepEqual(await loadPublishedPins(SHA, { fetcher: fakeFetch() }), []);
  assert.equal(await loadPublishedPins(SHA, { fetcher: fakeFetch({ "data/civic-home.json": { status: 500 } }) }), null);
  assert.ok(FEED_PAGE.test("page-daily-market.html") && FEED_PAGE.test("page-news-a.html") && FEED_PAGE.test("page-press-b.html"));
  assert.ok(!FEED_PAGE.test("page-service-a.html") && !FEED_PAGE.test("index.html"));
  assert.match(PINNED_UNPUBLISH_MESSAGE, /先到首頁取消置頂/);
  const big = new Uint8Array(PAGE_SOURCE_MAX_BYTES + 1).fill(0x20);
  await assert.rejects(readCommittedJSON(SHA, "data/page-content.json", "頁面區塊來源", { fetcher: fakeFetch({ "data/page-content.json": { body: big, headers: { "content-length": "5" } } }) }),
    (error: any) => error.status === 502 && /頁面區塊來源：超出大小限制/.test(error.message));
  await assert.rejects(readCommittedJSON(OTHER, "data/page-content.json", "頁面區塊來源", { fetcher: fakeFetch() }), (error: any) => error.status === 503);
});
