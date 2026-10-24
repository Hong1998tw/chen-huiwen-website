import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BOARD_PURGE_AT,
  DEFAULT_NICKNAME,
  REASONS,
  RuleError,
  charCount,
  cleanText,
  displayNickname,
  findViolation,
  isPurged,
  rateLimitKey,
  validTurnstileToken,
  validateNote,
} from "../src/rules.js";

const code = (text) => findViolation(cleanText(text))?.code ?? null;
const rejects = (input, expectedCode) => {
  assert.throws(() => validateNote(input), (error) => {
    assert.ok(error instanceof RuleError, "must be a RuleError");
    assert.equal(error.code, expectedCode, `${JSON.stringify(input)} → ${error.code}`);
    assert.match(error.message, /[一-鿿]/, "reason must be Chinese");
    return true;
  });
};

test("合法留言：整理空白、暱稱可留空", () => {
  assert.deepEqual(validateNote({ body: "  謝謝慧文議員\n\n幫忙修好路燈！ " }), { nickname: "", body: "謝謝慧文議員 幫忙修好路燈！" });
  assert.deepEqual(validateNote({ nickname: " 阿明 ", body: "加油" }), { nickname: "阿明", body: "加油" });
  assert.deepEqual(validateNote({ nickname: null, body: "加油" }), { nickname: "", body: "加油" });
  assert.equal(displayNickname(""), DEFAULT_NICKNAME);
  assert.equal(displayNickname("  "), "鳳山鄉親");
  assert.equal(displayNickname("阿明"), "阿明");
});

test("長度：內文 1–80 字、暱稱 ≤10 字（以碼位計，與 SQLite length() 一致）", () => {
  rejects({ body: "" }, "body_empty");
  rejects({ body: "   \n\t " }, "body_empty");
  rejects({ body: "​‎" }, "body_empty");
  assert.equal(validateNote({ body: "好".repeat(80) }).body.length, 80);
  rejects({ body: "好".repeat(81) }, "body_too_long");
  assert.equal(validateNote({ body: "👍".repeat(80) }).body, "👍".repeat(80));
  rejects({ body: "👍".repeat(81) }, "body_too_long");
  assert.equal(validateNote({ nickname: "鳳山區五甲老鄰居阿伯", body: "加油" }).nickname.length, 10);
  rejects({ nickname: "鳳山區五甲老鄰居阿伯呀", body: "加油" }, "nickname_too_long");
  assert.equal(charCount("鳳山區五甲老鄰居阿伯"), 10);
});

test("格式錯誤：非物件、非字串", () => {
  for (const input of [null, "字串", [], 3]) rejects(input, "invalid");
  rejects({ body: 3 }, "invalid");
  rejects({ body: "好", nickname: 7 }, "invalid");
});

test("不可見與雙向控制字元會被移除，無法拿來規避過濾", () => {
  assert.equal(cleanText("加​油‮"), "加油");
  assert.equal(code("0​9​1​2​3​4​5​6​7​8"), "phone");
});

test("網址與通訊軟體帳號", () => {
  for (const text of [
    "看這裡 https://example.com",
    "http:/bad",
    "www.example.org",
    "請上 huiwen.tw 看",
    "連結 bit.ly/abc",
    "ｈｔｔｐｓ://全形網址",
    "我的 line id: abc123",
    "加賴：myid88",
    "加line @shop99",
    "追蹤我 @someone_ig",
    "加我line abc123",
    "line id abc123",
    "賴 abc123",
    "bit .ly/abc",
    "bit。ly/x",
    "google。com",
    "example點com",
  ]) assert.equal(code(text), "link", text);
});

test("電子郵件", () => {
  for (const text of ["寄到 someone@gmail.com", "someone ＠ gmail . com", "abc(at)example", "test at gmail dot com"]) assert.equal(code(text), "email", text);
});

test("電話：手機、市話、國際碼、拆開寫、國字、全形", () => {
  for (const text of [
    "0912345678",
    "0912-345-678",
    "0912 345 678",
    "+886 912 345 678",
    "886912345678",
    "(07)746-1234",
    "07-7461234",
    "02-2345-6789",
    "049-2345678",
    "0836-22222",
    "打 746-1234 找我",
    "０９１２３４５６７８",
    "零九一二三四五六七八",
    "0 9 1 2 3 4 5 6 7 8",
    "09一二345678",
    "0912345678元",
  ]) assert.equal(code(text), "phone", text);
});

