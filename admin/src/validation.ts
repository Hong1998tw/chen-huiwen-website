import { HttpError } from './security.ts';
export const domains=['events','legal-schedule'] as const;
const eventKeys=['name','start','end','content','registration','sourceUrl','verifiedAt','status','changeNote','updatedAt','reviewDueAt'];
const legalKeys=['month','observedAt','sourceUrl','sourceTitle','nextReviewAt','sessions'];
export function validate(domain: string, value: unknown): Record<string,unknown> {
 if (!domains.includes(domain as typeof domains[number]) || !value || typeof value!=='object' || Array.isArray(value)) throw new HttpError(400,'不支援的內容類型');
 const p=value as Record<string,unknown>;const keys=domain==='events'?eventKeys:legalKeys;
 if(Object.keys(p).some(k=>!keys.includes(k)))throw new HttpError(400,'包含不允許修改的欄位');
 for(const [k,v] of Object.entries(p)){if(k==='sessions')continue;if(v!==null&&typeof v!=='string')throw new HttpError(400,`${k} 格式不正確`);if(typeof v==='string'&&(v.length>(k==='content'?4000:500)||/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]|<\s*\/?[a-z!?]/i.test(v)))throw new HttpError(400,`${k} 含不允許的文字或長度`);}
 for(const k of keys.filter(k=>!['changeNote','sessions'].includes(k)))if(typeof p[k]!=='string'||!(p[k] as string).trim())throw new HttpError(400,`${k} 尚未填寫`);
 let url:URL;try{url=new URL(String(p.sourceUrl));}catch{throw new HttpError(400,'請填寫公開來源網址');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname.includes('.')||/^(\d+\.){3}\d+$/.test(url.hostname)||url.hostname.includes(':')||/(^|\.)(notion\.(so|site|com)|drive.google.com|docs.google.com|localhost)$/.test(url.hostname)||/\.(local|internal|lan|localhost|home|corp)$/.test(url.hostname))throw new HttpError(400,'來源必須是公開 HTTPS 網址');
 const day=(s:unknown)=>typeof s==='string'&&/^20\d\d-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(`${s}T00:00:00Z`))&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
 const time=(s:unknown)=>typeof s==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
 if(domain==='events'){
   for(const k of ['start','end'])if(!/^20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?\+08:00$/.test(String(p[k]))||!Number.isFinite(Date.parse(String(p[k]))))throw new HttpError(400,'活動時間請使用台灣時間');
   if(Date.parse(String(p.end))<=Date.parse(String(p.start)))throw new HttpError(400,'結束時間必須晚於開始');
   if(!['scheduled','rescheduled','cancelled'].includes(String(p.status)))throw new HttpError(400,'活動狀態不正確');
   if(p.status!=='scheduled'&&!p.changeNote)throw new HttpError(400,'改期或取消請填寫原因');
   for(const k of ['verifiedAt','updatedAt','reviewDueAt'])if(!day(p[k]))throw new HttpError(400,`${k} 日期不正確`);
 }else{
   if(!/^20\d\d-(0[1-9]|1[0-2])$/.test(String(p.month))||!day(p.observedAt)||!day(p.nextReviewAt))throw new HttpError(400,'月份或日期不正確');
   if(!Array.isArray(p.sessions)||!p.sessions.length||p.sessions.length>31)throw new HttpError(400,'請填寫 1 至 31 個時段');
   const dates=new Set();for(const s of p.sessions){if(!s||typeof s!=='object'||Object.keys(s).some(k=>!['date','start','end'].includes(k))||!day(s.date)||!s.date.startsWith(p.month)||!time(s.start)||!time(s.end)||s.start>=s.end||dates.has(s.date))throw new HttpError(400,'時段日期、時間或重複日期有誤');dates.add(s.date);}
   if(String(p.nextReviewAt)<String(p.observedAt)||!String(p.nextReviewAt).startsWith(String(p.month)))throw new HttpError(400,'下次核對須在核對日之後且在該月份內');
 }
 return p;
}
