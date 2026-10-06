#!/usr/bin/env python3
"""
JS 引擎 ↔ Python 管线 特征一致性校验

背景：P.H.M. Standard（phm/PHM-Standard.html）在浏览器端独立实现了
谱面解析 + 特征提取 + PS 公式。复制必然漂移——本脚本把两边的输出
逐维比对，任何一处不一致 → 退出码 1。

流程：
  1. Python 侧：用 tools/enhance_features_v3.py + tools/dims14.py（交付管线的
     同一套算法）对样本谱面计算特征 → 期望值
  2. JS 侧：从 PHM-Standard.html 抽出引擎 <script>，在 node 里对同一批文件
     跑 analyzeChart()
  3. 逐维比对（浮点相对误差 ≤ 1e-9）

用法：python tools/js_parity_check.py
"""
import json
import os
import re
import subprocess
import tempfile
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, BASE)

HTML = os.path.join(ROOT, "phm", "PHM-Standard.html")
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


def pick_samples(n=5):
    """从社区谱挑跨度样本（与 D:/phira-ipa/test-zips 相同的 5 张）"""
    import json
    rows = [json.loads(l) for l in
            open(os.path.join(ROOT, "data", "community.jsonl"), encoding="utf-8")]
    picks, seen = [], set()
    for lo, hi in ((3, 5), (7, 9), (12, 13), (15, 16), (16.5, 18)):
        cands = [r for r in rows
                 if lo <= (r.get("difficulty") or 0) <= hi
                 and (r.get("notes_real") or 0) > 300
                 and r["id"] not in seen and r.get("format") == "rpe"]
        cands.sort(key=lambda r: (r.get("notes_real") or 0))
        r = cands[len(cands) // 2] if cands else None
        if r:
            seen.add(r["id"])
            picks.append(r)
    return picks


def expected_features(picks):
    """Python 侧：与交付管线同算法（add_community_dims.read_* + dims14 +
    enhance_features_v3 的 strain/rhythm）计算特征"""
    import add_community_dims as acd
    import enhance_features_v3 as v3
    out = []
    for r in picks:
        d = os.path.join(ROOT, "data", "charts", str(r["id"]))
        src = os.path.join(d, r.get("chart_file") or "chart.json")
        if not os.path.exists(src):
            src = os.path.join(d, "chart.json")
        notes, ev, bpm = acd.load_chart(src)
        if len(notes) < 2:
            raise SystemExit(f"[abort] {src} 音符不足")
        notes.sort(key=lambda x: (x[0], x[1]))
        ts = [x[0] for x in notes]
        ty = [x[2] for x in notes]
        dur = max(1e-3, ts[-1] - ts[0])
        f = {}
        f.update(v3.strain_features(ts, ty))
        f.update(v3.rhythm_features(ts))
        f.update(acd.extract_dims(notes, ev, dur, bpm,
                                  len({x[5] for x in notes})))
        f["notes_real"] = len(notes)
        f["duration_s"] = dur
        f["bpm"] = bpm
        out.append({"name": r["name"], "feats": f})
    return out


def extract_engine_js(html):
    m = re.search(r'<script id="engine">(.*?)</script>', html, re.S)
    if not m:
        raise SystemExit("[abort] PHM-Standard.html 缺少 engine script")
    return m.group(1)


def main():
    if not NODE:
        print("[abort] 未找到 node", file=sys.stderr)
        return 1
    picks = pick_samples()
    print(f"[1] 样本 {len(picks)} 张")
    exp = expected_features(picks)

    html = open(HTML, encoding="utf-8").read()
    js = extract_engine_js(html)

    # node 侧：把谱面打成 .pez（与用户实际放入的文件同构）再喂给 JS 引擎
    import zipfile
    files = []
    tmpdir = tempfile.mkdtemp(prefix="phm-parity-")
    for i, r in enumerate(picks, 1):
        d = os.path.join(ROOT, "data", "charts", str(r["id"]))
        src = os.path.join(d, r.get("chart_file") or "chart.json")
        if not os.path.exists(src):
            src = os.path.join(d, "chart.json")
        zp = os.path.join(tmpdir, f"parity-{i}.pez")
        with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(src, "chart.json")
        files.append(zp)
    harness = (
        js
        + "\nconst fs=require('fs');"
        + "const FILES=" + json.dumps(files) + ";"
        + "(async()=>{const out=[];"
        + "for(const f of FILES){"
        + "const rs=await analyzeChart(new Uint8Array(fs.readFileSync(f)).buffer,f);"
        + "out.push(rs[0]);}"
        + "console.log(JSON.stringify(out.map(r=>({name:r.name,ps:r.ps.total,"
        + "g:r.ps.g,feats:r.feats}))));})().catch(e=>{console.error(String(e));"
        + "process.exit(1);});\n")
    fd, tmp = tempfile.mkstemp(suffix=".js")
    os.close(fd)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(harness)
    r = subprocess.run([NODE, tmp], capture_output=True, text=True)
    os.remove(tmp)
    if r.returncode != 0:
        print("[FAIL] node 执行失败：\n" + r.stderr[:900], file=sys.stderr)
        return 1
    got = json.loads(r.stdout.strip())

    # 逐维比对
    KEYS = [k for k in exp[0]["feats"]
            if not k.startswith("_") and not k.startswith("jline_")]
    print("[diag] 音符数（py _tn vs js notes_real）:",
          [(e["feats"].get("_tn"), g["feats"].get("notes_real"))
           for e, g in zip(exp, got)])
    bad = 0
    for e, g in zip(exp, got):
        fe, fg = e["feats"], g["feats"]
        diffs = []
        for k in KEYS:
            a, b = fe.get(k), fg.get(k)
            if a is None or b is None:
                continue
            denom = max(abs(a), abs(b), 1e-9)
            if abs(a - b) / denom > 1e-9:
                diffs.append((k, a, b))
        if diffs:
            bad += 1
            print(f"[MISMATCH] {e['name'][:26]}")
            for k, a, b in diffs[:8]:
                print(f"    {k:<34} py={a!r}  js={b!r}")
    print(f"\n比对维度 {len(KEYS)} 个 × {len(exp)} 张："
          f"一致 {len(exp)-bad}/{len(exp)}")
    if bad:
        print("[FAIL] JS 引擎与 Python 管线漂移", file=sys.stderr)
        return 1
    print("✓ JS 引擎与 Python 管线逐维一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
