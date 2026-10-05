#!/usr/bin/env python3
"""
GUI ↔ 引擎 一致性验证：在真实数据上逐谱比对 k-NN 点估计

为什么需要
----------
GUI 是浏览器端独立实现（无 Python 运行时），k-NN 只能复制一份。
构建期 assert 只校验了参数与特征公式（单点数值）。本脚本做更彻底的验证：
把 index.html 里的 k-NN 函数抽出来，在 node 里对**真实官谱语料**跑，
再与 phm/core.py 的 Verdict 逐个谱面比对 point / lo / hi。

任何一处不一致 → 退出码 1。

用法：python tools/verify_gui_parity.py [--n 40]
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, os.path.join(ROOT, "phm"))

from core import Verdict, norm_level  # noqa: E402

HTML = os.path.join(ROOT, "phm", "gui", "index.html")
OFFICIAL = os.path.join(ROOT, "data", "official.jsonl")
COMMUNITY = os.path.join(ROOT, "data", "community.jsonl")
NODE = None
for c in (os.environ.get("PHM_NODE"),
          r"C:\Users\30500\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
          r"C:\Program Files\nodejs\node.exe"):
    if c and os.path.exists(c):
        NODE = c
        break
if not NODE:
    import shutil
    NODE = shutil.which("node")


def extract_fn(html, name):
    """按大括号配平抽 function name(...){...}"""
    head = "function " + name + "("
    i = html.find(head)
    if i < 0:
        raise SystemExit(f"[abort] index.html 缺少 function {name}()")
    j = html.find("{", i)
    depth, k = 1, j + 1
    while depth > 0 and k < len(html):
        c = html[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        k += 1
    return html[i:k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40, help="抽查谱面数")
    args = ap.parse_args()

    if not NODE:
        print("[abort] 未找到 node", file=sys.stderr)
        return 1

    html = open(HTML, encoding="utf-8").read()
    fns = "\n".join(extract_fn(html, n) for n in
                    ("knnFeats", "knnPrepare", "knnNeighbors", "wq",
                     "knnPoint"))
    m = re.search(r"const KNN_K=\d+", html)
    m2 = re.search(r"KNN_BW=[\d.]+", html)
    consts = "const " + m.group(0).replace("const ", "") + "," + m2.group(0) + ";"

    off_rows = [json.loads(l) for l in open(OFFICIAL, encoding="utf-8")]
    off_rows = [r for r in off_rows if r["notes_real"] > 0]

    # GUI 的 OFF 是裁剪过的前端数据；tag 是 build_gui_data.py 预计算下发的
    # 归一化标签，必须一并带上，否则 OFF[i].tag 为 undefined，检索永远落空
    off_js = json.dumps([{
        "name": r["name"], "level": r.get("level"),
        "tag": norm_level(r.get("level")),
        "difficulty": r["difficulty"], "nps": r["nps"],
        "notes_real": r["notes_real"], "t_hold": r["t_hold"],
        "stair_speed_avg": r.get("stair_speed_avg") or 0,
    } for r in off_rows], ensure_ascii=False)

    # 查询样本：社区谱随机抽 n 张 + 若干官谱
    com = [json.loads(l) for l in open(COMMUNITY, encoding="utf-8")]
    com = [r for r in com if (r.get("notes_real") or 0) > 0]
    random.seed(20261005)
    picks = random.sample(com, min(args.n, len(com)))
    picks += off_rows[:5]
    queries = [{
        "id": r.get("id"), "name": r.get("name"),
        "nps": r["nps"], "hold": (r.get("t_hold") or 0) / max(r["notes_real"], 1),
        "notes": r["notes_real"],
        "stair": r.get("stair_speed_avg") or 0,
        # ⚠️ 必须传归一化后的标签（GUI 传的是预算好的 r.tag），
        #    不是原始 level 字符串 —— 原始串匹配不到任何官谱标签，
        #    会静默回退到「全标签混池」，得到完全不同的估计。
        "level": r.get("level"), "tag": norm_level(r.get("level")),
    } for r in picks]

    js = (consts + "\n"
          # KN 是模块级状态对象（不在函数内），必须一并注入
          + "const KN={Z:null,mu:null,sd:null};\n"
          + fns + "\n"
          + "const OFF=" + off_js + ";\n"
          + "const Q=" + json.dumps(queries, ensure_ascii=False) + ";\n"
          + "console.log(JSON.stringify(Q.map(function(q){"
          + "var p=knnPoint(q.nps,q.hold,q.notes,q.stair,q.tag);"
          + "return [p.point,p.lo,p.hi,p.k];})));\n")

    fd, tmp = tempfile.mkstemp(suffix=".js")
    os.close(fd)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, tmp], capture_output=True, text=True)
    finally:
        os.remove(tmp)
    if r.returncode != 0:
        print("[FAIL] node 执行失败：\n" + r.stderr[:900], file=sys.stderr)
        return 1
    got = json.loads(r.stdout.strip())

    vd = Verdict(rows=off_rows)
    bad = 0
    for q, g in zip(queries, got):
        pe = vd.point_estimate(q["nps"], q["hold"], q["notes"],
                               q["stair"], q["tag"])
        want = [pe["point"], pe["lo"], pe["hi"], pe["k"]]
        ok = all(
            (a is None and b is None) or
            (a is not None and b is not None and abs(a - b) < 1e-6)
            for a, b in zip(want, g))
        if not ok:
            bad += 1
            if bad <= 6:
                print(f"[MISMATCH] {q['name'][:28]:<30} "
                      f"level={q['level']!r}\n"
                      f"           GUI  {g}\n"
                      f"           core {want}")
    print(f"\n抽样 {len(queries)} 张（社区 {min(args.n, len(com))} + 官谱 5），"
          f"k-NN 点估计/区间/近邻数完全一致：{len(queries)-bad}/{len(queries)}")
    if bad:
        print(f"[FAIL] {bad} 张不一致 —— 浏览器端与引擎已漂移", file=sys.stderr)
        return 1
    print("✓ GUI 与 phm/core.py 输出逐谱相同")
    return 0


if __name__ == "__main__":
    sys.exit(main())
