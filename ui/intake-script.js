// intake-script.js — 卡片前端
//
// v3（app v0.6.16）：
//   1. 鉴权修复 —— 以前是裸 fetch，全部 403（宿主在框架层拦，不是 Hono 路由问题）。
//      现在从自己的 scoped UI 路径里取 surface session token，放到
//      X-Hana-App-Surface-Session 头。实测链路：
//        GET  /api/apps/<id>/ui/_surface/<token>/intake.html   200（iframe 自己）
//        GET  /api/apps/<id>/routes/intake/health              200（带该头）
//        GET  /api/apps/<id>/routes/intake/health              403（不带，无凭证）
//      token 就在 iframe 自己的 location.pathname 里，宿主不用注入任何东西。
//   2. 卡片是**展示面**，不是抓取器。所有硬编码占位数据（三体、BV1xx、BV2yy、
//      xiaohongshu.com/xxx）全部删除 —— 那些从没过任何平台。
//   3. 四个 tab：记录 / 采集 / 搜索 / 状态。记录支持删，15s 轮询 + 手动刷新。
//   4. 音频 + Whisper 不在这里做：卡片路由有 30s 封顶，音频路径经常超时。
//      那部分走模型工具 bilibili_video_intake（background:true）。

const AID = "bilibili-intake-v2";
const ROUTE_BASE = "/api/apps/" + AID + "/routes";

const SS = (() => {
  const m = /^\/api\/apps\/[^/]+\/ui\/_surface\/([^/]+)\//.exec(location.pathname);
  return m ? m[1] : null;
})();

function req(method, p, body) {
  const h = {};
  if (SS) h["X-Hana-App-Surface-Session"] = SS;
  if (body) h["Content-Type"] = "application/json";
  return fetch(ROUTE_BASE + p, {
    method, headers: h,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    // ⭐ 先读文本再解析，不按 Content-Type 盲走 .json()。
    //   宿主对 app 路由 30s 封顶时直接返回纯文本 `Internal Server Error`
    //   （Hono onError），`.json()` 会抛 `Unexpected token I`，用户看到的是乱码。
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch {
      j = { ok: false, error: "HTTP " + r.status + "：" + (text.slice(0, 200) || "无响应体") };
    }
    return j;
  }).catch(e => ({ ok: false, error: e.message }));
}

const API = {
  health:  () => req("GET", "/intake/health"),
  routing: () => req("GET", "/intake/routing"),
  // ⭐ 2026-09-26：带上服务端给的版本号（rev）。版本没变时后端连 records.json 都不读，
  //   只回一句 unchanged —— 轮询的绝大部分轮次走的就是这条路。
  records: (rev) => req("GET", "/intake/records?limit=100" + (rev ? "&rev=" + encodeURIComponent(rev) : "")),
  // ⭐ 2026-09-22：历史里有、记录是 0 时自动回填一次；产物读回也走这里。
  backfill: () => req("POST", "/intake/records/backfill"),
  artifact: (dir) => req("GET", "/intake/artifact?dir=" + encodeURIComponent(dir)),
  // ⭐ 画面分析报告的整页文件（弹窗内嵌用）。路由侧仍按 captures 边界校验。
  reportFile: (shotDir) => req("GET", "/intake/artifact?dir=" + encodeURIComponent(shotDir) + "&file=" + encodeURIComponent("report.html")),
  saveRec: (d) => req("POST", "/intake/record", d),
  delRec:  (id) => req("DELETE", "/intake/record/" + encodeURIComponent(id)),
  // ⭐ W3（2026-09-26）：批量删除 + 删除缓冲。
  //   delRec 现在也会连本地产物一起删（后端已改），不再是“只删记录”。
  purgeRec:  (ids) => req("POST", "/intake/records/purge", { ids }),
  trash:     () => req("GET", "/intake/trash"),
  emptyTrash:() => req("POST", "/intake/trash/empty"),
  search:  (kw, sort, limit, platform) => req("GET", `/intake/search?keyword=${encodeURIComponent(kw)}&sort=${sort||0}&limit=${limit||10}${platform ? "&platform=" + encodeURIComponent(platform) : ""}`),
  fetch:   (d) => req("POST", "/intake/fetch", d),
  cookies: () => req("GET", "/intake/cookies"),
  // ⭐ 把所有平台的登录态都收成"粘贴 cookie"这一种形态（扫码在沙箱里不可能通）。
  importCookies: (platform, text) => req("POST", "/intake/login/import-cookies", { platform, text }),
  logout: (platform) => req("POST", "/intake/cookies-logout", { platform }),
  // /intake/history（后端 L206）与 /intake/logs（L372）都存在，当前 UI 未用。
  //   保留定义，做「历史 / 日志」tab 时直接用，不用回来加。
  history: () => req("GET", "/intake/history"),
  logs:    () => req("GET", "/intake/logs"),
  settings:{ get: () => req("GET", "/intake/settings"), set: (d) => req("POST", "/intake/settings", d) },
  // ⭐ 知识地图模型：清单来自宿主（复用已配好的供应商），key 不下发
  llmModels: () => req("GET", "/intake/llm/models"),
  llmTest: (d) => req("POST", "/intake/llm/test", d),
};

// ── 小工具 ──
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
function fmtDur(s) {
  s = Number(s) || 0;
  if (s <= 0) return "";
  if (s >= 3600) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h + ":" + String(m).padStart(2,"0"); }
  return Math.floor(s/60) + ":" + String(Math.round(s%60)).padStart(2,"0");
}
function fmtAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = Date.now(), diff = (now - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff/60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff/3600) + " 小时前";
  return d.getMonth()+1 + "/" + d.getDate();
}
const PLAT = { bilibili:"B站", xhs:"小红书", weibo:"微博", zhihu:"知乎", tieba:"贴吧", douyin:"抖音", kuaishou:"快手" };
const platName = (p) => PLAT[p] || (p || "").toUpperCase();

