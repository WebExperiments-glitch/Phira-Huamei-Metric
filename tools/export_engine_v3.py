#!/usr/bin/env python3
"""导出 20 维「移动/夹角/应变」模型给网页引擎用 → phm-web/public/data/engine-v3.json

━━━ 为什么单独做 v3 ━━━
站点现役的 v2 是 **37 维手工统计量**（对玩家行为难度 β 的 ρ 0.774）。
离线这条路后来做了 20 维**事件序列**特征（移动距离 / 跳跃速度 / 三连音夹角 /
和弦 / 局部密度 / running strain），配上 142 个权重的岭回归到 **0.8024**。

v3 = 把那个模型原样搬过来。做三件事：
  1. 用同一套切分（seed 20261028、85%）重训，保证和离线报的数字可对
  2. 把 mu/sd/w/b 和「b → 定数」的映射一起写进 JSON
  3. 写一份 **自检样本**（若干张谱的 142 维池化向量 + 期望输出），
     供 JS 端做逐位对拍 —— 移植最怕"看起来对、其实差一点"

用法：python tools/export_engine_v3.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)

from bench_suite import Ridge, load_inputs, pooled_vector, spearman  # noqa: E402

OUT = os.path.join(ROOT, "phm-web", "public", "data", "engine-v3.json")
SEED = 20261028
ALPHA = 10.0
# b → 定数：用「真的填了定数」的谱拟合（标称 ≥5、玩家 ≥200），见 gen_discrepancy.py
B2D_SLOPE, B2D_INTER = 1.12, 15.99



def live_pooled(cid):
    """用当前代码从谱面文件现场算 142 维池化向量（与 JS 对拍的基准）。"""
    import numpy as np
    from build_seq_dataset import events_of, to_feats
    path = os.path.join(ROOT, "data", "charts", cid, "chart.json")
    a = to_feats(events_of(path)).astype(np.float64)
    # to_feats 现在是 24 维（beta.3 加了 1s 窗口/按住数/加权/屏幕位移），
    # 而线上模型是按 **20 维** 训的（beta.2）。前 20 列完全一致，取切片。
    # ⚠ 两者不能混用：24 维池化是 170 维，权重是 142 维，直接相乘会 broadcast 报错。
    a = a[:, :20]
    q = np.percentile(a, [10, 50, 90], axis=0)
    return np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0),
                           q.ravel(), [len(a), a[:, 0].sum()]])


def main():
    d = load_inputs()
    ids, y = d["ids"], d["y"]
    n = len(y)
    perm = np.random.default_rng(SEED).permutation(n)
    cut = int(n * 0.85)
    tr = [ids[i] for i in perm[:cut]]

    m = Ridge(alpha=ALPHA).fit(tr, y[perm[:cut]])
    Xall = np.stack([pooled_vector(d["index"][c]) for c in ids])
    pred = (Xall - m.mu) / m.sd @ m.w + m.b
    rho = spearman(pred.tolist(), y.tolist())

    print(f"训练 {len(tr)} 张 · 全量 ρ(b) = {rho:.4f} · 权重 {len(m.w)}")

    # 自检样本：取 5 张，**现场重算**池化向量（不读 npz）。
    # 为什么不读 npz：数据集是某个时间点用当时的代码建的，和"现在的 Python"
    # 可能不一致（实测 Σdt 差 0.065）。对拍要对着**当前代码**，否则永远对不上。
    pick = [ids[i] for i in perm[cut:cut + 5]]
    checks = []
    for c in pick:
        i = d["index"][c]
        v = live_pooled(c)
        b = float((v - m.mu) / m.sd @ m.w + m.b)
        checks.append({"id": c, "pooled": [round(float(t), 6) for t in v],
                       "b": round(b, 6), "ding": round(B2D_SLOPE * b + B2D_INTER, 4)})

    payload = {
        "note": ("v3 引擎：20 维事件序列特征（移动/跳速/夹角/和弦/密度/strain）"
                 "→ 142 维池化 → 岭回归 → IRT 难度 b → 定数映射"),
        "target": "irt-b",
        "alpha": ALPHA,
        "split": {"seed": SEED, "trim": 0.85, "n_train": len(tr)},
        "rho_vs_b": round(float(rho), 4),
        "dims": 20,
        "mu": [round(float(t), 8) for t in m.mu],
        "sd": [round(float(t), 8) for t in m.sd],
        "w": [round(float(t), 8) for t in m.w],
        "b": float(m.b),
        "b2d": {"slope": B2D_SLOPE, "inter": B2D_INTER},
        "checks": checks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"写出 {OUT}（{os.path.getsize(OUT)/1024:.0f} KB）")
    for c in checks:
        print(f"  自检 {c['id']}: b={c['b']:.4f} → 定数 {c['ding']:.2f}")


if __name__ == "__main__":
    main()
