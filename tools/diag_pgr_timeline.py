#!/usr/bin/env python3
"""官谱 PGR 时间轴诊断"""
import glob
import json
import os
import statistics as st

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "_research", "pgr"))

spans = []
for f in glob.glob("chart/*/IN.json"):
    try:
        with open(f, encoding="utf-8") as fp:
            j = json.load(fp)
    except Exception:
        continue
    L = j.get("judgeLineList") or []
    t = [n.get("time", 0) or 0 for ln in L
         for k in ("notesAbove", "notesBelow") for n in (ln.get(k) or [])]
    if not t:
        continue
    bpms = [ln.get("bpm") for ln in L if ln.get("bpm")]
    name = os.path.basename(os.path.dirname(f))
    spans.append(((max(t) - min(t)) / 1000.0, name,
                  bpms[0] if bpms else None, len(t)))

spans.sort()
sv = [s for s, _, _, _ in spans]
print("样本:", len(spans))
print("音符时间跨度: 最短 %.1fs  中位 %.1fs  最长 %.1fs"
      % (min(sv), st.median(sv), max(sv)))
print()
print("最短 6:")
for s, nm, b, n in spans[:6]:
    print("  %7.1fs  %-32s BPM=%-6s 物量=%4d NPS=%5.1f"
          % (s, nm[:30], b, n, n / max(s, 0.01)))
print("最长 3:")
for s, nm, b, n in spans[-3:]:
    print("  %7.1fs  %-32s BPM=%-6s 物量=%4d NPS=%5.1f"
          % (s, nm[:30], b, n, n / max(s, 0.01)))

nps = sorted(n / max(s, 0.01) for s, _, _, n in spans)
print()
print("NPS 分布: 最短 %.1f  中位 %.1f  最长 %.1f"
      % (nps[0], nps[len(nps) // 2], nps[-1]))
print()
print("物量分布: 中位 %.0f" % st.median([n for _, _, _, n in spans]))
print("BPM 分布: 中位 %.0f" % st.median([b for _, _, b, _ in spans if b]))
