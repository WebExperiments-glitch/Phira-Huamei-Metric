#!/usr/bin/env python3
"""从 `handshape-cache-v1.npz`（1,472 维）切出 A_extent 的 **256 维**并补齐缺谱。

━━━ 为什么是这 8 个指标 ━━━
`docs/结果/片段手型特征-A-B.md` 的结论：A 组内部「包围盒/跨度」这 8 个指标
（`bbox_area / diag / span_x / span_y / aspect / path / disp / eff`）值 +0.061，
其余 38 个指标值 ≈0。全量 1,472 维是过拟合，故生产只带 256 维。

━━━ 数据来源（必须说清）━━━
- 7,492 张直接复用 `handshape-cache-v1.npz`（同一份 `handshape_features.py` 的输出，
  逐位可比）。切片按**名称**取，不按列号猜。
- 12 张谱（`handshape-ab.json::handshape_missing_ids`）当时因
  `chart_io._line_tracks` 缺 null 图层保护而解析失败、被填 0；本脚本用**已修复**的
  chart_io 重算真值。
- 抽样 20 张与缓存逐位对拍，防止 `chart_io` 的改动悄悄改变既有特征。

输出 `data/handshape-extent-v1.npz`：ids（与 seq 数据集同序）+ E（n×256）+ 修复标记。

用法：
    python tools/build_handshape_extent.py
    python tools/build_handshape_extent.py --verify 40
"""
import argparse
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

DATA = os.path.join(ROOT, "data")
SEQ = os.path.join(DATA, "seq-dataset-v0.1-beta.2.npz")
CACHE_V1 = os.path.join(DATA, "handshape-cache-v1.npz")
AB = os.path.join(DATA, "handshape-ab.json")
OUT = os.path.join(DATA, "handshape-extent-v1.npz")

EXTENT = ["bbox_area", "diag", "span_x", "span_y", "aspect", "path", "disp", "eff"]


def _find_chart(d):
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            return os.path.join(d, f)
    return None


def compute_one(cid):
    from build_seq_dataset import events_of
    from handshape_features import chart_features
    p = _find_chart(os.path.join(DATA, "charts", cid))
    if not p:
        raise FileNotFoundError(cid)
    ev = events_of(p)
    if len(ev) < 20:
        raise ValueError("short<20")
    return chart_features(ev)[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", type=int, default=20,
                    help="随机抽 n 张与缓存逐位对拍（0 = 跳过）")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    z = np.load(SEQ, allow_pickle=False)
    ids = [str(x) for x in z["ids"]]
    n = len(ids)

    c = np.load(CACHE_V1, allow_pickle=False)
    c_ids = [str(k) for k in c["ids"]]
    H = c["H"]
    have = {c: i for i, c in enumerate(c_ids)}

    from handshape_features import feature_names, METRIC_NAMES
    names = feature_names()
    metric = [nm.split("|")[2] for nm in names]
    cols = np.array([i for i, m in enumerate(metric) if m in EXTENT], dtype=np.int64)
    assert cols.size == len(EXTENT) * 4 * 8, cols.size        # 8 指标 × 4 切法 × 8 统计
    print(f"切片：{cols.size} 维（{len(EXTENT)} 指标 × 4 切法 × 8 统计）")

    # ── 抽样对拍（当前 chart_io vs 缓存当时的 chart_io）──
    if a.verify:
        rng = np.random.default_rng(20261105)
        pool = [i for i in ids if i in have]
        pick = [pool[k] for k in rng.choice(len(pool), min(a.verify, len(pool)), replace=False)]
        worst = 0.0
        for cid in pick:
            v = compute_one(cid)
            d = float(np.abs(v - H[have[cid]]).max())
            worst = max(worst, d)
        print(f"抽样 {len(pick)} 张：与缓存 max|Δ| = {worst:.3e} "
              f"→ {'一致' if worst < 1e-6 else '⚠ 不一致'}")
        assert worst < 1e-6, "chart_io 改动影响了既有特征，先查清再继续"

    # ── 补齐缺谱 ──
    miss = [i for i in ids if i not in have]
    print(f"缓存缺 {len(miss)} 张：{miss}")
    t0 = time.time()
    fixed = {}
    for cid in miss:
        try:
            fixed[cid] = compute_one(cid)
        except Exception as e:                                   # noqa: BLE001
            print(f"  ✗ {cid}: {type(e).__name__} {e}")
    print(f"重算 {len(fixed)}/{len(miss)} 张（{time.time() - t0:.0f}s）")

    E = np.zeros((n, cols.size), dtype=np.float32)
    used_cache, used_new, zero_fill = 0, 0, []
    for i, cid in enumerate(ids):
        if cid in have:
            E[i] = H[have[cid]][cols]
            used_cache += 1
        elif cid in fixed:
            E[i] = fixed[cid][cols]
            used_new += 1
        else:
            zero_fill.append(cid)
    print(f"组装：缓存 {used_cache} · 重算 {used_new} · 仍缺失填 0 {len(zero_fill)}")
    if zero_fill:
        print("  ", zero_fill[:10])

    np.savez_compressed(a.out, ids=np.array(ids), E=E,
                        names=np.array([names[j] for j in cols]),
                        repaired=np.array(sorted(fixed)))
    print(f"→ {a.out}（{n} 张 × {E.shape[1]} 维，"
          f"{os.path.getsize(a.out) / 1e6:.1f} MB）")

    meta = {"n": n, "n_dims": int(cols.size), "n_from_cache": used_cache,
            "n_recomputed": used_new, "zero_filled": zero_fill,
            "metrics": EXTENT}
    json.dump(meta, open(os.path.join(DATA, "handshape-extent-meta.json"), "w",
                         encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
