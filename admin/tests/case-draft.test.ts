import assert from "node:assert/strict";
import test from "node:test";
import { validateCaseDraft } from "../src/case-draft.ts";

const base = (): any => ({
  title: "和興里公共自行車站", summary: "公開辦理紀錄", updated: "2026-09-13",
  paragraphs: [], history: [], sources: [{ title: "高雄市政府公告", url: "https://www.kcg.gov.tw/News_Content.aspx?n=1&s=2", sourceDate: "2026" }],
  media: [], imageMetadata: {},
});

test("case draft allows optional empty sections and historical year-only dates", () => {
  const draft = base();
  draft.history.push({ date: "2026", title: "列入追蹤", text: "持續核對公開進度" });
  assert.equal(validateCaseDraft(draft).history[0].date, "2026");
});

test("media import requires a supported public link, credit and explicit access confirmation", () => {
  const draft = base();
  draft.media.push({ kind: "video", url: "https://drive.google.com/file/d/1234567890abcdef/view", alt: "會勘影片", caption: "現場紀錄", credit: "陳慧文服務處", publicAccessConfirmed: true });
  assert.equal(validateCaseDraft(draft).media.length, 1);
  draft.media[0].publicAccessConfirmed = false;
  assert.throws(() => validateCaseDraft(draft));
  draft.media[0].publicAccessConfirmed = true;
  draft.media[0].url = "https://127.0.0.1/photo.jpg";
  assert.throws(() => validateCaseDraft(draft));
});

test("source URL and date edits reject private documents and invented invalid dates", () => {
  const draft = base();
  draft.sources[0].url = "https://drive.google.com/file/d/1234567890abcdef/view";
  assert.throws(() => validateCaseDraft(draft));
  draft.sources[0].url = "https://www.kcg.gov.tw/News_Content.aspx?n=1&s=2";
  draft.sources[0].sourceDate = "2026-02-31";
  assert.throws(() => validateCaseDraft(draft));
});
