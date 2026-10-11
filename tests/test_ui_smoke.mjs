// 顶层 stub 冒烟：模拟最小 DOM 跑完 intake-script.js 全部顶层代码，暴露运行时错误
import fs from "node:fs";

const src = fs.readFileSync("C:\\Users\\Administrator\\.hanako\\apps\\bilibili-intake-v2\\ui\\intake-script.js", "utf-8");

const elStub = () => ({
  addEventListener() {}, removeEventListener() {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  dataset: {}, style: {}, hidden: false, disabled: false,
  textContent: "", innerHTML: "", value: "", title: "",
  onclick: null, onchange: null, oninput: null,
  setAttribute() {}, appendChild() {}, insertBefore() {}, remove() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  closest() { return null; }, parentElement: null, select() {},
});

const sandbox = {
  console,
  setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  fetch: () => new Promise(() => {}),   // 永挂起：让 async 路径停住，不产生噪音
  location: { href: "/api/apps/bilibili-intake-v2/ui/_surface/stubtoken/intake.html", pathname: "/api/apps/bilibili-intake-v2/ui/_surface/stubtoken/intake.html", search: "", hash: "" },
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    visibilityState: "visible",
    querySelector: () => null, querySelectorAll: () => [],   // 故意返 null：抓所有无守卫的顶层元素赋值
    addEventListener() {}, createElement: () => elStub(),
    getElementById: () => null, body: elStub(),
    execCommand: () => false, hidden: false,
  },
  window: null,   // 下面自引用
};
sandbox.window = {
  ...sandbox,
  addEventListener() {},
  parent: { postMessage() {} },
};
sandbox.globalThis = sandbox;

const params = Object.keys(sandbox);
const vals = params.map((k) => sandbox[k]);
try {
  new Function(...params, src)(...vals);
  console.log("PASS: 顶层全部执行，无同步异常");
} catch (e) {
  console.error("FAIL: 顶层抛错 ->", e?.message);
  console.error((e?.stack || "").split("\n").slice(0, 6).join("\n"));
  process.exit(1);
}
// 给 async 路径（renderRecords 的 catch 分支等）一个微任务机会
await new Promise((r) => setTimeout(r, 150));
console.log("PASS: async 路径 150ms 内无未捕获拒绝冒出");
