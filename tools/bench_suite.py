#!/usr/bin/env python3
"""难度模型基准测试：六组切分 × 八项指标 × 两个必跑基线。

━━━ 为什么需要 ━━━
此前所有实验只用「随机切分 + Spearman ρ」。它会被四种方式骗过：
谱师泄漏、时间泄漏、捷径学习（只学会"音符多就是难"）、长尾崩溃。
规格与判据见 `docs/调研/难度模型-基准测试.md`。

━━━ 用法 ━━━
    python tools/bench_suite.py prep          # 建元数据索引
    python tools/bench_suite.py split         # 生成六组切分（缓存）
    python tools/bench_suite.py run           # 跑全部基线与切分，出表

━━━ 铁律 ━━━
所有模型必须共用同一份切分与同一份输入缓存 —— 否则基准本身不可比。
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
BENCH = os.path.join(DATA, "bench")
SEQ = os.path.join(DATA, "seq-dataset.npz")
IRT = os.path.join(DATA, "player-irt.json")
CHARTS = os.path.join(DATA, "crawl", "charts.jsonl")
META = os.path.join(BENCH, "meta.json")
SPLITS = os.path.join(BENCH, "splits.json")
SEED = 20261101


# ────────────────────────── 指标 ──────────────────────────
def _rank(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def spearman(a, b):
    ra, rb = _rank(a), _rank(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = math.sqrt(sum((x - ma) ** 2 for x in ra))
    db = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return num / (da * db + 1e-12)


def kendall(a, b):
    """O(n²)，n<2,000 时可接受。"""
    n = len(a)
    conc = disc = 0
    for i in range(n):
        for j in range(i + 1, n):
            d = (a[i] - a[j]) * (b[i] - b[j])
            if d > 0:
                conc += 1
            elif d < 0:
                disc += 1
    tot = conc + disc
    return (conc - disc) / tot if tot else 0.0


def metrics(pred, gold):
    p, g = np.asarray(pred, float), np.asarray(gold, float)
    err = p - g
    mae = float(np.abs(err).mean())
    rmse = float(np.sqrt((err ** 2).mean()))
    var = float(((g - g.mean()) ** 2).mean())
    return {
        "rho": round(spearman(p.tolist(), g.tolist()), 4),
        "kendall": round(kendall(p.tolist(), g.tolist()), 4),
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(1 - float((err ** 2).mean()) / (var + 1e-12), 4),
        "band05": round(float((np.abs(err) <= 0.5).mean()), 4),
        "band10": round(float((np.abs(err) <= 1.0).mean()), 4),
        "bias": round(float(err.mean()), 4),
        "n": int(len(g)),
    }


# ────────────────────────── 数据 ──────────────────────────
def prep():
    os.makedirs(BENCH, exist_ok=True)
    z = np.load(SEQ, allow_pickle=False)
    ids = [str(x) for x in z["ids"]]
    y = z["y"]
    offs = z["offs"]
    irt = json.load(open(IRT, encoding="utf-8"))["items"]
    meta_chart = {}
    for line in open(CHARTS, encoding="utf-8"):
        r = json.loads(line)
        meta_chart[str(r["id"])] = r

    rows = {}
    for i, cid in enumerate(ids):
        ir = irt.get(cid, {})
        mc = meta_chart.get(cid, {})
        rows[cid] = {
            "i": i,                                   # 在 npz 里的下标
            "b": float(y[i]),
            "players": int(ir.get("players", 0)),
            "declared": float(ir.get("declared") or 0.0),
            "uploader": mc.get("uploader"),
            "created": mc.get("created") or "",
            "n_events": int(offs[i + 1] - offs[i]),
            "tags": mc.get("tags") or [],
        }
    json.dump(rows, open(META, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"元数据索引：{len(rows)} 张 → {META}")
    miss_up = sum(1 for r in rows.values() if not r["uploader"])
    miss_t = sum(1 for r in rows.values() if not r["created"])
    print(f"  缺谱师 uid {miss_up} · 缺上传时间 {miss_t}")


def split():
    rows = json.load(open(META, encoding="utf-8"))
    ids = sorted(rows)
    rng = np.random.default_rng(SEED)
    out = {}

    # S1 随机
    perm = rng.permutation(len(ids))
    cut = int(len(ids) * 0.85)
    out["S1_random"] = {"train": [ids[i] for i in perm[:cut]],
                        "test": [ids[i] for i in perm[cut:]]}

    # S2 按谱师分组：整组留出，保证测试集的作者训练时一张都没见过
    by_up = {}
    for cid in ids:
        up = rows[cid]["uploader"]
        if up is None:
            continue
        by_up.setdefault(str(up), []).append(cid)
    ups = sorted(by_up)
    rng.shuffle(ups)
    n_test = max(1, int(len(ups) * 0.15))
    test_ups = set(ups[:n_test])
    out["S2_by_uploader"] = {
        "train": [c for u in ups[n_test:] for c in by_up[u]],
        "test": [c for u in ups[:n_test] for c in by_up[u]],
    }

    # S3 时间切分：旧训练 / 新测试（产品里永远是预测新谱）
    dated = sorted((c for c in ids if rows[c]["created"]), key=lambda c: rows[c]["created"])
    cut = int(len(dated) * 0.85)
    out["S3_temporal"] = {"train": dated[:cut], "test": dated[cut:]}

    # S4 冷启动：训练用高支撑度谱，测试用 50–99 人的谱（真实新谱形态）
    cold = [c for c in ids if 50 <= rows[c]["players"] < 100]
    hot = [c for c in ids if rows[c]["players"] >= 200]
    out["S4_cold"] = {"train": hot, "test": cold}

    # S5/S6 长谱 / 短谱外推：按事件数取两端 10%
    by_len = sorted(ids, key=lambda c: rows[c]["n_events"])
    k = max(1, int(len(by_len) * 0.10))
    out["S5_long"] = {"train": by_len[:-k], "test": by_len[-k:]}
    out["S6_short"] = {"train": by_len[k:], "test": by_len[:k]}

    json.dump(out, open(SPLITS, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"六组切分 → {SPLITS}")
    for k2, v in out.items():
        print(f"  {k2:16s} 训练 {len(v['train']):5d} · 测试 {len(v['test']):5d}")


# ────────────────────────── 输入表示 ──────────────────────────
_CACHE = {}


def load_inputs():
    """一份统一的输入缓存，所有模型共用。

    events: 每个事件 10 维（第 0 维是 dt 秒）
    pooled: 每个谱一份固定长度摘要（均值/标准差/分位/极值 + 物量 + 时长）
    """
    if _CACHE:
        return _CACHE
    z = np.load(SEQ, allow_pickle=False)
    _CACHE["feats"] = z["feats"].astype(np.float32)
    _CACHE["offs"] = z["offs"]
    _CACHE["ids"] = [str(x) for x in z["ids"]]
    _CACHE["y"] = z["y"]
    _CACHE["index"] = {c: i for i, c in enumerate(_CACHE["ids"])}
    return _CACHE


def pooled_vector(i):
    d = load_inputs()
    a = d["feats"][d["offs"][i]:d["offs"][i + 1]]
    if len(a) == 0:
        return np.zeros(72, dtype=np.float32)
    q = np.percentile(a, [10, 50, 90], axis=0)                 # 3×10
    stats = np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0),
                            q.ravel(), [len(a), a[:, 0].sum()]])
    return stats.astype(np.float32)


def pooled_matrix(ids):
    d = load_inputs()
    return np.stack([pooled_vector(d["index"][c]) for c in ids])


# ────────────────────────── 模型 ──────────────────────────
class Ridge:
    def __init__(self, alpha=10.0):
        self.alpha = alpha

    def fit(self, ids, y):
        X = pooled_matrix(ids)
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-6
        Xs = (X - self.mu) / self.sd
        n, d = Xs.shape
        A = Xs.T @ Xs + self.alpha * np.eye(d)
        self.w = np.linalg.solve(A, Xs.T @ (y - y.mean()))
        self.b = float(y.mean())
        return self

    def predict(self, ids):
        X = (pooled_matrix(ids) - self.mu) / self.sd
        return X @ self.w + self.b


class CountOnly:
    """羞辱性基线：只看音符数。复杂模型打不过它，说明学到的全是"多就是难"。"""

    def fit(self, ids, y):
        d = load_inputs()
        x = np.array([len(d["feats"][d["offs"][d["index"][c]]:d["offs"][d["index"][c] + 1]])
                      for c in ids], float)
        A = np.stack([x, np.ones_like(x)], 1)
        self.w = np.linalg.lstsq(A, y, rcond=None)[0]
        return self

    def predict(self, ids):
        d = load_inputs()
        x = np.array([len(d["feats"][d["offs"][d["index"][c]]:d["offs"][d["index"][c] + 1]])
                      for c in ids], float)
        return np.stack([x, np.ones_like(x)], 1) @ self.w


MODELS = {"count_only": CountOnly, "ridge_pooled": Ridge}


# ────────────────────────── 运行 ──────────────────────────
def run():
    rows = json.load(open(META, encoding="utf-8"))
    splits = json.load(open(SPLITS, encoding="utf-8"))
    y_all = load_inputs()["y"]
    idx = load_inputs()["index"]
    table = {}
    for mname, cls in MODELS.items():
        table[mname] = {}
        for sname, sp in splits.items():
            tr = [c for c in sp["train"] if c in idx]
            te = [c for c in sp["test"] if c in idx]
            if len(tr) < 50 or len(te) < 20:
                continue
            m = cls().fit(tr, y_all[[idx[c] for c in tr]])
            pred = m.predict(te)
            table[mname][sname] = metrics(pred, y_all[[idx[c] for c in te]])
    os.makedirs(BENCH, exist_ok=True)
    json.dump(table, open(os.path.join(BENCH, "results.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    cols = ["rho", "kendall", "mae", "band05", "band10", "bias", "n"]
    head = f"{'模型':<14}{'切分':<17}" + "".join(f"{c:>9}" for c in cols)
    print(head)
    print("-" * len(head))
    for mname, per in table.items():
        for sname, r in per.items():
            print(f"{mname:<14}{sname:<17}" + "".join(f"{r[c]:>9}" for c in cols))
        print("-" * len(head))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    {"prep": prep, "split": split, "run": run}[cmd]()


if __name__ == "__main__":
    main()
