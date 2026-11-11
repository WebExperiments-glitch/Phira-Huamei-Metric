/* tools/deploy-maint.mjs —— 部署时在状态页挂"维护窗口"
 *
 * 用法：
 *   BETTERSTACK_TOKEN=xxx node tools/deploy-maint.mjs --start 10
 *     创建一条 10 分钟的维护公告，返回 id（会写到 tmp/maint-id.txt）
 *
 *   BETTERSTACK_TOKEN=xxx node tools/deploy-maint.mjs --end
 *     提前结束（读 tmp/maint-id.txt）。不调用也行 —— 窗口到期自动结束。
 *
 *   BETTERSTACK_TOKEN=xxx node tools/deploy-maint.mjs --status
 *     列出当前状态页的维护/通报
 *
 * 【这个东西到底解决什么】
 *   部署会让服务重启几十秒，监控在那个窗口里必然失败 → 状态页红一片 →
 *   外部以为站挂了。而它其实是**计划内的更新**。
 *   在 BetterStack 上挂一条 maintenance 公告，状态页就显示"维护中"而不是"故障"。
 *   这不是掩盖：维护窗口是**公开可见**的，用户看到的是"正在更新"。
 *
 * 【必须守住的边界】
 *   ⚠ 维护窗口会**同时压掉真故障的报警** —— 窗口内如果服务真的挂了，
 *     状态页只会显示"维护中"，不会红。
 *     所以：部署后**必须自己验证**（本项目每次都验），不能依赖监控兜底。
 *   ⚠ 窗口要短。默认 10 分钟够部署 + 验证；不要开 1 小时。
 *   ⚠ 绝不因为"现在出故障了"去开维护窗口 —— 那是骗人，不是运维。
 *
 * 【为什么用 status-report 而不是暂停监控】
 *   BetterStack 没有公开的 maintenance-windows API（实测 404）。
 *   `report_type: 'maintenance'` 是状态页层面的事件，带 starts_at / ends_at：
 *     · 到期自动结束，忘了收尾也不会永久挂着
 *     · 监控照常探测（真故障仍有内部记录），只是状态页对外显示"维护中"
 *   暂停监控反而更危险：忘了恢复 = 永久失去告警。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ID_FILE = path.join(ROOT, 'tmp', 'maint-id.txt');
const PAGE = '270700';
const API = 'https://uptime.betterstack.com/api/v2';

const TOKEN = process.env.BETTERSTACK_TOKEN || process.env.PHM_BETTERSTACK_TOKEN || '';
if (!TOKEN) {
  console.error('  ✗ 缺 BETTERSTACK_TOKEN（不要把它写进仓库，用环境变量传）');
  process.exit(2);
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 204 无体 */ }
  return { ok: r.ok, status: r.status, body: j };
}

async function start(minutes) {
  const now = new Date();
  const end = new Date(now.getTime() + minutes * 60_000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const r = await api('POST', `/status-pages/${PAGE}/status-reports`, {
    title: '计划维护：站点更新',
    report_type: 'maintenance',
    notify_subscribers: false,
    starts_at: iso(now),
    ends_at: iso(end),
    message: '正在部署新版本，期间可能出现短暂中断。这是计划内的更新，不是故障。'
      + '预计 ' + minutes + ' 分钟内完成。',
  });

  if (!r.ok) {
    console.error('  ✗ 创建维护窗口失败：HTTP ' + r.status, JSON.stringify(r.body || {}).slice(0, 200));
    process.exit(1);
  }
  const id = r.body && r.body.data && r.body.data.id;
  fs.mkdirSync(path.dirname(ID_FILE), { recursive: true });
  fs.writeFileSync(ID_FILE, String(id));
  console.log('  ✓ 维护窗口已开：' + id);
  console.log('    有效至 ' + iso(end) + '（' + minutes + ' 分钟），到期自动结束');
  console.log('    ⚠ 窗口内真故障也不会红 —— 部署后请自行验证');
}

async function end() {
  if (!fs.existsSync(ID_FILE)) { console.log('  没有记录的维护窗口（可能已到期自动结束）'); return; }
  const id = fs.readFileSync(ID_FILE, 'utf8').trim();
  const r = await api('DELETE', `/status-pages/${PAGE}/status-reports/${id}`);
  if (r.status === 204 || r.ok) {
    fs.unlinkSync(ID_FILE);
    console.log('  ✓ 维护窗口已结束：' + id);
  } else {
    console.log('  · 结束失败（HTTP ' + r.status + '），可能已到期：' + id);
  }
}

async function status() {
  const r = await api('GET', `/status-pages/${PAGE}/status-reports`);
  const xs = (r.body && r.body.data) || [];
  console.log('  共 ' + xs.length + ' 条：');
  for (const x of xs) {
    const a = x.attributes;
    console.log('   ' + String(a.title).slice(0, 34).padEnd(36)
      + ' | ' + String(a.report_type).padEnd(12) + ' | ' + a.aggregate_state
      + ' | ' + String(a.starts_at || '').slice(0, 16));
  }
}

if (has('--start')) await start(Number(val('--start')) || 10);
else if (has('--end')) await end();
else if (has('--status')) await status();
else console.log('用法：--start <分钟> | --end | --status');
