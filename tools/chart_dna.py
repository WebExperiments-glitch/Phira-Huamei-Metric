#!/usr/bin/env python3
"""谱面 DNA：把一张谱压成 2 字符/事件的紧凑串。

━━━ 为什么值得单独写一个模块 ━━━
最初的自然语言式编码（`12.34 +337.5 T`）要 **13.2 token/事件** ——
中位谱面 1,093 个事件就是 14,400 token，4,096 上下文只能装三成，
所以我一度打算"均匀抽样"糊过去。那是错的方向：先该压编码，不是砍数据。

压到 2 字符后是 **2.00 token/事件**，中位谱 2,186 token —— 完整装下。

━━━ 格式（全部单字符，无分隔符）━━━
每个事件：
  char 1  = 时间差（0.1 秒为单位，0..31；超过 31 记 31 并标长间隔）
  char 2  = 轨道(0..7) × 4 + 类型(T=0 H=1 F=2 D=3)   → 0..31
  char 3  = 仅长条（H）才有：时长（0.1 秒，0..31，超了截断）
字符集 = base32 `0123456789abcdefghijklmnopqrstuvwxyz`，每个都是单 token。

损失：横坐标量化到 8 条轨道（±675 均分）；长间隔与长条时长封顶 3.1 秒。
这两项对难度判断的影响远小于"看不到整张谱"。
"""
B32 = "0123456789abcdefghijklmnopqrstuvwxyz"
TY = {"T": 0, "H": 1, "F": 2, "D": 3}
MAXDT = 31
LANES = 8


def encode(events):
    """events: [(t_sec, x, type_char, hold_sec or None), ...] → str"""
    out = []
    prev = 0.0
    for t, x, ty, hold in events:
        dt = int(round((t - prev) * 10))
        prev = t
        if dt < 0:
            dt = 0
        if dt > MAXDT:
            dt = MAXDT                       # 长间隔封顶（乐句间的停顿）
        lane = int((x + 675.0) / (1350.0 / LANES))
        lane = min(max(lane, 0), LANES - 1)
        out.append(B32[dt] + B32[lane * 4 + TY.get(ty, 0)])
        if ty == "H":
            hd = min(int(round((hold or 0.0) * 10)), MAXDT)
            out.append(B32[hd])
    return "".join(out)


def decode(s):
    """反解回事件（写测试和排查用，训练不需要）。"""
    i, t, ev = 0, 0.0, []
    while i < len(s):
        dt = B32.index(s[i])
        v = B32.index(s[i + 1])
        lane, ty = v // 4, v % 4
        x = -675.0 + (lane + 0.5) * (1350.0 / LANES)
        t += dt / 10.0
        hold = None
        i += 2
        if ty == 1 and i < len(s):
            hold = B32.index(s[i]) / 10.0
            i += 1
        ev.append((t, x, "THFD"[ty], hold))
    return ev
