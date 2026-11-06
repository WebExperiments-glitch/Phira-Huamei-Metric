#!/usr/bin/env python3
"""生成序列模型的参考值（golden），供 tools/verify-seq-model.mjs 对拍。

━━━ 为什么要有这个文件 ━━━
序列模型搬进浏览器是「34k 个数按固定顺序做四则运算」。移植写错了**不会报错**，
只会静默偏移 —— 页面照样出数字，每个数都不可信。所以需要一个不在浏览器里的
第二实现当参照系。

━━━ 参照系怎么来（口径很重要）━━━
特征用**当前 Python 代码现场算**（`build_seq_dataset.to_feats` 取前 20 列），
不用数据集 npz 里那份 —— npz 的 feats 是 **float16**（体积换的），
照它算出来的 b 与真值差 1e-4 量级，会把「移植对不对」淹没在存储量化里。
这条口径与 tools/export_engine_v3.py 的自检样本一致：
    「对拍要对着当前代码，否则永远对不上」。

前向用 tools/export_seq_model.py 的 `np_predict`（纯 numpy，已与 torch 对拍 1.5e-07）。

━━━ 两类用例 ━━━
  · chart：data/charts 里 5 张测试谱（55 / 808 / 1113 / 1465 / ≥8000 事件，
           覆盖极短谱到 8,000 截断上限，也覆盖 8 的整数倍与非整数倍）
  · synth：3 条合成序列（n = 1 / 8 / 17），数列在两边都能精确复现，
           **不依赖谱面文件** —— CI 里没有 data/charts 时这条仍能拦住移植错误

用法（需要 numpy + torch，只在本机重新生成时跑一次）：
    python phm-web/tools/gen-seq-golden.py
产物：phm-web/tools/golden-seq.json（提交进仓库，check.mjs 直接读）
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
REPO = os.path.dirname(WEB)
sys.path.insert(0, os.path.join(REPO, "tools"))
from export_seq_model import np_predict          # noqa: E402  已与 torch 对拍过的纯 numpy 前向
from build_seq_dataset import events_of, to_feats  # noqa: E402
from handshape_features import chart_features     # noqa: E402

# 与 export_engine_v4.py 的 EXTENT_METRICS 同一份：8 个值钱的 A_extent 指标
EXTENT_METRICS = {"path", "disp", "eff", "bbox_area", "diag", "aspect", "span_x", "span_y"}

# ⚠ 读**浏览器实际加载的那一份**（phm-web/public/data），不是训练侧的 data/。
#   两份曾经同名不同内容（data/ 还是 v1），对拍就会拿错权重 —— 实测踩过一次：
#   golden 全对、页面全错，因为生成 golden 时读的是旧文件。
WEIGHTS = os.path.join(WEB, "public", "data", "seq-model.json")
CHARTS = os.path.join(REPO, "data", "charts")
OUT = os.path.join(HERE, "golden-seq.json")

# 测试集里按事件数取 5 个分位（55 / 808 / 1113 / 1465 / 8000）
# 与 data/seq-model-result.json 的 preds.ids 同源，都是外层切分剩下的那 1,126 张
CHART_IDS = ["53170", "63210", "27607", "20626", "15183"]
SYNTH_N = [1, 8, 9, 55, 320, 1500]
# 合成序列的逐维量级（让 20 个通道都落在训练分布附近：dt≈0.1s、局部密度≈16、
# 跳跃速度≈5、strain≈3.5 …），比清一色 0~1 更能试出数值问题
SYNTH_SCALE = [0.5, 4.0, 1.0, 0.8, 1.0, 1.0, 1.0, 1.0,
               1.0, 2.0, 0.5, 0.5, 6.0, 1.0, 0.4, 1.0,
               8.0, 40.0, 4.0, 5.0]
PATCH = 8


def synth_seq(n):
    """与 gen 同款的合成序列 —— verify-seq-model.mjs 里有一份逐字对应的实现。

    只用「取模 + 除法 + 乘常数」三种运算，IEEE 754 double 下两边结果逐位相同
    （含负值的 x 通道也覆盖到了）。"""
    return np.array([[(i * 13 + d * 7) % 97 / 97.0 * SYNTH_SCALE[d] - 0.3
                      for d in range(20)] for i in range(n)], dtype=np.float64)


def synth_side(mu, sd):
    """合成 256 维手型（**原始量纲**，未标准化）。

    v2 的头层吃的是标准化后的手型，所以这里围绕 side_mu 上下摆 ±3 个 sd ——
    既不落在常量上（那样测不出拼接口），也不会被 clip 一刀切平。
    公式只含取模、除法、乘加，JS 侧逐字复现（见 verify-seq-model.mjs）。
    ⚠ 顺序写死：先 mu + k*sd，再由前向内部做 (x-mu)/sd。两边都由这一份 mu/sd
      算出，所以只要公式一致，进位也一致。"""
    out = np.empty(256, dtype=np.float64)
    for d in range(256):
        k = ((d * 13 + 7) % 97) / 97.0 * 6.0 - 3.0
        out[d] = mu[d] + k * sd[d]
    return out


def main():
    j = json.load(open(WEIGHTS, encoding="utf-8"))
    W = {k: np.array(v, dtype=np.float64) for k, v in j["weights"].items()}
    mu = np.array(j["meta"]["mu"], dtype=np.float64)
    sd = np.array(j["meta"]["sd"], dtype=np.float64)
    ym, ys = float(j["meta"]["ym"]), float(j["meta"]["ys"])
    n_side = int(j["meta"].get("n_side") or 0)
    smu = ssd = None
    if n_side:
        smu = np.array(j["meta"]["side_mu"], dtype=np.float64)
        ssd = np.array(j["meta"]["side_sd"], dtype=np.float64)
        assert len(smu) == n_side and len(ssd) == n_side, "side 统计量与 n_side 不一致"

    def forward(x64, side):
        n = len(x64)
        z = np_predict(W, (x64 - mu) / sd, np.ones(int(np.ceil(n / PATCH)), dtype=bool), n,
                       side=side)
        b = z * ys + ym
        return b, 1.12 * b + 15.99

    cases = []
    for cid in CHART_IDS:
        path = os.path.join(CHARTS, cid, "chart.json")
        feats = to_feats(events_of(path))[:, :20].astype(np.float64)   # β.3 的 24 维取前 20
        side = None
        if n_side:
            # 与 export_engine_v4.py 的 live_extent 同一口径：只留 8 个 A_extent 指标
            names, vec = chart_features(events_of(path))
            idx = [i for i, nm in enumerate(names) if nm.split("|")[2] in EXTENT_METRICS]
            side = np.clip((vec[idx].astype(np.float64) - smu) / ssd, -8.0, 8.0)
        b, ding = forward(feats, side)
        cases.append({"id": cid, "kind": "chart", "n": int(len(feats)),
                      "b": float(b), "ding": float(ding)})
        print(f"  {cid:>6s}  n={len(feats):5d}  b={b:.6f}  ding={ding:.6f}")

    for n in SYNTH_N:
        side = None if not n_side else np.clip(
            (synth_side(smu, ssd) - smu) / ssd, -8.0, 8.0)
        b, ding = forward(synth_seq(n), side)
        cases.append({"id": f"synth-{n}", "kind": "synth", "n": n,
                      "b": float(b), "ding": float(ding)})
        print(f"  synth-{n:<4d}  n={n:5d}  b={b:.6f}  ding={ding:.6f}")

    out = {"_note": "生成自 phm-web/tools/gen-seq-golden.py；特征=当前 Python to_feats 前 20 列，"
                    "手型=当前 Python handshape_features 的 8 个 A_extent 指标（256 维），"
                    "前向=tools/export_seq_model.py 的 np_predict",
           "meta": {"patch": int(j["meta"]["patch"]), "d_model": int(j["meta"]["d_model"]),
                    "hidden": int(j["meta"]["hidden"]), "d_in": int(j["meta"]["d_in"]),
                    "n_side": n_side, "synth_scale": SYNTH_SCALE},
           "cases": cases}
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"→ {OUT}（{len(cases)} 条）")


if __name__ == "__main__":
    main()
