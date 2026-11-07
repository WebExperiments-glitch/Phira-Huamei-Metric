#!/usr/bin/env python3
"""RPE 判定线的世界/屏幕坐标变换。

━━━ 为什么需要 ━━━
现有 20 维事件特征全部基于 `positionX`（判定线的**本地**坐标）。但判定线本身
会平移、旋转、还有父级链 —— 玩家要移多远取决于判定线在屏幕上的位置，不是
`positionX`。这个模块把「本地 x → 世界屏幕 x」这一步补上。

━━━ 依据（不是猜的）━━━
直接对照仓库里的 prpr 源码 `phira-huamei/prpr/src/core/line.rs`
（`JudgeLine::fetch_rot` / `fetch_pos` / `now_transform`）与
`phira-huamei/prpr/src/parse/rpe.rs`（坐标缩放因子 / 旋转符号）：

    rot(i) = -Σ_layers rotateEvents(i)            # prpr 用 factor = -1
             + (rotate_with_father ? rot(parent) : 0)
    pos(i) = pos(parent) + R(rot(parent)) · own(i)  # 位置**总是**继承父级旋转
    own(i) = ( Σ moveXEvents / 675,  Σ moveYEvents / 450 / ASPECT )
    note   = pos(i) + R(rot(i)) · (positionX / 675, note_y)

━━━ 与任务描述的差异（实测）━━━
- 父链不是 `judgeLineGroup` 字符串决定的，而是 `father: int` —— 指向
  `judgeLineList` 的下标，`-1` 表示无父级。`judgeLineGroup`/`Group` 只是
  分组号。按字符串匹配会得到 0 条父链。
- `rotate_with_father` 在 `data/charts` 前 225 张里**一次都没出现**
  （0 / 约 6000 条判定线），所以父级旋转继承在当前语料里不生效；但父级
  **位置**继承（503 条线有 father）是生效的，必须实现。

━━━ 近似（明确标注，不假装精确）━━━
1. **缓动只做线性插值**。RPE 有几十种 `easingType`，这里与
   `chart_io._track_value` 保持同一口径（那里也只做线性）。保持型事件
   （`start == end`，最常见）是精确的。
2. **多 `eventLayers` 按 prpr 语义求和**（`AnimFloat::chain`：
   `a1(t) + a2(t) + ...`）。现有 `chart_io._line_tracks` 是"取第一个非空
   图层"，两者在单图层时等价。前 225 张里 20% 的线有同字段多图层。
3. **首事件之前取首值**（prpr 实际会线性外推）。语料里事件几乎都从 0 拍
   起，这条只在畸形谱上生效。
4. 忽略 `height`/`speedEvents` 对 y 的积分、`skew`、`size`、音符 yOffset
   （x 特征不需要；y 只通过父级旋转影响 x）。
5. `eventLayers` 中 `moveX/moveY/rotate` 的**层级顺序**按数组顺序求和，
   与 prpr 一致；不做 speed 重排。

━━━ 坐标约定 ━━━
内部一律用**归一化屏幕坐标**：x ∈ [-1, 1]（半宽 = 1），
y ∈ [-0.5625, 0.5625]（= 1/ASPECT，16:9）。
对外接口（`screen_x` / `ChartGeometry.screen_xy`）乘回 675，返回
**RPE 单位** —— 与 `positionX` 同尺度，所以 `screen_x / 675` 可直接与
`positionX / 675` 对齐比较。
"""
import bisect
import json
import math

from chart_io import _frac

ASPECT = 16.0 / 9.0
HALF_W = 675.0          # RPE x 半宽
HALF_H = 450.0          # RPE y 半高（除以 ASPECT 后 = 屏幕半高）


