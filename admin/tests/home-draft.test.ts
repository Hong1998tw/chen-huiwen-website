import assert from "node:assert/strict";
import { test } from "node:test";
import { validateHomeDraft } from "../src/home-draft.ts";

const home = { featured: "a", reading: ["b", "c", "d"], summaries: { a: "甲", b: "乙", c: "丙", d: "丁" } };

test("homepage order keeps four unique stories and their existing summaries", () => {
  assert.deepEqual(validateHomeDraft(home), home);
  assert.throws(() => validateHomeDraft({ ...home, reading: ["a", "c", "d"] }));
  assert.throws(() => validateHomeDraft({ ...home, reading: ["b", "c"] }));
  assert.throws(() => validateHomeDraft({ ...home, summaries: { ...home.summaries, b: "<script>bad</script>" } }));
});
