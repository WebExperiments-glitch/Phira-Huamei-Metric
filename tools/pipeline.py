#!/usr/bin/env python3
"""
P.H.M. 流水线统一入口

把散落的 6 个脚本串成可复现的流水线，一条命令跑完一个阶段。

数据布局（真源与中间产物分离）：
    data/
    ├── charts/                       原始语料（31GB，需先下载）
    │   └── manifest.jsonl            爬取日志
    ├── .stages/                      中间产物（可随时删，重跑重建）
    │   ├── official_base.jsonl
    │   ├── community_base.jsonl
    │   └── community_dims.jsonl
    ├── official.jsonl            ★  官谱真源（全部特征）
    └── community.jsonl           ★  社区谱真源（全部特征）

阶段：
    official    官谱：APK → 谱面/定数 → 基础特征 → 18 维    需要 APK
    community   社区谱：下载 → 基础特征 → 18 维 → 合并       需要网络
    calibrate   校准：对交付引擎做留一法 + 校验浏览器端与引擎逐谱一致
    gui         前端数据：由真源裁剪派生（含单文件版）
    all         以上全部（按依赖顺序）

用法：
    python tools/pipeline.py official      # 官谱（需先有 _research/pgr/）
    python tools/pipeline.py community
    python tools/pipeline.py gui
    python tools/pipeline.py all

    python tools/pipeline.py --status      # 查看当前数据状态
"""
import argparse
import os
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data")
STAGES = os.path.join(DATA, ".stages")
PY = sys.executable          # 用当前解释器，避免路径写死


def run(script, *args, **kw):
    """执行一个流水线脚本，失败即中止"""
    cmd = [PY, os.path.join(BASE, script)] + list(args)
    print(f"\n$ {' '.join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd))}")
    t0 = time.time()
    r = subprocess.run(cmd, cwd=ROOT)
    el = time.time() - t0
    if r.returncode != 0:
        print(f"[FAIL] {script} 退出码 {r.returncode}（{el:.1f}s）", file=sys.stderr)
        sys.exit(r.returncode)
    print(f"[ok] {script}  {el:.1f}s")


def exists(p):
    return os.path.exists(p)


def stage_official(args):
    """官谱：从已提取的 pgr 目录构建真源"""
    pgr = os.path.join(ROOT, "_research", "pgr")
    if not exists(os.path.join(pgr, "chart")):
        print(f"[abort] 未找到 {pgr}/chart/", file=sys.stderr)
        print("        先跑：python tools/extract_pgr.py --apk <apk> --out _research/pgr --charts",
              file=sys.stderr)
        print("              python tools/extract_difficulty.py --apk <apk> --out _research/pgr --typetree <tt>",
              file=sys.stderr)
        sys.exit(1)
    os.makedirs(STAGES, exist_ok=True)
    base = os.path.join(STAGES, "official_base.jsonl")
    out = os.path.join(DATA, "official.jsonl")
    run("build_official_baseline.py", "--pgr", pgr, "--out", base)
    run("enhance_features_v3.py", "--pgr", pgr, "--baseline", base,
        "--out", out, "--workers", str(args.workers))
    print(f"\n[stage] 官谱真源 → data/official.jsonl")


def stage_community(args):
    """社区谱：从已下载的语料构建真源"""
    charts = os.path.join(DATA, "charts")
    if not exists(os.path.join(charts, "manifest.jsonl")):
        print(f"[abort] 未找到 {charts}/manifest.jsonl", file=sys.stderr)
        print("        先跑：python tools/fetch_charts.py --workers 6", file=sys.stderr)
        sys.exit(1)
    os.makedirs(STAGES, exist_ok=True)
    base = os.path.join(STAGES, "community_base.jsonl")
    dims = os.path.join(STAGES, "community_dims.jsonl")
    out = os.path.join(DATA, "community.jsonl")
    mf = os.path.join(charts, "manifest.jsonl")
    run("extract_community_features.py", "--manifest", mf, "--root", charts,
        "--out", base, "--workers", str(args.workers))
    run("add_community_dims.py", "--manifest", mf, "--root", charts,
        "--out", dims, "--workers", str(args.workers))
    run("merge_community_features.py", "--a", base, "--b", dims, "--out", out)
    print(f"\n[stage] 社区谱真源 → data/community.jsonl")


