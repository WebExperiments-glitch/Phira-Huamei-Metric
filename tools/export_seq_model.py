#!/usr/bin/env python3
"""把训练好的序列模型导成纯数值 JSON，并用 numpy 复算验证与 torch 逐位一致。

为什么要有这一步：生产端是浏览器（纯 JS，无 PyTorch/ONNX 运行时）。
岭回归能上线就是因为它只是 142 次乘法。序列模型想上线，
必须证明「同样的算子，JS 也写得出、且数值对得上」。

用法：
    python tools/export_seq_model.py                       # 导出 + 验证
    python tools/export_seq_model.py --ckpt data/seq-model-s1.pt
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from train_seq_model import DATA, PATCH, SeqDiffNet, stack_patches  # noqa: E402


def erf(x):
    """Abramowitz-Stegun 7.1.26，|误差| < 1.5e-7 —— JS 端照抄这一段即可。"""
    s = np.sign(x)
    x = np.abs(x)
    t = 1.0 / (1.0 + 0.3275911 * x)
    y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
                - 0.284496736) * t + 0.254829592) * t * np.exp(-x * x)
    return s * y


def gelu(x):
    return 0.5 * x * (1.0 + erf(x / math.sqrt(2.0)))


def layer_norm(x, w, b, eps=1e-5):
    mu = x.mean(-1, keepdims=True)
    var = x.var(-1, keepdims=True)
    return (x - mu) / np.sqrt(var + eps) * w + b


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def torch_gru_np(W, h, suf):
    """严格按 PyTorch 定义实现：r,u,n = σ(W_ir x + b_ir + W_hr h + b_hr) …
    n = tanh(W_in x + b_in + r ⊙ (W_hn h + b_hn))；h' = (1-u) ⊙ n + u ⊙ h
    """
    wi, wh = W["gru.weight_ih_l0" + suf], W["gru.weight_hh_l0" + suf]
    bi, bh = W["gru.bias_ih_l0" + suf], W["gru.bias_hh_l0" + suf]
    H = wh.shape[1]
    T = h.shape[0]
    hh = np.zeros(H)
    seq = np.zeros((T, H))
    order = range(T) if suf == "" else range(T - 1, -1, -1)
    for t in order:
        gi = h[t] @ wi.T + bi
        gh = hh @ wh.T + bh
        r = sigmoid(gi[:H] + gh[:H])
        u = sigmoid(gi[H:2 * H] + gh[H:2 * H])
        n = np.tanh(gi[2 * H:] + r * gh[2 * H:])
        hh = (1 - u) * n + u * hh
        seq[t] = hh
    return seq


def np_predict(W, x_std, tok, lens, patch=PATCH, side=None):
    T = int(np.ceil(lens / patch))
    Lp = T * patch
    xp = np.zeros((Lp, x_std.shape[1]))
    xp[:lens] = x_std
    pm = np.zeros(Lp, dtype=bool)
    pm[:lens] = True
    xf = xp.reshape(T, patch, -1)
    pmf = pm.reshape(T, patch)
    nvalid = pmf.sum(-1).astype(np.float64)
    dt = (xf[..., 0] * pmf).sum(-1)
    feats = np.concatenate([xf.reshape(T, patch * x_std.shape[1]),
                            dt[:, None], (nvalid / patch)[:, None]], -1)
    z = feats @ W["embed.0.weight"].T + W["embed.0.bias"]
    z = gelu(layer_norm(z, W["embed.1.weight"], W["embed.1.bias"]))
    z = z * np.asarray(tok[:T], dtype=np.float64)[:, None]
    d = z.shape[1]
    k = W["dw.weight"].shape[-1]
    pad = k // 2
    zp = np.pad(z, ((pad, pad), (0, 0)))
    dw = np.zeros((T, d))
    for j in range(k):
        dw += zp[j:j + T] * W["dw.weight"][:, 0, j]
    h = z + (gelu(dw + W["dw.bias"]) @ W["pw.weight"][:, :, 0].T + W["pw.bias"])
    h = layer_norm(h, W["norm.weight"], W["norm.bias"])
    hf = torch_gru_np(W, h, "")
    hb = torch_gru_np(W, h, "_reverse")
    hh = np.concatenate([hf, hb], -1)
    a = hh @ W["att.weight"].T + W["att.bias"]
    a = a[:, 0]
    a = np.where(np.asarray(tok[:T], bool), a, -1e4)
    w = np.exp(a - a.max())
    w /= w.sum()
    g = (w[:, None] * hh).sum(0)
    g = layer_norm(g, W["head.0.weight"], W["head.0.bias"])
    if side is not None:
        g = np.concatenate([g, side], -1)
    return float((g @ W["head.1.weight"].T).ravel()[0] + W["head.1.bias"][0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=os.path.join(ROOT, "data", "seq-model-s1.pt"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "seq-model.json"))
    ap.add_argument("--n-verify", type=int, default=8)
    ap.add_argument("--handshape", default=None,
                    help="带谱级手型特征的模型：传 build_handshape_extent.py 的 npz")
    args = ap.parse_args()

    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    sd = ck["model"]
    W = {k: v.detach().cpu().numpy().astype(np.float64) for k, v in sd.items()}

    z = np.load(DATA, allow_pickle=False)
    feats, offs, y = z["feats"], z["offs"], z["y"].astype(np.float64)
    n_side = int(W["head.1.weight"].shape[1]) - 2 * int(W["gru.weight_hh_l0"].shape[1])
    model = SeqDiffNet(d_in=feats.shape[1], n_side=n_side)
    S = hs_mu = hs_sd = None
    if n_side:
        assert args.handshape, "模型带手型特征，必须传 --handshape"
        hz = np.load(args.handshape, allow_pickle=False)
        assert [str(k) for k in hz["ids"]] == [str(k) for k in z["ids"]]
        S = hz["E"].astype(np.float64)
        hs_mu = ck["side_mu"].numpy().astype(np.float64)
        hs_sd = ck["side_sd"].numpy().astype(np.float64)
    model.load_state_dict(ck["model"])
    model.eval()

    # 切分与标准化统计量都是确定性的，就地复算（避免依赖 checkpoint 里存了什么）
    from train_seq_model import INNER_FRAC, SEED, norm_stats
    perm = np.random.default_rng(SEED).permutation(len(y))
    cut = int(len(y) * 0.85)
    tr_all = perm[:cut]
    rin = np.random.default_rng(SEED + 1).permutation(len(tr_all))
    tr = tr_all[rin[int(len(tr_all) * INNER_FRAC):]]
    mu, sd_ = [a.astype(np.float64) for a in norm_stats(feats, offs, tr)]
    te = perm[cut:][: args.n_verify]

    errs = []
    for i in te:
        seg = feats[offs[i]:offs[i + 1]].astype(np.float32)
        lens = len(seg)
        x_std = (seg.astype(np.float64) - mu) / sd_
        T = int(np.ceil(lens / PATCH))
        tok = np.zeros(T, dtype=bool)
        tok[:] = True
        # torch 侧：和训练时走完全相同的堆叠函数
        x, tk, pm = stack_patches(feats, offs, [int(i)],
                                  mu=mu.astype(np.float32), sd=sd_.astype(np.float32))
        side = None
        if n_side:
            side = np.clip((S[i] - hs_mu) / hs_sd, -8.0, 8.0)
            side = side[None, :]
        with torch.no_grad():
            st = torch.from_numpy(side.astype(np.float32)) if side is not None else None
            pt = float(model(x, tk, pm, st)[0])
        pn = np_predict(W, x_std, tok, lens, side=None if side is None else side[0])
        errs.append(abs(pt - pn))
    print(f"numpy vs torch：最大绝对误差 {max(errs):.2e} "
          f"→ {'通过' if max(errs) < 1e-3 else '不通过'}")

    out = {"meta": {"patch": PATCH, "d_model": int(W["embed.0.weight"].shape[0]),
                    "n_side": n_side,
                    "side_mu": None if hs_mu is None else [float(v) for v in hs_mu],
                    "side_sd": None if hs_sd is None else [float(v) for v in hs_sd],
                    "side_clip": 8.0,
                    "side_spec": "tools/handshape_spec.md" if n_side else None,
                    "hidden": int(W["gru.weight_hh_l0"].shape[1]),
                    "d_in": int(feats.shape[1]),
                    "mu": [float(v) for v in mu], "sd": [float(v) for v in sd_],
                    "ym": float(ck["ym"]), "ys": float(ck["ys"]),
                    "layernorm_eps": 1e-5, "gelu": "erf (exact)"},
           "weights": {k: v.tolist() for k, v in W.items()}}
    json.dump(out, open(args.out, "w", encoding="utf-8"))
    sz = os.path.getsize(args.out) / 1024
    print(f"→ {args.out}（{sz:.0f} KB，{sum(v.size for v in W.values()):,} 个数）")


if __name__ == "__main__":
    main()
