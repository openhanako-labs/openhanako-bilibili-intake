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
  records: () => req("GET", "/intake/records?limit=100"),
  // ⭐ 2026-09-22：历史里有、记录是 0 时自动回填一次；产物读回也走这里。
  backfill: () => req("POST", "/intake/records/backfill"),
  artifact: (dir) => req("GET", "/intake/artifact?dir=" + encodeURIComponent(dir)),
  saveRec: (d) => req("POST", "/intake/record", d),
  delRec:  (id) => req("DELETE", "/intake/record/" + encodeURIComponent(id)),
  search:  (kw, sort, limit, platform) => req("GET", `/intake/search?keyword=${encodeURIComponent(kw)}&sort=${sort||0}&limit=${limit||10}${platform ? "&platform=" + encodeURIComponent(platform) : ""}`),
  fetch:   (d) => req("POST", "/intake/fetch", d),
  cookies: () => req("GET", "/intake/cookies"),
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
// ⭐ 展开状态跨轮询保留。旧写法每次轮询重建 innerHTML，
//   `clamped` + `data-open="0"` 会把已展开的总结收回去——用户展开一次、15 秒后被收。
const openSums = new Set();
// ⭐ 2026-09-22：回填只试一次（记录为空时）。
let backfillTried = false;

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
  };
});

// ── 记录 ──
async function renderRecords() {
  const wrap = $("#records-list");
  if (!wrap) return;
  if (!wrap.dataset.loaded) {
    wrap.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div>加载中…</div></div>';
  }
  let r = await API.records();
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
  const count = $("#rec-count");
  if (count) count.textContent = (r.total || 0);

  if (!r.ok) {
    wrap.innerHTML = '<div class="empty"><div class="e-icon">!</div><div>读取记录失败：' + esc(r.error) + "</div></div>";
    return;
  }
  const items = r.items || [];
  if (items.length === 0) {
    wrap.innerHTML = '<div class="empty"><div class="e-icon">▤</div><div>还没有记录</div><div class="e-sub">采集一条内容会自动落记录；总结由采集后补写</div></div>';
    return;
  }
  wrap.innerHTML = items.map(rec => {
    const tags = (rec.tags || []).filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    const sm = rec.summary || "";
    const long = sm.length > 160;
    const isOpen = openSums.has(rec.id);
    const summary = sm
      ? `<div class="rec-summary${long && !isOpen ? " clamped" : ""}">${esc(sm)}</div>` +
        (long ? `<button class="rec-toggle" data-open="${isOpen ? "1" : "0"}" data-id="${esc(rec.id)}">${isOpen ? "收起" : "展开"}</button>` : "")
      : '<div class="rec-nosummary">未写总结</div>';
    return `<div class="rec">
      <div class="rec-top">
        <div class="rec-title">${esc(rec.title || rec.source || "(无标题)")}</div>
        <button class="rec-del" data-id="${esc(rec.id)}" title="删除">✕</button>
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

  $$(".rec-del", wrap).forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.dataset.id;
    b.textContent = "…";
    const d = await API.delRec(id);
    if (d.ok) { renderRecords(); flash("#rec-status", "已删除", false); }
    // ⭐ 失败只写 b.title（悬停才可见），用户点完什么都不看到
    else { b.textContent = "✕"; b.title = d.error; flash("#rec-status", "删除失败：" + (d.error || ""), true); }
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
      $("#url-input").value = b.dataset.src;
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
    ["视觉分析", s.visionEnabled ? "已启用 (" + (s.visionModel || "") + ")" : "未启用"],
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
  pollTimer = setInterval(refreshAll, 15000);
}

setAuthStatus();
$$(".tabs button[data-tab]").forEach(b => b.onclick = () => {
  // ⭐ 走 switchTab，别在这里重写一遍——两份实现会各自漂移
  switchTab(b.dataset.tab);
  if (b.dataset.tab === "status") renderStatus();
  if (b.dataset.tab === "history") renderHistory();
  if (b.dataset.tab === "logs") renderLogs();
});
$("#btn-capture").onclick = doCapture;
$("#btn-search").onclick = doSearch;
$("#btn-refresh").onclick = () => { refreshAll(); if ($("#tc-status").classList.contains("on")) renderStatus(); };
$("#url-input").addEventListener("keydown", e => { if (e.key === "Enter") doCapture(); });
$("#search-input").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
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
refreshAll();
startPoll();
applyPlatformUI();
