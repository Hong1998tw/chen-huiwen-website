import assert from "node:assert/strict";
import { test } from "node:test";
import { validateHomeDraft, validateLatestFeed } from "../src/home-draft.ts";

const home = { featured: "a", reading: ["b", "c", "d"], summaries: { a: "甲", b: "乙", c: "丙", d: "丁" } };

test("homepage selection keeps a featured story, public reading slots and matching summaries", () => {
  assert.deepEqual(validateHomeDraft(home), home);
  assert.throws(() => validateHomeDraft({ ...home, reading: ["a", "c", "d"] }));
  assert.deepEqual(validateHomeDraft({ featured: "a", reading: ["b"], summaries: { a: "甲", b: "乙" } }).reading, ["b"]);
  assert.throws(() => validateHomeDraft({ ...home, reading: [] }));
  assert.throws(() => validateHomeDraft({ ...home, reading: Array.from({length: 13}, (_, i) => `r${i}`) }));
  assert.throws(() => validateHomeDraft({ ...home, reading: ["b", "c", "e"] }));
  assert.throws(() => validateHomeDraft({ ...home, summaries: { ...home.summaries, b: "<script>bad</script>" } }));
});

test("homepage card summaries may be blank and normalize to empty for the public fallback", () => {
  const result = validateHomeDraft({ ...home, summaries: { ...home.summaries, c: "  " } });
  assert.equal(result.summaries.c, "");
  assert.throws(() => validateHomeDraft({ ...home, summaries: { ...home.summaries, c: "<script>bad</script>" } }),
    error => error instanceof Error && (error as any).field === "home.summaries.c");
});

test("latest pins are optional, explicit, unique and limited to three", () => {
  // Older drafts without the key stay distinguishable from an explicit clear.
  assert.equal("latestPinned" in validateHomeDraft(home), false);
  assert.deepEqual(validateHomeDraft({ ...home, latestPinned: [] }).latestPinned, []);
  assert.deepEqual(validateHomeDraft({ ...home, latestPinned: ["event-x", "media-20260909-1f376635"] }).latestPinned,
    ["event-x", "media-20260909-1f376635"]);
  for (const latestPinned of [["a", "a"], ["a", "b", "c", "d"], ["Bad Id"], "a", [1]])
    assert.throws(() => validateHomeDraft({ ...home, latestPinned }), error => (error as any).field === "home.latestPinned");
  assert.throws(() => validateHomeDraft({ ...home, extra: [] }));
});

test("latest feed for pin choices is validated and kept in published order", () => {
  const feed = { schemaVersion: 1, items: [
    { id: "b", type: "news", kind: "媒體報導", title: "二", publishedAt: "2026-09-01", dateLabel: "報導日期", eventStart: null, naturalIndex: 1, url: "news.html" },
    { id: "a", type: "activity", kind: "公開活動", title: "一", publishedAt: "2026-10-02T04:00+08:00", dateLabel: "活動時間", eventStart: "2026-10-31T15:50:00+08:00", naturalIndex: 0, url: "event-a.html" },
  ] };
  assert.deepEqual(validateLatestFeed(feed).map(item => item.id), ["a", "b"]);
  assert.throws(() => validateLatestFeed({ ...feed, schemaVersion: 2 }));
  assert.throws(() => validateLatestFeed({ ...feed, items: [feed.items[0], feed.items[0]] }));
  assert.throws(() => validateLatestFeed({ ...feed, items: [{ ...feed.items[0], type: "secret" }] }));
});
