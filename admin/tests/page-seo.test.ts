import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePageSeo } from "../src/page-seo.ts";

const inherited = {
  title: "正式標題",
  description: "正式說明",
  image: "https://www.huiwen.tw/assets/site-share-20260909.png",
  imageAlt: "正式分享圖",
};

test("blank SEO fields inherit the current published values", () => {
  assert.deepEqual(validatePageSeo({ title:"", description:" ", image:"", imageAlt:"" }, "seo", inherited), inherited);
});

test("blank SEO fields fail only when no fallback exists, while unsafe values stay rejected", () => {
  assert.throws(() => validatePageSeo({ title:"", description:"", image:"", imageAlt:"" }), /可沿用/);
  assert.throws(() => validatePageSeo({ ...inherited, title:"<script>" }, "seo", inherited));
});
