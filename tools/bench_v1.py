#!/usr/bin/env python3
"""PHM-Bench v1 执行器 —— 规范见 docs/调研/难度模型-基准规范.md。

━━━ 与 bench_suite.py 的关系 ━━━
bench_suite.py 是最早的六组切分（找泄漏用）；本文件是**对外发布的基准**，
多了三件事：
  1. 任务 T7（截断 50%）与 T8（跨格式 PEC）
  2. **每个数字都带 95% bootstrap 置信区间**（n≈1,000 时 ρ 的标准误约 0.031，
     0.03 以内的差距是噪声）
  3. 两两胜率矩阵 → Elo（比 MAE 抗离群值）

━━━ 用法 ━━━
    python tools/bench_v1.py tasks      # 生成八组任务（含公开/隐藏切分）
    python tools/bench_v1.py run        # 跑基线并出榜单
"""
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bench_suite import DATA, META, Ridge, CountOnly, load_inputs, metrics, spearman  # noqa: E402

BENCH = os.path.join(DATA, "bench")
TASKS = os.path.join(BENCH, "tasks_v1.json")
HIDDEN_SHA = os.path.join(BENCH, "hidden.sha256")
FMT_CACHE = os.path.join(BENCH, "fmt.json")
SEED = 20261101


# ────────────────────────── 任务定义 ──────────────────────────
def chart_fmt(cid):
    """判断谱面文件是 RPE(JSON) 还是 PEC(文本)。结果缓存。"""
    if os.path.exists(FMT_CACHE):
        return json.load(open(FMT_CACHE, encoding="utf-8")).get(cid, "rpe")
    return "rpe"


def build_fmt_cache(ids):
    out = {}
    for cid in ids:
        d = os.path.join(DATA, "charts", cid)
        if not os.path.isdir(d):
            continue
        cand = [f for f in os.listdir(d) if f.endswith((".json", ".pec", ".pgr"))]
        if not cand:
            continue
        try:
            head = open(os.path.join(d, cand[0]), encoding="utf-8",
                        errors="replace").read(64).lstrip()[:1]
            out[cid] = "rpe" if head == "{" else "pec"
        except OSError:
            pass
    os.makedirs(BENCH, exist_ok=True)
    json.dump(out, open(FMT_CACHE, "w", encoding="utf-8"))
    return out


def build_tasks():
    rows = json.load(open(META, encoding="utf-8"))
    ids = sorted(rows)
    rng = np.random.default_rng(SEED)
    T = {}

    perm = rng.permutation(len(ids))
    cut = int(len(ids) * 0.85)
    T["T1_random"] = {"train": [ids[i] for i in perm[:cut]],
                      "test": [ids[i] for i in perm[cut:]]}

    by_up = {}
    for c in ids:
        up = rows[c]["uploader"]
        if up is not None:
            by_up.setdefault(str(up), []).append(c)
    ups = sorted(by_up)
    rng.shuffle(ups)
    k = max(1, int(len(ups) * 0.15))
    T["T2_by_uploader"] = {"train": [c for u in ups[k:] for c in by_up[u]],
                           "test": [c for u in ups[:k] for c in by_up[u]]}

    dated = sorted((c for c in ids if rows[c]["created"]), key=lambda c: rows[c]["created"])
    cut = int(len(dated) * 0.85)
    T["T3_temporal"] = {"train": dated[:cut], "test": dated[cut:]}

    T["T4_cold"] = {"train": [c for c in ids if rows[c]["players"] >= 200],
                    "test": [c for c in ids if 50 <= rows[c]["players"] < 100]}

    by_len = sorted(ids, key=lambda c: rows[c]["n_events"])
    kk = max(1, int(len(by_len) * 0.10))
    T["T5_long"] = {"train": by_len[:-kk], "test": by_len[-kk:]}
    T["T6_short"] = {"train": by_len[kk:], "test": by_len[:kk]}

    # T7 截断：同一批测试谱，但模型只看前 50% 事件（train 侧原样）
    T["T7_trunc50"] = {"train": T["T1_random"]["train"], "test": T["T1_random"]["test"][:600],
                       "truncate": 0.5}

    # T8 跨格式：测试集只用 PEC 谱面
    fmtd = build_fmt_cache(ids)
    pec = [c for c in ids if fmtd.get(c) == "pec"]
    T["T8_pec"] = {"train": [c for c in ids if fmtd.get(c) != "pec"], "test": pec}

    # 每组的测试集再切 60% 公开 / 40% 隐藏
    hidden_commit = []
    for name, sp in T.items():
        te = sp["test"]
        rng2 = np.random.default_rng(abs(hash(name)) % (2 ** 32))
        idx = rng2.permutation(len(te))
        n_h = int(len(te) * 0.40)
        sp["hidden"] = [te[i] for i in idx[:n_h]]
        sp["public"] = [te[i] for i in idx[n_h:]]
        hidden_commit.extend(sorted(sp["hidden"]))

    json.dump(T, open(TASKS, "w", encoding="utf-8"), ensure_ascii=False)
    sha = hashlib.sha256("\n".join(sorted(set(hidden_commit))).encode()).hexdigest()
    open(HIDDEN_SHA, "w", encoding="utf-8").write(sha + "\n")

    print(f"八组任务 → {TASKS}")
    for k2, v in T.items():
        print(f"  {k2:16s} 训练 {len(v['train']):5d} · 测试 {len(v['test']):5d} "
              f"（公开 {len(v['public']):4d} / 隐藏 {len(v['hidden']):4d}）")
    print(f"隐藏集承诺 sha256 = {sha}")


