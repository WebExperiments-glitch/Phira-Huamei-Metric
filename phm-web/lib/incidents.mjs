/* ============================================================
 * lib/incidents.mjs —— 故障事件（incident）与组件状态机
 * ============================================================
 * 【为什么要有这一层】
 *   现在的状态页只有「可用率百分比」，那是**结果**，不是**事件**。
 *   用户看到 62% 只能猜「是不是我又赶上倒霉」，看不到「出了什么事、
 *   影响哪些功能、什么时候恢复的」。
 *
 *   业界（Atlassian Statuspage / FlashDuty / OpenStatus）的做法一样：
 *   把「组件状态」和「事件时间线」作为一等公民，可用率由事件派生。
 *
 * 【词汇照抄 Statuspage，不自创】
 *   Operational   正常        绿
 *   Degraded      性能下降     黄   ← 还在响应，只是慢或部分失败
 *   Partial       部分中断     橙   ← 一部分用户/功能完全不可用
 *   Major         完全中断     红
 *
 * 【状态判定（照 OpenStatus 的三问）】
 *   ① 有彻底失败吗？没有 → Degraded
 *   ② 有失败，但只是部分 → Partial
 *   ③ 全都失败 → Major
 *   ⚠ 两个都沾边时取**更严重**那个：少报比多报更伤信任。
 *
 * 【总状态：Atlassian 官方决策树】
 *   全部 Operational → operational
 *   任意 Major       → partial        （一个组件挂 ≠ 整站挂）
 *   任意 Partial     → minor
 *   全部 Degraded    → degraded
 *   任意 Degraded    → partial_degraded
 *
 * 【阈值：宁可慢一点，也别误报】
 *   连续 3 次失败才降级（60s 间隔 ≈ 3 分钟）
 *   连续 5 次成功才恢复（≈ 5 分钟，避免抖动来回翻）
 * ============================================================ */

export const STATUS = {
  operational: { label: '正常', rank: 0 },
  degraded: { label: '性能下降', rank: 1 },
  partial: { label: '部分中断', rank: 2 },
  major: { label: '完全中断', rank: 3 },
};

/* 组件 = 探针的分组。20 个探针逐个列在页面上没人看得懂，
   按「页面 / 接口 / 数据」三组聚合才对得上用户的心智模型。 */
export const COMPONENTS = [
  { id: 'page', label: '页面' },
  { id: 'api', label: '接口' },
  { id: 'data', label: '数据' },
];

const FAIL_TO_DEGRADE = 3;   // 连续失败几次 → 降级
const OK_TO_RECOVER = 5;     // 连续成功几次 → 恢复
const SLOW_MS = 1500;        // 成功但慢过这个值，算降级（还在响应）

/* 每个 target 的连续计数 */
const streaks = new Map();   // id -> { fails, oks, status }
const incidents = [];        // 最近的故障事件（新的在前）
let seq = 0;

function st(targetId) {
  let s = streaks.get(targetId);
  if (!s) {
    s = { fails: 0, oks: 0, status: 'operational', since: Date.now() };
    streaks.set(targetId, s);
  }
  return s;
}

/** 单个探针 → 一个 target 级状态 */
function targetStatus(sample) {
  const s = st(sample.id);
  if (sample.ok) {
    s.oks++;
    s.fails = 0;
    /* 成功但很慢：仍算 degraded —— 用户能打开，但体验已经坏了。
       这正是标准里最被低估的那一档。 */
    const slow = sample.ms != null && sample.ms > SLOW_MS;
    const next = slow ? 'degraded' : 'operational';
    if (s.status !== next) {
      /* 从降级恢复要连续成功够久，避免抖动 */
      if (next === 'operational' && s.oks < OK_TO_RECOVER && s.status !== 'operational') {
        return s.status;
      }
    }
    if (s.status !== next) {
      s.status = next;
      s.since = Date.now();
    }
  } else {
    s.oks = 0;
    s.fails++;
    if (s.fails >= FAIL_TO_DEGRADE) {
      if (s.status !== 'major') {
        s.status = 'major';
        s.since = Date.now();
      }
    } else if (s.status === 'operational') {
      /* 还没到阈值：先记一笔，但不对外显示 —— 一次抖动不该让页面变红 */
      s.status = 'operational';
    }
  }
  return s.status;
}

/** 把 target 级状态聚合成组件级状态 */
function componentStatus(statuses) {
  const worst = (arr) => {
    if (!arr.length) return 'operational';
    const major = arr.filter((x) => x === 'major').length;
    const bad = arr.filter((x) => x === 'major' || x === 'partial').length;
    if (major === arr.length) return 'major';
    if (bad > 0) return 'partial';
    if (arr.some((x) => x === 'degraded')) return 'degraded';
    return 'operational';
  };
  return worst(statuses);
}

/** Atlassian 官方决策树：组件 → 总状态 */
export function overallFrom(components) {
  const s = components.map((c) => c.status);
  if (!s.length || s.every((x) => x === 'operational')) return 'operational';
  if (s.every((x) => x === 'major')) return 'major';
  if (s.every((x) => x === 'partial')) return 'partial';
  if (s.some((x) => x === 'major')) return 'partial';
  if (s.some((x) => x === 'partial')) return 'minor';
  if (s.every((x) => x === 'degraded')) return 'degraded';
  if (s.some((x) => x === 'degraded')) return 'partial_degraded';
  return 'operational';
}

const OVERALL_LABEL = {
  operational: '所有系统运行正常',
  degraded: '系统整体性能下降',
  partial_degraded: '部分服务性能下降',
  minor: '部分服务中断',
  partial: '部分系统中断',
  major: '系统完全中断',
};

/** 每轮探测后调用：更新状态机，必要时开/关事件 */
export function ingest(samples, targets) {
  const byGroup = new Map();
  for (const t of targets) byGroup.set(t.group, []);

  for (const s of samples) {
    const t = targets.find((x) => x.id === s.id);
    if (!t) continue;
    const status = targetStatus(s);
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(status);
  }

  const comps = COMPONENTS.map((c) => {
    const sts = byGroup.get(c.id) || [];
    return { id: c.id, label: c.label, status: componentStatus(sts), targets: sts.length };
  });

  /* ── 事件生命周期 ──
     组件离开 operational → 开一条；回到 operational → 关闭。
     同一组件同时只有一条未关闭的事件（不重复刷屏）。 */
  for (const c of comps) {
    const open = incidents.find((i) => !i.resolvedAt && i.component === c.id);
    if (c.status !== 'operational' && !open) {
      incidents.unshift({
        id: 'inc-' + (++seq) + '-' + Date.now().toString(36),
        component: c.id,
        componentLabel: c.label,
        level: c.status,
        startedAt: Date.now(),
        resolvedAt: null,
        updates: [{
          at: Date.now(),
          status: c.status,
          text: `${c.label}出现${STATUS[c.status].label}，正在排查。`,
        }],
      });
    } else if (c.status !== 'operational' && open && open.level !== c.status) {
      open.level = c.status;
      open.updates.push({
        at: Date.now(),
        status: c.status,
        text: `${c.label}状态变更为${STATUS[c.status].label}。`,
      });
    } else if (c.status === 'operational' && open) {
      open.resolvedAt = Date.now();
      open.updates.push({
        at: Date.now(),
        status: 'operational',
        text: `${c.label}已恢复。`,
      });
    }
  }

  if (incidents.length > 50) incidents.length = 50;

  return { components: comps, overall: overallFrom(comps), incidents };
}


export function overallLabel(key) {
  return OVERALL_LABEL[key] || key;
}
