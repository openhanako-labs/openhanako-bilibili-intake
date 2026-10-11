// 删除链路 e2e：建记录 → 单删 → 批量删 → 缓冲端点，全程真实 HTTP
import fs from "node:fs";
import crypto from "node:crypto";

const APP_ID = "bilibili-intake-v2";
const BASE = "http://127.0.0.1:20099";
const PREFIX = `/api/apps/${APP_ID}/routes`;

function sign(hanakoHome, appId) {
  const key = fs.readFileSync(`${hanakoHome}/security/app-surface-session-key`, "utf-8").trim();
  const now = Date.now();
  const payload = {
    schemaVersion: 1,
    sessionId: `aps_${crypto.randomUUID()}`,
    appId, action: "apps.surface", principalId: "local_user",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `${b64}.${crypto.createHmac("sha256", key).update(b64).digest("base64url")}`;
}

let token = null;
for (const h of ["C:/Users/Administrator/.hanako", "W:/Games/Hanako/.hanako"]) {
  const t = sign(h, APP_ID);
  const r = await fetch(`${BASE}${PREFIX}/intake/health`, { headers: { "X-Hana-App-Surface-Session": t } });
  if (r.ok) { token = t; break; }
}
if (!token) { console.error("FAIL: token 鉴权不通"); process.exit(1); }

const H = { "X-Hana-App-Surface-Session": token, "Content-Type": "application/json" };
const j = async (r) => { try { return await r.json(); } catch { return null; } };
let fails = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? "  " + detail : ""}`);
  if (!cond) fails++;
};
const listIds = async () => {
  const r = await fetch(`${BASE}${PREFIX}/intake/records?limit=200`, { headers: H });
  const b = await j(r);
  return new Set((b?.items || []).map((x) => x.id));
};

// ── ① 建两条假记录 ──
const mk = (tag) => ({
  source: "selfcheck://delete-test/" + tag,
  title: "[自检可删] 删除链路验证 " + tag,
  author: "selfcheck",
  platform: "bilibili",
  summary: "这条是删除链路自检记录，马上会被删掉。",
  tags: ["selfcheck"],
});
const mkId = async (rec) => {
  const r = await fetch(`${BASE}${PREFIX}/intake/record`, { method: "POST", headers: H, body: JSON.stringify(rec) });
  const b = await j(r);
  return { status: r.status, id: b?.id || b?.record?.id || null, body: b };
};
const c1 = await mkId(mk("a-" + Date.now()));
const c2 = await mkId(mk("b-" + Date.now()));
check("创建自检记录 ×2", c1.status === 200 && c2.status === 200 && c1.id && c2.id, `id1=${c1.id} id2=${c2.id}`);

// ── ② 确认存在 ──
{
  const ids = await listIds();
  check("两条都在记录列表", ids.has(c1.id) && ids.has(c2.id));
}

// ── ③ 单删（DELETE /intake/record/:id）──
{
  const r = await fetch(`${BASE}${PREFIX}/intake/record/${encodeURIComponent(c1.id)}`, { method: "DELETE", headers: H });
  const b = await j(r);
  const ids = await listIds();
  check("单删 200 且列表里消失", r.status === 200 && b?.ok === true && !ids.has(c1.id), `HTTP ${r.status}`);
  // 删不存在的：应 404 而不是 500
  const r404 = await fetch(`${BASE}${PREFIX}/intake/record/${encodeURIComponent(c1.id)}`, { method: "DELETE", headers: H });
  check("重复删除 -> 404", r404.status === 404, `HTTP ${r404.status}`);
}

// ── ④ 批量删（POST /intake/records/purge）──
{
  const r = await fetch(`${BASE}${PREFIX}/intake/records/purge`, {
    method: "POST", headers: H, body: JSON.stringify({ ids: [c2.id, "no-such-id"] }),
  });
  const b = await j(r);
  const ids = await listIds();
  check("批量删：真 id 删掉", r.status === 200 && !ids.has(c2.id));
  check("批量删：假 id 报告失败不炸", b?.items?.some((x) => x.error), JSON.stringify((b?.items || []).filter((x) => x.error).slice(0, 1)));
}

// ── ⑤ 缓冲端点 ──
{
  const r = await fetch(`${BASE}${PREFIX}/intake/trash`, { headers: H });
  const b = await j(r);
  check("GET /intake/trash 200", r.status === 200 && b?.ok === true);
}

// ── ⑥ 收尾确认：没有 selfcheck 残留 ──
{
  const ids = await listIds();
  const leftovers = [...ids].filter((x) => x.includes("selfcheck")).length;
  check("无 selfcheck 记录残留", leftovers === 0, `残留 ${leftovers}`);
}

console.log(`\n===== 删除链路: ${fails === 0 ? "全部通过 ✓" : fails + " 项失败 ✗"} =====`);
process.exit(fails ? 1 : 0);