# ────────────────────────── 单条轨道 ──────────────────────────
class _Layer:
    """一条事件轨道（线性插值）。事件按 startTime 升序。"""

    __slots__ = ("starts", "ends", "v0", "v1")

    def __init__(self, events):
        evs = []
        for e in events or []:
            try:
                b0 = _frac(e.get("startTime"))
                b1 = _frac(e.get("endTime", e.get("startTime")))
                v0 = float(e.get("start") or 0.0)
                v1 = float(e.get("end") if e.get("end") is not None else v0)
            except (TypeError, ValueError, KeyError):
                continue
            evs.append((b0, b1, v0, v1))
        evs.sort(key=lambda x: x[0])
        self.starts = [x[0] for x in evs]
        self.ends = [x[1] for x in evs]
        self.v0 = [x[2] for x in evs]
        self.v1 = [x[3] for x in evs]

    def at(self, beat):
        """beat 处的值。空轨道返回 0；首事件前取首值。"""
        n = len(self.starts)
        if n == 0:
            return 0.0
        if beat <= self.starts[0]:
            return self.v0[0]
        i = bisect.bisect_right(self.starts, beat) - 1
        b0, b1, v0, v1 = self.starts[i], self.ends[i], self.v0[i], self.v1[i]
        if beat >= b1:
            return v1
        if b1 - b0 < 1e-12:
            return v1
        return v0 + (v1 - v0) * (beat - b0) / (b1 - b0)


def _layers_of(line, key):
    """收集两种 RPE 结构里该字段的所有图层：老版挂在判定线上，v150+ 在 eventLayers。"""
    out = []
    direct = line.get(key)
    if direct:
        out.append(direct)
    for el in line.get("eventLayers") or []:
        if isinstance(el, dict) and el.get(key):
            out.append(el[key])
    return [_Layer(es) for es in out]


# ────────────────────────── 单条判定线 ──────────────────────────
class Line:
    """一条判定线的运动（不含父链）。"""

    def __init__(self, d):
        f = d.get("father", -1)
        # ⚠ 不能用 `or -1`：father=0 是合法父级，会被 falsy 吞掉。
        self.parent = int(f) if f is not None else -1
        # prpr 的 serde 是 camelCase：JSON 键名是 rotateWithFather；
        # 两种写法都兼容（语料里 3,590 条判定线一个都没出现这个键）。
        self.rot_with_parent = bool(d.get("rotateWithFather",
                                           d.get("rotate_with_father", False)))
        self.mx = _layers_of(d, "moveXEvents")
        self.my = _layers_of(d, "moveYEvents")
        self.rot = _layers_of(d, "rotateEvents")
        self.n_notes = len(d.get("notes") or [])

    def own(self, beat):
        """本地位移，归一化屏幕坐标 (x 半宽=1, y 半高=1/ASPECT)。"""
        x = sum(l.at(beat) for l in self.mx) / HALF_W
        y = sum(l.at(beat) for l in self.my) / HALF_H / ASPECT
        return x, y

    def own_rot(self, beat):
        """本地旋转（度）。prpr 用 factor=-1，即 RPE 角度取负。"""
        return -sum(l.at(beat) for l in self.rot)


def screen_x(line, beat, local_x, parent_rot_deg=0.0, parent_pos=(0.0, 0.0)):
    """单层判定线的屏幕 x（RPE 单位，±675），可选传入已合成的父级变换。

    这是任务要求的那个入口的"无父链"形态；有父链请用 `ChartGeometry`。
    `local_x` 是音符的 `positionX`（±675）。
    """
    ox, _oy = line.own(beat)
    rot = line.own_rot(beat) + parent_rot_deg
    th = math.radians(rot)
    return parent_pos[0] * HALF_W + ox * HALF_W + local_x * math.cos(th)


def screen_xy(line, beat, local_x, parent_rot_deg=0.0, parent_pos=(0.0, 0.0)):
    """同上，返回 (x, y)，都是 RPE 单位（x ±675 / y 按 675 缩放）。"""
    ox, oy = line.own(beat)
    rot = line.own_rot(beat) + parent_rot_deg
    th = math.radians(rot)
    c, s = math.cos(th), math.sin(th)
    x = parent_pos[0] + ox + local_x / HALF_W * c
    y = parent_pos[1] + oy + local_x / HALF_W * s
    return x * HALF_W, y * HALF_W


