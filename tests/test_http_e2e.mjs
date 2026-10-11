// 直连宿主 HTTP 实测 bilibili-intake-v2 卡片路由（自签 surface session token）
import fs from "node:fs";
import crypto from "node:crypto";

const APP_ID = "bilibili-intake-v2";
const BASE = "http://127.0.0.1:20099";
const PREFIX = `/api/apps/${APP_ID}/routes`;

// ── 签 token（复刻宿主 g6e/nTe 逻辑）──
function sign(hanakoHome, appId) {
  const key = fs.readFileSync(`${hanakoHome}/security/app-surface-session-key`, "utf-8").trim();
  const now = Date.now();
  const payload = {
    schemaVersion: 1,
    sessionId: `aps_${crypto.randomUUID()}`,
    appId,
    action: "apps.surface",
    principalId: "local_user",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(), // 1h，短于宿主 12h 上限
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

const HOMES = ["C:/Users/Administrator/.hanako", "W:/Games/Hanako/.hanako"];
let token = null, tokenHome = null;
for (const h of HOMES) {
  const t = sign(h, APP_ID);
  const r = await fetch(`${BASE}${PREFIX}/intake/health`, { headers: { "X-Hana-App-Surface-Session": t } });
  console.log(`[${h}] health probe -> HTTP ${r.status}`);
  if (r.ok) { token = t; tokenHome = h; break; }
}
if (!token) { console.error("FAIL: 两个 home 的 token 都没过鉴权"); process.exit(1); }
console.log(`OK: token 生效（home: ${tokenHome}）\n`);

const H = { "X-Hana-App-Surface-Session": token, "Content-Type": "application/json" };
const j = async (r) => { try { return await r.json(); } catch { return null; } };
let fails = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? "  " + detail : ""}`);
  if (!cond) fails++;
};

// ── ① health（我改的：deps + env）──
{
  const r = await fetch(`${BASE}${PREFIX}/intake/health`, { headers: H });
  const b = await j(r);
  check("health 200", r.status === 200);
  check("health.deps 7 项", Array.isArray(b?.deps) && b.deps.length === 7, `实际 ${b?.deps?.length}`);
  check("health.env 带 venv 信息", b?.env && typeof b.env.venvDir === "string", `venvDir=${b?.env?.venvDir || "(空)"}, source=${b?.env?.runtimeSource}`);
}

// ── ② import-cookies（假平台假 cookie，走完整解析+落盘）──
const FAKE_PLATFORM = "selfcheck-tmp";
{
  const text = JSON.stringify([
    { name: "SESSDATA", value: "selfcheck-value", domain: ".example.com", expirationDate: 1900000000, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "b_nut", value: "1" },
  ]);
  const r = await fetch(`${BASE}${PREFIX}/intake/login/import-cookies`, {
    method: "POST", headers: H, body: JSON.stringify({ platform: FAKE_PLATFORM, text }),
  });
  const b = await j(r);
  check("import-cookies 200 + count=2", r.status === 200 && b?.ok === true && b?.count === 2, JSON.stringify(b));
}

// ── ③ cookies-export（读回刚才写入的）──
{
  const r = await fetch(`${BASE}${PREFIX}/intake/cookies-export?platform=${FAKE_PLATFORM}`, { headers: H });
  const b = await j(r);
  const c = b?.ok ? JSON.parse(b.text) : null;
  check("cookies-export 200", r.status === 200 && b?.ok === true);
  check("导出内容=导入内容", c?.cookies?.[0]?.name === "SESSDATA" && c?.cookies?.[0]?.value === "selfcheck-value" && c?.source === "manual-paste");
  // 404 路径：不存在的平台
  const r404 = await fetch(`${BASE}${PREFIX}/intake/cookies-export?platform=no-such-plat`, { headers: H });
  check("export 不存在平台 -> 404", r404.status === 404);
}

// ── ④ settings：写入标记 key → 读回 → 恢复原样 ──
{
  const g = await fetch(`${BASE}${PREFIX}/intake/settings`, { headers: H });
  const original = (await j(g))?.settings || {};
  const marked = { ...original, _selfcheck: "ok-" + Date.now() };
  const w = await fetch(`${BASE}${PREFIX}/intake/settings`, { method: "POST", headers: H, body: JSON.stringify(marked) });
  const g2 = await fetch(`${BASE}${PREFIX}/intake/settings`, { headers: H });
  const after = (await j(g2))?.settings || {};
  check("settings POST 写入成功", w.status === 200 && after._selfcheck?.startsWith("ok-"));
  check("原设置项保留（整体替换没丢数据）", after.whisperModel === original.whisperModel && after.llmProvider === original.llmProvider);
  // 恢复原样（去掉标记）
  const restore = { ...original };
  await fetch(`${BASE}${PREFIX}/intake/settings`, { method: "POST", headers: H, body: JSON.stringify(restore) });
  const g3 = await fetch(`${BASE}${PREFIX}/intake/settings`, { headers: H });
  const restored = (await j(g3))?.settings || {};
  check("settings 已恢复原样", restored._selfcheck === undefined && restored.whisperModel === original.whisperModel);
}

// ── ⑤ 清理：删掉假平台 cookie ──
{
  const r = await fetch(`${BASE}${PREFIX}/intake/cookies-logout`, {
    method: "POST", headers: H, body: JSON.stringify({ platform: FAKE_PLATFORM }),
  });
  const b = await j(r);
  const gone = !fs.existsSync(`C:/Users/Administrator/.hanako/app-data/bilibili-intake-v2/cookies/${FAKE_PLATFORM}.json`);
  check("cookies-logout 清理成功", r.status === 200 && gone, `deleted=${gone}`);
}

console.log(`\n===== 结果: ${fails === 0 ? "全部通过 ✓" : fails + " 项失败 ✗"} =====`);
process.exit(fails ? 1 : 0);
