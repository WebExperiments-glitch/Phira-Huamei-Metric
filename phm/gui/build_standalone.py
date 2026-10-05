#!/usr/bin/env python3
"""
构建单文件版 P.H.M.

把 index.html + 数据打包成一个 .html，双击即可打开。
不需要 Python、不需要起 HTTP 服务、不需要联网。

体积预估：HTML 40KB + 数据 3.7MB ≈ 3.8MB
浏览器解析 3.7MB JSON 约 0.3 秒，可接受。
"""
import argparse
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))


def _find_node():
    """定位可用的 node：先用环境/托管版本，再退回 PATH。

    之前这里把 node 路径硬编码到某一个托管版本号，一旦版本升级就静默跳过
    语法自检（产物照样写出，等于自检失效）。改为候选列表 + PATH 兜底。
    """
    import shutil
    cands = [
        os.environ.get("PHM_NODE"),
        r"C:\Users\30500\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
        r"C:\Program Files\nodejs\node.exe",
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return shutil.which("node")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=os.path.join(BASE, "index.html"))
    ap.add_argument("--data", default=os.path.join(BASE, "data"))
    ap.add_argument("--out", default=os.path.join(BASE, "..", "P.H.M..html"))
    args = ap.parse_args()

    with open(args.index, encoding="utf-8") as fp:
        html = fp.read()

    com = open(os.path.join(args.data, "community.jsonl"),
               encoding="utf-8").read()
    off = open(os.path.join(args.data, "official.jsonl"),
               encoding="utf-8").read()

    # 转成 JS 数组字面量，避免运行时 split/parse 开销
    com_arr = "[" + ",".join(
        l for l in com.split("\n") if l.strip()) + "]"
    off_arr = "[" + ",".join(
        l for l in off.split("\n") if l.strip()) + "]"

    # ---- 1. 替换数据声明 ----
    # ⚠️ index.html 里已有 `let DATA=[],OFF=[],IDX=new Map(),CUR=null;`
    #    直接再写 const DATA= 会导致「重复声明」语法错误
    decl = ("let DATA=" + com_arr + ";\n"
            "let OFF=" + off_arr + ";\n"
            "let IDX=new Map();let CUR=null;\n")
    old = "let DATA=[],OFF=[],IDX=new Map(),CUR=null;"
    if old not in html:
        print(f"[abort] 未找到声明行：{old}", file=sys.stderr)
        return 1
    html = html.replace(old, decl, 1)

    # ---- 2. 替换 boot() 函数体（原用 fetch 取数据）----
    # ⚠️ 两个坑：
    #  1) 不能用 rfind('boot();') 定位终点 —— show() 等函数定义在 boot() 与末尾调用之间，
    #     会被一起吞掉。必须用大括号配平。
    #  2) 配平时 k 指向「结束大括号之后」，即 html[k] 是 boot() 闭合的 } 的下一个字符。
    #     所以 tail 必须从 k-1 开始（把那个 } 留住），否则函数缺右括号。
    head = "async function boot(){"
    i = html.find(head)
    if i < 0:
        print("[abort] 未找到 boot() 标记", file=sys.stderr)
        return 1

    k = i + len(head)          # 指向 boot() 的 {（本身不计入 depth）
    depth = 1
    while depth > 0 and k < len(html):
        c = html[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        k += 1
    # k 现在指向「结束 } 的下一个字符」
    close = k - 1              # 结束 } 的位置
    if html[close] != "}":
        print("[abort] 括号配平异常，close=%r" % html[close], file=sys.stderr)
        return 1
    tail = html[close:]        # 从 } 开始，保留闭合

    new_body = (
        "\n  try{\n"
        "    IDX=new Map(DATA.map(r=>[r.id,r]));\n"
        "    const ORDER=['EZ','HD','IN','AT','SP'];\n"
        "    const rk=x=>{const i=ORDER.indexOf(x);return i<0?99:i};\n"
        "    const lvs=[...new Set(DATA.map(r=>r.tag).filter(Boolean))]\n"
        "      .sort((a,b)=>rk(a)-rk(b)||a.localeCompare(b));\n"
        "    let opts=lvs.map(x=>'<option value=\"'+x+'\">'+x+'</option>').join('');\n"
        "    if(DATA.some(r=>!r.tag))opts+="
        "'<option value=\"\\x00none\">其他/未标注</option>';\n"
        "    const el=document.getElementById('lv');\n"
        "    el.innerHTML='<option value=\"\">全部难度</option>'+opts;\n"
        "    if(DATA.length)show(DATA[0].id);\n"
        "  }catch(e){\n"
        "    document.getElementById('view').innerHTML="
        "'<div class=\"empty\" style=\"color:var(--bad)\">载入失败：'+e.message+'</div>';\n"
        "  }\n"
    )
    # 只替换函数体（保留 head 的语义：改成非 async）
    html = html[:i] + "function boot(){" + new_body + tail

    # 末尾的 boot(); 保持不变（单文件版仍需启动）

    out = os.path.abspath(args.out)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)

    # ---- 3. 语法自检：产物必须能被解析，否则不报成功 ----
    import re
    import subprocess
    import tempfile
    m = re.search(r"<script>([\s\S]*?)</script>", html)
    if not m:
        print("[FAIL] 产物中找不到 <script>", file=sys.stderr)
        return 1

    # ---- 3b. 数据量自检：产物内嵌行数必须等于源文件行数 ----
    # 教训：单文件版曾出现「数据已更新但 HTML 用旧数据」，因为构建没跟流水线走。
    #      校验对象必须是【产物】，不是源文件。
    # 数组由 json.dumps 行拼接，本身即合法 JSON，直接解析最可靠
    # （用正则数 `{"id":` 会漏掉官谱——它的 id 是别名后置的）。
    n_com = sum(1 for l in com.split("\n") if l.strip())
    n_off = sum(1 for l in off.split("\n") if l.strip())
    try:
        got_com = len(json.loads(com_arr))
        got_off = len(json.loads(off_arr))
    except json.JSONDecodeError as e:
        print(f"[FAIL] 内嵌数组不是合法 JSON：{e}", file=sys.stderr)
        return 1
    if (got_com, got_off) != (n_com, n_off):
        print(f"[FAIL] 内嵌数据量与源不符："
              f"社区 {got_com}/{n_com}，官谱 {got_off}/{n_off}",
              file=sys.stderr)
        return 1
    print(f"[check] 内嵌数据量 社区 {got_com} + 官谱 {got_off} ✓")

    node = _find_node()
    if not node:
        print("[warn] 未找到 node，跳过 JS 语法自检（产物仍已写出）",
              file=sys.stderr)
    else:
        fd, tmp = tempfile.mkstemp(suffix=".js")
        os.close(fd)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(m.group(1))
        r = subprocess.run([node, "--check", tmp],
                           capture_output=True, text=True)
        os.remove(tmp)
        if r.returncode != 0:
            print("[FAIL] 产物 JS 语法错误：", file=sys.stderr)
            print(r.stderr[:800], file=sys.stderr)
            return 1
        print(f"[check] JS 语法 OK（{os.path.basename(node)}）")

    # ---- 4. 关键内容自检：防止替换吞掉代码 ----
    need = ["function show(", "<details", 'class="vcard"',
            "特征对照", "官谱参照", "body.prof", "data-theme"]
    miss = [k for k in need if k not in html]
    if miss:
        print(f"[FAIL] 产物缺失关键内容：{miss}", file=sys.stderr)
        return 1
    n_fetch = len(re.findall(r"fetch\(", m.group(1)))
    if n_fetch:
        print(f"[FAIL] 产物仍有 {n_fetch} 个 fetch（未内嵌）", file=sys.stderr)
        return 1
    print("[check] 关键内容齐全，无 fetch")

    size = os.path.getsize(out)
    print(f"[done] {out}")
    print(f"       {size/1048576:.2f} MB  （双击即可打开，无需服务）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
