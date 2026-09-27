import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEditorialPage, validateEditorialBlocks } from "../src/editorial-page.ts";

const path = "page-council-public-record.html";
const block = () => ({type:"paragraph",title:"",text:"議會公開紀錄",date:"",url:"",alt:"",credit:"",address:"",publicAccessConfirmed:false});
const page = () => ({section:"council",title:"議會公開資料整理",summary:"整理公開紀錄",updated:"2026-09-27",
  eventStart:"2026-09-27T10:00+08:00",eventEnd:"2026-09-27T11:00+08:00",
  seo:{title:"議會公開資料整理｜陳慧文",description:"整理議會公開紀錄與可查證來源。",
    image:"https://www.huiwen.tw/assets/site-share-20260909.png",imageAlt:"陳慧文議會紀錄"},blocks:[block()]});

test("editorial page validates route, Taipei time, and ordered block model", () => {
  assert.equal(validateEditorialPage(path,page()).blocks.length,1);
  const invalid:any = page(); invalid.eventEnd="2026-09-27T09:00+08:00";
  assert.throws(() => validateEditorialPage(path,invalid));
  invalid.eventEnd="2026-09-27T11:00+08:00"; invalid.blocks=[{...block(),type:"map",text:"",address:"鳳山車站"}];
  assert.throws(() => validateEditorialPage(path,invalid));
  invalid.blocks[0].address="高雄市鳳山區錦田路231號";
  assert.equal(validateEditorialPage(path,invalid).blocks[0].address,"高雄市鳳山區錦田路231號");
  assert.throws(() => validateEditorialPage("page-news-public-record.html",page()));
});

test("existing pages can keep empty extensions, while media and locations use the same checks", () => {
  assert.deepEqual(validateEditorialBlocks([]),[]);
  assert.throws(()=>validateEditorialBlocks([{...block(),type:"map",address:"高雄市鳳山區錦田路"}]));
  const media={...block(),type:"photo",text:"",url:"https://drive.google.com/file/d/1234567890abcde/view",alt:"活動照片",credit:"服務處",publicAccessConfirmed:true};
  assert.equal(validateEditorialBlocks([media])[0].url,media.url);
  assert.throws(()=>validateEditorialBlocks([{...media,publicAccessConfirmed:false}]));
  assert.throws(()=>validateEditorialBlocks([{...media,url:"https://example.com/page"}]));
});
