"""节奏/时序侧三组新特征 A/B（补空间之外的另一个方向）。

来源：用户给的特征清单里我们**没做过**的三条。
  ① syncopation  反直觉采音 —— 音符偏离 16 分音符网格的程度（拍位是 RPE 原生数据，无需音频）
  ② burst_rest   爆发-休息比 —— 峰值 5s 物量 / 之后 2s 物量（现在只有 0.125~1s 的窗口）
  ③ dens_slope   密度走势 —— 5s 分箱密度的线性斜率与二阶差分（断崖式难度的代理）

━━━ 口径 ━━━
基线与实验组**只差这一块**：同一个 `to_feats` + 同一个 `pool` + 同一个 Ridge（带截距）。
助手函数从已修的 `ab-align-phiraiad.py` 导入，不重写（AI-PITFALLS D4）。
"""
import glob
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import chart_io
from build_seq_dataset import to_feats

_spec = importlib.util.spec_from_file_location("abf", os.path.join(HERE, "ab-align-phiraiad.py"))
abf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abf)          # 复用 pool / cv_eval / boot_ci / spearman

GRID = 0.25      # 16 分音符


def _beats(path):
    """从 RPE 原始 JSON 取每个音符的拍位（bar + num/den）。非 RPE 返回 None。"""
    with open(path, encoding="utf-8", errors="replace") as f:
        head = f.read(1)
    if head.strip() != "{":
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    out = []
    for ln in d.get("judgeLineList") or []:
        for nt in ln.get("notes") or []:
            st = nt.get("startTime")
            if not st:
                continue
            bar, num = float(st[0]), float(st[1])
            den = float(st[2]) if len(st) > 2 and st[2] else 1.0
            out.append(bar + num / den)
    return np.array(out, float) if out else None


def new_feats(ev, path):
    t = np.array([e[0] for e in ev], float)
    n = len(t)
    f = []

    # ① syncopation
    bt = _beats(path)
    if bt is not None and len(bt) > 8:
        ph = np.mod(bt / GRID, 1.0)                  # 0..1 表示落在 16 分网格之间的位置
        dev = np.minimum(ph, 1.0 - ph) * 2           # 0=正网格, 1=最偏离
        f += [float((dev > 0.2).mean()), float(dev.mean()), float(np.percentile(dev, 90)),
              float(np.std(np.diff(bt)) if len(bt) > 2 else 0.0)]
    else:
        f += [0.0, 0.0, 0.0, 0.0]

    # ② burst-rest：对每个音符看「前 5s 物量 / 后 2s 物量」
    i5 = np.searchsorted(t, t + 5.0, side="right") - np.arange(n)
    i2 = np.searchsorted(t, t + 2.0, side="right") - np.arange(n)
    ratio = i5 / np.maximum(i2, 1)
    f += [float(np.median(ratio)), float(np.percentile(ratio, 90)), float(ratio.max()),
          float(i5.max() / max(n, 1))]

    # ③ 5 秒分箱的密度走势
    dur = max(t[-1] - t[0], 1e-3)
    nb = max(int(dur / 5.0), 1)
    idx = np.minimum(((t - t[0]) / dur * nb).astype(int), nb - 1)
    dens = np.bincount(idx, minlength=nb) / (dur / nb)
    if nb >= 3:
        xs = np.arange(nb, dtype=float)
        slope = float(np.polyfit(xs, dens, 1)[0])
        d2 = float(np.abs(np.diff(dens, 2)).max())
        f += [slope, d2, float(dens.std() / (dens.mean() + 1e-6)), float(dens.max() / (dens.mean() + 1e-6))]
    else:
        f += [0.0, 0.0, 0.0, 1.0]
    return np.array(f, float)


def main(n=1500):
    z = np.load("data/seq-dataset-v0.1-beta.2.npz", allow_pickle=True)
    ids = [str(x) for x in z["ids"]]
    y = np.asarray(z["y"], float)
    files = {os.path.basename(os.path.dirname(p)): p for p in glob.glob("data/charts/*/chart.*")}

    A, B, Y, kept = [], [], [], []
    for k, cid in enumerate(ids[:n] if n else ids):
        p = files.get(cid)
        if not p:
            continue
        try:
            ev = chart_io.load_events(p)
            if len(ev) < 20:
                continue
            base = abf.pool(to_feats(ev))
            nf = new_feats(ev, p)
        except Exception:
            continue
        A.append(base); B.append(np.concatenate([base, nf])); Y.append(y[k]); kept.append(cid)
        if len(kept) % 300 == 0:
            print(f"  {len(kept)} 张…", flush=True)
    A, B, Y = np.stack(A), np.stack(B), np.array(Y)
    print(f"可用 {len(Y)} 张，基线 {A.shape[1]} 维 → 实验 {B.shape[1]} 维", flush=True)

    for name, X in [("基线20维", A), ("+节奏时序12维", B)]:
        rho, mae, pred, te = abf.cv_eval(X, Y, 10.0)
        print(f"{name:14s} ρ={rho:.4f}  MAE={mae:.4f}  n_test={len(te)}", flush=True)
        if name.startswith("+节奏"):
            lo, hi = abf.boot_ci(resp[0], pred, Y[te], 1000)
            print(f"  Δρ={rho-resp[1]:+.4f}  95%CI [{lo:+.4f}, {hi:+.4f}]", flush=True)
        else:
            resp = (pred, rho, mae)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1500)