let currentPlatform = "bilibili";
// ⭐ 后端未实现的平台。点了不会成功，必须在 UI 上标出来。
const STUB_PLATS = new Set(["douyin", "kuaishou"]);
// ⭐ 部分平台：能拿元数据，评论功能未实现
const PARTIAL_PLATS = new Set(["xhs", "weibo", "zhihu", "tieba"]);
// ⭐ 平台切换的可见反馈。
//   旧写法切换只改了按钮高亮和 currentPlatform 变量——界面上没有任何地方
//   显示「现在在用哪个平台」，而 placeholder 还写死「BV 号」（B站专属）。
//   选了小红书点采集，请求确实带了对的平台（后端已修），但用户看不到任何
//   变化，于是判断「切换没效果」。placeholder 跟着平台变是最直接的反馈。
function applyPlatformUI() {
  const p = platName(currentPlatform);
  const urlInput = $("#url-input");
  const searchInput = $("#search-input");
  if (urlInput) urlInput.placeholder = currentPlatform === "bilibili"
    ? "粘贴链接或 BV 号"
    : "在 " + p + " 粘贴链接";
  if (searchInput) searchInput.placeholder = "在 " + p + " 搜索关键词";
}
let pollTimer = null;
// ⭐ 2026-09-26：轮询的两处省。
//   ① 数据没变就不重画：把"条数 + 每条 id:updatedAt"当指纹，与上次相同就直接返回，
//      连 `innerHTML` 都不碰。正常运行下绝大多数轮次都会命中这条。
//   ② 页面不可见时跳过本轮（卡片切到后台 / 被别的 tab 盖住）。
let lastRecFingerprint = "";
// ⭐ 数据本身的版本号（服务端 records.json 的 size:mtimeMs）。同上——没变就别重画。
let recRev = "";
// ⭐ 展开状态跨轮询保留。旧写法每次轮询重建 innerHTML，
//   `clamped` + `data-open="0"` 会把已展开的总结收回去——用户展开一次、15 秒后被收。
const openSums = new Set();
// ⭐ 2026-09-22：回填只试一次（记录为空时）。
let backfillTried = false;

// ⭐ W3（2026-09-26）：批量选择 + 两步确认。
//   与 openSums 同一个道理：轮询每 15 秒重建列表，选中状态必须存在这个集合里，
//   不能指望 checkbox 的 DOM 状态能活过一轮。
let bulkMode = false;
const pickedIds = new Set();
let lastItems = [];
// ⭐ 2026-09-26：记录过滤（用户原话：只能一个个翻）。纯本地筛选，不打后端。
let recFilter = "";

function updateBulkInfo() {
  const info = $("#bulk-info");
  const del = $("#btn-bulk-del");
  if (info) info.textContent = bulkMode ? (pickedIds.size ? `已选 ${pickedIds.size} 条` : "勾选要删的记录") : "";
  if (del) del.hidden = !(bulkMode && pickedIds.size > 0);
}

