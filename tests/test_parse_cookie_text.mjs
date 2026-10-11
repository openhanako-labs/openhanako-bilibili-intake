// parseCookieText 逻辑单测：从 intake.js 提取函数源码，eval 后跑用例
import fs from "node:fs";

const src = fs.readFileSync("C:\\Users\\Administrator\\.hanako\\apps\\bilibili-intake-v2\\http\\intake.js", "utf-8");
const start = src.indexOf("const normalizeEntry");
const end = src.indexOf("app.post(\"/intake/login/import-cookies\"");
if (start < 0 || end < 0 || end <= start) { console.error("FAIL: 没截取到函数源码"); process.exit(1); }
const code = src.slice(start, end);
const fn = new Function(code + "\nreturn parseCookieText;")();

let pass = 0, failCount = 0;
const t = (name, cond) => { if (cond) { pass++; } else { failCount++; console.error("FAIL: " + name); } };

// ① header 串
const r1 = fn("a1=xxx; web_session=yyy; buvid3=zzz");
t("header 串解析 3 条", r1.length === 3);
t("header 串 name/value", r1[0].name === "a1" && r1[0].value === "xxx");
t("header 串默认 path=/", r1[0].path === "/" && r1[0].domain === "" && r1[0].expires === 0);

// ② Cookie-Editor JSON 数组
const r2 = fn(JSON.stringify([
  { name: "SESSDATA", value: "v1", domain: ".bilibili.com", expirationDate: 1767225600.6, httpOnly: true, secure: true, sameSite: "Lax" },
  { name: "bad", value: null },   // 无 value，应被过滤
]));
t("JSON 数组留 1 条", r2.length === 1);
t("expirationDate→expires 四舍五入", r2[0].expires === 1767225601);
t("httpOnly→http_only 映射", r2[0].http_only === true && r2[0].secure === true);
t("sameSite 等未知字段被丢弃", !("sameSite" in r2[0]) && Object.keys(r2[0]).length === 7);

// ③ 整份 bundle JSON（备份恢复路径）
const r3 = fn(JSON.stringify({
  platform: "bilibili",
  cookies: [{ name: "SESSDATA", value: "v2", domain: ".bilibili.com", path: "/", expires: 100, http_only: true, secure: false }],
  headers: { "User-Agent": "UA" },
  user: { name: "月曦夜" },
}));
t("bundle 恢复 1 条", r3.length === 1 && r3[0].name === "SESSDATA" && r3[0].expires === 100);

// ④ 空输入
t("空输入 → 空", fn("").length === 0 && fn("   ").length === 0);

// ⑤ 无等号片段被丢弃
const r5 = fn("abc; def=x; ;=y");
t("无等号片段丢弃", r5.length === 1 && r5[0].name === "def");

// ⑥ 值里带等号（base64 类）
const r6 = fn("token=abc==; k=v");
t("值里等号保留", r6[0].value === "abc==" && r6.length === 2);

// ⑦ 损坏 JSON 抛错
let threw = false;
try { fn("[{bad"); } catch { threw = true; }
t("损坏 JSON 抛错（上层转 400）", threw);

console.log(`parseCookieText: ${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