# ────────────────────────── 整谱几何 ──────────────────────────
class ChartGeometry:
    """一张 RPE 谱面的判定线几何，含父链合成。

    用法：
        g = ChartGeometry(chart_dict)
        sx, sy = g.screen_xy(line_idx, beat, position_x)
        g.line_speed(line_idx, beat, bpm)      # 屏幕单位/秒
        g.rot_speed(line_idx, beat, bpm)       # 度/秒
    """

    def __init__(self, data):
        raw = data.get("judgeLineList") or []
        self.lines = [Line(d) for d in raw if isinstance(d, dict)]
        self._pos_cache = {}
        self._validate()

    def _validate(self):
        """校验 father 下标与成环 —— 不做静默修补，坏谱让调用方跳过并计数。"""
        n = len(self.lines)
        for i in range(n):
            seen, j = set(), i
            while 0 <= j < n:
                if j in seen:
                    raise ValueError("judge line parent cycle")
                seen.add(j)
                j = self.lines[j].parent
            if j >= n and self.lines[i].parent >= n:
                raise ValueError("judge line father index out of range")

    def _rot_full(self, i, beat):
        """fetch_rot：自身旋转 + （可选）父级完整旋转。"""
        ln = self.lines[i]
        r = ln.own_rot(beat)
        if ln.rot_with_parent and 0 <= ln.parent < len(self.lines):
            r += self._rot_full(ln.parent, beat)
        return r

    def _pos(self, i, beat, depth=0):
        """fetch_pos：pos(parent) + R(rot(parent)) · own。返回归一化屏幕坐标。"""
        key = (i, beat)
        hit = self._pos_cache.get(key)
        if hit is not None:
            return hit
        if depth > 64:
            raise ValueError("judge line parent cycle")
        ln = self.lines[i]
        ox, oy = ln.own(beat)
        if 0 <= ln.parent < len(self.lines):
            px, py = self._pos(ln.parent, beat, depth + 1)
            th = math.radians(self._rot_full(ln.parent, beat))
            c, s = math.cos(th), math.sin(th)
            res = (px + ox * c - oy * s, py + ox * s + oy * c)
        else:
            res = (ox, oy)
        if len(self._pos_cache) > 400000:
            self._pos_cache.clear()
        self._pos_cache[key] = res
        return res

    def screen_xy(self, i, beat, local_x):
        """音符的屏幕坐标（RPE 单位）：判定线位置 + 旋转后的本地偏移。"""
        px, py = self._pos(i, beat)
        th = math.radians(self._rot_full(i, beat))
        lx = local_x / HALF_W
        return ((px + lx * math.cos(th)) * HALF_W,
                (py + lx * math.sin(th)) * HALF_W)

    def screen_x(self, i, beat, local_x):
        return self.screen_xy(i, beat, local_x)[0]

    # ── 速度：在拍空间做中心差分，再乘 bpm/60 换成每秒 ──
    def _bpm_at(self, beat, bps):
        cur = bps[0][1] if bps else 120.0
        for b, v in bps:
            if b <= beat:
                cur = v
            else:
                break
        return cur

    def line_speed(self, i, beat, bps, h_sec=0.01):
        """判定线位移速度，单位 = RPE 屏幕单位/秒（675 = 半屏宽）。

        拍空间的中心差分：位移/拍 × 拍/秒。`bps` 为 [(beat, bpm), ...]。
        """
        bpm = self._bpm_at(beat, bps)
        hb = max(h_sec * bpm / 60.0, 1e-6)
        b0, b1 = max(beat - hb, 0.0), beat + hb
        if b1 - b0 < 1e-9:
            return 0.0
        x0, y0 = self._pos(i, b0)
        x1, y1 = self._pos(i, b1)
        dist = math.hypot((x1 - x0) * HALF_W, (y1 - y0) * HALF_W)
        return dist / ((b1 - b0) * 60.0 / bpm)

    def rot_speed(self, i, beat, bps, h_sec=0.01):
        """判定线角速度，度/秒（取绝对值，角度差按 ±180° 归一，避免 360→0 假跳变）。"""
        bpm = self._bpm_at(beat, bps)
        hb = max(h_sec * bpm / 60.0, 1e-6)
        b0, b1 = max(beat - hb, 0.0), beat + hb
        if b1 - b0 < 1e-9:
            return 0.0
        d = self._rot_full(i, b1) - self._rot_full(i, b0)
        d = (d + 180.0) % 360.0 - 180.0
        return abs(d) / ((b1 - b0) * 60.0 / bpm)


