"""解码 phira-huamei 上报的逐音符判定串。

格式（`prpr/src/huamei.rs:95-124`）：
    byte 0        JUDGE_VER (= 1)
    之后每 8 字节一条记录（RECORD_SIZE = 8）：
        +0  u16 LE   line_id
        +2  u16 LE   note_id
        +4  i16 LE   offset_ms   早/晚毫秒；-32768 (OFFSET_UNKNOWN) 表示未知
        +6  u8       code        0=Perfect 1=Good 2=Bad 3=Miss 4=HoldPress
        +7  u8       flags       保留

⚠ offset 的三条「未知」来源（别当成 0ms 正中）：
    · Miss       上游硬编码 0.25 哨兵
    · Drag/Flick 上游硬编码 0.，本来就自动 Perfect
    · Hold 按下   没有 diff
   服务端要拿谱面副本判断哪些 note 是 Drag/Flick，再排除。

用法：
    python tools/decode_judge.py --b64 "<base64>"
    python tools/decode_judge.py --file judge.b64        # 文件内容就是 base64
    python tools/decode_judge.py --selftest
"""
import argparse
import base64
import struct
import sys
from collections import Counter

JUDGE_VER = 1
RECORD_SIZE = 8
OFFSET_UNKNOWN = -32768
CODES = {0: "Perfect", 1: "Good", 2: "Bad", 3: "Miss", 4: "HoldPress"}


def decode_blob(b64: str):
    """base64 → [(line_id, note_id, offset_ms, code, flags), ...]"""
    raw = base64.b64decode(b64, validate=False)
    if not raw:
        return [], None
    ver = raw[0]
    recs = []
    for off in range(1, len(raw) - RECORD_SIZE + 1, RECORD_SIZE):
        line_id, note_id, offset_ms, code, flags = struct.unpack_from("<HHhBB", raw, off)
        recs.append((line_id, note_id, offset_ms, code, flags))
    return recs, ver


def summarize(recs, ver):
    print(f"版本 {ver}，记录 {len(recs)} 条")
    cnt = Counter(CODES.get(r[3], f"unknown({r[3]})") for r in recs)
    total = max(len(recs), 1)
    for k, v in cnt.most_common():
        print(f"  {k:10s} {v:6d}  {v / total * 100:5.1f}%")
    offs = [r[2] for r in recs if r[2] != OFFSET_UNKNOWN]
    if offs:
        offs_sorted = sorted(offs)
        n = len(offs_sorted)
        print(f"  有偏移的 {n} 条：中位 {offs_sorted[n // 2]} ms  "
              f"p10 {offs_sorted[n // 10]}  p90 {offs_sorted[n * 9 // 10]}  "
              f"最早 {offs_sorted[0]}  最晚 {offs_sorted[-1]}")
    print(f"  偏移未知 {sum(1 for r in recs if r[2] == OFFSET_UNKNOWN)} 条"
          f"（Miss / Drag / Flick / Hold 按下）")
    # 失误位置分布：按 note_id 分十段，看是否集中
    misses = [r[1] for r in recs if r[3] == 3]
    if len(misses) >= 10:
        mx = max(r[1] for r in recs) or 1
        buckets = Counter(min(m * 10 // (mx + 1), 9) for m in misses)
        print("  失误按谱面进度分十段：", " ".join(str(buckets.get(i, 0)) for i in range(10)))
        top = buckets.most_common(1)[0]
        share = top[1] / len(misses)
        print(f"  最集中的一段占 {share * 100:.0f}%"
              f"（若接近 10% 说明失误是均匀散布的）")


def selftest():
    """手工构造一条 blob，验证解码与字段顺序。"""
    body = bytes([JUDGE_VER])
    cases = [(0, 0, 0, 0, 0), (3, 120, -15, 1, 0), (7, 65535, 22, 3, 0),
             (1, 5, OFFSET_UNKNOWN, 4, 0)]
    for line, note, off, code, flags in cases:
        body += struct.pack("<HHhBB", line, note, off, code, flags)
    recs, ver = decode_blob(base64.b64encode(body).decode())
    assert ver == JUDGE_VER, "版本号错"
    assert len(recs) == len(cases), f"条数错：{len(recs)}"
    for got, want in zip(recs, cases):
        assert got[:4] == want[:4], f"解析错：{got} != {want}"
    assert recs[1][2] == -15 and recs[3][2] == OFFSET_UNKNOWN
    print(f"[OK ] 自检通过：{len(recs)} 条，字段顺序、有符号偏移、哨兵值都对")
    summarize(recs, ver)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--b64")
    ap.add_argument("--file")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        return
    if a.file:
        b64 = open(a.file, encoding="utf-8").read()
    elif a.b64:
        b64 = a.b64
    else:
        print("需要 --b64 / --file / --selftest")
        return
    recs, ver = decode_blob(b64)
    summarize(recs, ver)


if __name__ == "__main__":
    main()
