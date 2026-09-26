"use strict";
let session,
  documents = [],
  selected = null,
  dirty = false,
  previewVersion = null;
const $ = (s) => document.querySelector(s);
const statusNames = {
  queued: "等待發布",
  processing: "正在建置與檢查",
  pr_created: "等待 GitHub 檢查",
  failed: "發布未完成",
  no_change: "與網站相同",
  closed: "發布已取消",
  merged: "已合併，等待部署",
  deployed: "已部署，等待外部驗證",
  verified: "已上線並完成驗證",
};
const labels = {
  name: "活動名稱",
  start: "開始時間",
  end: "結束時間",
  content: "活動說明",
  registration: "參與／報名方式",
  sourceUrl: "公開來源網址",
  verifiedAt: "來源核對日",
  status: "活動狀態",
  changeNote: "異動原因",
  updatedAt: "來源更新日",
  reviewDueAt: "下次複查日",
  month: "月表月份",
  observedAt: "核對日",
  sourceTitle: "來源圖卡標題",
  nextReviewAt: "下次核對日",
  sessions: "諮詢時段",
};
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
  "sourceTitle",
  "sourceUrl",
  "observedAt",
  "nextReviewAt",
  "sessions",
];
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function notice(text) {
  $("#notice").textContent = text;
}
async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "X-CSRF-Token": session.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    let error;
    try {
      error = (await r.json()).error;
    } catch {}
    throw new Error(
      error || "連線中斷或登入已失效，請重新載入；未儲存內容仍保留在表單。",
    );
  }
  return r.json();
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
}
function displayDate(value) {
  return new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}