def load_geometry(path):
    """从 RPE 文件建 ChartGeometry；非 RPE 返回 None。"""
    raw = open(path, encoding="utf-8", errors="replace").read()
    if raw.lstrip()[:1] != "{":
        return None
    d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    if not isinstance(d, dict) or "judgeLineList" not in d:
        return None
    return ChartGeometry(d)


# ────────────────────────── 自测 ──────────────────────────
def _selftest():
    """3 个手算用例 + 1 个父链用例，误差断言 < 1e-6。

    所有用例 bpm=120（1 拍 = 0.5 秒）。
    """
    def line(**kw):
        return Line(kw)

    one = lambda a, b, v0, v1: [{"startTime": a, "endTime": b,
                                 "start": v0, "end": v1}]

    cases = []

    # 1) 无线运动：rot=0，判定线不动 → screen_x 就是 local_x
    cases.append(("静止", line(), 8.0, 300.0, 300.0))

    # 2) 纯平移：moveX 0→270 每 8 拍，beat=4 时 135
    ln2 = line(moveXEvents=one([0, 0, 1], [8, 0, 1], 0.0, 270.0))
    cases.append(("纯平移", ln2, 4.0, 0.0, 135.0))

    # 3) 纯旋转 90°：local_x=100 → 屏幕 x = 100·cos(90°) = 0
    ln3 = line(rotateEvents=one([0, 0, 1], [0, 0, 1], 90.0, 90.0))
    cases.append(("旋转90°", ln3, 0.0, 100.0, 0.0))

    # 4) 父链：父 moveX=200，子 moveX=100、父 rot=90° 而子不随父旋转
    #    子世界 x = 200 + 100·cos(90°) = 200
    parent = {"father": -1, "moveXEvents": one([0, 0, 1], [0, 0, 1], 200.0, 200.0),
              "rotateEvents": one([0, 0, 1], [0, 0, 1], 90.0, 90.0)}
    child = {"father": 0, "moveXEvents": one([0, 0, 1], [0, 0, 1], 100.0, 100.0)}
    g = ChartGeometry({"judgeLineList": [parent, child]})
    got = g.screen_x(1, 0.0, 0.0)
    cases.append(("父链(父转90°子平移100)", None, 0.0, 0.0, 200.0, got))

    print("line_geometry 自测")
    ok = True
    for c in cases:
        name, ln, beat, local_x, expect = c[:5]
        if len(c) > 5:
            got = c[5]
        else:
            got = screen_x(ln, beat, local_x)
        err = abs(got - expect)
        flag = "OK " if err < 1e-6 else "FAIL"
        ok = ok and err < 1e-6
        print(f"  [{flag}] {name:<22} expect={expect:>8.3f} got={got:>12.6f} "
              f"err={err:.2e}")

    # 5) 额外：旋转 90° 的 y 分量应为 -100（prpr 的 rotation factor = -1）
    y = screen_xy(ln3, 0.0, 100.0)[1]
    err = abs(y - (-100.0))
    ok = ok and err < 1e-6
    print(f"  [{'OK ' if err < 1e-6 else 'FAIL'}] {'旋转90°的y分量':<22} "
          f"expect={-100.0:>8.3f} got={y:>12.6f} err={err:.2e}")

    assert ok, "自测失败"
    print("全部通过（容差 1e-6）")
    return True


if __name__ == "__main__":
    _selftest()
