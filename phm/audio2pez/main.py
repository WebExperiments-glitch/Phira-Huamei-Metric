# -*- coding: utf-8 -*-
"""audio2pez 命令行入口。

两种模式：
  1) 从音频直接生成：python main.py song.mp3
  2) 从已踩音 points 排布：python main.py --from-points notes.json
       （可加 song.mp3 作为 --input 以提升音符类型/轨道质量）
"""

import argparse
import json
import os
import sys

from generate import generate, arrange
from config import DIFFICULTY_PRESETS

LINE_FX = ["none", "alpha_pulse", "pinwheel", "grid", "curve", "color_flow",
           "glow", "bounce", "breathe", "meteor", "echo_trail", "spotlight", "mix"]
KEYS = ["auto", "2k", "4k", "6k"]


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="audio2pez - 音频转 PhiraEdit 谱面生成器 / 从踩音 points 排布",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python main.py song.mp3                         # 音频直接生成\n"
               "  python main.py --from-points notes.json         # 用踩音 points 排布\n"
               "  python main.py --from-points notes.json song.mp3  # 附带音频提升质量",
    )
    parser.add_argument("input", nargs="?", default=None,
                        help="输入音频文件（配合 --from-points 时可选，用于提升质量）")
    parser.add_argument("--from-points", default=None,
                        help="直接输入踩音后的 points JSON（含 points/bpm），跳过音频检测")
    parser.add_argument("--bpm", type=float, default=None, help="手动指定 BPM（不指定则自动检测/取 JSON）")
    parser.add_argument("--difficulty", default="hard", choices=list(DIFFICULTY_PRESETS),
                        help="难度分级")
    parser.add_argument("--all-tiers", action="store_true", help="一次输出全部 5 档难度")
    parser.add_argument("--name", default=None, help="谱面名称/曲名")
    parser.add_argument("--artist", default="", help="曲师 / Artist")
    parser.add_argument("--charter", default=None, help="谱师 / Charter")
    parser.add_argument("--cover", default=None, help="封面图片路径（可选）")
    parser.add_argument("--outdir", default="output", help="输出目录")
    parser.add_argument("--key", default="auto", choices=KEYS, help="判定线轨道数")
    parser.add_argument("--line-fx", default="none", choices=LINE_FX, help="判定线动效")
    parser.add_argument("--pulse-style", default="chain", choices=["chain", "sweep"],
                        help="pulse 侧闪形态")
    parser.add_argument("--deco-when", default="intro_chorus",
                        choices=["intro_chorus", "intro", "chorus", "verse", "repeat", "all"],
                        help="旋转装饰出现段落")
    parser.add_argument("--main-y", type=float, default=-300.0, help="主判定线初始 Y")
    parser.add_argument("--mix-spec", default="", help="mix 特效顺序 effect@段落;…")
    parser.add_argument("--main-swing", action="store_true", help="主判定线左右摆动")
    parser.add_argument("--density", type=float, default=1.0, help="写谱密度/难度倍率")
    parser.add_argument("--tap-weight", type=float, default=None)
    parser.add_argument("--hold-weight", type=float, default=None)
    parser.add_argument("--flick-weight", type=float, default=None)
    parser.add_argument("--drag-weight", type=float, default=None)
    args = parser.parse_args(argv)

    common = dict(
        difficulty=args.difficulty,
        all_tiers=args.all_tiers,
        image_path=args.cover,
        title=(args.name or "").strip() or None,
        artist=(args.artist or "").strip(),
        charter_name=(args.charter or "").strip() or None,
        outdir=args.outdir,
        density_mult=args.density,
        line_fx=args.line_fx,
        pulse_style=args.pulse_style,
        deco_when=args.deco_when,
        main_y=args.main_y,
        mix_spec=(args.mix_spec or "").strip(),
        key_mode=args.key,
        main_swing=bool(args.main_swing),
        tap_weight=args.tap_weight,
        hold_weight=args.hold_weight,
        flick_weight=args.flick_weight,
        drag_weight=args.drag_weight,
    )

    if args.from_points:
        if not os.path.exists(args.from_points):
            print(f"错误: points 文件不存在 {args.from_points}", file=sys.stderr)
            return 1
        with open(args.from_points, "r", encoding="utf-8") as f:
            data = json.load(f)
        audio = os.path.abspath(args.input) if args.input else None
        if audio and not os.path.exists(audio):
            print(f"错误: 音频文件不存在 {audio}", file=sys.stderr)
            return 1
        out = arrange(data, audio_path=audio, bpm=args.bpm, **common)
    else:
        if not args.input:
            print("错误: 需要提供输入音频，或使用 --from-points 传入踩音 points。", file=sys.stderr)
            return 1
        audio = os.path.abspath(args.input)
        if not os.path.exists(audio):
            print(f"错误: 文件不存在 {audio}", file=sys.stderr)
            return 1
        out = generate(audio_path=audio, bpm=args.bpm, **common)

    print("=" * 64)
    for tier, path in out["results"].items():
        print(f"  [{tier}] {path}")
    print("=" * 64)
    print(out["log"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
