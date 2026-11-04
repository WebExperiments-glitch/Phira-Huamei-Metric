#!/usr/bin/env python3
"""make_kaggle_pack.compact() 的自检：below 音符不得被静默吞掉。

━━━ 为什么需要 ━━━
serialize_chart 给 below(above=0) 音符的位置打 "b" 后缀（`-2.5b`），
compact() 此前用 float(f[1]) 直接解析 → ValueError → 被
`except ValueError: continue` 吞掉，且没有任何计数或日志。
真语料抽样（499 张）：39.9% 的谱面受影响，事件丢失率 0.39%，
最差一张丢 34.2%。这条测试把行为钉死，防止回归。

━━━ 跑法（零依赖，跟随仓库 NON-GOALS）━━━
    python tools/test_pack_compact.py
退出码 0 = 全过；1 = 有失败（每条单独报告）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chart_dna            # noqa: E402
import make_kaggle_pack     # noqa: E402

META = "#META lines=1 notes=4 dur=1.2 bpm=180"

# 新格式：tag 挂在位置列（serialize_chart 现行为）
CASE_NOW = "\n".join([
    META,
    "0.00 +3.5 T",        # above
    "0.27 -2.5b H 0.9",   # below hold：b 后缀 + hold 列，此前整行被吞
    "0.55 +0.0 F",        # above
    "0.73 -2.5b T",       # below tap：此前整行被吞
])

# 旧格式：tag 挂在类型列（`Tb`/`Hb`）——修复前后都必须能吃
CASE_OLD = "\n".join([
    META,
    "0.00 +3.5 T",
    "0.27 -2.5 Tb 0.9",
    "0.55 +0.0 F",
])

# 混入一行真的坏数据：两种实现都该跳过它（不归 below 修复管）
CASE_MALFORMED = "\n".join([
    META,
    "0.00 +3.5 T",
    "xx +1.0 T",          # 时间列坏 → 旧/新实现都跳过
    "0.27 -2.5b T",       # below：此前被吞（与坏行混在一起时也要能保住）
])


def test_below_notes_survive():
    dna, n = make_kaggle_pack.compact(CASE_NOW)
    assert n == 4, f"4 个事件应全部进入编码，实得 {n}（below 还在被吞）"
    dec = chart_dna.decode(dna)
    assert len(dec) == 4, f"decode 回事件数 {len(dec)} != 4"


def test_below_hold_keeps_duration():
    dna, _ = make_kaggle_pack.compact(CASE_NOW)
    dec = chart_dna.decode(dna)
    holds = [e for e in dec if e[2] == "H"]
    assert len(holds) == 1 and holds[0][3] == 0.9, (
        f"below hold 的时长应保留 0.9s，实得 {holds}")


def test_old_format_tag_on_type():
    dna, n = make_kaggle_pack.compact(CASE_OLD)
    assert n == 3, f"旧格式（tag 在类型列）应解析 3 个事件，实得 {n}"


def test_malformed_lines_still_skipped():
    dna, n = make_kaggle_pack.compact(CASE_MALFORMED)
    assert n == 2, f"坏行应被跳过、below 行应保留：实得 {n}（want 2）"


def test_roundtrip_dt_chain():
    """below 音符回到时间轴后，dt 链目测应连续（0.27 = b 行与上一行的间隔）。"""
    dna, _ = make_kaggle_pack.compact(CASE_NOW)
    dec = chart_dna.decode(dna)
    ts = [e[0] for e in dec]
    assert ts == [0.0, 0.3, 0.6, 0.8], f"dt 链应含全部 4 拍，实得 {ts}"


def test_dna_charset_only():
    for name, case in (("now", CASE_NOW), ("old", CASE_OLD)):
        dna, _ = make_kaggle_pack.compact(case)
        bad = set(dna) - set(chart_dna.B32)
        assert not bad, f"{name}: DNA 串里混入非法字符 {bad}"


TESTS = (test_below_notes_survive, test_below_hold_keeps_duration,
         test_old_format_tag_on_type, test_malformed_lines_still_skipped,
         test_roundtrip_dt_chain, test_dna_charset_only)


def main():
    fails = 0
    for fn in TESTS:
        try:
            fn()
            print(f"  PASS {fn.__name__}")
        except AssertionError as e:
            fails += 1
            print(f"  FAIL {fn.__name__}: {e}")
    n = len(TESTS)
    print(f"{n - fails}/{n} 通过")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
