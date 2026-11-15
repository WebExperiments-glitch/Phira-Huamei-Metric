#!/usr/bin/env node
/* 成绩数据质量体检。
 *
 * 用法：
 *   node tools/hm-stats.mjs            # 摘要
 *   node tools/hm-stats.mjs --verbose  # 加上每条明细
 *
 * 【回答三个问题】
 *   1. 同谱重复打了吗   —— A 方向（改进难度模型）需要「同一张谱多次游玩」
 *   2. 判定完整吗       —— perfect+good+bad+miss 必须等于 chart_notes
 *   3. 字段齐吗         —— device / touch_heat / chart_digest 的 null 率
 *
 * 【为什么要单独一个工具】
 *   每次都是临时写脚本查库，口径不一致，昨天说「完整性 100%」今天说「98%」——
 *   因为口径变了。固定成一个工具，每次跑出来的数才可比。
 *
 * 【为什么不做成站点页面】
 *   这是给自己看的体检，不是给玩家看的。放 tools/ 下跑一下最快。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

function dbUrl() {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = env.match(/^PHM_NEON_URL\s*=\s*(.+)$/m);
  if (!m) throw new Error('.env 里没有 PHM_NEON_URL');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/* Neon 免费档会睡，重试几次 */
async function connect(pg, url) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 60_000, query_timeout: 60_000 });
      await c.connect();
      return c;
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

const pct = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);
const bar = (n, total, width = 20) => {
  const k = total === 0 ? 0 : Math.round((n / total) * width);
  return '█'.repeat(k) + '·'.repeat(width - k);
};

async function main() {
  const { default: pg } = await import('pg');
  const c = await connect(pg, dbUrl());

  const all = await c.query(`
    select id, chart_id, chart_notes, score, accuracy, max_combo,
           perfect, good, bad, miss, max_touch_points,
           client_ver, judge_ver, played_at, device, touch_heat, chart_digest,
           length(judge_blob) as blob_len
      from hm_plays
     order by id desc`);
  const rows = all.rows;
  const n = rows.length;

  if (n === 0) {
    console.log('\n  库里还没有数据。\n');
    await c.end();
    return;
  }

  console.log('\n  ═══ 成绩数据体检 ═══');
  console.log('  总条数: %d\n', n);

  /* ── ① 同谱分布 ── */
  const byChart = new Map();
  for (const r of rows) byChart.set(r.chart_id, (byChart.get(r.chart_id) ?? 0) + 1);
  const charts = [...byChart.entries()].sort((a, b) => b[1] - a[1]);
  const repeated = charts.filter(([, k]) => k >= 2);

  console.log('  ① 谱面覆盖');
  console.log('     不同谱面: %d 张   平均每谱 %s 局', charts.length, (n / charts.length).toFixed(1));
  console.log('     玩过 ≥2 次的谱: %d 张（A 方向的关键——同谱多局才能比较）', repeated.length);
  for (const [cid, k] of charts.slice(0, 5)) {
    console.log('       chart=' + String(cid).padEnd(8) + ' ' + String(k).padStart(2) + ' 局  ' + bar(k, charts[0][1]));
  }

  /* ── ② 判定完整性 ── */
  let sumOk = 0, sumBad = 0;
  const badOnes = [];
  for (const r of rows) {
    const s = r.perfect + r.good + r.bad + r.miss;
    if (s === r.chart_notes) sumOk++;
    else { sumBad++; badOnes.push({ id: r.id, s, notes: r.chart_notes }); }
  }
  console.log('\n  ② 判定完整性（p+g+b+m == chart_notes）');
  console.log('     一致: %d 条 %s   不一致: %d 条 %s',
    sumOk, pct(sumOk, n), sumBad, pct(sumBad, n));
  for (const b of badOnes.slice(0, 3)) {
    console.log('       #%s 判定和=%s 物量=%s', b.id, b.s, b.notes);
  }

  /* ── ③ 字段完整率 ── */
  const nn = (f) => rows.filter(f).length;
  const fields = [
    ['chart_digest', nn(r => r.chart_digest), 'A 方向对齐同谱的凭据'],
    ['device', nn(r => r.device !== null), '设备/机型/定位'],
    ['  └ gyro', nn(r => r.device && r.device.gyro), '陀螺仪摘要（一直缺）'],
    ['  └ lat/lon', nn(r => r.device && r.device.lat != null), '城市级坐标'],
    ['touch_heat', nn(r => r.touch_heat !== null), '8×8 落点热度图'],
    ['max_touch_points', nn(r => r.max_touch_points !== null), '单手/双手/多指'],
    ['played_at', nn(r => r.played_at !== null), '结算时刻'],
  ];
  console.log('\n  ③ 字段完整率');
  for (const [name, k, note] of fields) {
    console.log('     ' + name.padEnd(18) + String(k).padStart(4) + pct(k, n).padStart(8) + '  ' + note);
  }

  /* ── ④ 版本分布 ── */
  const byVer = new Map();
  for (const r of rows) byVer.set(r.client_ver, (byVer.get(r.client_ver) ?? 0) + 1);
  console.log('\n  ④ 客户端版本');
  for (const [v, k] of [...byVer.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('     ' + String(v).padEnd(22) + String(k).padStart(3) + ' 条');
  }

  /* ── ⑤ 简述 ── */
  console.log('\n  ⑤ 一句话');
  if (n < 50) console.log('     数据量太少（%d 条），现在还做不了任何统计结论，只能看字段齐不齐。', n);
  else if (repeated.length < 3) console.log('     有量但缺「同谱多局」，A 方向最需要的那类样本还不够。');
  else console.log('     同谱多局已有 %d 张谱，可以考虑做「同一谱不同表现的对比」了。', repeated.length);

  if (VERBOSE) {
    console.log('\n  ═══ 明细（最近 10 条）═══');
    for (const r of rows.slice(0, 10)) {
      console.log('  #' + r.id + ' chart=' + r.chart_id + ' ' + r.score + '分 acc=' + Number(r.accuracy).toFixed(4) +
        ' 判定=' + [r.perfect, r.good, r.bad, r.miss].join('/') + ' touch=' + r.max_touch_points + ' ver=' + r.client_ver);
    }
  }

  console.log('');
  await c.end();
}

main().catch((e) => {
  console.error('\n  体检失败:', e.message);
  process.exit(1);
});
