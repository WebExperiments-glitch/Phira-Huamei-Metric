/* ============================================================
 * js/skills.js —— 把 39 个原始特征重组为「技能维度」
 * ============================================================
 *  存在理由（2026-10-18，方案 C）：
 *    引擎已经算了 39 个特征，但对外只吐一个总数。玩家问
 *    「这首是手速难还是读谱难」时无解 —— 而这个问题恰恰是
 *    「又一个定数网站」和「专业难度参考」的分界线。
 *
 *  ⚠⚠ **本模块绝不改任何计算**。
 *     · 不新增特征
 *     · 不修改 `ENGINE_VER`（引擎数值轴不变）
 *     · 不影响 k-NN 用的 8 个 REF_DIMS
 *     · 661 张已缓存谱面的定数一个字都不变
 *    它只是把 `report.feats` 按语义**重新分组**，属于纯展示层。
 *    这正是选它作为第一步的原因：零风险、高感知、可回滚。
 *
 *  分组依据 osu! (20220902) 的四技能模型，并按 Phira 谱面特性调整：
 *     osu!                  → 本模块
 *     Aim（光标移动）        → Precision（落点精度）
 *     Speed（ Tap 密度）     → Stamina（持续输出）
 *     Accuracy（节奏准时）   → Dexterity（手指灵活）
 *     Flashlight（记忆）     → Reading（读谱 / 视觉处理）
 *  另加 Phira 特有的一项：
 *     Rhythm（节奏复杂度）   → 已有 pattern_switch_rate 等，但先不单列
 *                            （避免与 Reading 重叠；等 strain 化改造时再拆）
 *
 *  ⚠ 为什么用「归一化后加权」而不是直接平均：
 *     各特征量纲差极大（notes_real 上千、entropy 不到 1）。
 *     直接平均会让大量纲特征吃掉一切。这里按技能内 min-max 归一到 0-100，
 *     权重写在 SKILL_DEFS 里，**可被审计和调整**。
 *
 *  ⚠ 归一化的锚点（分母）来自官谱参照集 1037 行的实测分布，
 *     不是拍的数字。写死锚点的理由：展示层要稳定可比，
 *     每次按当前样本重算会让同一张谱的分数前后不一致。
 * ============================================================ */

/** 各技能的归一化上限 —— 取自官谱参照集 1037 行的 max（向上取整到好用）。
 *  ⚠ 这些是**展示锚点**，不是难度定义。改动它们只影响显示，不影响定数。 */
const ANCHOR = {
  real_notes_per_second:      15,
  real_core_notes_per_second: 15,
  strain_p99:                 100,
  above_avg_density_mean:     34,
  eff_peak_tps_1s:            8,
  chord_ratio:                12,
  avg_chord_size:             4,
  multi_finger_3plus_events:   400,
  chord_size_entropy:         1,
  note_clutter_ratio:         91,
  position_entropy:           7,
  cross_hand_density:         10,
  jline_move_disp_per_sec:    5,
  jline_rotate_density:       30,
  pattern_switch_rate:        12,
  type_switch_per_sec:        12,
  hold_ratio:                 1,
  drag_per_sec:               3,
  stair_speed_max:            60,
  iv_mean:                    0.4,
  fast_ratio:                 40,
};

/** 归一化：v/anchor，封顶 1。缺失字段记 0（不会让整组崩）。 */
function norm(v, key) {
  const a = ANCHOR[key];
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (!Number.isFinite(a) || a <= 0) return 0;
  return Math.min(1, x / a);
}

/* ── 技能定义 ──
 * 每项：label 词条名 / desc 说明 / dims [特征, 权重][]
 * ⚠ 权重之和应为 1（不强制，但便于理解）。
 * ⚠ 只用「确实算了」的字段 —— 加字段前先确认 engine.js 真的产出它，
 *   否则该技能会静默少一项（而且看不出来）。 */
const SKILL_DEFS = Object.freeze([
  {
    id: 'stamina',
    label: 'skill.stamina',
    desc: 'skill.stamina.d',
    dims: [
      ['real_notes_per_second', 0.30],
      ['real_core_notes_per_second', 0.20],
      ['strain_p99', 0.25],
      ['above_avg_density_mean', 0.15],
      ['eff_peak_tps_1s', 0.10],
    ],
  },
  {
    id: 'dexterity',
    label: 'skill.dexterity',
    desc: 'skill.dexterity.d',
    dims: [
      ['chord_ratio', 0.22],
      ['avg_chord_size', 0.18],
      ['multi_finger_3plus_events', 0.18],
      ['chord_size_entropy', 0.12],
      ['type_switch_per_sec', 0.15],
      ['fast_ratio', 0.15],
    ],
  },
  {
    id: 'reading',
    label: 'skill.reading',
    desc: 'skill.reading.d',
    dims: [
      ['note_clutter_ratio', 0.30],
      ['position_entropy', 0.22],
      ['cross_hand_density', 0.18],
      ['jline_rotate_density', 0.12],
      ['jline_move_disp_per_sec', 0.08],
      ['pattern_switch_rate', 0.10],
    ],
  },
  {
    id: 'precision',
    label: 'skill.precision',
    desc: 'skill.precision.d',
    dims: [
      ['iv_mean', 0.30],
      ['stair_speed_max', 0.25],
      ['hold_ratio', 0.20],
      ['drag_per_sec', 0.25],
    ],
  },
]);

/**
 * 算技能分（0-100，一位小数）。
 * @param {object} feats reportFromChart() 返回的 feats
 * @returns {{stamina:number, dexterity:number, reading:number, precision:number,
 *            top:string, profile:string}}
 *   top     = 最高项 id（"难在哪"的直接答案）
 *   profile = 一句概括（如 "stamina-led"），给页面/API 用
 */
export function skillScores(feats) {
  const f = feats || {};
  const out = {};
  for (const s of SKILL_DEFS) {
    let acc = 0, wsum = 0;
    for (const [key, w] of s.dims) {
      acc += norm(f[key], key) * w;
      wsum += w;
    }
    out[s.id] = Math.round((wsum > 0 ? acc / wsum : 0) * 1000) / 10;
  }
  /* 最高项：并列时取定义顺序里的第一个（顺序即优先级，
     把 stamina 放最前是因为它最常被玩家感知）。 */
  let top = SKILL_DEFS[0].id;
  for (const s of SKILL_DEFS) if (out[s.id] > out[top]) top = s.id;
  /* profile：最高项 >= 60 时称 "-led"，否则 "balanced"。
     ⚠ 阈值 60 是拍的但理由充分：四项各 25 才是均衡，
        60 表示该项明显超出基线一截。 */
  const led = out[top] >= 60;
  return Object.assign(out, {
    top,
    profile: led ? top + '-led' : 'balanced',
  });
}

export default skillScores;
