import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "../src/validation.ts";
const month="2026-10";
const eligible=Array.from({length:31},(_,i)=>month+"-"+String(i+1).padStart(2,"0")).filter(d=>new Date(d+"T12:00:00Z").getUTCDay()>=2);
const payload={month,observedAt:"2026-10-01",sourceUrl:"https://www.huiwen.tw/service.html#monthly-heading",sessions:[{date:"2026-10-01",start:"19:30",end:"21:00",lawyer:"林岡輝"}],closedDates:eligible.filter(d=>d!=="2026-10-01"),unconfirmedDates:[]};
test("the published monthly plan has named sessions and explicit non-service days",()=>assert.doesNotThrow(()=>validate("legal-schedule",payload)));
test("pending dates can be saved but cannot be published",()=>{
 const p={...payload,sessions:[],closedDates:[],unconfirmedDates:eligible};
 assert.doesNotThrow(()=>validate("legal-schedule",p,{draft:true}));
 assert.throws(()=>validate("legal-schedule",p),/待填/);
});
test("month coverage, duplicate dates, markup and invalid times fail closed",()=>{
 for(const patch of [
   {closedDates:[]},
   {closedDates:[...payload.closedDates,"2026-10-01"]},
   {sessions:[{...payload.sessions[0],lawyer:"<script>"}]},
   {sessions:[{...payload.sessions[0],end:"19:00"}]},
   {closedDates:[...payload.closedDates,"2026-11-01"]},
 ])assert.throws(()=>validate("legal-schedule",{...payload,...patch}));
});
test("old published schedules without names remain readable",()=>{
 assert.doesNotThrow(()=>validate("legal-schedule",{month,observedAt:"2026-10-01",sourceUrl:payload.sourceUrl,sessions:[{date:"2026-10-01",start:"19:30",end:"21:00"}]}));
});