// 两步确认。不用 window.confirm —— iframe 里未必可用，而且它拦不住手滑。
let confirmResolve = null;
function askConfirm(text) {
  const bar = $("#confirm-bar");
  const t = $("#confirm-text");
  if (!bar || !t) return Promise.resolve(false);   // 没确认条就不删
  t.textContent = text;
  bar.hidden = false;
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(v) {
  const bar = $("#confirm-bar");
  if (bar) bar.hidden = true;
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(v);
}

// ── 鉴权状态 ──
function setAuthStatus() {
  const el = $("#auth-dot");
  if (!el) return;
  if (!SS) {
    el.textContent = "离线";
    el.title = "卡片不在 scoped UI 路径下，无法调用路由。请从插件面板打开卡片。";
    return;
  }
  el.textContent = "已连接";
  el.title = "通过 X-Hana-App-Surface-Session 鉴权";
}

// tab 切换、事件绑定都在文件末尾统一做（只绑定一次，避免后定义覆盖前先前的行为）。

// ── 平台选择 ──
$$(".platform-select button").forEach(b => {
  if (STUB_PLATS.has(b.dataset.p)) {
    b.classList.add("stub");
    b.title = "后端未实现，采集会失败";
  } else if (PARTIAL_PLATS.has(b.dataset.p)) {
    b.classList.add("partial");
    // ⭐ 不同平台的限制不同：xhs 需要浏览器，weibo/zhihu/tieba 需要登录态
    b.title = "部分支持：需要登录态或浏览器，评论功能可能不可用";
  }
  b.onclick = function() {
    $$(".platform-select button").forEach(x => x.classList.remove("on"));
    this.classList.add("on");
    currentPlatform = this.dataset.p || "bilibili";
    applyPlatformUI();
    refreshLoginState();
  };
});

// ── 记录 ──
async function renderRecords(force = false) {
  const wrap = $("#records-list");
  if (!wrap) return;
  if (!wrap.dataset.loaded) {
    wrap.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>加载中…</div></div>';
  }
  // ⭐ force（手动点刷新）时不带 rev，强制后端读完再回列表。
  let r = await API.records(force ? "" : recRev);
  // ⭐ 2026-09-22：0.6.26 及以前只有卡片侧采集会写 records.json，模型工具侧一个字不写，
  //   于是会出现「历史里有、记录是 0」。这里自愈一次：发现记录为空就从 captures 回填。
  //   每次打开卡片最多试一次（backfillTried），不会反复扫目录。
  if (!backfillTried && r.ok && (r.total || 0) === 0) {
    backfillTried = true;
    const bf = await API.backfill();
    if (bf.ok && (bf.created || bf.updated)) {
      r = await API.records();
      flash("#rec-status", `已从历史回填 ${bf.created} 条记录（扫描 ${bf.scanned} 个产物目录）`, false);
    }
  }
  // ⭐ 版本没变：后端没读盘、也没传列表。这一轮到此为止 —— DOM、计数、指纹全都不碰。
  // ⭐ 2026-09-26：过滤时不能走这个早退 —— 版本没变但用户改了过滤词，列表必须重画。
  //   force 那条路不带 rev，所以一定会拿到完整列表，不会绕回这里（无递归）。
  if (r.ok && r.unchanged) {
    updateBulkInfo();
    if (recFilter.trim()) renderRecords(true);
    return;
  }
  if (r.ok && r.rev) recRev = r.rev;

  const count = $("#rec-count");
  if (count) count.textContent = (r.total || 0);

  // ⭐ 指纹比对：数据没变就别重建 DOM。force=true（手动点刷新）时跳过这层。
  if (r.ok) {
    const fp = (r.total || 0) + "|" + (r.items || []).map(x => x.id + ":" + (x.updatedAt || x.createdAt || "")).join(",");
    if (!force && fp === lastRecFingerprint && wrap.dataset.loaded === "1") {
      updateBulkInfo();
      return;
    }
    lastRecFingerprint = fp;
  }

  if (!r.ok) {
    wrap.innerHTML = '<div class="empty"><div class="e-icon">!</div><div>读取记录失败：' + esc(r.error) + "</div></div>";
    return;
  }
  const items = r.items || [];
  lastItems = items;
  // 匹配范围用整条记录的 JSON 串 —— 标题 / 平台 / 链接 / 总结正文一网打尽，
  // 不用逐字段维护（字段会变，这个不会）。
  const _q = recFilter.trim().toLowerCase();
  const itemsShown = _q ? items.filter((rec) => JSON.stringify(rec).toLowerCase().includes(_q)) : items;
  {
    const st = $("#rec-status");
    if (st) st.textContent = _q ? ("已过滤 " + itemsShown.length + " / " + items.length + " 条") : "";
  }
  if (itemsShown.length === 0) {
    if (_q) {
      wrap.innerHTML = '<div class="empty"><div class="e-icon">⌕</div><div>没有匹配的记录</div>'
        + '<div class="e-sub">过滤词：' + esc(recFilter) + '（共 ' + items.length + ' 条，清空过滤框看全部）</div></div>';
    } else {
      wrap.innerHTML = '<div class="empty"><div class="e-icon">▤</div><div>还没有记录</div>'
        + '<div class="e-sub">采集一条内容会自动落记录；总结由采集后补写</div></div>';
    }
    return;
  }
  wrap.innerHTML = itemsShown.map(rec => {
    const tags = (rec.tags || []).filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    const sm = rec.summary || "";
    const long = sm.length > 160;
    const isOpen = openSums.has(rec.id);
    const summary = sm
      ? `<div class="rec-summary${long && !isOpen ? " clamped" : ""}">${esc(sm)}</div>` +
        (long ? `<button class="rec-toggle" data-open="${isOpen ? "1" : "0"}" data-id="${esc(rec.id)}">${isOpen ? "收起" : "展开"}</button>` : "")
      : '<div class="rec-nosummary">未写总结</div>';
    const picked = pickedIds.has(rec.id);
    return `<div class="rec${bulkMode && picked ? " picked" : ""}">
      <div class="rec-top">
        ${bulkMode ? `<input type="checkbox" class="rec-pick" data-id="${esc(rec.id)}"${picked ? " checked" : ""} title="选中这条">` : ""}
        <div class="rec-title">${esc(rec.title || rec.source || "(无标题)")}</div>
        ${rec.artifactDir ? `<button class="rec-report" data-dir="${esc(rec.artifactDir)}" title="看画面分析报告（弹窗内嵌整页）">报告</button>` : ""}
         <button class="rec-del" data-id="${esc(rec.id)}" title="删除这条记录与其本地产物">✕</button>
      </div>
      <div class="rec-meta">
        ${rec.author ? '<span>' + esc(rec.author) + "</span>" : ""}
        ${rec.durationSec ? '<span>' + fmtDur(rec.durationSec) + "</span>" : ""}
        <span class="rec-plat">${esc(platName(rec.platform))}</span>
        ${rec.kind ? '<span class="tag" title="素材类型（artifact.json 的 kind）">' + esc({ video: "视频", article: "文章", document: "文档" }[rec.kind] || rec.kind) + "</span>" : ""}
        <span class="tag" title="${sm ? "已回写总结" : "采集到了但还没写总结；用模型工具写完后回写这条记录"}">${sm ? "已总结" : "未总结"}</span>
        ${rec.transcriptChars ? '<span title="采集到的正文字符数">' + rec.transcriptChars + " 字</span>" : ""}
        ${rec.summaryPoints ? '<span class="tag" title="结构化摘要：要点数与回指校验结果（回指不到 = 可能编的）">要点 ' + rec.summaryPoints + (rec.summaryUngrounded ? " · 未回指 " + rec.summaryUngrounded : " · 已全部回指") + "</span>" : ""}
        <span class="rec-when" title="最近更新">${fmtAgo(rec.updatedAt || rec.createdAt)}</span>
      </div>
      ${summary}
      ${tags ? '<div class="rec-tags">' + tags + "</div>" : ""}
      ${rec.source ? '<div class="rec-src">' + esc(rec.source) + "</div>" : ""}
      ${rec.artifactDir ? '<div class="rec-src" title="采集产物目录：正文 text.txt、原始字幕、报告、帧图都在这里；不采集就不会删">产物：' + esc(rec.artifactDir) + "</div>" : ""}
    </div>`;
  }).join("");

  // ⭐ W3：删除前先确认。文案里说清“会删什么”与“哪些会留档”，
  //   不靠一个孤零零的 ✕ 让用户猜它删到哪一层。
  $$(".rec-del", wrap).forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.dataset.id;
    const rec = (items || []).find(x => x.id === id) || {};
    const who = (rec.title || rec.source || "这条记录").slice(0, 40);
    const extra = rec.summary
      ? "已总结：摘要会留档到删除缓冲。"
      : (rec.artifactDir ? "本地产物（正文/字幕/帧/原片）会一并删除。" : "这条没有产物目录。");
    if (!(await askConfirm(`删除「${who}」？${extra}不可恢复。`))) return;
    b.disabled = true;
    b.textContent = "…";
    const d = await API.delRec(id);
    if (d.ok) {
      pickedIds.delete(id);
      updateBulkInfo();
      renderRecords();
      flash("#rec-status", `已删除${d.trashedFiles ? `（留档 ${d.trashedFiles} 项）` : ""}`, false);
    } else {
      b.disabled = false;
      b.textContent = "✕";
      flash("#rec-status", "删除失败：" + (d.error || ""), true);
    }
  });

  // ⭐ W3：批量勾选
  $$(".rec-pick", wrap).forEach(c => c.onchange = () => {
    if (c.checked) pickedIds.add(c.dataset.id); else pickedIds.delete(c.dataset.id);
    const card = c.closest(".rec");
    if (card) card.classList.toggle("picked", c.checked);
    updateBulkInfo();
  });
  // 展开 / 收起长总结：默认只露 3 行，避免列表被长总结擑爆
  $$(".rec-toggle", wrap).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const box = b.previousElementSibling;
    const id = b.dataset.id;
    const open = b.dataset.open === "1";
    if (box) box.classList.toggle("clamped", open);
    b.dataset.open = open ? "0" : "1";
    b.textContent = open ? "展开" : "收起";
    if (open) openSums.delete(id); else openSums.add(id);
  });
  wrap.dataset.loaded = "1";
}

