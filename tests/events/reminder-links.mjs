// Unit-level URL contract; browser interaction/accessibility runs separately in events.mjs.
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../../activities.js',import.meta.url),'utf8');
function setup(patch={}){
 const change=new Map(),windowEvents=new Map();
 const select={value:'60',addEventListener:(name,fn)=>change.set(name,fn)};
 const link={hidden:false,href:'https://example.com/old',removeAttribute(name){delete this[name];}};
 const status={textContent:''};
 const event={name:'活動 < & 名稱',start:'2026-10-31T15:50:00+08:00',content:'公開說明 & <字詞>',location:'高雄市鳳山區錦田路231號',url:'https://www.huiwen.tw/event-stable-id.html',...patch};
 const picker={dataset:{eventReminder:JSON.stringify(event)},querySelector:name=>({'.event-reminder-duration':select,'.event-reminder-link':link,'.event-reminder-status':status})[name]};
 vm.runInNewContext(source,{URL,URLSearchParams,Date,Number,Set,JSON,document:{querySelectorAll:()=>[picker]},window:{addEventListener:(name,fn)=>windowEvents.set(name,fn)}});
 return {select,link,status,event,choose(value){select.value=value;change.get('change')?.();},restore(){windowEvents.get('pageshow')?.();}};
}
const state=setup();assert.equal(state.select.value,'');assert.equal(state.link.href,undefined);assert(state.link.hidden);
const starts='20261031T075000Z';
for(const [minutes,end] of [['15','20261031T080500Z'],['30','20261031T082000Z'],['60','20261031T085000Z']]){
 state.choose(minutes);const url=new URL(state.link.href);
 assert.equal(url.origin,'https://calendar.google.com');assert.equal(url.pathname,'/calendar/r/eventedit');
 assert.equal(url.searchParams.get('dates'),starts+'/'+end);
 assert.equal(url.searchParams.get('stz'),'Asia/Taipei');assert.equal(url.searchParams.get('etz'),'Asia/Taipei');
 assert.equal(url.searchParams.get('text'),state.event.name+'（開始提醒）');
 assert.equal(url.searchParams.get('location'),state.event.location);
 assert(url.searchParams.get('details').includes(minutes+' 分鐘個人開始提醒，不是活動時長'));
 assert(url.searchParams.get('details').endsWith(state.event.url));assert(!state.link.hidden);
}
for(const invalid of ['', '0', '1', '120', '<script>']){state.choose(invalid);assert(state.link.hidden);assert.equal(state.link.href,undefined);}
state.choose('15');state.restore();assert.equal(state.select.value,'');assert(state.link.hidden);assert.equal(state.link.href,undefined);
for(const url of ['https://evil.example/event-x.html','javascript:alert(1)','https://www.huiwen.tw/event-x.html?private=1','https://www.huiwen.tw/scripts/private.html']){
 const invalid=setup({url});invalid.choose('15');assert.notEqual(invalid.link.href?.includes('calendar.google.com'),true);
}
console.log('PASS: explicit reminder durations, encoded Google URL, blank/reset states, and destination validation');
