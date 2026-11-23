/* tools/incident.mjs —— 在 BetterStack 状态页发「故障通告」与「恢复」
 *
 * 【和 deploy-maint.mjs 的分工】
 *   deploy-maint.mjs  → report_type: 'maintenance'，用于**计划内**部署窗口。
 *                       它的文件头明确写着「绝不因为现在出故障了去开维护窗口」。
 *   incident.mjs      → report_type: 'manual'，用于**真实故障**的对外说明。
 *   两者不能混用：拿 maintenance 掩盖真故障是骗人。
 *
 * 【三个必须知道的坑（都踩过）】
 *   ① **API 没有正文。** status-reports 的 attributes 只有
 *      title / report_type / starts_at / ends_at / status_page_id /
 *      affected_resources / aggregate_state。
 *      传 message 会被静默丢弃，PATCH 也会报 invalid_attributes:["message"]。
 *      ⇒ **能写的只有标题。** 先说什么、后说什么必须在标题里一次讲完。
 *      标题带「（算定数不受影响）」这种最关心的结论，比写十行正文有用。
 *
 *   ② **affected_resources 要 status_page_resource_id，不是 monitor id。**
 *      从 `GET /status-pages/{page}/resources` 取 `data[].id`。
 *      直接传 monitor id 会报：Has to be an object with
 *      `status_page_resource_id` and `status`。
 *      status 只接受 resolved / degraded / downtime 三个值。
 *
 *   ③ **不传 status_page_id。** 它在 URL 路径里；body 里重复会被判 misspelled。
 *
 * 用法：
 *   BETTERSTACK_TOKEN=xxx node tools/incident.mjs --list
 *   BETTERSTACK_TOKEN=xxx node tools/incident.mjs --publish "标题（要把结论写进来）"
 *   BETTERSTACK_TOKEN=xxx node tools/incident.mjs --resolve 1133648
 *   BETTERSTACK_TOKEN=xxx node tools/incident.mjs --publish "..." --only 5199432,5202326
 *       （只标记指定 monitor 受影响；默认全部标记 downtime）
 *
 * token 从 .env 的 BETTERSTACK_TOKEN 读，不进仓库（.env 已 gitignore）。
 */
import { readFileSync } from 'node:fs';

const PAGE = '270700';
const API = 'https://uptime.betterstack.com/api/v2';

function token() {
  if (process.env.BETTERSTACK_TOKEN) return process.env.BETTERSTACK_TOKEN.trim();
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = env.match(/^BETTERSTACK_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* 没 .env 就用环境变量 */ }
  return '';
}
const TK = token();
if (!TK) { console.error('  ✗ 没有 BETTERSTACK_TOKEN（用环境变量或 phm-web/.env）'); process.exit(2); }

const H = { authorization: 'Bearer ' + TK, 'content-type': 'application/json' };
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

async function api(method, p, body) {
  const r = await fetch(API + p, {
    method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null; try { j = await r.json(); } catch { /* 204 */ }
  return { ok: r.ok, status: r.status, body: j };
}

/* 状态页资源：{ status_page_resource_id, monitor_id, name } */
async function resources() {
  const r = await api('GET', `/status-pages/${PAGE}/resources`);
  if (!r.ok) throw new Error('读取资源失败 HTTP ' + r.status);
  return (r.body.data || []).map(x => ({
    sid: String(x.id),
    mid: String(x.attributes.resource_id),
    name: String(x.attributes.public_name || ''),
    state: String(x.attributes.status || ''),
  }));
}

async function list() {
  const rs = await resources();
  console.log(`  状态页资源 ${rs.length} 个：`);
  for (const x of rs) console.log(`   ${x.sid}  monitor=${x.mid}  ${x.name.padEnd(24)} ${x.state}`);
  const r = await api('GET', `/status-pages/${PAGE}/status-reports?per_page=20`);
  const xs = (r.body && r.body.data) || [];
  console.log(`\n  报告 ${xs.length} 条：`);
  for (const x of xs) {
    const a = x.attributes;
    console.log(`   ${x.id}  [${String(a.aggregate_state).padEnd(9)}] ${String(a.report_type).padEnd(11)} `
      + `${String(a.title).slice(0, 46)} @${String(a.starts_at || '').slice(0, 16)}`);
  }
}

async function publish(title, onlyIds) {
  if (!title) { console.error('  ✗ 缺标题（正文 API 不存在，全部信息必须在标题里）'); process.exit(1); }
  const rs = await resources();
  const use = onlyIds && onlyIds.length
    ? rs.filter(x => onlyIds.includes(x.mid) || onlyIds.includes(x.sid))
    : rs;
  if (!use.length) { console.error('  ✗ 没有匹配的资源'); process.exit(1); }
  const r = await api('POST', `/status-pages/${PAGE}/status-reports`, {
    title,
    report_type: 'manual',
    notify_subscribers: false,
    affected_resources: use.map(x => ({ status_page_resource_id: x.sid, status: 'downtime' })),
  });
  if (!r.ok) {
    console.error('  ✗ 发布失败 HTTP ' + r.status, JSON.stringify(r.body || {}).slice(0, 240));
    process.exit(1);
  }
  const a = r.body.data.attributes;
  console.log(`  ✓ 已发布 id=${r.body.data.id} state=${a.aggregate_state}`);
  console.log(`    标记 ${use.length} 个组件为 downtime：${use.map(x => x.name).join(' / ')}`);
  console.log('    标题：' + a.title);
}

async function resolve(id, title) {
  if (!id) { console.error('  ✗ 缺报告 id'); process.exit(1); }
  const rs = await resources();
  const body = { affected_resources: rs.map(x => ({ status_page_resource_id: x.sid, status: 'resolved' })) };
  if (title) body.title = title;
  const r = await api('PATCH', `/status-pages/${PAGE}/status-reports/${id}`, body);
  if (!r.ok) {
    console.error('  ✗ 恢复失败 HTTP ' + r.status, JSON.stringify(r.body || {}).slice(0, 240));
    process.exit(1);
  }
  console.log(`  ✓ ${id} 已标记 resolved`);
}

if (has('--list')) await list();
else if (has('--publish')) {
  const only = val('--only');
  await publish(val('--publish'), only ? only.split(',').map(s => s.trim()) : null);
} else if (has('--resolve')) await resolve(val('--resolve'), val('--title'));
else console.log('用法：--list | --publish "标题" [--only monitorIds] | --resolve <id> [--title "..."]');