// ── 采集 ──
async function doCapture() {
  if (!$("#url-input")) return;   // 卡片已无采集栏
  const src = $("#url-input").value.trim();
  if (!src) return flash("#capture-status", "请输入链接或 BV 号", true);
  // ⭐ stub 平台拦截：避免跑 15 秒才失败
  if (STUB_PLATS.has(currentPlatform)) {
    return flash("#capture-status", platName(currentPlatform) + " 后端未实现，无法采集", true);
  }
  const btn = $("#btn-capture");
  btn.disabled = true; btn.textContent = "采集中…";
  $("#capture-status").textContent = "正在采集 " + platName(currentPlatform) + "…";
  $("#capture-status").className = "status";
  try {
    const r = await API.fetch({ source: src, platform: currentPlatform, saveRecord: true });
    // ⭐ 形状判定，不靠 r.ok：后端 collector 直返的 JSON 里没有 ok 字段
    // （search/health/cookies 都没有），靠 r.ok 会把成功当失败。
    if (!r.title && !Array.isArray(r.results)) {
      flash("#capture-status", "采集失败：" + (r.error || "响应缺少 title"), true);
      $("#tc-capture").innerHTML = '<div class="empty"><div class="e-icon">!</div><div>' + esc(r.error || "响应缺少 title") + "</div></div>";
      return;
    }
    renderCapture(r);
    switchTab("capture");
    $("#rec-count") && renderRecords();
    flash("#capture-status", "完成" + (r.savedRecordId ? "，已记入记录" : ""), false);
  } catch (e) {
    flash("#capture-status", "采集异常：" + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "采集";
  }
}
function flash(sel, msg, isError) {
  const el = $(sel); if (!el) return;
  el.textContent = msg;
  el.className = "status" + (isError ? " err" : " ok");
}
function switchTab(name) {
  $$(".tabs button[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tc").forEach(t => t.classList.toggle("on", t.id === "tc-" + name));
}
function renderCapture(r) {
  const el = $("#tc-capture");
  const dur = fmtDur(r.duration || r.durationSec);
  const comments = r.comments || [];
  const subs = comments.reduce((n, c) => n + ((Array.isArray(c.replies) ? c.replies.length : 0) + (Array.isArray(c.subs) ? c.subs.length : 0)), 0);
  // ⭐ 后端字段是 transcriptText（result.json 已确认），旧写法读 r.transcript / r.subtitle
  //   两个字段后端都不返回——采集 tab 的转写摘录区一直是空的，没人发现。
  const transcript = r.transcriptText || r.transcript || r.subtitle || "";
  const excerpt = transcript ? `<div class="cap-transcript">${esc(transcript.slice(0, 900))}${transcript.length > 900 ? "…" : ""}</div>` : "";
  // ⭐ Whisper 兜底转写质量不如平台字幕（small 模型中文能力有限），
  //   必须明确标注，否则用户会以为质量有保障。
  const transNote = r.transcriptSource === "whisper"
    ? '<div class="cap-warn">Whisper 兜底转写（' + esc(r.transcriptDevice || "cpu") + ' 推理），人名专有名词可能不准。有平台字幕的视频建议不用 forceTranscribe。</div>'
    : "";
  // ⭐ v0.6.27：音频已下载但转写失败 → 红色报错条。与 Whisper 黄条、cap-note 青条
  //   分开，方便一眼看出「不是 Whisper 质量差」，而是真的挂了。
  //   截断 120 字符（完整错误在 result.json 里），避免 SSL stack trace 把面板冲崩。
  const transErr = (r.audioDownloaded === true && r.transcriptionError)
    ? '<div class="cap-err">音频已下载但转写失败：' + esc(String(r.transcriptionError).slice(0, 120)) + '</div>'
    : "";
  el.innerHTML = `
    <div class="cap-head">
      <div class="cap-title">${esc(r.title || "(无标题)")}</div>
      <div class="cap-meta">
        ${r.author || r.uploader ? '<span>' + esc(r.author || r.uploader) + "</span>" : ""}
        ${dur ? '<span>' + dur + "</span>" : ""}
        <span>${esc(r.bvid || r.source || "")}</span>
      </div>
    </div>
    <div class="cap-stats">
      <span>评论 ${comments.length}</span>
      <span>二级 ${subs}</span>
      ${r.comments ? '<span>已带评论</span>' : ""}
    </div>
    ${excerpt}
    ${transErr}
    ${transNote}
    <div class="cap-note">音频 + Whisper 转写不在此处执行（路由 30s 封顶）。需要完整转写请用模型工具 bilibili_video_intake，传 background:true。</div>`;
}

// ── 搜索 ──
async function doSearch() {
  if (!$("#search-input")) return;   // 卡片已无搜索栏
  const kw = $("#search-input").value.trim();
  if (!kw) return flash("#search-status", "请输入关键词", true);
  // ⭐ stub 平台拦截：避免跑 15 秒才失败
  if (STUB_PLATS.has(currentPlatform)) {
    return flash("#search-status", platName(currentPlatform) + " 后端未实现，无法搜索", true);
  }
  // ⭐ 和 doCapture 一致：操作即切标签，结果马上可见。
  //   旧写法点了「搜索」停在「记录」标签，结果在「搜索」标签里，
  //   得手动切过去——看起来像按钮没反应。
  switchTab("search");
  // ⭐ 切标签后立刻给加载态。否则用户看到「搜索结果会显示在这里」
  //   以为搜索没开始或失败了——请求其实正在跑，只有顶部状态条在动。
  //   和 renderRecords 首次加载显示「加载中…」的处理一致。
  $("#tc-search").innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>搜索中…</div><div class="e-sub">在 ' + esc(platName(currentPlatform)) + ' 搜索「' + esc(kw) + '」</div></div>';
  const btn = $("#btn-search");
  btn.disabled = true; btn.textContent = "搜索中…";
  $("#search-status").textContent = "正在搜索 " + platName(currentPlatform) + "…";
  $("#search-status").className = "status";
  try {
    const r = await API.search(kw, 0, 20, currentPlatform);
    const el = $("#tc-search");
    // ⭐ 同上：search 响应没有 ok 字段（只有 mode/keyword/results）。
    //   旧代码写 `!r.ok || ...` 会把每次成功搜索都判成失败，
    //   而且失败分支不更新 #search-status，按钮文案一直卡在「搜索中…」。
    if (!Array.isArray(r.results)) {
      el.innerHTML = '<div class="empty"><div class="e-icon">!</div><div>' + esc(r.error || "搜索失败（响应缺少 results）") + "</div></div>";
      flash("#search-status", "搜索失败", true);
      return;
    }
    if (r.results.length === 0) {
      el.innerHTML = '<div class="empty"><div class="e-icon">○</div><div>没有结果</div></div>';
      return;
    }
    el.innerHTML = r.results.map(v => `
      <div class="srow" onclick="this.querySelector('.sbtn').click()">
        <div class="sinfo">
          <div class="stitle">${esc(v.title || "(无标题)")}</div>
          <div class="smeta">${esc(v.author || v.authorName || "")} ${v.duration ? "· " + fmtDur(v.duration) : ""} <span class="badge">${esc(v.bvid || v.id || v.url || "")}</span></div>
        </div>
        <button class="sbtn" data-src="${esc(v.bvid || v.url || v.id || "")}">采集</button>
      </div>`).join("");
    $$(".sbtn", el).forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      const _ui = $("#url-input"); if (!_ui) return;   // 卡片已无采集栏
  _ui.value = b.dataset.src;
      switchTab("capture");
      doCapture();
    });
    flash("#search-status", "找到 " + r.results.length + " 条", false);
  } catch (e) {
    flash("#search-status", "搜索异常：" + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "搜索";
  }
}

