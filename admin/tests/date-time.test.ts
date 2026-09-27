import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Normalizers = Record<"day" | "month" | "time" | "dateTime" | "period", (value: string) => string>;
const context: { HuiwenDateTime?: Normalizers } = {};
runInNewContext(readFileSync(new URL("../public/date-time.js", import.meta.url), "utf8"), context);
const normalize = context.HuiwenDateTime!;

test("compact CMS dates, months, periods, and Taiwan local times normalize consistently", () => {
  assert.equal(normalize.day("20230621"), "2023-06-21");
  assert.equal(normalize.day("2023/6/21"), "2023-06-21");
  assert.equal(normalize.month("202306"), "2023-06");
  assert.equal(normalize.period("20230621"), "2023-06-21");
  assert.equal(normalize.period("202306"), "2023-06");
  assert.equal(normalize.period("2023"), "2023");
  assert.equal(normalize.period("第4屆第6次定期大會"), "第4屆第6次定期大會");
  assert.equal(normalize.time("930"), "09:30");
  assert.equal(normalize.time("1930"), "19:30");
  assert.equal(normalize.time("9.3"), "09:03");
  assert.equal(normalize.dateTime("202306211930"), "2023-06-21T19:30");
  assert.equal(normalize.dateTime("2023-06-21 9:30"), "2023-06-21T09:30");
});

test("invalid calendar dates and clock values remain visible for validation", () => {
  assert.equal(normalize.day("20230230"), "20230230");
  assert.equal(normalize.day("2023-02-30"), "2023-02-30");
  assert.equal(normalize.month("202313"), "202313");
  assert.equal(normalize.time("2460"), "2460");
  assert.equal(normalize.dateTime("202302301930"), "202302301930");
  assert.equal(normalize.dateTime("2023-02-30 19:30"), "2023-02-30 19:30");
  assert.equal(normalize.day("20240229"), "2024-02-29");
  assert.equal(normalize.day("20230229"), "20230229");
});
