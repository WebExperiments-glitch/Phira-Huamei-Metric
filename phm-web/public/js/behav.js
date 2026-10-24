/* ============================================================
 * js/behav.js —— 玩家实测难度
 * ============================================================
 * 数据在 /data/behavior-diff.json（1,700 张谱，每张 ≥10 人打过）。
 * 由 17,000 名玩家的 15.8 万条记录，按 log(std) 双向固定效应反推 ——
 * **完全不看谱面文件**，所以和引擎算出的两个数方法独立，能互相印证。
 *
 * ⚠ 只有知道谱面 id 时才有（从 /chart/<id> 深链进来）。本地拖入的文件没有 id。
 * ⚠ JSON 一次会话只拉一次：切谱不该重新下载 36 KB。
 * ============================================================ */

let CACHE = null;
let LOADING = false;

/**
 * @param {Element} root 已渲染的容器
 * @param {(k:string)=>string} t 词条函数
 * @param {(n:number)=>string} f1 一位小数格式化
 */
export function fillBehav(root, t, f1) {
  const el = root.querySelector('.behav');
  if (!el) return;
  const id = el.getAttribute('data-behav');
  if (!id) return;                     /* 本地文件：没有 id，整行不出现 */

  const paint = () => {
    const e = CACHE && CACHE.charts && CACHE.charts[id];
    if (!e) return;
    el.textContent = t('app.res.behav') + ' ' + f1(e[0]) + '（' + e[1] + '）';
    el.title = t('app.res.behav.tip');
  };

  if (CACHE) { paint(); return; }
  if (LOADING) return;
  LOADING = true;
  fetch('/data/behavior-diff.json')
    .then(r => r.json())
    .then(d => { CACHE = d; LOADING = false; paint(); })
    .catch(() => { LOADING = false; /* 没有这个文件就当没这项功能 */ });
}
