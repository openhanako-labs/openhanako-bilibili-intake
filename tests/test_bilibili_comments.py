"""B 站评论取数的回归测试（离线，不打真实网络）。

    python tests/test_bilibili_comments.py

盖住 2026-10-04 那次修复的两个坑：

  1. `/x/v2/reply` 已废弃 —— 带不带 cookie 都只回 3 条（而 page.count 仍报 13，
     看起来像"这个视频就 3 条评论"）。必须走 `/x/v2/reply/wbi/main` + WBI 签名。
  2. `buvid3` 会把新接口也砍回 3 条（实测：全量 cookie → 3 条 is_end=true，
     去掉 buvid3 → 20 条/页）。评论请求必须把设备指纹类 cookie 摘掉。

假响应按 B 站真实形状造（cursor.pagination_reply.next_offset / replies 可能为 null /
rcount 与内联 replies 的关系），并记录每一个被请求的 URL，断言"根本没碰旧接口"。
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = HERE if os.path.basename(HERE) != "tests" else os.path.dirname(HERE)
# collector / bilibili_comments 都在 python/ 下；跑测试时手动上 sys.path。
PY_DIR = os.path.join(_ROOT, "python") if os.path.isdir(os.path.join(_ROOT, "python")) else HERE
if PY_DIR not in sys.path:
    sys.path.insert(0, PY_DIR)

import bilibili_comments as bc  # noqa: E402


# ────────────────────────────────────────────────────────────────
# 假响应
# ────────────────────────────────────────────────────────────────

def make_reply(rpid: int, *, rcount: int = 0, inline: int = 0) -> dict:
    """造一条形状与 B 站 replies 一致的假评论。

    故意保留两个真实存在过的坑：
      · 空/末页时 replies 是 null 不是 []；
      · rcount（子评论总数）与内联给到的 replies 条数可以不相等。
    """
    children = [
        {
            "rpid": rpid * 1000 + i,
            "like": 0,
            "ctime": 1700000000,
            "rcount": 0,
            "member": {"uname": f"sub{i}"},
            "content": {"message": f"{rpid} 的子评论 {i}"},
            "replies": None,
        }
        for i in range(inline)
    ]
    return {
        "rpid": rpid,
        "like": rpid % 7,
        "ctime": 1700000000 + rpid,
        "rcount": rcount,
        "member": {"uname": f"user{rpid}"},
        "content": {"message": f"评论 {rpid}"},
        "replies": children or None,
    }


class FakeBili:
    """按 URL 分发假响应，并把请求记下来。"""

    OLD_ENDPOINT = "api.bilibili.com/x/v2/reply?"      # 已废弃的那条
    NEW_ENDPOINT = "api.bilibili.com/x/v2/reply/wbi/main"
    SUB_ENDPOINT = "api.bilibili.com/x/v2/reply/reply"

    def __init__(self, *, total_pages=3, ps=20, base=1000, deny_probe=False):
        self.requests: list[tuple[str, str]] = []   # (url, cookie)
        self.total_pages = total_pages
        self.ps = ps
        self.base = base
        self.deny_probe = deny_probe
        bc.invalidate_wbi_keys()
    # 让测试能断言"cookie 到底带没带 buvid3"
    def __call__(self, url, *, cookies="", **kw):
        self.requests.append((url, cookies))
        if "web-interface/nav" in url:
            return {
                "code": 0,
                "data": {
                    "wbi_img": {
                        "img_url": "https://i0.hdslb.com/bfs/wbi/ea1db124a4f9ffd24ae9cbd3d7cac6rf.png",
                        "sub_url": "https://i0.hdslb.com/bfs/wbi/360914a5ead0497aaf5c0e8f6d5e3c0f.png",
                    }
                },
            }
        if "web-interface/view" in url:
            return {"code": 0, "data": {"aid": 117125771497211}}
        if self.OLD_ENDPOINT in url:
            # 废弃接口：只给 3 条，但总数照报 —— 这就是当年骗过所有人的形状
            return {"code": 0, "data": {"page": {"count": 13},
                                        "replies": [make_reply(self.base + i) for i in range(3)]}}
        if self.SUB_ENDPOINT in url:
            return {"code": 0, "data": {"page": {"size": 20, "count": 5},
                                        "replies": [make_reply(90000 + i) for i in range(5)]}}
        if self.NEW_ENDPOINT in url:
            q = bc.urllib.parse.parse_qs(url.split("?", 1)[1])
            page = int(q.get("next", ["0"])[0] or 0)
            offset = q.get("pagination_str", [""])[0]
            # 只有带上了上一页给的 offset 游标，才算翻到了下一页
            idx = page if (page >= 1 or offset) else 0
            if idx > self.total_pages:
                return {"code": 0, "data": {"replies": [], "cursor": {"is_end": True}}}
            n = self.ps
            cursor = {
                "is_end": idx >= self.total_pages,
                "next": idx + 1,
                "all_count": self.ps * self.total_pages,
                "pagination_reply": {"next_offset": f"CAEiAgg{idx + 1}"},
            }
            return {
                "code": 0,
                # 末页故意给 null，钉住"or [] 而不是 .get 默认值"这个坑
                "data": {"replies": None if idx >= self.total_pages + 5 else
                                    [make_reply(self.base + idx * n + i) for i in range(n)],
                         "cursor": cursor,
                         "page": None},
            }
        return None

    def urls(self):
        return [u for u, _ in self.requests]

    def hit(self, needle: str) -> bool:
        return any(needle in u for u in self.urls())


def patch(monkey_target: str, fake):
    """把 bc.get_json 换掉；返回还原函数。"""
    orig = bc.get_json
    setattr(bc, monkey_target, fake)
    return lambda: setattr(bc, monkey_target, orig)


# ────────────────────────────────────────────────────────────────
# 1. cookie 净化
# ────────────────────────────────────────────────────────────────

def test_sanitize_drops_buvid3_keeps_login():
    header = ("buvid3=ABCdef; b_nut=1700000000; sid=xyz; SESSDATA=secret; "
              "DedeUserID=123; buvid4=ZZZ; _uuid=4_0; fingerprint=ff")
    out = bc.sanitize_cookie_header(header)
    assert "buvid3" not in out, out
    assert "buvid4" not in out, out
    assert "_uuid" not in out, out
    assert "fingerprint" not in out, out
    for keep in ("b_nut", "sid", "SESSDATA", "DedeUserID"):
        assert keep in out, f"{keep} 不该被摘掉：{out}"
    print("PASS sanitize 摘掉 buvid 家族、保住登录态")


def test_sanitize_cookie_dict_and_header():
    hdr = bc.cookies_to_header({"buvid3": "X", "SESSDATA": "Y", "buvid_fp": "Z"})
    assert hdr == "SESSDATA=Y", hdr
    print("PASS cookies_to_header 同步净化")


# ────────────────────────────────────────────────────────────────
# 2. 一级评论：新接口 + 签名 + 游标翻页
# ────────────────────────────────────────────────────────────────

def test_root_comments_use_wbi_main_not_old_endpoint():
    fake = FakeBili(total_pages=3)
    restore = patch("get_json", fake)
    try:
        nodes = bc.fetch_root_comments(170001, limit=50, cookies="buvid3=BAD; SESSDATA=ok",
                                        timeout=5)
    finally:
        restore()
    assert fake.hit(FakeBili.NEW_ENDPOINT), "没走新接口"
    assert not fake.hit(FakeBili.OLD_ENDPOINT), "不应该再碰已废弃的 /x/v2/reply"
    assert len(nodes) == 50, f"limit=50 应该拿到 50 条，实际 {len(nodes)}"
    # 钉住"只回 3 条"这个历史 bug：任何一次请求都不该是旧接口
    print(f"PASS 一级评论走 wbi/main（{len(nodes)} 条）且没碰废弃接口")


def test_root_comments_are_signed():
    fake = FakeBili(total_pages=1)
    restore = patch("get_json", fake)
    try:
        bc.fetch_root_comments(170001, limit=5, cookies="")
    finally:
        restore()
    urls = [u for u in fake.urls() if FakeBili.NEW_ENDPOINT in u]
    assert urls, "没发出评论请求"
    for u in urls:
        assert "w_rid=" in u and "wts=" in u, f"缺 WBI 签名：{u}"
    print("PASS 每个评论请求都带 w_rid / wts")


def test_root_comments_strip_buvid3_from_request():
    fake = FakeBili(total_pages=2)
    restore = patch("get_json", fake)
    try:
        bc.fetch_root_comments(170001, limit=30, cookies="buvid3=BAD; b_nut=1; sid=x; SESSDATA=y")
    finally:
        restore()
    for url, cookie in fake.requests:
        if FakeBili.NEW_ENDPOINT in url or FakeBili.SUB_ENDPOINT in url:
            assert "buvid3" not in cookie, f"评论请求仍然带上了 buvid3：{cookie}"
            assert "SESSDATA" in cookie, f"登录态不该被一起摘掉：{cookie}"
    print("PASS 评论请求真的没带 buvid3")


def test_root_comments_dedupes_repeated_page():
    # 游标失效时 B 站会重发同一页；不去重就原地打转到 max_pages
    fake = FakeBili(total_pages=1)
    seen_calls = {"n": 0}
    inner = fake

    def repeated(url, *, cookies="", **kw):
        r = inner(url, cookies=cookies, **kw)
        if FakeBili.NEW_ENDPOINT in url:
            seen_calls["n"] += 1
            if seen_calls["n"] > 1:
                # 同一页内容 + 同一个游标
                r["data"]["cursor"]["is_end"] = False
                r["data"]["cursor"]["pagination_reply"]["next_offset"] = "CAEiAgg1"
                r["data"]["replies"] = [make_reply(1000 + i) for i in range(20)]
        return r

    restore = patch("get_json", repeated)
    try:
        nodes = bc.fetch_root_comments(170001, limit=200, cookies="")
    finally:
        restore()
    rpids = [n["rpid"] for n in nodes]
    assert len(rpids) == len(set(rpids)), f"翻页出现重复条目：{len(rpids)} vs {len(set(rpids))}"
    print(f"PASS 重复页被去重（{len(rpids)} 条唯一）")


def test_sub_comments_stay_on_reply_endpoint():
    """二级评论接口实测没坏，新接口那边也没有 wbi/main 变体（404）—— 不许跟着一起换。"""
    fake = FakeBili(total_pages=1)
    restore = patch("get_json", fake)
    try:
        subs = bc.fetch_sub_comments(170001, 81611691, cookies="buvid3=BAD")
    finally:
        restore()
    assert fake.hit(FakeBili.SUB_ENDPOINT), "二级评论应该走 /x/v2/reply/reply"
    assert len(subs) == 5, subs
    for url, cookie in fake.requests:
        if FakeBili.SUB_ENDPOINT in url:
            assert "buvid3" not in cookie
    print("PASS 二级评论保持原接口 + 同样净化 cookie")


# ────────────────────────────────────────────────────────────────
# 3. collector 侧接线
# ────────────────────────────────────────────────────────────────

def test_collector_fetch_comments_shape():
    import collector
    fake = FakeBili(total_pages=3)
    restore = patch("get_json", fake)
    # collector 里那层 get_json 是通过模块函数引用的，换 bilibili_comments.get_json 就够
    orig_read = collector._read_cookies_for_request
    collector._read_cookies_for_request = lambda p: "buvid3=BAD; b_nut=1; sid=x"
    try:
        comments = collector.fetch_comments_via_api("https://www.bilibili.com/video/BV18TbZ6REyp",
                                                    cookies_file="dummy", limit=50)
    finally:
        restore()
        collector._read_cookies_for_request = orig_read
    assert comments, "collector 一条评论都没拿到"
    assert len(comments) == 50, len(comments)
    first = comments[0]
    for k in ("rpid", "username", "content", "like_count", "ctime", "level", "replies"):
        assert k in first, f"记录形状缺字段 {k}: {first}"
    assert not fake.hit(FakeBili.OLD_ENDPOINT), "collector 还在打废弃接口"
    print(f"PASS collector.fetch_comments_via_api 拿到 {len(comments)} 条，形状完整")


def test_collector_respects_with_sub_comments_off():
    import collector
    fake = FakeBili(total_pages=1)
    restore = patch("get_json", fake)
    orig_read = collector._read_cookies_for_request
    collector._read_cookies_for_request = lambda p: ""
    try:
        comments = collector.fetch_comments_via_api(
            "av170001", cookies_file="", limit=10, with_sub_comments=False)
    finally:
        restore()
        collector._read_cookies_for_request = orig_read
    assert all(c["replies"] == [] for c in comments), "关掉二级评论却还是拿到了子评论"
    print("PASS with_sub_comments=False 真的关掉了二级评论")


def test_aid_resolution_from_bv():
    fake = FakeBili()
    restore = patch("get_json", fake)
    try:
        aid = bc.resolve_aid("https://www.bilibili.com/video/BV18TbZ6REyp/?p=2")
        assert aid == 117125771497211, aid
        assert bc.resolve_aid("av170001") == 170001
        assert bc.resolve_aid("BV18TbZ6REyp") == 117125771497211
        assert bc.resolve_aid("https://tieba.baidu.com/p/123") is None
    finally:
        restore()
    print("PASS aid 解析吃 URL / 裸 BV / av，认不出的返回 None")


# ────────────────────────────────────────────────────────────────

def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = []
    for t in tests:
        try:
            t()
        except Exception as exc:  # noqa: BLE001
            failures.append((t.__name__, exc))
            print(f"FAIL {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - len(failures)}/{len(tests)} passed")
    if failures:
        print("失败：")
        for name, exc in failures:
            print(f"  - {name}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