# ────────────────────────── 评估 ──────────────────────────
def bootstrap_ci(pred, gold, stat=spearman, n=2000, seed=SEED):
    """ρ 的 95% bootstrap 区间。n≈1,000 时标准误约 0.031，0.03 内算噪声。"""
    rng = np.random.default_rng(seed)
    m = len(pred)
    vals = []
    for _ in range(n):
        i = rng.integers(0, m, m)
        vals.append(stat([pred[j] for j in i], [gold[j] for j in i]))
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def task_matrix(ids, frac=1.0):
    """取某批谱面的输入矩阵（frac<1 时只用前 frac 比例的事件 → T7）。"""
    d = load_inputs()
    from bench_suite import pooled_vector
    return np.stack([pooled_vector(d["index"][c], frac=frac) for c in ids])


def run():
    T = json.load(open(TASKS, encoding="utf-8"))
    d = load_inputs()
    idx, y = d["index"], d["y"]
    models = {"count_only": CountOnly, "ridge_pooled": Ridge}
    out = {m: {} for m in models}

    for tname, sp in T.items():
        tr = [c for c in sp["train"] if c in idx]
        te = [c for c in sp["public"] if c in idx]
        if len(tr) < 50 or len(te) < 20:
            continue
        frac = sp.get("truncate", 1.0)
        Xtr = task_matrix(tr, 1.0)
        Xte = task_matrix(te, frac)
        ytr, yte = y[[idx[c] for c in tr]], y[[idx[c] for c in te]]
        for name, cls in models.items():
            m = cls()
            if name == "ridge_pooled":                     # 传入预算好的特征，避免重复算
                m.fit(tr, ytr, X=Xtr, Xk=Xte)
                pred = m.predict(te, X=Xte)
            else:
                m.fit(tr, ytr)
                pred = m.predict(te)
            r = metrics(pred, yte)
            lo, hi = bootstrap_ci(list(pred), list(yte))
            r["rho_ci"] = [round(lo, 4), round(hi, 4)]
            out[name][tname] = r

    # 宏平均（只看 ρ）
    for name in out:
        vals = [v["rho"] for v in out[name].values()]
        out[name]["_macro"] = round(float(np.mean(vals)), 4) if vals else 0.0

    json.dump(out, open(os.path.join(BENCH, "v1_results.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    names = [k for k in out["count_only"] if not k.startswith("_")]
    head = f"{'模型':<16}{'宏平均ρ':>9}" + "".join(f"{n[:6]:>8}" for n in names)
    print(head)
    print("-" * len(head))
    for mn, per in out.items():
        row = f"{mn:<16}{per['_macro']:>9.4f}"
        for n in names:
            row += f"{per.get(n, {}).get('rho', float('nan')):>8.3f}"
        print(row)
    print("\n每项 ρ 的 95% CI（公开集；隐藏集由我们代跑，不公开 id）：")
    for mn, per in out.items():
        for n in names[:3]:
            r = per.get(n)
            if r:
                print(f"  {mn:<14}{n:<16} {r['rho']:.3f}  [{r['rho_ci'][0]:.3f}, {r['rho_ci'][1]:.3f}]")


def run_all():
    """一条命令跑完：任务缺失则重建 → 跑基线 → 写带版本的结果快照。

    ⚠ 结果文件带版本号，因为「0.82」在不标注特征版本/切分/epoch 时毫无意义。
    """
    import time
    if not os.path.exists(TASKS):
        build_tasks()
    run()
    ver = os.environ.get("PHM_VER", "unversioned")
    src = os.environ.get("PHM_SEQ", "seq-dataset.npz")
    snap = os.path.join(BENCH, f"v1_results_{ver}.json")
    with open(os.path.join(BENCH, "v1_results.json"), encoding="utf-8") as f:
        data = json.load(f)
    payload = {"version": ver, "dataset": os.path.basename(src),
               "when": time.strftime("%Y-%m-%dT%H:%M:%S"), "results": data}
    json.dump(payload, open(snap, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print()
    print("结果快照 → " + snap)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    {"tasks": build_tasks, "run": run, "all": run_all}[cmd]()


if __name__ == "__main__":
    main()
