"""统一的分组切分工具：同一份谱面（内容哈希相同）只能落在训练集或测试集的一边。

━━━ 为什么必须有这个 ━━━
2026-11-06 实测：2,500 张谱里 19 组内容完全相同（38 张），
随机切分把这些"孪生谱"分到了训练和测试两边，
ρ 从 0.7716（分组切分）被抬到 0.7940（随机切分）—— **虚高 0.0224**。

我们过去所有报出去的 ρ 都是随机切分算的，都含这块虚高。
从今天起，所有 A/B 必须走这里。

用法：
    from group_split import group_ids, split
    gid = group_ids(ids)                 # 每个谱的内容组编号
    tr, te = split(gid, test_frac=0.15, seed=20261028)
"""
import glob
import hashlib
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def chart_hash(cid, root=None):
    """谱面文件的 md5。找不到文件时回退到 id 本身（保证不会把两份合并）。"""
    root = root or os.path.join(ROOT, "data", "charts")
    for p in glob.glob(os.path.join(root, str(cid), "chart.*")):
        with open(p, "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:16]
    return f"id:{cid}"


def group_ids(ids, root=None, cache=None):
    """把内容相同的谱分到同一组，返回每个 id 的组编号（0..G-1）。"""
    h = [chart_hash(c, root) for c in ids]
    if cache and os.path.exists(cache):
        old = np.load(cache, allow_pickle=True)
        m = {str(k): v for k, v in zip(old["hashes"], old["gid"])}
        if all(x in m for x in h):
            return np.array([m[x] for x in h])
    uq, gid = np.unique(h, return_inverse=True)
    if cache:
        np.savez(cache, hashes=np.array(uq), gid=np.arange(len(uq)))
    return gid


def split(gid, test_frac=0.15, seed=20261028):
    """按**组**切分，返回训练/测试下标。保证同一组的谱不会跨集。"""
    uq = np.unique(gid)
    order = np.random.RandomState(seed).permutation(len(uq))
    cut = int(len(uq) * (1.0 - test_frac))
    tr_g, te_g = set(uq[order[:cut]]), set(uq[order[cut:]])
    tr = np.array([i for i in range(len(gid)) if gid[i] in tr_g])
    te = np.array([i for i in range(len(gid)) if gid[i] in te_g])
    return tr, te


def report(ids, gid):
    """打印重复情况，便于写进报告。"""
    n_dup = sum(1 for g in np.unique(gid) if (gid == g).sum() > 1)
    n_in = sum((gid == g).sum() for g in np.unique(gid) if (gid == g).sum() > 1)
    print(f"谱 {len(ids)}，内容组 {len(np.unique(gid))}，"
          f"重复组 {n_dup}（涉及 {n_in} 张，{n_in/max(len(ids),1)*100:.1f}%）")
    return n_dup, n_in


if __name__ == "__main__":
    c = np.load(os.path.join(ROOT, "data", "rhythm-feat-cache.npz"), allow_pickle=True)
    ids = [str(x) for x in c["ids"]]
    gid = group_ids(ids)
    report(ids, gid)
    tr, te = split(gid)
    print(f"训练 {len(tr)}，测试 {len(te)}")
    # 自检：任何组都不应跨集
    cross = set(gid[tr]) & set(gid[te])
    print("跨集内容组数量 =", len(cross), "（必须为 0）")
    assert not cross, "分组切分失效"
