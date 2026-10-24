/* ============================================================
 * js/behav.js —— 玩家实测难度
 * ============================================================
 * 数据在 /data/behavior-diff.json（1,700 张谱，每张 ≥10 人打过）：
 *   charts[id] = [难度, 人数, 物量, 时长, BPM]
 * 难度由 17,000 名玩家的 15.8 万条记录按 log(std) 双向固定效应反推 ——
 * **完全不看谱面文件**，所以和引擎算的数方法独立，能互相印证。
 *
 * 【两种找法】
 *   ① 有谱面 id（/chart/<id> 深链进来）→ 直接查
 *   ② 没有 id（本地拖入）→ 用**指纹反查**：物量 + 时长 + BPM 三元组
 *
 * 【指纹必须唯一】
 *   三项都对上才算命中；命中多个就**放弃**，不猜。
 *   猜错比不显示糟得多 —— 用户会拿这个数当真。
 * ============================================================ */

let CACHE = null;
let LOADING = false;
const WAITERS = [];

const DUR_TOL = 0.35;      /* 秒。引擎与服务端算时长的方式一致，差这么点够用 */
const BPM_TOL = 0.15;

function findByFingerprint(notes, dur, bpm) {
  const charts = CACHE && CACHE.charts;
  if (!charts) return null;
  let hit = null;
  for (const id in charts) {
    const e = charts[id];
    if (e[2] !== notes) continue;
    if (Math.abs(e[3] - dur) > DUR_TOL) continue;
    if (Math.abs(e[4] - bpm) > BPM_TOL) continue;
    if (hit) return null;          /* 不止一个 → 宁可不显示 */
    hit = e;
  }
  return hit;
}

/**
 * @param {Element} root 已渲染的容器
 * @param {(k:string)=>string} t 词条函数
 * @param {(n:number)=>string} f1 一位小数格式化
 */
export function fillBehav(root, t, f1) {
  const el = root.querySelector('.behav');
  if (!el) return;
  const id = el.getAttribute('data-behav') || '';
  /* 指纹由 app.html 写好：物量|时长|BPM。任一为空就说明算不出来，直接放弃。 */
  const fp = (el.getAttribute('data-fp') || '').split('|').map(Number);
  const hasFp = fp.length === 3 && fp.every(v => isFinite(v) && v > 0);

  const paint = () => {
    let e = null;
    if (id) e = CACHE && CACHE.charts && CACHE.charts[id];
    if (!e && hasFp) e = findByFingerprint(fp[0], fp[1], fp[2]);
    if (!e) return;
    el.textContent = t('app.res.behav') + ' ' + f1(e[0]) + '（' + e[1] + '）';
    el.title = t('app.res.behav.tip');
  };

  if (CACHE) { paint(); return; }
  WAITERS.push(paint);
  if (LOADING) return;
  LOADING = true;
  fetch('/data/behavior-diff.json')
    .then(r => r.json())
    .then(d => {
      CACHE = d; LOADING = false;
      while (WAITERS.length) WAITERS.pop()();
    })
    .catch(() => { LOADING = false; /* 没有这个文件就当没这项功能 */ });
}