// ── 状态 / 设置 ──
async function renderStatus() {
  const el = $("#tc-status");
  if (!el) return;
  if (!el.dataset.loaded) el.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>探测运行时…</div><div class="e-sub">首次约 6s（起 Python 探 torch），之后走缓存</div></div>';
  const [h, ck, st] = await Promise.all([API.health(), API.cookies(), API.settings.get()]);
  if (!el) return;
  el.dataset.loaded = "1";

  // 后端返回 _cached 就标一下，避免误以为刚重探过
  const cachedTag = (o) => o && o._cached
    ? ' <span class="st-cached">缓存 ' + fmtAgo(new Date(o._cachedAt).toISOString()) + "</span>"
    : "";

  // 运行时
  const rt = h.runtime || {};
  const rtRows = [
    ["Python", rt.python || "—"],
    ["平台", rt.platform || "—"],
    ["CUDA", rt.cuda_available ? String(rt.cuda) : "CPU"],
    ["Whisper", rt.whisper || "—"],
    ["Scrapling", rt.scrapling || "—"],
  ];

  // 各平台连通性
  const plats = h.platforms || {};
  const platRows = Object.entries(plats).map(([k, v]) => {
    const pv = v.status === "ok"
      ? '<span class="pv ok">✓ ' + (v.latency_ms != null ? v.latency_ms + "ms" : "可用") + "</span>"
      : (v.status === "stub"
        // ⭐ stub（douyin/kuaishou）是未实现，不能和「已验证待确认」混在一起
        ? '<span class="pv idle">未实现</span>'
        : '<span class="pv idle">待验证</span>');
    return '<div class="st-line"><span class="st-k">' + esc(PLAT[k] || k) + '</span><span class="st-v">' + pv + "</span></div>";
  }).join("");

  // cookies
  let ckHtml = '<div class="st-sub">B 站 cookies 文件</div>';
  const cf = (st.settings || {}).cookiesFile || "";
  ckHtml += cf
    ? '<div class="st-line"><span class="st-k">路径</span><span class="st-v">' + esc(cf) + "</span></div>"
    : '<div class="st-line"><span class="st-k">路径</span><span class="st-v warn">未设置</span></div>';

  // 关键设置
  const s = st.settings || {};
  const setRows = [
    ["Whisper 模型", s.whisperModel || "—"],
    ["转写设备", s.whisperDevice || "—"],
    ["字幕优先语言", s.preferredSubtitleLanguages || "—"],
    ["音频格式", s.audioFormat || "—"],
    ["启用平台", s.enabledPlatforms || "—"],
    ["运行模式", s.runtimeMode || "—"],
    ["最大正文", s.maxReturnedTranscriptChars ? s.maxReturnedTranscriptChars + " 字符" : "—"],
    ["视觉分析", s.visionEnabled ? "已启用（宿主视觉通道）" : "未启用"],
  ];

  el.innerHTML = `
    <div class="st-block">
      <div class="st-head">运行时${cachedTag(h)}${h.runtime ? "" : '<span class="dot err">异常</span>'}</div>
      ${rtRows.map(([k, v]) => '<div class="st-line"><span class="st-k">' + esc(k) + '</span><span class="st-v">' + esc(v) + "</span></div>").join("")}
      ${platRows ? '<div class="st-sub" style="margin-top:10px">各平台</div>' + platRows : ""}
    </div>
    <div class="st-block">
      <div class="st-head">Cookies${cachedTag(ck)}</div>
      ${ckHtml}
      <div class="st-line"><span class="st-k">登录集合</span><span class="st-v">${(ck.logins || []).length} 项</span></div>
    </div>
    <div class="st-block">
      <div class="st-head">设置</div>
      ${setRows.map(([k, v]) => '<div class="st-line"><span class="st-k">' + esc(k) + '</span><span class="st-v">' + esc(v) + "</span></div>").join("")}
    </div>
    <div class="st-block" id="llm-block"><div class="st-head">知识地图模型</div><div class="empty"><div>加载中…</div></div></div>
    <div class="st-block">
      <div class="st-head">鉴权</div>
      <div class="st-line"><span class="st-k">凭证</span><span class="st-v">${SS ? "surface session" : "缺失（离线）"}</span></div>
      <div class="st-line"><span class="st-k">路由</span><span class="st-v">${ROUTE_BASE}</span></div>
    </div>`;

  // ⭐ 知识地图模型选择器（单独异步加载，不堵住状态区）
  loadLlmBlock(s);
}

/**
 * 知识地图模型：从宿主读已配好的供应商/模型，让用户选一个。
 * key 全程只在服务端；这里只存"选谁"（llmProvider + llmModel）。
 */
async function loadLlmBlock(currentSettings) {
  const el = $("#llm-block");
  if (!el) return;
  let data = null;
  try { data = await API.llmModels(); } catch (e) { data = { ok: false, busError: e?.message || String(e) }; }
  if (!$("#llm-block")) return; // 已经切走了
  const cur = (data && data.current) || {};
  const providers = (data && data.providers) || [];
  if (!providers.length) {
    el.innerHTML = '<div class="st-head">知识地图模型</div>'
      + '<div class="st-line"><span class="st-k">宿主模型</span><span class="st-v warn">读不到</span></div>'
      + '<div class="st-sub">' + esc(data?.busError || data?.detail || "宿主未返回模型列表") + '</div>'
      + '<div class="st-sub">知识地图需要 LLM。也可以在 settings.json 里手填 llmApiKey / llmBaseUrl / llmModel。</div>';
    return;
  }
  const options = [];
  for (const p of providers) for (const m of (p.models || [])) options.push({ pid: p.id, model: m });
  const optHtml = options.map(o => {
    const sel = (o.pid === cur.providerId && o.model === cur.model) ? " selected" : "";
    return '<option value="' + esc(o.pid + "|" + o.model) + '"' + sel + ">" + esc(o.pid + " · " + o.model) + "</option>";
  }).join("");
  el.innerHTML = '<div class="st-head">知识地图模型<span class="st-cached">复用宿主，key 不下发</span></div>'
    + '<div class="st-line"><span class="st-k">可选项</span><span class="st-v">' + providers.length + ' 个供应商 / ' + options.length + ' 个模型</span></div>'
    + (data?.fallback ? '<div class="st-sub">宿主模型列表读不到，以下来自 provider-catalog.json 兜底（可能含非聊天模型）</div>' : '')
    + '<div class="st-line"><span class="st-k">选用</span><span class="st-v"><select id="llm-pick" style="max-width:260px">' + optHtml + '</select></span></div>'
    + '<div class="st-line"><span class="st-k">操作</span><span class="st-v"><button id="llm-save" type="button">保存</button> <button id="llm-test" type="button">测试连通</button> <span id="llm-out"></span></span></div>';

  const picked = () => {
    const v = ($("#llm-pick") || {}).value || "";
    const i = v.indexOf("|");
    return i < 0 ? { providerId: v, model: "" } : { providerId: v.slice(0, i), model: v.slice(i + 1) };
  };
  const out = (text, warn) => {
    const el2 = $("#llm-out");
    if (el2) el2.innerHTML = '<span class="' + (warn ? "warn" : "ok") + '">' + esc(text) + "</span>";
  };

  const saveBtn = $("#llm-save");
  if (saveBtn) saveBtn.onclick = async () => {
    const { providerId, model } = picked();
    try {
      out("保存中…");
      await API.settings.set({ ...(currentSettings || {}), llmProvider: providerId, llmModel: model });
      out("已保存：知识地图将用 " + model);
    } catch (e) { out("保存失败：" + (e?.message || e), true); }
  };
  const testBtn = $("#llm-test");
  if (testBtn) testBtn.onclick = async () => {
    const { providerId, model } = picked();
    try {
      out("测试中…");
      const r = await API.llmTest({ providerId, model });
      if (r && r.ok) out("连通正常（" + (r.ms || "?") + "ms）");
      else out("不可用：" + (r?.error || "未知") + (r?.detail ? " · " + String(r.detail).slice(0, 80) : ""), true);
    } catch (e) { out("测试失败：" + (e?.message || e), true); }
  };
}