test("身分證、居留證", () => {
  for (const text of ["A123456789", "a 123-456-789", "我的證號Ｆ２２３４５６７８９", "AB12345678"]) assert.equal(code(text), "national_id", text);
});

test("門牌地址（…號）", () => {
  for (const text of [
    "我住中山路123號",
    "光遠路一段45號",
    "五甲二路 100 巷 3 弄 5 號",
    "家在 88 巷 6 號",
    "建國路三段四百號",
    "12號之3",
    "35號5樓",
    "自強一路 12-1 號",
    "光復里 4 鄰 7 號",
    "五甲里3號",
  ]) assert.equal(code(text), "address", text);
});

test("不雅字詞", () => {
  for (const text of ["幹你娘", "幹 你 娘", "幹，你，娘", "靠北喔", "雞掰", "白痴", "智障", "fuck you", "FUCKING", "what the shit", "恁老師", "f u c k", "f.u.c.k you"])
    assert.equal(code(text), "profanity", text);
});

test("正常用語不可誤擋（日期、號次、地名、常見詞）", () => {
  for (const text of [
    "11月28號投票給慧文！",
    "支持3號陳慧文",
    "一路支持3號",
    "捷運鳳山站1號出口的人行道好走多了",
    "2026-11-28 一起去投票",
    "2026/11/28 投票",
    "20261128",
    "爭取 3,000,000 元經費",
    "等了三小時終於修好",
    "實幹的議員、能幹的團隊",
    "垃圾車時間改了很方便",
    "做體操他也來了",
    "林老師的班很棒",
    "停車場靠北邊入口",
    "手機八點才有訊號",
    "過去死角很多，現在亮了",
    "push it",
    "光遠路的路燈修好了",
    "五甲二路 100 巷路面很平",
    "第 2 號議題",
    "鳳山區",
    "😀👍 加油",
    "Hello 慧文",
    "I love Fengshan",
    "3.5 公里自行車道",
    "2026-11-28 8點投票",
    "全部 10000000 元",
    "爭取 12000000 萬元",
    "早上8點在鳳山區公所集合",
    "a b c 三個選項",
    "line 很好用",
    "賴清德也來了",
    "晚上十點 com 到",
  ]) assert.equal(code(text), null, text);
});

test("違規原因是清楚的中文，且標出欄位", () => {
  try {
    validateNote({ nickname: "0912345678", body: "加油" });
    assert.fail("should throw");
  } catch (error) {
    assert.equal(error.field, "nickname");
    assert.equal(error.message, REASONS.phone);
  }
  try {
    validateNote({ body: "我住中山路123號" });
    assert.fail("should throw");
  } catch (error) {
    assert.equal(error.field, "body");
    assert.equal(error.message, REASONS.address);
  }
});

test("保存期限：2026-12-28 00:00 台北時間起", () => {
  assert.equal(BOARD_PURGE_AT, "2026-12-27T16:00:00.000Z");
  assert.equal(isPurged(Date.parse("2026-12-27T15:59:59.999Z")), false);
  assert.equal(isPurged(Date.parse("2026-12-28T00:00:00+08:00")), true);
  const adminSource = readFileSync(new URL("../../admin/src/board.ts", import.meta.url), "utf8");
  assert.match(adminSource, new RegExp(`BOARD_PURGE_AT = "${BOARD_PURGE_AT.replaceAll(".", "\\.")}"`),
    "CMS 後台與公開 API 的刪除時間必須相同");
});

test("Turnstile token 與限流 IP 鍵", () => {
  assert.equal(validTurnstileToken("abc.DEF_123-xyz"), true);
  assert.equal(validTurnstileToken(""), false);
  assert.equal(validTurnstileToken("a b"), false);
  assert.equal(validTurnstileToken("x".repeat(2049)), false);
  assert.equal(validTurnstileToken(undefined), false);
  assert.equal(rateLimitKey("203.0.113.7"), "203.0.113.7");
  assert.equal(rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(rateLimitKey("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  assert.equal(rateLimitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rateLimitKey(""), "unknown");
  assert.equal(rateLimitKey("::ffff:1.2.3.4"), "1.2.3.4", "IPv4-mapped IPv6 uses the embedded IPv4");
  assert.equal(rateLimitKey("0:0:0:0:0:ffff:5.6.7.8"), "5.6.7.8");
  assert.notEqual(rateLimitKey("::ffff:1.2.3.4"), rateLimitKey("::ffff:9.9.9.9"));
});
