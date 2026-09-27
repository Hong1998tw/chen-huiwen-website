"use strict";
// Presentation and navigation only. Drafts and publishing continue through app.js.
const workspaces = ["content", "services", "publishing", "system"];
let currentWorkspace = "dashboard";
let currentEditorTab = "content";
let drawerReturnFocus = null;
let commandReturnFocus = null;

function showWorkspace(name) {
  currentWorkspace = workspaces.includes(name) ? name : "dashboard";
  document.querySelector("#dashboard").hidden = currentWorkspace !== "dashboard";
  for (const workspace of workspaces) {
    document.querySelector(`#workspace-${workspace}`).hidden = currentWorkspace !== workspace;
  }
  for (const button of document.querySelectorAll("[data-workspace-target]")) {
    button.setAttribute("aria-current", button.dataset.workspaceTarget === currentWorkspace ? "page" : "false");
  }
  if (currentWorkspace !== "content") closePageDrawer(false);
  window.location.hash = currentWorkspace === "dashboard" ? "" : currentWorkspace;
  window.scrollTo({top: 0, behavior: "instant"});
}
function showEditorTab(name) {
  currentEditorTab = ["content", "seo", "versions", "publishing"].includes(name) ? name : "content";
  for (const button of document.querySelectorAll("[data-editor-tab]")) {
    const active = button.dataset.editorTab === currentEditorTab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    document.querySelector(`#panel-${button.dataset.editorTab}`).hidden = !active;
  }
}
function openPageDrawer() {
  drawerReturnFocus = document.activeElement;
  document.body.dataset.pageDrawer = "open";
  document.querySelector("#page-drawer-backdrop").hidden = false;
  document.querySelector("#open-page-drawer").setAttribute("aria-expanded", "true");
  document.querySelector("#page-filter").focus();
}
function closePageDrawer(restoreFocus = true) {
  if (document.body.dataset.pageDrawer !== "open") return;
  document.body.dataset.pageDrawer = "closed";
  document.querySelector("#page-drawer-backdrop").hidden = true;
  document.querySelector("#open-page-drawer").setAttribute("aria-expanded", "false");
  if (restoreFocus) (drawerReturnFocus || document.querySelector("#open-page-drawer")).focus();
}
function localDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "時間未提供";
  return new Date(value).toLocaleString("zh-TW", {timeZone:"Asia/Taipei", year:"numeric", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit"});
}
function updateDashboard() {
  const pending = publicationRecords.filter(p => ["queued", "processing", "pr_created"].includes(p.status));
  const verifying = publicationRecords.filter(p => ["merged", "deployed"].includes(p.status));
  const failed = publicationRecords.filter(p => p.status === "failed");
  const now = new Date().toISOString().slice(0, 10);
  const review = documents.filter(d => {
    try { const p = JSON.parse(d.payload); return Boolean((p.reviewDueAt || p.nextReviewAt) && (p.reviewDueAt || p.nextReviewAt) <= now); }
    catch { return false; }
  });
  const unsentPages = pages.filter(p => p.draft_version && !p.pending_operation);
  document.querySelector("#count-draft").textContent = String(pages.filter(p => p.draft_version).length + documents.length);
  document.querySelector("#count-pending").textContent = String(pending.length);
  document.querySelector("#count-verification").textContent = String(verifying.length);
  document.querySelector("#count-review").textContent = String(review.length);
  const recent = document.querySelector("#recent-work"); recent.replaceChildren();
  const recentPages = pages.filter(p => p.draft_updated_at).sort((a,b) => Date.parse(b.draft_updated_at) - Date.parse(a.draft_updated_at)).slice(0, 5);
  if (!recentPages.length) recent.append(el("p", "目前沒有頁面草稿的最近編輯紀錄。", "hint"));
  for (const page of recentPages) {
    const button = el("button", `${page.title || page.path} · ${localDate(page.draft_updated_at)}`, "dashboard-link secondary");
    button.type = "button"; button.onclick = () => action(async () => { showWorkspace("content"); await selectPage(page); }); recent.append(button);
  }
  const attention = document.querySelector("#attention-work"); attention.replaceChildren();
  if (!failed.length && !review.length && !verifying.length && !unsentPages.length) attention.append(el("p", "目前沒有由現有資料確認的異常、複查到期或未送出頁面草稿。", "hint"));
  for (const item of failed.slice(0, 5)) attention.append(el("p", `發布異常 · ${item.path || item.document_id || "內容"} · ${item.message || "詳細原因未回傳"}`));
  for (const item of review.slice(0, 5)) attention.append(el("p", `需要複查 · ${item.domain === "events" ? "活動" : "律師時間表"} · ${JSON.parse(item.payload).reviewDueAt || JSON.parse(item.payload).nextReviewAt}`));
  for (const item of verifying.slice(0, 5)) attention.append(el("p", `待驗證 · ${item.path || item.document_id || "內容"} · ${statusNames[item.status] || item.status}`));
  for (const item of unsentPages.slice(0, 5)) attention.append(el("p", `尚未送出發布 · ${item.title || item.path} · 草稿 v${item.draft_version}`));
  updateSelectedRelease();
}
function updateSelectedRelease() {
  const target = document.querySelector("#page-release-state"); target.replaceChildren();
  if (!selectedPage) { target.append(el("p", "請先選擇頁面。", "hint")); return; }
  const records = publicationRecords.filter(record => record.path === selectedPage.path).sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!records.length) { target.append(el("p", "這一頁尚無後台發布紀錄。", "hint")); return; }
  const latest = records[0];
  target.append(el("h3", `最近一次發布 · ${statusNames[latest.status] || latest.status}`), el("p", `v${latest.version} · ${localDate(latest.created_at)}`));
  const details = el("p", latest.message || "後端未回傳詳細原因。", "hint"); target.append(details);
  const full = document.querySelector("#publications").querySelector(`.publication[data-release-id="${CSS.escape(String(latest.id))}"] .verification-chain`);
  if (full) target.append(full.cloneNode(true));
  const link = document.createElement("button"); link.type="button"; link.className="secondary"; link.textContent="在發布中心查看完整歷程"; link.onclick=()=>showWorkspace("publishing"); target.append(link);
}
function filterReleases() {
  const filter=document.querySelector('[data-release-filter][aria-pressed="true"]')?.dataset.releaseFilter || "all";
  let visible=0;
  for (const row of document.querySelectorAll("#publications .publication")) {
    const status=row.dataset.status;
    row.hidden=!(filter==="all" || filter==="queued" && status==="queued" ||
      filter==="running" && ["processing","pr_created"].includes(status) ||
      filter==="verification" && ["merged","deployed"].includes(status) ||
      filter==="failed" && status==="failed" ||
      filter==="history" && ["verified","no_change","closed"].includes(status));
    if (!row.hidden) visible++;
  }
  document.querySelector("#release-filter-empty").hidden=visible>0 || !publicationRecords.length;
}
function renderCommandResults() {
  const query = document.querySelector("#command-query").value.trim().toLocaleLowerCase();
  const target = document.querySelector("#command-results"); target.replaceChildren();
  const results = pages.filter(p => [p.title, p.path].some(value => String(value || "").toLocaleLowerCase().includes(query))).slice(0, 12);
  if (!results.length) target.append(el("p", "沒有符合的頁面。", "hint"));
  for (const page of results) {
    const button = el("button", `${page.title || page.path} · /${page.path}`, "command-result secondary");
    button.type="button"; button.onclick=()=>action(async()=>{document.querySelector("#command-dialog").close();showWorkspace("content");await selectPage(page);});
    target.append(button);
  }
}
function appendChange(target, title, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  const row=el("div",undefined,"review-change"); row.append(el("strong",title));
  if (before !== undefined && before !== null) row.append(el("p",String(before),"previous-value"));
  row.append(el("p", `→ ${String(after ?? "—")}`)); target.append(row); return true;
}
function diffForReview(target, label, before, after, depth = 0) {
  if (JSON.stringify(before) === JSON.stringify(after)) return 0;
  if (depth > 5 || after === null || typeof after !== "object") return Number(appendChange(target,label,before,after));
  const keys = Array.isArray(after) ? Array.from({length:Math.max(after.length,Array.isArray(before)?before.length:0)},(_,index)=>index) :
    [...new Set([...Object.keys(before && typeof before === "object" ? before : {}),...Object.keys(after)])];
  let count=0;
  const names={featured:"主打專題",reading:"閱讀卡片",summaries:"卡片摘要",title:"標題",summary:"摘要",updated:"內容整理日期",description:"描述",image:"分享圖片",imageAlt:"圖片替代文字",paragraphs:"完整背景與說明",history:"推動歷程",sources:"資料來源",media:"照片與影片",url:"公開網址",sourceDate:"來源日期",sourceType:"來源類型",date:"日期",text:"內文",caption:"圖說",credit:"來源署名",blocks:"內容區塊",alt:"替代文字",address:"完整地址"};
  for (const key of keys.slice(0,100)) {
    const nextLabel = `${label} / ${typeof key === "number" ? `第 ${key+1} 項` : names[key] || key}`;
    count += diffForReview(target,nextLabel,before?.[key],after?.[key],depth+1);
  }
  return count;
}
function openPageReview() {
  if (!selectedPage || !pageDraft?.version || pageDirty) return;
  const target=document.querySelector("#page-review-content"); target.replaceChildren();
  let count=0;
  for (const [label, draft, base] of [["政績內容",caseDraft,caseBase],["首頁專題",homeDraft,homeBase],["SEO 與分享",seoDraft,seoBase],["子頁內容",editorialDraft,editorialBase],["延伸區塊",extraBlocks,extraBlocksBase]]) {
    if (draft) count+=diffForReview(target,label,base,draft);
  }
  for (const [id, field] of pageFields) { if (appendChange(target,`正式頁面文字 · ${id}`,null,field.value)) count++; }
  target.prepend(el("h3", `${count} 個變更區域`));
  if (!count) target.append(el("p", "未偵測到可呈現的欄位差異；後端仍會檢查草稿與來源。", "hint"));
  const readiness=el("dl",undefined,"review-readiness");
  for (const [label,state] of [["草稿儲存", "PASS · v"+pageDraft.version],["內容格式","NOT CHECKED · 發布流程會檢查"],["來源事實核對","NOT CHECKED"],["外部連結","NOT CHECKED"],["SEO","NOT CHECKED"],["預覽載入",pageReady ? "已載入；非發布驗證" : "NOT CHECKED"]]) readiness.append(el("dt",label),el("dd",state));
  target.append(el("h3","Readiness Summary"),readiness);
  document.querySelector("#confirm-page-publish").textContent=`確認發布 ${count} 個變更區域`;
  document.querySelector("#page-review-dialog").showModal();
}