// ⭐ 历史 tab：显示采集记录（后端 /intake/history）
async function renderHistory() {
  const el = $("#tc-history");
  if (!el) return;
  if (!el.dataset.loaded) el.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>加载中…</div></div>';
  try {
    const r = await API.history();
    if (!r.ok) throw new Error(r.error || "加载失败");
    const items = r.items || [];
    if (items.length === 0) {
      el.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>暂无采集历史</div><div class="e-sub">采集内容后会记录在这里</div></div>';
      return;
    }
    el.dataset.loaded = "1";
    el.innerHTML = '<div class="hist-list">' + items.map(item => `
      <div class="hist-item">
        <div class="hist-title">${esc(item.title || "(无标题)")}</div>
        <div class="hist-meta">
          <span>${esc(item.platform || "bilibili")}</span>
          ${item.duration ? '<span>' + fmtDur(item.duration) + '</span>' : ''}
          ${item.time ? '<span>' + new Date(item.time).toLocaleString() + '</span>' : ''}
        </div>
      </div>
    `).join('') + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty"><div class="e-icon">✕</div><div>加载失败</div><div class="e-sub">' + esc(e.message) + '</div></div>';
  }
}

// ⭐ 日志 tab：显示运行日志（后端 /intake/logs）
async function renderLogs() {
  const el = $("#tc-logs");
  if (!el) return;
  if (!el.dataset.loaded) el.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>加载中…</div></div>';
  try {
    const r = await API.logs();
    if (!r.ok) throw new Error(r.error || "加载失败");
    const logs = r.logs || [];
    if (logs.length === 0) {
      el.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>暂无日志</div></div>';
      return;
    }
    el.dataset.loaded = "1";
    el.innerHTML = '<div class="log-list">' + logs.map(log => `
      <div class="log-line">
        <span class="log-time">${esc(log.time || "")}</span>
        <span class="log-msg">${esc(log.message || "")}</span>
      </div>
    `).join('') + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty"><div class="e-icon">✕</div><div>加载失败</div><div class="e-sub">' + esc(e.message) + '</div></div>';
  }
}

// ── 启动 ──
async function refreshAll() {
  renderRecords();
  if ($("#tc-status").classList.contains("on")) renderStatus();
}
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // ⭐ 卡片不可见时不干活：省一次路由请求，也省一次 DOM 重建。
    //   iframe 里的 visibilityState 跟随顶层文档。
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    refreshAll();
  }, 15000);
}

setAuthStatus();
$$(".tabs button[data-tab]").forEach(b => b.onclick = () => {
  // ⭐ 走 switchTab，别在这里重写一遍——两份实现会各自漂移
  switchTab(b.dataset.tab);
  if (b.dataset.tab === "status") renderStatus();
  if (b.dataset.tab === "history") renderHistory();
  if (b.dataset.tab === "logs") renderLogs();
});
const _bc = $("#btn-capture"); if (_bc) _bc.onclick = doCapture;   // 卡片已去掉采集栏（功能在会话里做）
const _bs = $("#btn-search"); if (_bs) _bs.onclick = doSearch;      // 卡片已去掉搜索栏
// ⭐ 2026-09-26：过滤框接线（防抖 250ms，避免每个字都打一次后端）。
let recFilterTimer = null;
$("#rec-filter").oninput = (e) => {
  recFilter = (e.target && e.target.value) || "";
  if (recFilterTimer) clearTimeout(recFilterTimer);
  recFilterTimer = setTimeout(() => renderRecords(true), 250);   // 过滤必须重画，别撞 unchanged 早退
};

$("#btn-refresh").onclick = () => { renderRecords(true); if ($("#tc-status").classList.contains("on")) renderStatus(); };
$("#btn-new-rec").onclick = async () => {
  // ⭐ 旧写法 prompt 链只判了第一步：任意后续一步取消（返回 null），
  //   后面的 prompt 仍会连着弹完。而且保存时不带 platform，
  //   记录的平台字段会丢、canonical id 退化，同一个视频又变两条。
  const ask = (label) => prompt(label);   // null = 取消，"" = 留空
  const src = ask("BV 号 / 链接：");
  if (src === null || !src.trim()) return;
  const title = ask("标题（可留空）：");        if (title === null) return;
  const author = ask("作者（可留空）：");       if (author === null) return;
  const tagsRaw = ask("标签（逗号分隔，可留空）："); if (tagsRaw === null) return;
  const summary = ask("总结（可留空）：");       if (summary === null) return;
  const tags = tagsRaw.split(",").map(t => t.trim()).filter(Boolean);
  const r = await API.saveRec({ source: src.trim(), title, author, summary, tags, platform: currentPlatform });
  flash("#rec-status", r.ok ? "已记录" : "记录失败：" + (r.error || ""), !r.ok);
  renderRecords();
};
$("#btn-trash").onclick = async () => {
  const t = await API.trash();
  if (!t.ok) return flash("#rec-status", "读缓冲失败：" + (t.error || ""), true);
  if (!t.count) return flash("#rec-status", "缓冲是空的", false);
  const names = (t.items || []).slice(0, 6).map(i => `${i.day}/${i.slot}`).join("、");
  flash("#rec-status", `缓冲：${t.count} 个槽位的留档（${(t.bytes / 1048576).toFixed(1)} MB）— ${names}${t.count > 6 ? " 等" : ""}`, false);
};
$("#btn-trash-empty").onclick = async () => {
  if (!(await askConfirm("彻底清空删除缓冲？里面的总结留档将不可恢复。"))) return;
  const d = await API.emptyTrash();
  flash("#rec-status", d.ok ? `缓冲已清空（${d.removed} 个槽位）` : "清空失败：" + (d.error || ""), !d.ok);
};
// ⭐ 2026-09-26：全选 / 反选。
//   实现上直接 .click() 已有的 checkbox —— 复用现成的 onchange（它负责加进 pickedIds、
//   切 .picked 类、刷新计数），所以不依赖记录对象里的 id 字段名，也不怕渲染逻辑改动。
// ⚠️ 2026-09-26：原来写成了 $(".rec-pick") —— 单 $ 是 querySelector，返回的是单个元素，
//   对它调 .forEach 直接抛 TypeError，于是"点全选完全没反应"。$ 才是 querySelectorAll。
//   而且这种错 py/JS 语法检查都抓不到，只有真点一下才暴露。
//   现在改成改集合 + 重渲染（模板会按 pickedIds 决定 checked / .picked），不再依赖 DOM 点击。
function bulkToggleAll() {
  lastItems.forEach((it) => pickedIds.add(it.id));
  updateBulkInfo();
  renderRecords();
}
function bulkInvert() {
  lastItems.forEach((it) => {
    if (pickedIds.has(it.id)) pickedIds.delete(it.id); else pickedIds.add(it.id);
  });
  updateBulkInfo();
  renderRecords();
}
$("#btn-bulk-all").onclick = bulkToggleAll;
$("#btn-bulk-inv").onclick = bulkInvert;

