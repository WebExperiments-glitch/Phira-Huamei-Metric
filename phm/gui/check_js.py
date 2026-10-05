#!/usr/bin/env python3
"""单文件版 JS 语法体检：定位语法错误与括号失衡

（构建脚本 build_standalone.py 已在构建时做语法自检；
  本脚本用于产物出错后做逐行定位，故保留。）
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_standalone import _find_node   # noqa: E402

NODE = _find_node()
HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "P.H.M..html")


def main():
    if not NODE:
        print("[abort] 未找到 node")
        return 1
    p = os.path.abspath(HTML)
    h = open(p, encoding="utf-8").read()
    m = re.search(r"<script>([\s\S]*?)</script>", h)
    if not m:
        print("[abort] 未找到 <script>")
        return 1
    s = m.group(1)

    js = os.path.join(os.path.dirname(p), "_check.js")
    open(js, "w", encoding="utf-8").write(s)

    r = subprocess.run([NODE, "--check", js], capture_output=True, text=True)
    print("Node --check 退出码:", r.returncode)

    lines = s.split("\n")
    if r.returncode == 0:
        print("✓ 语法 OK")
        os.remove(js)
        return 0

    out = r.stderr
    print(out[:900])
    mm = re.search(r"_check\.js:(\d+)", out)
    if mm:
        ln = int(mm.group(1))
        print("\n=== 出错行 %d 上下文 ===" % ln)
        for i in range(max(0, ln - 6), min(len(lines), ln + 3)):
            mark = ">>" if i + 1 == ln else "  "
            print("%s%5d: %s" % (mark, i + 1, lines[i][:130]))
    os.remove(js)
    return 1


if __name__ == "__main__":
    sys.exit(main())
