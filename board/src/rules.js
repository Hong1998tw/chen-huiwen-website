// 布告欄共用規則：長度、內容過濾、保存期限、允許來源。
// 公開 API Worker（board/src/index.js）與單元測試共用；CMS 後台的保存期限常數另存於
// admin/src/board.ts，兩者由 board/test/rules.test.mjs 檢查必須一致。
// 純 ES module、無相依套件，可在 Workers 與 Node 直接執行。

export const BODY_MAX = 80;
export const NICKNAME_MAX = 10;
export const DEFAULT_NICKNAME = "鳳山鄉親";
export const RATE_LIMIT_MS = 10 * 60 * 1000;
export const PUBLIC_LIMIT = 60;
export const MAX_REQUEST_BYTES = 4096;
export const TURNSTILE_TOKEN_MAX = 2048;
/** 2026-11-28 投票日後 30 天：2026-12-28 00:00（台北時間）起全部刪除、停止收件。 */
export const BOARD_PURGE_AT = "2026-12-27T16:00:00.000Z";
/** 限流用的雜湊 IP 只保留 1 天，之後由排程清空。 */
export const IP_HASH_TTL_MS = 24 * 60 * 60 * 1000;
export const ALLOWED_ORIGINS = Object.freeze(["https://www.huiwen.tw", "http://localhost:8765"]);

export class RuleError extends Error {
  /** @param {string} code @param {string} message @param {string} [field] */
  constructor(code, message, field) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

export const REASONS = Object.freeze({
  bodyEmpty: "請寫下想說的話（1 到 80 個字）。",
  bodyTooLong: "留言最多 80 個字，請精簡後再送出。",
  nicknameTooLong: "暱稱最多 10 個字；不填會顯示「鳳山鄉親」。",
  link: "為了安全，留言不能包含網址、連結或通訊軟體帳號。",
  phone: "請不要留下電話號碼；需要聯絡請改用服務處專線。",
  nationalId: "請不要留下身分證字號或居留證號碼。",
  email: "請不要留下電子郵件地址。",
  address: "請不要留下門牌地址（○○路○○號）；可以只寫路名或地點。",
  profanity: "留言含有不雅字詞，請修改後再送出。",
  invalid: "留言格式不正確，請重新整理頁面後再試。",
});

// 不可見與雙向控制字元：一律移除（保留 U+200D 讓 emoji 組合字正常，但比對時也移除）。
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­​‌‎‏‪-‮⁠-⁤⁦-⁩﻿￹-￻]/g;
const ZWJ = /‍/g;

/** 計算字數（以 Unicode 碼位計，與 SQLite length() 一致）。 */
export const charCount = (value) => Array.from(String(value)).length;