def stage_gui(args):
    """前端数据 + 单文件产物：由真源裁剪派生"""
    for p in ("official.jsonl", "community.jsonl"):
        if not exists(os.path.join(DATA, p)):
            print(f"[abort] 未找到 data/{p}，先跑对应阶段", file=sys.stderr)
            sys.exit(1)
    run("build_gui_data.py")
    # 单文件版必须跟在裁剪之后重建，否则内嵌数据会比 gui/data/ 旧（曾脱同步）
    run(os.path.join("..", "phm", "gui", "build_standalone.py"))
    print(f"\n[stage] 前端数据 phm/gui/data/ → 单文件 phm/P.H.M..html")


def stage_calibrate(args):
    """校准交付引擎 + 校验前后端一致"""
    src = os.path.join(DATA, "official.jsonl")
    if not exists(src):
        print(f"[abort] 未找到 {src}，先跑 pipeline.py official", file=sys.stderr)
        sys.exit(1)
    run("calibrate_engine.py", "--data", src)
    # 浏览器端是独立实现，必须证明它与引擎输出逐谱相同（防止悄悄漂移）
    run("verify_gui_parity.py")


STAGES_MAP = {
    "official": stage_official,
    "community": stage_community,
    "calibrate": stage_calibrate,
    "gui": stage_gui,
}


def status():
    print("=" * 66)
    print("P.H.M. 数据状态")
    print("=" * 66)
    checks = [
        ("原始语料", os.path.join(DATA, "charts", "manifest.jsonl")),
        ("官谱真源", os.path.join(DATA, "official.jsonl")),
        ("社区谱真源", os.path.join(DATA, "community.jsonl")),
        ("前端数据", os.path.join(ROOT, "phm", "gui", "data", "community.jsonl")),
        ("前端产物", os.path.join(ROOT, "phm", "P.H.M..html")),
    ]
    for lab, p in checks:
        if exists(p):
            n = ""
            if p.endswith(".jsonl"):
                n = f"  {sum(1 for _ in open(p, encoding='utf-8')):>6} 条"
            sz = os.path.getsize(p) / 1048576
            print(f"  ✓ {lab:<10} {os.path.relpath(p, ROOT):<36} {sz:>7.2f} MB{n}")
        else:
            print(f"  ✗ {lab:<10} {os.path.relpath(p, ROOT):<36} （缺）")
    # 中间产物
    if os.path.isdir(STAGES):
        fs = sorted(os.listdir(STAGES))
        if fs:
            print(f"\n  中间产物 data/.stages/（可删，重跑会重建）")
            for f in fs:
                fp = os.path.join(STAGES, f)
                print(f"      {f:<28} {os.path.getsize(fp)/1048576:>7.2f} MB")
    # 语料
    cdir = os.path.join(DATA, "charts")
    if os.path.isdir(cdir):
        nd = sum(1 for x in os.listdir(cdir) if x.isdigit())
        print(f"\n  谱面语料 data/charts/  {nd} 个谱面目录")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", nargs="?",
                    choices=list(STAGES_MAP) + ["all"],
                    help="要执行的阶段")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    if args.status or not args.stage:
        return status()

    order = ["official", "community", "calibrate", "gui"]
    targets = order if args.stage == "all" else [args.stage]
    print("=" * 66)
    print(f"P.H.M. 流水线：{' → '.join(targets)}")
    print("=" * 66)
    t0 = time.time()
    for s in targets:
        STAGES_MAP[s](args)
    print()
    print("=" * 66)
    print(f"完成，耗时 {time.time()-t0:.1f}s")
    print("=" * 66)
    return status()


if __name__ == "__main__":
    sys.exit(main())