$("#btn-bulk").onclick = () => {
  bulkMode = !bulkMode;
  if (!bulkMode) pickedIds.clear();
  $("#btn-bulk").textContent = bulkMode ? "取消选择" : "批量选择";
  // 全选/反选只在批量模式下出现（非批量模式下它们是噪音）
  { const x = $("#btn-bulk-all"); if (x) x.hidden = !bulkMode; }
  { const x = $("#btn-bulk-inv"); if (x) x.hidden = !bulkMode; }
  updateBulkInfo();
  renderRecords();
};
$("#btn-bulk-del").onclick = async () => {
  const ids = [...pickedIds];
  if (!ids.length) return flash("#rec-status", "还没选记录", true);
  const sumCount = lastItems.filter(x => ids.includes(x.id) && x.summary).length;
  const extra = sumCount ? `其中 ${sumCount} 条已总结，摘要会留档到缓冲。` : "";
  if (!(await askConfirm(`删除选中的 ${ids.length} 条记录与其本地产物？${extra}不可恢复。`))) return;
  const d = await API.purgeRec(ids);
  if (d.ok) {
    pickedIds.clear();
    updateBulkInfo();
    renderRecords();
    flash("#rec-status", `已删除 ${d.deleted} 条${d.failed ? `，失败 ${d.failed} 条` : ""}${d.trashedFiles ? `，留档 ${d.trashedFiles} 项` : ""}`, d.failed > 0);
  } else flash("#rec-status", "批量删除失败：" + (d.error || ""), true);
};
$("#confirm-yes").onclick = () => closeConfirm(true);
$("#confirm-no").onclick = () => closeConfirm(false);

// ── 画面分析报告：点「报告」→ 弹窗里内嵌整页 ──
//   报告是自包含的单文件 HTML（样式内联），所以用 srcdoc 而不是 iframe src ——
//   不需要再为它开一条静态路由。
function openReport(slotDir, title) {
  const modal = $("#report-modal");
  const frame = $("#report-frame");
  const t = $("#report-title");
  if (!modal || !frame) return;
  if (t) t.textContent = title || "画面分析报告";
  modal.hidden = false;
  const path_ = String(slotDir).replace(/[\\/]+$/, "") + "/shots/report.html";
  // 先占位，别让人对着白屏猜
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><body style="font:13px/1.8 system-ui,sans-serif;color:#6c6965;padding:24px">正在读取报告…</body>';
  __loadReport(String(slotDir).replace(/[\\/]+$/, "") + "/shots", path_);
}

// ⭐ 2026-09-26：失败**不再自动关窗**。
//   两个症状两个原因：① req() 遇到非 2xx 会抛，而这里没接 catch —— Promise 断了，
//   既不关窗也不填内容，就停在白屏；② 走到 !r.ok 的那种才会 closeReport()，看起来像"自己关了"。
//   现在一律把原因 + 我查的具体路径写进弹窗，让人能自己判断。
async function __loadReport(shotDir, shownPath) {
  const frame = $("#report-frame");
  if (!frame) return;
  const msg = (head, body) => {
    frame.srcdoc = '<!doctype html><meta charset="utf-8"><body style="font:13px/1.8 system-ui,sans-serif;color:#1e1d1c;padding:24px">'
      + '<div style="font-size:14px;margin-bottom:10px">' + head + "</div>"
      + '<div style="color:#6c6965">' + body + "</div>"
      + '<div style="color:#9e9b97;margin-top:14px;font-size:12px">我查的是：' + shownPath + "</div>"
      + "</body>";
  };
  let r = null, err = "";
  try {
    r = await API.reportFile(shotDir);
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  if (!r || !r.ok) {
    msg("这条记录还没有可看的报告",
        "原因：" + esc(err || (r && r.error) || "未知原因")
        + "<br>报告由画面分析（intake_shots）生成，落在 &lt;采集目录&gt;/shots/report.html。"
        + "<br>先对它跑一次画面分析，再点这里。");
    return;
  }
  if (!r.content) {
    msg("报告文件是空的", "文件存在但内容为 0 字节，可能上次生成被中断了。重新跑一次画面分析即可。");
    return;
  }
  frame.srcdoc = r.content;
}function closeReport() {
  const modal = $("#report-modal");
  if (modal) modal.hidden = true;
  const frame = $("#report-frame");
  if (frame) frame.removeAttribute("srcdoc");
}
$("#report-close").onclick = closeReport;
$("#report-modal").onclick = (e) => { if (e.target === $("#report-modal")) closeReport(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeReport(); });

// 事件代理：记录列表会被整体重建（innerHTML），逐个绑定会在下一轮轮询后失效。
$("#records-list").addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".rec-report");
  if (!b) return;
  e.stopPropagation();
  const rec = b.closest(".rec");
  const title = rec ? (rec.querySelector(".rec-title") || {}).textContent || "" : "";
  openReport(b.dataset.dir || "", title.trim());
});

// ── 扫码登录 ──

let _loginCache = { at: 0, r: null };
const LOGIN_TTL_MS = 60000;

