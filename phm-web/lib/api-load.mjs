/* ============================================================
 * lib/api-load.mjs —— 压力感知 + 选择性放弃（load shedding）
 * ============================================================
 * 【为什么需要它】
 *   限流（lib/api-guard.mjs）解决的是"某个调用方用太多"；
 *   它解决不了"所有人一起用、或者被打"——因为每个调用方都没超自己的额度，
 *   但总在途请求和下游延迟已经爆了。那种时候继续一视同仁地接，
 *   结果就是**全部变慢直到全挂**，连状态页和监控都打不开。
 *
 * 【核心原则】按成本选择性放弃，而不是平等地接住所有请求
 *   cheap     本地内存/静态 JSON（meta / engines / versions / behavior / reference）
 *             永远保 —— 它们不碰数据库，是"我还活着"的最后证据
 *   normal    单次查库（charts / stats / discrepancy）
 *             压力大时先降额，但不全拒
 *   expensive 打上游 / 跑引擎（charters / players / POST analyses）
 *             压力一来就先牺牲它们
 *
 * 【谁能被牺牲】匿名先于持 Key 先于签名/管理员。
 *   这是"成本不对称"：付费/可信调用方在压力期保留，匿名读降级。
 *
 * 【压力信号从哪来】
 *   不侵入 dbFetch（那要改几十个调用点），只看两个**代理指标**：
 *     · 在途请求数（inflight）
 *     · 最近 40 次请求的耗时中位数
 *   任何真实拥塞都会同时推高这两个数，够用了。
 *
 * 【状态是进程内的】无状态部署下每个进程各算各的 —— 这是刻意的：
 *   压力是**本进程**的感受，跨进程共享一个全局计数器反而会慢一拍。
 * ============================================================ */

const WINDOW = 40;          /* 最近多少次请求参与中位数 */
const LAT = [];             /* 最近请求耗时（ms） */
let inflight = 0;
let shedTotal = 0;
const shedBy = { cheap: 0, normal: 0, expensive: 0 };

/* 阈值：进程内并发 40 已远超正常（我们并发槽本来只有 2~4） */
const T = {
  busyInflight: 24,
  criticalInflight: 48,
  busyP50: 1_200,
  criticalP50: 2_600,
};

export function loadEnter() { inflight += 1; }

export function loadLeave(ms) {
  inflight = Math.max(0, inflight - 1);
  if (Number.isFinite(ms) && ms >= 0) {
    LAT.push(ms);
    if (LAT.length > WINDOW) LAT.shift();
  }
}

function p50() {
  if (!LAT.length) return 0;
  const a = LAT.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

export function pressure() {
  const med = p50();
  let level = 'normal';
  if (inflight >= T.criticalInflight || med >= T.criticalP50) level = 'critical';
  else if (inflight >= T.busyInflight || med >= T.busyP50) level = 'busy';
  return { level, inflight, p50: Math.round(med), window: LAT.length, shedTotal };
}

/* 路径 → 成本档。用 req.url 判，免得每个 gateApi 调用点都要多传一个参数。 */
export function costOf(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/^\/api\/v1/, '') || '/';
  if (p === '/analyses' || /^\/(charters|players)\//.test(p)) return 'expensive';
  if (/^\/(meta|openapi\.json|engines|versions|behavior|reference|status|incidents|health|analyses\/probe)/.test(p)) {
    return 'cheap';
  }
  return 'normal';
}

/* 身份优先级：数字越大越"该被保" */
function rank(tier) {
  if (tier === 'admin' || tier === 'signed') return 3;
  if (tier === 'key') return 2;
  return 1;
}

/* 返回 {shed:boolean, retryAfter?:number, reason?:string} */
export function shouldShed(cost, tier) {
  const pr = pressure();
  if (pr.level === 'normal') return { shed: false };

  if (pr.level === 'busy') {
    /* 只砍最贵的，且只砍匿名 —— 持 Key 的第三方还能用 */
    if (cost === 'expensive' && rank(tier) <= 1) {
      shedTotal += 1; shedBy.expensive += 1;
      return { shed: true, retryAfter: 5, reason: 'expensive' };
    }
    return { shed: false };
  }

  /* critical：
     · 廉价档永远保（状态页/监控/探针靠它活着）
     · 签名 / 管理员全保 —— 他们是运维通道，压力期砍掉等于自断手脚
     · Key 保普通查库，但昂贵操作（上游/重算）也要让路
     · 匿名只留廉价档 */
  if (cost === 'cheap') return { shed: false };
  if (rank(tier) >= 3) return { shed: false };
  if (cost === 'normal' && rank(tier) >= 2) return { shed: false };
  shedTotal += 1;
  shedBy[cost] += 1;
  return { shed: true, retryAfter: 10, reason: cost };
}

export function loadStats() {
  return { ...pressure(), shedBy: { ...shedBy } };
}

/* 测试缝 */
export function _resetLoad() {
  LAT.length = 0; inflight = 0; shedTotal = 0;
  shedBy.cheap = 0; shedBy.normal = 0; shedBy.expensive = 0;
}
export const _T = T;