document.querySelector(".brand").addEventListener("click",event=>{event.preventDefault();showWorkspace("dashboard");});
for (const button of document.querySelectorAll("[data-workspace-target]")) button.addEventListener("click",()=>showWorkspace(button.dataset.workspaceTarget));
for (const button of document.querySelectorAll("[data-editor-tab]")) {
  button.addEventListener("click",()=>showEditorTab(button.dataset.editorTab));
  button.addEventListener("keydown",event=>{
    if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
    event.preventDefault(); const keys=["content","seo","versions","publishing"];
    const index=keys.indexOf(currentEditorTab); const next=event.key==="Home" ? 0 : event.key==="End" ? keys.length-1 : (index+(event.key==="ArrowRight" ? 1 : -1)+keys.length)%keys.length;
    showEditorTab(keys[next]); document.querySelector(`#tab-${keys[next]}`).focus();
  });
}
document.querySelector("#open-page-drawer").onclick=openPageDrawer;
document.querySelector("#close-page-drawer").onclick=()=>closePageDrawer();
document.querySelector("#page-drawer-backdrop").onclick=()=>closePageDrawer();
document.querySelector("#page-explorer").addEventListener("keydown",event=>{
  if (event.key === "Escape") { closePageDrawer(); return; }
  if (event.key !== "Tab" || document.body.dataset.pageDrawer !== "open") return;
  const items=[...document.querySelector("#page-explorer").querySelectorAll("button:not(:disabled),input,select,summary")].filter(item=>item.getClientRects().length);
  if (event.shiftKey && document.activeElement===items[0]) {event.preventDefault();items.at(-1).focus();}
  else if (!event.shiftKey && document.activeElement===items.at(-1)) {event.preventDefault();items[0].focus();}
});
document.querySelector("#open-command").onclick=()=>{commandReturnFocus=document.activeElement;renderCommandResults();document.querySelector("#command-dialog").showModal();document.querySelector("#command-query").focus();};
document.querySelector("#close-command").onclick=()=>document.querySelector("#command-dialog").close();
document.querySelector("#command-dialog").addEventListener("close",()=>commandReturnFocus?.focus());
document.querySelector("#command-query").oninput=renderCommandResults;
document.addEventListener("keydown",event=>{
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==="k") {event.preventDefault();document.querySelector("#open-command").click();}
  if (event.key==="Escape") {
    for (const id of ["#command-dialog","#page-review-dialog","#preview-dialog"]) {
      const dialog=document.querySelector(id);
      if (dialog.open) {event.preventDefault();dialog.close();return;}
    }
    closePageDrawer();
  }
},true);
for (const button of document.querySelectorAll("[data-dashboard-target]")) button.onclick=()=>{
  const type=button.dataset.dashboardTarget;
  showWorkspace(type==="pending" || type==="verification" ? "publishing" : type==="review" ? "services" : "content");
  if (type==="draft") {document.querySelector("#page-work-filter").value="draft";renderPages();}
};
for (const button of document.querySelectorAll("[data-service-filter]")) button.onclick=()=>{
  documentFilter=button.dataset.serviceFilter;
  for (const item of document.querySelectorAll("[data-service-filter]")) item.setAttribute("aria-pressed",String(item===button));
  action(load);
};
for (const button of document.querySelectorAll("[data-release-filter]")) button.onclick=()=>{
  for (const item of document.querySelectorAll("[data-release-filter]")) item.setAttribute("aria-pressed",String(item===button));
  filterReleases();
};
document.querySelector("#page-publish").onclick=openPageReview;
document.querySelector("#close-page-review").onclick=()=>document.querySelector("#page-review-dialog").close();
document.querySelector("#confirm-page-publish").onclick=()=>action(async()=>{
  const button=document.querySelector("#confirm-page-publish");button.disabled=true;
  try {document.querySelector("#page-review-dialog").close();await submitPageOperation("publish",true);} finally {button.disabled=false;}
});
const originalSelectPage=selectPage;
selectPage=async function(page) {
  const previous=selectedPage;
  const loading=originalSelectPage(page);
  if (selectedPage===page) closePageDrawer(false);
  await loading;
  if (selectedPage !== previous || selectedPage?.path===page.path) {
    closePageDrawer(false); showEditorTab("content"); updateSelectedRelease();
    if (window.matchMedia("(max-width: 760px)").matches) document.querySelector("#page-editor-title").scrollIntoView({block:"start"});
  }
};
const originalLoadPages=loadPages;
loadPages=async function(){await originalLoadPages();updateDashboard();};
const originalLoad=load;
load=async function(){await originalLoad();updateDashboard();};
const originalPublications=publications;
publications=async function(){await originalPublications();for(const row of document.querySelectorAll("#publications .publication")){const index=[...row.parentElement.children].indexOf(row);row.dataset.releaseId=String(publicationRecords[index]?.id||"");}filterReleases();updateDashboard();if(selectedPage)pageControls();};
showWorkspace(location.hash.slice(1));
showEditorTab("content");
window.addEventListener("hashchange",()=>{const target=location.hash.slice(1);if(target!==currentWorkspace)showWorkspace(target);});