// 只负责画：把后端回的 logins 列表映射成一行状态。
function paintLoginState(r) {
  const el = $("#login-state");
  if (!el) return;
  const plat = currentPlatform;
  const list = Array.isArray(r && r.logins) ? r.logins : [];
  // logins 里出现这个平台 = 本地有它的 cookies 文件。
  const hit = list.find((x) => String((x && (x.platform || x.id)) || x || "") === plat);
  el.textContent = platName(plat) + "：" + (hit ? "已登录" : "未登录");
  el.className = "status " + (hit ? "ok" : "no");
}

async function refreshLoginState(force) {
  if (!$("#btn-login")) return;   // 卡片已无登录条 → 连同轮询一起停掉
  const el = $("#login-state");
  const bl = $("#btn-login");
  const bo = $("#btn-logout");
  if (!el || !bl || !bo) return;
  const plat = currentPlatform;
  bl.disabled = false;   // 粘贴 cookie 对所有平台都成立，不再按 QR 平台禁用
  bo.disabled = false;
  if (!SS) { el.textContent = "离线（卡片不在 scoped UI 路径下）"; el.className = "status"; return; }
  // ⚠️ 这一步后端要 spawn 一次 python（实测冷 1020ms / 热 668ms，和健康探针 5.9s 一个量级）。
  //   卡片每次打开都问一遍是白花的 —— 60 秒内直接复用上次结果；登录/登出后传 force。
  const now = Date.now();
  if (!force && _loginCache.r && now - _loginCache.at < LOGIN_TTL_MS) { paintLoginState(_loginCache.r); return; }
  el.textContent = "登录态查询中…";
  el.className = "status";
  const r = await API.cookies();
  _loginCache = { at: Date.now(), r };
  paintLoginState(r);
}

// ⭐ 2026-09-26：改成无头扫码 —— 二维码显示在卡片里。
//   原来那条"拉起浏览器窗口再让人去扫"的做法在子进程被隔离的环境里是死的：
//   窗口起来用户也看不见（实测过）。零窗口的这条路与运行环境无关。

// 把二维码画在卡片里。元素用 JS 建、样式内联 —— 不动 HTML，就少一处会忘的地方。

// 把二维码画进已有的框（幂等：已经有了就只更新 src）。

// 轮询登录状态（后端读 state.json）。约 200 秒后放弃 —— 二维码本身也会过期。

$("#btn-logout").onclick = async () => {
  const plat = currentPlatform;
  if (!(await askConfirm("删掉 " + platName(plat) + " 在本地的 cookies？下次采集要重新扫码。"))) return;
  const r = await API.logout(plat);
  if (r && r.ok) flash("#login-state", "已登出 " + platName(plat), false);
  else flash("#login-state", "登出失败：" + ((r && r.error) || ""), true);
  cookiesStale();
  await refreshLoginState(true);
};

// 登录/登出都改了盘上的 cookies，缓存（后端 60s TTL + 我这个 60s）得跟着失效。
function cookiesStale() {
  const st = $("#status-panel");
  if (st) st.dataset.loaded = "";
}

// ── 手动粘贴登录 cookie（2026-09-26）──
//
// 为什么把「扫码登录」换成这个：App 跑在宿主的 Windows 沙箱里，启动不了任何浏览器
//（直指 exe 被拒、channel 靠注册表读不到、自带 chromium 未安装，批准 runtime 权限也一样）。
// 所以登录态只有一种形态：你把 cookie 粘进来。全程在 App 内、零窗口、所有平台同一套。
$("#btn-login").textContent = "粘贴 cookie";
$("#btn-login").onclick = () => showCookieBox(currentPlatform);

function cookieBoxNode() {
  let box = document.getElementById("cookie-box");
  const bar = document.getElementById("btn-login");
  if (!box) {
    box = document.createElement("div");
    box.id = "cookie-box";
    box.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:12px;margin:8px 0;"
      + "border:1px solid var(--line-s);border-radius:10px;background:var(--card)";
    const holder = bar && bar.parentElement && bar.parentElement.parentElement;
    if (holder) holder.insertBefore(box, bar.parentElement.nextSibling);
  }
  return box;
}

function showCookieBox(plat) {
  const box = cookieBoxNode();
  if (box.dataset.open === plat) { box.dataset.open = ""; box.style.display = "none"; return; }
  box.dataset.open = plat;
  box.style.display = "flex";
  box.innerHTML = "";

  const how = document.createElement("div");
  how.style.cssText = "font-size:12px;color:var(--ink-2);line-height:1.6";
  how.textContent = "把 " + platName(plat) + " 的登录 cookie 粘在下面，两种都行："
    + "① 浏览器 Console 里 document.cookie 的整串；"
    + "② 用 Cookie-Editor 之类扩展导出成 JSON 数组（这种更全，含 HttpOnly 的条目）。";
  box.appendChild(how);

  const ta = document.createElement("textarea");
  ta.id = "cookie-input";
  ta.rows = 5;
  ta.placeholder = "a1=...; web_session=...;  或者  [{\"name\":\"a1\",\"value\":\"...\"}]";
  ta.style.cssText = "width:100%;box-sizing:border-box;font-family:var(--font-mono);font-size:12px;"
    + "padding:8px;border:1px solid var(--line-s);border-radius:8px;background:var(--bg);color:var(--ink);resize:vertical";
  box.appendChild(ta);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center";
  const save = document.createElement("button");
  save.textContent = "保存登录态";
  save.style.cssText = "padding:6px 14px;border:1px solid var(--accent-line);border-radius:8px;"
    + "background:var(--accent-lt);color:var(--ink);cursor:pointer;font-size:12px";
  const tip = document.createElement("span");
  tip.id = "cookie-tip";
  tip.style.cssText = "font-size:12px;color:var(--ink-2)";
  row.appendChild(save);
  row.appendChild(tip);
  box.appendChild(row);

  save.onclick = async () => {
    const text = (document.getElementById("cookie-input") || {}).value || "";
    if (!text.trim()) { tip.textContent = "还没有内容"; return; }
    save.disabled = true;
    tip.textContent = "保存中…";
    const r = await API.importCookies(plat, text);
    save.disabled = false;
    if (r && r.ok) {
      tip.textContent = "已保存 " + r.count + " 条（" + (r.names || []).slice(0, 5).join(", ") + "…）";
      flash("#login-state", platName(plat) + " 登录态已保存", false);
      await refreshLoginState(true);
    } else {
      tip.textContent = "失败：" + ((r && r.error) || "未知原因");
    }
  };
}

refreshAll();
startPoll();
applyPlatformUI();
// 登录态故意延后：它是卡片打开时唯一要 spawn 一次 python 的一步（~1s），别跟首屏抢。
setTimeout(() => { if (!document.hidden) refreshLoginState(); }, 1500);
