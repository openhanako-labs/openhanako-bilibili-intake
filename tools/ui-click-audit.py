"""用真 Chrome 打开卡片页面，逐个检查按钮到底有没有绑定 onclick。

为什么这么做：语法检查查不出「给字符串挂 onclick」这类错误（实测 19 处全漏），
只能真加载一遍 DOM 才知道。后端不在线没关系——绑定在顶层执行，fetch 失败不影响。
"""
import asyncio
import json
from pathlib import Path

HTML = Path(__file__).resolve().parent.parent / "ui" / "intake.html"

PROBE = """
() => {
  const out = [];
  for (const b of document.querySelectorAll('button')) {
    const label = (b.textContent || '').trim().slice(0, 14);
    out.push({
      id: b.id || '',
      cls: b.className || '',
      label,
      onclick: typeof b.onclick === 'function',
      disabled: b.disabled,
    });
  }
  return out;
}
"""


async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, channel="chrome")
        page = await browser.new_page(viewport={"width": 820, "height": 1000})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))
        await page.goto(HTML.as_uri(), wait_until="load")
        await page.wait_for_timeout(1500)
        rows = await page.evaluate(PROBE)
        await browser.close()

    print("=== 按钮绑定检查 ===")
    dead = []
    for r in rows:
        mark = "OK  " if r["onclick"] else "死  "
        if not r["onclick"]:
            dead.append(r)
        print(f"  {mark} id={r['id'] or '-':18} cls={r['cls'][:22]:22} 「{r['label']}」")

    print(f"\n总计 {len(rows)} 个按钮，其中未绑定 {len(dead)} 个")
    if dead:
        for d in dead:
            print("   未绑定:", d)

    print("\n=== 页面 JS 错误 ===")
    if errors:
        for e in errors[:8]:
            print("  ", e)
    else:
        print("  （无）")


asyncio.run(main())