async function load() {
  documents = (await api("/api/documents")).documents;
  const list = $("#documents");
  list.replaceChildren();
  if (!documents.length)
    list.append(el("p", "正在等待首次同步網站內容，請稍後更新狀態。"));
  for (const d of documents) {
    const p = JSON.parse(d.payload),
      b = el(
        "button",
        d.domain === "events" ? p.name : `${p.month} 律師時間表`,
        "document",
      );
    b.type = "button";
    b.setAttribute("aria-current", String(selected?.id === d.id));
    b.append(el("small", `草稿 v${d.version} · ${displayDate(d.updated_at)}`));
    b.onclick = () => action(() => select(d));
    list.append(b);
  }
  await publications();
}
async function select(d) {
  if (dirty && !confirm("尚有未儲存內容，確定離開這筆草稿？")) return;
  selected = d;
  dirty = false;
  render();
  await history();
}
function render() {
  const p = JSON.parse(selected.payload),
    container = $("#fields");
  container.replaceChildren();
  $("#editor-title").textContent =
    selected.domain === "events" ? "活動內容" : "公益律師月表";
  $("#record-type").textContent =
    selected.domain === "events" ? "公開行程與活動" : "市民服務";
  $("#version").textContent = selected.id
    ? `草稿 v${selected.version}`
    : "新活動";
  $("#conflict").hidden =
    !selected.published_hash || selected.base_hash === selected.published_hash;
  $("#editor-form").hidden = false;
  $("#history-panel").hidden = !selected.id;
  $("#refresh").disabled = !selected.id;
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    const label = el("label", labels[key], "field");
    let input;
    if (key === "status") {
      input = el("select");
      for (const [v, t] of [
        ["scheduled", "排定"],
        ["rescheduled", "改期"],
        ["cancelled", "取消"],
      ]) {
        const o = el("option", t);
        o.value = v;
        input.append(o);
      }
    } else if (["content", "sessions"].includes(key)) {
      input = el("textarea");
      input.rows = key === "sessions" ? 8 : 6;
    } else {
      input = el("input");
      input.type =
        key === "month"
          ? "month"
          : key === "sourceUrl"
            ? "url"
            : /At$/.test(key)
              ? "date"
              : ["start", "end"].includes(key)
                ? "datetime-local"
                : "text";
    }
    input.name = key;
    input.id = `field-${key}`;
    input.required = key !== "changeNote";
    input.value =
      key === "sessions"
        ? (p.sessions || [])
            .map((s) => `${s.date} ${s.start} ${s.end}`)
            .join("\n")
        : ["start", "end"].includes(key)
          ? String(p[key] || "").slice(0, 16)
          : (p[key] ?? "");
    label.append(input);
    if (key === "sessions")
      label.append(
        el("small", "每行一個時段：2026-10-01 19:30 21:00。每個日期只填一次。"),
      );
    container.append(label);
  }
  $("#preview").disabled = !selected.id;
  $("#editor-form").oninput = () => {
    dirty = true;
    $("#preview").disabled = true;
  };
}
function read() {
  const out = {};
  for (const [key, value] of new FormData($("#editor-form"))) {
    out[key] =
      key === "sessions"
        ? value
            .trim()
            .split("\n")
            .map((line) => {
              const [date, start, end, ...extra] = line.trim().split(/\s+/);
              if (extra.length)
                throw new Error("每行時段只需填日期、開始、結束。");
              return { date, start, end };
            })
        : ["start", "end"].includes(key)
          ? `${value}:00+08:00`
          : value || null;
  }
  return out;
}
async function save() {
  const payload = read();
  const result = selected.id
    ? await api(`/api/documents/${selected.id}`, "PUT", {
        version: selected.version,
        payload,
      })
    : await api("/api/documents", "POST", { domain: "events", payload });
  dirty = false;
  await load();
  selected = documents.find((d) => d.id === result.id);
  render();
  await history();
  notice("草稿已儲存，官網尚未變更。");
}
async function history() {
  const target = $("#history");
  target.replaceChildren();
  if (!selected.id) return;
  const data = await api(`/api/documents/${selected.id}/history`);
  for (const v of data.versions) {
    const row = el(
      "div",
      `v${v.version} · ${displayDate(v.created_at)} `,
      "history-row",
    );
    if (v.version !== selected.version) {
      const b = el("button", "還原為新草稿", "secondary");
      b.type = "button";
      b.onclick = () =>
        action(async () => {
          if (!confirm(`將 v${v.version} 還原為新草稿？既有歷史版本會保留。`))
            return;
          await api(`/api/documents/${selected.id}/restore`, "POST", {
            version: selected.version,
            restoreVersion: v.version,
          });
          dirty = false;
          const id = selected.id;
          await load();
          await select(documents.find((d) => d.id === id));
          notice("已還原為新草稿，尚未發布。");
        });
      row.append(b);
    }
    target.append(row);
  }
}
async function publications() {
  const result = await api("/api/publications");
  const target = $("#publications");
  target.replaceChildren();
  if (!result.publications.length)
    target.append(el("p", "尚未送出發布要求。", "hint"));
  for (const p of result.publications) {
    const row = el("article", undefined, "publication");
    row.append(
      el("strong", statusNames[p.status] || p.status),
      el("span", `v${p.version} · ${displayDate(p.updated_at)}`, "badge"),
      el("p", p.message || "已保存發布要求，等待處理。"),
    );
    if (p.pr_number) {
      const a = el("a", `檢視發布 #${p.pr_number} ↗`);
      a.href = `https://github.com/Hong1998tw/chen-huiwen-website/pull/${p.pr_number}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.append(a);
    }
    target.append(row);
  }
}
$("#editor-form").onsubmit = (e) => {
  e.preventDefault();
  action(save);
};
$("#preview").onclick = () => {
  if (dirty || !selected?.id) return;
  previewVersion = selected.version;
  const target = $("#preview-content");
  target.replaceChildren();
  const p = JSON.parse(selected.payload);
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    const dl = el("dl", undefined, "preview-item");
    dl.append(
      el("dt", labels[key]),
      el(
        "dd",
        key === "sessions"
          ? p.sessions.map((s) => `${s.date} ${s.start}–${s.end}`).join("\n")
          : p[key] || "—",
      ),
    );
    target.append(dl);
  }
  $("#preview-dialog").showModal();
};
$("#close-preview").onclick = () => $("#preview-dialog").close();
$("#publish").onclick = () =>
  action(async () => {
    const b = $("#publish");
    b.disabled = true;
    try {
      await api(`/api/documents/${selected.id}/publish`, "POST", {
        version: previewVersion,
      });
      $("#preview-dialog").close();
      notice("發布要求已保存。請在下方查看檢查與部署進度。");
      await publications();
    } finally {
      b.disabled = false;
    }
  });
$("#refresh").onclick = () =>
  action(async () => {
    if (
      !confirm(
        "載入目前網站內容作為新草稿？現有草稿會保留在版本紀錄。未儲存的表單內容會被取代。",
      )
    )
      return;
    const id = selected.id;
    await api(`/api/documents/${id}/refresh`, "POST", {
      version: selected.version,
    });
    dirty = false;
    await load();
    await select(documents.find((d) => d.id === id));
    notice("已載入網站版本，可以繼續編輯。");
  });
$("#new-event").onclick = () =>
  action(() =>
    select({
      domain: "events",
      version: 0,
      payload: JSON.stringify({ status: "scheduled" }),
    }),
  );
$("#reload").onclick = () =>
  action(async () => {
    await load();
    notice("清單與發布狀態已更新；正在編輯的表單保持不變。");
  });
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
action(async () => {
  session = await api("/api/session");
  $("#identity").textContent = `${session.login} · 擁有者`;
  await load();
});