/** 儲存前的整理：移除不可見字元、所有空白（含換行）壓成一個半形空格、去頭尾。 */
export function cleanText(value) {
  return String(value ?? "").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

/** 比對用字串：NFKC（全形轉半形）、移除 ZWJ、轉小寫。 */
function foldForMatch(value) {
  return value.normalize("NFKC").replace(ZWJ, "").toLowerCase();
}

const CN_NUM = "零〇一二三四五六七八九十百千兩";
const N = `[0-9${CN_NUM}]+`;

// 先比對電子郵件，再比對網址（否則 gmail.com 會被當成網址）。
const EMAIL_PATTERNS = [
  /[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)+/i,
  /[a-z0-9._%+-]+\s*[([]\s*(?:at|小老鼠)\s*[)\]]\s*[a-z0-9-]+/i,
];
const URL_PATTERNS = [
  /\b(?:https?|ftp):\/{0,2}/i,
  /\bwww\s*\./i,
  // 常見網域：英數字串 + 點 + 頂級網域（含 .tw 二層網域）
  /[a-z0-9-]+\.(?:com|net|org|tw|io|me|cc|co|ly|gl|gd|to|tv|app|xyz|info|biz|shop|top|link|site|online|club|vip|page|dev|ai|gov|edu|us|jp|hk|cn|so|im|gg|ee|be|ws|ink|live|news|store|tech|one|pro|art|fun|ltd|life|world)\b/i,
  // 通訊軟體帳號：LINE ID、加賴、@帳號
  /(?:\bline|賴)\s*(?:id)?\s*:\s*\S/i,
  /加\s*(?:line|賴|好友)\s*:?\s*@?[a-z0-9._-]{3,}/i,
  /(?:^|[^a-z0-9._%+-])@[a-z0-9._-]{4,}/i,
];
// 身分證／居留證：1 個英文字母 + 9 碼數字；舊式居留證為 2 個英文字母 + 8 碼數字。
const NATIONAL_ID_PATTERNS = [/[a-z][0-9]{9}/i, /[a-z][a-d][0-9]{8}/i];
// 門牌「…號」：只在像地址的情況才擋（路／街／大道後緊接數字，可含段、巷、弄、之），
// 避免誤擋「11月28號投票」「支持3號」「一路支持3號」等正常用語。
const ADDRESS_PATTERNS = [
  new RegExp(`(?:路|街|大道)\\s*(?:${N}\\s*段)?\\s*(?:${N}\\s*(?:巷|弄)\\s*)*${N}\\s*(?:[-之]\\s*${N}\\s*)?號`),
  new RegExp(`(?:巷|弄)\\s*${N}\\s*(?:[-之]\\s*${N}\\s*)?號`),
  new RegExp(`${N}\\s*號\\s*(?:之\\s*${N}|${N}\\s*樓)`),
];
// 小型不雅字詞表。中文詞同時在原字串與「移除空白、符號、標點」後的字串比對（擋「幹 你 娘」）；
// 刻意避開「幹部、實幹、能幹、垃圾車、垃圾人力、三小時、體操、林老師、靠北邊、手機八點、過去死角」等正常用語。
const PROFANITY_CJK = [
  /幹(?:你|妳|您|恁|拎|林)(?:娘|祖|媽|爸|老師|老母|老爸)/,
  /(?:操|肏)(?:你|妳|恁|他|她)(?:媽|娘|祖|老母)/,
  /(?:恁|拎)(?:娘|老母|老師|祖媽)/,
  /你娘(?:咧|勒|啦|卡好|的)/,
  /靠北(?!邊|側|方|面|上|門|端|岸|區|部)|靠杯|靠腰(?!部|帶|間)/,
  /雞掰|機掰(?!掰)|雞歪|雞巴/,
  /三小(?!時|段|節|組|項|塊|朋友|孩|學|姐|姊|兒|吃|店)/,
  /白癡|白痴|智障|腦殘|(?<![台臺])北七|王八蛋|賤人|婊子|死全家|人渣/,
];
// 英文只比對原字串並要求字界，避免「push it」被壓成「pushit」誤判。
const PROFANITY_LATIN = /\b(?:f+u+c+k\w*|sh[i1!]t+|b[i1!]tch\w*|asshole|wtf|stfu|cunt)\b/i;

/**
 * 找出內容違規原因；沒有違規回傳 null。
 * @param {string} text 已經 cleanText() 的字串
 * @returns {null | {code: string, message: string}}
 */
export function findViolation(text) {
  const folded = foldForMatch(text);
  // 證號比對前移除空白與連字號（「A 123-456-789」）。
  const compact = folded.replace(/[\s\-–—]+/g, "");
  // 不雅字詞：移除所有空白、符號、標點（含全形），避免「幹 你 娘」「f.u.c.k」規避。
  const squashed = folded.replace(/[\s\p{P}\p{S}_]+/gu, "");

  if (EMAIL_PATTERNS.some((re) => re.test(folded))) return { code: "email", message: REASONS.email };
  if (URL_PATTERNS.some((re) => re.test(folded))) return { code: "link", message: REASONS.link };
  if (NATIONAL_ID_PATTERNS.some((re) => re.test(compact))) return { code: "national_id", message: REASONS.nationalId };
  if (isPhoneLike(folded)) return { code: "phone", message: REASONS.phone };
  if (ADDRESS_PATTERNS.some((re) => re.test(folded))) return { code: "address", message: REASONS.address };
  if (PROFANITY_LATIN.test(folded) || PROFANITY_CJK.some((re) => re.test(squashed) || re.test(folded)))
    return { code: "profanity", message: REASONS.profanity };
  return null;
}

const DATE_LIKE = /^(?:19|20)[0-9]{2}[\s\-–—./]*(?:0?[1-9]|1[0-2])[\s\-–—./]*(?:0?[1-9]|[12][0-9]|3[01])$/;
/**
 * 台灣手機（09xx、+886 9xx）、市話（0X、+886X，含 0836 等離島區碼）、
 * 不含區碼的市話（746-1234）與 7 碼以上的長串數字（含以空白、連字號、括號、句點拆開的寫法）。
 * 年月日（2026-11-28、2026/11/28）不算。
 * @param {string} folded NFKC 後的小寫字串
 */
export function isPhoneLike(folded) {
  for (const match of folded.matchAll(/\+?\(?[0-9][0-9\s\-–—().]*[0-9]|[0-9]/g)) {
    const raw = match[0].trim();
    if (DATE_LIKE.test(raw)) continue;
    const digits = raw.replace(/[^0-9]/g, "");
    if (/^(?:886|0)9[0-9]{8}$/.test(digits)) return true; // 手機
    if (/^(?:886|0)[2-8][0-9]{6,8}$/.test(digits)) return true; // 市話（含區碼）
    if (/(?:^|[^0-9])[0-9]{3,4}[\s\-–—.][0-9]{4}$/.test(raw)) return true; // 市話（不含區碼）
    if (digits.length >= 7) return true; // 任何可能是號碼的長串數字
  }
  // 國字數字逐位寫出的號碼（零九一二三四五六七八）
  if (/[零〇一二三四五六七八九]{7,}/.test(folded)) return true;
  return false;
}

/**
 * 驗證公開留言輸入。成功回傳整理後的 { nickname, body }，失敗丟出 RuleError。
 * @param {unknown} input
 */
export function validateNote(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RuleError("invalid", REASONS.invalid);
  const { nickname = "", body } = /** @type {Record<string, unknown>} */ (input);
  if (typeof body !== "string" || (nickname !== null && typeof nickname !== "string"))
    throw new RuleError("invalid", REASONS.invalid);
  const cleanBody = cleanText(body);
  const cleanNickname = cleanText(nickname ?? "");
  if (!cleanBody) throw new RuleError("body_empty", REASONS.bodyEmpty, "body");
  if (charCount(cleanBody) > BODY_MAX) throw new RuleError("body_too_long", REASONS.bodyTooLong, "body");
  if (charCount(cleanNickname) > NICKNAME_MAX) throw new RuleError("nickname_too_long", REASONS.nicknameTooLong, "nickname");
  for (const [field, value] of [["nickname", cleanNickname], ["body", cleanBody]]) {
    if (!value) continue;
    const violation = findViolation(value);
    if (violation) throw new RuleError(violation.code, violation.message, field);
  }
  return { nickname: cleanNickname, body: cleanBody };
}

/** 公開顯示用暱稱。 */
export const displayNickname = (nickname) => (typeof nickname === "string" && nickname.trim()) || DEFAULT_NICKNAME;

/** 是否已過保存期限（過期後停止收件、清單為空並刪除全部資料）。 */
export const isPurged = (now = Date.now()) => now >= Date.parse(BOARD_PURGE_AT);

/** Turnstile token：非空字串、長度上限、不可含空白或控制字元。 */
export function validTurnstileToken(token) {
  return typeof token === "string" && token.length > 0 && token.length <= TURNSTILE_TOKEN_MAX && !/[\s\u0000-\u001f\u007f]/.test(token);
}

/** 限流用 IP：IPv6 取 /64 前綴（隱私位址可在同一前綴內輪換），IPv4 原樣。 */
export function rateLimitKey(ip) {
  const value = String(ip || "").trim().toLowerCase();
  if (!value.includes(":")) return value || "unknown";
  const [head, tail = ""] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = value.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
