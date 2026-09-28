import assert from "node:assert/strict";
import { test } from "node:test";
import { validateHomeDraft } from "../src/home-draft.ts";

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
