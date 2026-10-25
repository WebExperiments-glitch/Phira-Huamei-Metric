/* ============================================================
 * js/beat-time.js —— 拍 ↔ 秒 的**唯一**换算
 * ============================================================
 * 【为什么单独成文件】
 *   这张谱里同时存在四种时间：全局秒 / 音频秒 / 全局拍 / 线局部拍。
 *   换算式在旧版埋在 agent-commands.js 里，于是它既**测不到**
 *   （那个模块 import 了 ui.js，要 DOM），也容易被别人抄一份走。
 *   抽出来之后是纯函数：给定 BPMList 就能双向换算，单测直接 import。
 *
 * 【语义（2026-10-25 修正，别再改回去）】
 *   `BPMList[i].bpm` 管的是 **[startTime_i, startTime_{i+1})** 这一段。
 *   旧版写的是 `sec += (at - prev) * 60 / p.bpm`，拿**下一个** BPM 点的值
 *   去算**前一段**，变速谱会整体偏掉（16 拍 @120 应 8.00 秒，旧版给 5.33 秒）。
 *   单 BPM 时新旧数值完全一致 —— 所以这条修正对现存谱面零影响。
 * ============================================================ */

/** RPE 的拍是 `[整拍, 分子, 分母]`；老数据可能直接是数字。 */
export function beatValue(b) {
  if (Array.isArray(b)) return b[0] + (b[1] || 0) / (b[2] || 1);
  return Number(b) || 0;
}

/** 拍数（可以是小数）→ RPE 三元组。分母取 1000，够表达任何量化到 1/48 的谱。 */
export function toBeat(n) {
  const v = Number(n) || 0;
  const whole = Math.trunc(v);
  const frac = v - whole;
  return frac < 1e-9 ? [whole, 0, 1] : [whole, Math.round(frac * 1000), 1000];
}

/* ⚠ 名字带 chart 前缀是为了和 rhythm.js 的 beatToSec/secToBeat 分开：
   那两个收的是**恒定速度的网格对象**（{offsetSec, beatSec}，音频量化用），
   这两个收的是 **RPE 的 BPMList**（可变速）。同名不同物，混了必错。 */

/** 拍 → 秒（分段积分，变速谱成立）。 */
export function chartBeatToSec(beat, bpmList) {
  let sec = 0;
  for (let i = 0; i < (bpmList?.length ?? 0); i++) {
    const at = beatValue(bpmList[i].startTime);
    const nextAt = i + 1 < bpmList.length ? beatValue(bpmList[i + 1].startTime) : Infinity;
    if (beat <= at) break;
    sec += (Math.min(beat, nextAt) - at) * 60 / bpmList[i].bpm;
    if (beat <= nextAt) break;
  }
  return sec;
}

/** 秒 → 拍：chartBeatToSec 的**严格逆运算**。
    模型手里是 onset 的秒数，而 tap()/key() 收的是拍；没有它就等于让人猜。 */
export function chartSecToBeat(sec, bpmList) {
  let acc = 0;
  for (let i = 0; i < (bpmList?.length ?? 0); i++) {
    const at = beatValue(bpmList[i].startTime);
    const nextAt = i + 1 < bpmList.length ? beatValue(bpmList[i + 1].startTime) : Infinity;
    const spanSec = nextAt === Infinity ? Infinity : (nextAt - at) * 60 / bpmList[i].bpm;
    if (acc + spanSec >= sec) return at + (sec - acc) * bpmList[i].bpm / 60;
    acc += spanSec;
  }
  return 0;
}
