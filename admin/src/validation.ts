import { HttpError } from "./security.ts";
export const domains = ["events", "legal-schedule"] as const;
const eventKeys = [
  "name",
  "start",
  "end",
  "content",
  "registration",
  "sourceUrl",
  "verifiedAt",
  "status",
  "changeNote",
  "updatedAt",
  "reviewDueAt",
];
const legalKeys = [
  "month",
  "observedAt",
  "sourceUrl",
  "sourceTitle",
  "nextReviewAt",
  "sessions",
  "closedDates",
  "unconfirmedDates",
  "weekdayTimes",
];
export function validate(
  domain: string,
  value: unknown,
  options: { draft?: boolean } = {},
): Record<string, unknown> {
  if (
    !domains.includes(domain as (typeof domains)[number]) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new HttpError(400, "不支援的內容類型");
  const p = value as Record<string, unknown>;
  const keys = domain === "events" ? eventKeys : legalKeys;
  if (Object.keys(p).some((k) => !keys.includes(k)))
    throw new HttpError(400, "包含不允許修改的欄位");
  for (const [k, v] of Object.entries(p)) {
    if (["sessions", "closedDates", "unconfirmedDates", "weekdayTimes"].includes(k)) continue;
    if (v !== null && typeof v !== "string")
      throw new HttpError(400, `${k} 格式不正確`, `document.${k}`);
    if (
      typeof v === "string" &&
      (v.length > (k === "content" ? 4000 : 500) ||
        /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]|<\s*\/?[a-z!?]/i.test(
          v,
        ))
    )
      throw new HttpError(400, `${k} 含不允許的文字或長度`, `document.${k}`);
  }
  const requiredKeys = domain === "events"
    ? ["name", "start", "end", "sourceUrl", "verifiedAt", "status"]
    : ["month", "observedAt", "sourceUrl", "sessions"];
  for (const k of requiredKeys.filter((key) => key !== "sessions"))
    if (typeof p[k] !== "string" || !(p[k] as string).trim())
      throw new HttpError(400, `${k} 尚未填寫`, `document.${k}`);
  let url: URL;
  try {
    url = new URL(String(p.sourceUrl));
  } catch {
    throw new HttpError(400, "請填寫公開來源網址", "document.sourceUrl");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.includes(".") ||
    /^(\d+\.){3}\d+$/.test(url.hostname) ||
    url.hostname.includes(":") ||
    /(^|\.)(notion\.(so|site|com)|drive.google.com|docs.google.com|localhost)$/.test(
      url.hostname,
    ) ||
    /\.(local|internal|lan|localhost|home|corp)$/.test(url.hostname)
  )
    throw new HttpError(400, "來源必須是公開 HTTPS 網址", "document.sourceUrl");
  const day = (s: unknown) =>
    typeof s === "string" &&
    /^20\d\d-\d\d-\d\d$/.test(s) &&
    Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  const time = (s: unknown) =>
    typeof s === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (domain === "events") {
    for (const k of ["start", "end"]) {
      const match = String(p[k]).match(/^(20\d\d-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\+08:00$/);
      if (!match || !day(match[1]))
        throw new HttpError(400, "活動時間請使用台灣時間", `document.${k}`);
    }
    if (Date.parse(String(p.end)) <= Date.parse(String(p.start)))
      throw new HttpError(400, "結束時間必須晚於開始", "document.end");
    if (!["scheduled", "rescheduled", "cancelled"].includes(String(p.status)))
      throw new HttpError(400, "活動狀態不正確", "document.status");
    if (p.status !== "scheduled" && !p.changeNote)
      throw new HttpError(400, "改期或取消請填寫原因", "document.changeNote");
    for (const k of ["verifiedAt", "updatedAt", "reviewDueAt"])
      if (p[k] && !day(p[k])) throw new HttpError(400, `${k} 日期不正確`, `document.${k}`);
    if (p.status !== "scheduled" && !day(p.updatedAt))
      throw new HttpError(400, "改期或取消請填寫來源更新日", "document.updatedAt");
  } else {
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(String(p.month)))
      throw new HttpError(400, "月份不正確", "document.month");
    if (!day(p.observedAt)) throw new HttpError(400, "核對日期不正確", "document.observedAt");
    if (p.nextReviewAt && !day(p.nextReviewAt)) throw new HttpError(400, "下次核對日期不正確", "document.nextReviewAt");
    if (
      !Array.isArray(p.sessions) ||
      (!p.sessions.length && !options.draft && !Array.isArray(p.closedDates)) ||
      p.sessions.length > 31
    )
      throw new HttpError(400, "請填寫 1 至 31 個時段", "document.sessions");
    const dates = new Set();
    for (const [index, s] of p.sessions.entries()) {
      if (
        !s ||
        typeof s !== "object" ||
        Object.keys(s).some((k) => !["date", "start", "end", "lawyer"].includes(k)) ||
        !day(s.date) ||
        !s.date.startsWith(p.month) ||
        !time(s.start) ||
        !time(s.end) ||
        s.start >= s.end ||
        dates.has(s.date)
      )
        throw new HttpError(400, `第 ${index + 1} 個時段日期、時間或重複日期有誤`, "document.sessions");
      if (s.lawyer !== undefined && (typeof s.lawyer !== "string" || !s.lawyer.trim() || s.lawyer.length > 40 ||
          /[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(s.lawyer)))
        throw new HttpError(400, `第 ${index + 1} 個時段律師姓名不正確`, "document.sessions");
      dates.add(s.date);
    }
    if (p.weekdayTimes !== undefined) {
      const times=p.weekdayTimes;
      if (!times || typeof times!=="object" || Array.isArray(times) || Object.keys(times).sort().join(",")!=="2,3,4,5,6")
        throw new HttpError(400, "每週時段格式不正確", "document.sessions");
      for (const slot of Object.values(times)) {
        if (!slot || typeof slot!=="object" || Array.isArray(slot) || Object.keys(slot).sort().join(",")!=="end,start" || !time(slot.start) || !time(slot.end) || slot.start>=slot.end)
          throw new HttpError(400, "每週開始與結束時間不正確", "document.sessions");
      }
    }
    if (p.weekdayTimes && typeof p.weekdayTimes==="object" && !Array.isArray(p.weekdayTimes)) {
      const weekly=p.weekdayTimes as Record<string,{start:string;end:string}>;
      for(const slot of p.sessions){
        const weekday=String(new Date(slot.date+"T12:00:00Z").getUTCDay());
        if(!weekly[weekday] || slot.start!==weekly[weekday].start || slot.end!==weekly[weekday].end)
          throw new HttpError(400,"日期時段與該星期設定不一致","document.sessions");
      }
    }
    for (const field of ["closedDates", "unconfirmedDates"]) {
      if (p[field] === undefined) continue;
      const values=p[field];
      if (!Array.isArray(values) || values.length > 31 || values.some(d=>!day(d) || !d.startsWith(String(p.month))) ||
          new Set(values).size !== values.length || values.some(d=>dates.has(d)))
        throw new HttpError(400, "未排日與時段日期需分開，且在所選月份內", "document.sessions");
    }
    const closedDates = p.closedDates;
    if (Array.isArray(p.unconfirmedDates) && Array.isArray(closedDates) && p.unconfirmedDates.some(d=>closedDates.includes(d)))
      throw new HttpError(400, "日期不可同時待填與無場次", "document.sessions");
    if (!options.draft && Array.isArray(p.unconfirmedDates) && p.unconfirmedDates.length)
      throw new HttpError(400, "仍有日期待填；請選律師或無／停辦後再發布", "document.sessions");
    if (Array.isArray(p.closedDates)) {
      const [year,month]=String(p.month).split("-").map(Number), count=new Date(Date.UTC(year,month,0)).getUTCDate();
      const covered=new Set([...dates,...p.closedDates,...(options.draft && Array.isArray(p.unconfirmedDates)?p.unconfirmedDates:[])]);
      for(let d=1;d<=count;d++){
        const value=String(p.month)+"-"+String(d).padStart(2,"0"), weekday=new Date(value+"T12:00:00Z").getUTCDay();
        if(weekday>=2 && !covered.has(value))
          throw new HttpError(400, "請逐日確認週二至週六的輪值或無／停辦", "document.sessions");
      }
      if (!options.draft && p.sessions.some(s=>!s.lawyer))
        throw new HttpError(400, "請填寫每個時段的律師姓名", "document.sessions");
    }
    if (p.nextReviewAt && (
      String(p.nextReviewAt) < String(p.observedAt) ||
      !String(p.nextReviewAt).startsWith(String(p.month))
    ))
      throw new HttpError(400, "下次核對須在核對日之後且在該月份內", "document.nextReviewAt");
  }
  return p;
}

const pageFieldId = /^main(?:>[a-z][a-z0-9-]*:nth-of-type\([1-9]\d{0,2}\))*$/;
export function validatePageFields(value: unknown): Record<string, { sourceHash: string; value: string }> {
  if (!Array.isArray(value) || value.length > 250) throw new HttpError(400, "頁面編輯內容格式不正確");
  const fields: Record<string, { sourceHash: string; value: string }> = {};
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some((key) => !["id", "sourceHash", "value"].includes(key)) ||
        typeof item.id !== "string" || !pageFieldId.test(item.id) ||
        typeof item.sourceHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(`sha256:${item.sourceHash}`) ||
        typeof item.value !== "string" || item.value.length > 4000 ||
        /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(item.value))
      throw new HttpError(400, "頁面文字含不允許的欄位、標記或長度");
    if (fields[item.id]) throw new HttpError(400, "頁面文字欄位重複");
    fields[item.id] = { sourceHash: item.sourceHash, value: item.value.normalize("NFC") };
  }
  return fields;
}
