/* tools/fix-monitors.mjs —— 给 BetterStack 的监控 URL 补上 sharecode
 *
 * 背景：平台把应用设成「需要分享码」后，所有请求（含 API）裸访问都 403。
 * BetterStack 的探针因此全部红了 —— 服务是好的，是探针被挡在门外。
 *
 * 用法：
 *   node tools/fix-monitors.mjs            # 只看会改成什么（dry run）
 *   node tools/fix-monitors.mjs --apply    # 真的改
 *
 * token 从 .env 的 BETTERSTACK_TOKEN 读，不进仓库。
 */
import { readFileSync } from 'node:fs';

const SHARECODE = 'NXNUI4YAVG';
const API = 'https://uptime.betterstack.com/api/v2';

function token() {
  if (process.env.BETTERSTACK_TOKEN) return process.env.BETTERSTACK_TOKEN.trim();
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = env.match(/^BETTERSTACK_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch (e) { /* 没 .env 就用环境变量 */ }
  return '';
}

const TK = token();
if (!TK) { console.error('  没找到 BETTERSTACK_TOKEN'); process.exit(1); }

const apply = process.argv.includes('--apply');

async function api(path, opt) {
  const r = await fetch(API + path, {
    ...(opt || {}),
    headers: { authorization: 'Bearer ' + TK, 'content-type': 'application/json', ...(opt && opt.headers) },
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 160));
  return j || {};
}

/** 给 URL 补 sharecode；已经带了就不动 */
function withSharecode(url) {
  if (!url) return url;
  if (url.includes('sharecode=')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'sharecode=' + SHARECODE;
}

const list = await api('/monitors');
const monitors = list.data || [];
console.log('  共', monitors.length, '个监控\n');

let changed = 0;
for (const m of monitors) {
  const a = m.attributes || {};
  const oldUrl = String(a.url || '');
  const newUrl = withSharecode(oldUrl);
  const name = String(a.pronounceable_name || m.id);

  if (newUrl === oldUrl) {
    console.log('  = ' + name + '  （已带 sharecode，跳过）');
    continue;
  }
  console.log('  · ' + name);
  console.log('      旧 ' + oldUrl);
  console.log('      新 ' + newUrl);

  if (apply) {
    try {
      await api('/monitors/' + m.id, { method: 'PATCH', body: JSON.stringify({ url: newUrl }) });
      console.log('      ✓ 已更新');
      changed++;
    } catch (e) {
      console.log('      ✗ 失败 ' + String(e.message || e).slice(0, 120));
    }
  }
}

if (!apply) {
  console.log('\n  这是 dry run。加 --apply 才会真的改。');
} else {
  console.log('\n  已更新 ' + changed + ' 个。等 1~2 分钟让 BetterStack 重新检查。');
}
