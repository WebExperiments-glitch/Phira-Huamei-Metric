/* tools/fix-monitors.mjs —— 修 BetterStack 监控的两类问题
 *
 * ① URL 缺 sharecode
 *    平台把应用设成「需要分享码」后，裸访问一律 403。
 *    BetterStack 的探针因此全红 —— 服务是好的，是探针被挡在门外。
 *
 * ② 探测频率高过匿名额度（2026-11-23 新增）
 *    站点匿名额度 `apiAnonHour = 100` 次/小时，**按 subject（IP）计**。
 *    BetterStack 有 us / eu / as 三个区域，7 个监控 × 每 60 秒
 *    ⇒ 每个区域约 138 次/小时 > 100 ⇒ 6 个端点全变 429。
 *    这个 429 会被状态页读成「站点挂了」，于是探针更急 —— 自己把自己打爆。
 *    降到 600 秒后约 42 次/小时，留足余量给真实访客。
 *    ⚠ 不改成带 API Key 的原因：key 会存到第三方控制台，且走 key 额度是
 *      1000/h，为了 7 个探针占用一把长期凭据，不划算。
 *
 * 用法：
 *   node tools/fix-monitors.mjs            # 只看会改成什么（dry run）
 *   node tools/fix-monitors.mjs --apply    # 真的改
 *
 * token 从 .env 的 BETTERSTACK_TOKEN 读，不进仓库（.env 已 gitignore）。
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

/* 目标频率：300 秒。见文件头 ② 的算术。 */
const TARGET_FREQ = 600;

let changed = 0;
for (const m of monitors) {
  const a = m.attributes || {};
  const oldUrl = String(a.url || '');
  const newUrl = withSharecode(oldUrl);
  const oldFreq = Number(a.check_frequency || 0);
  const newFreq = TARGET_FREQ;
  const name = String(a.pronounceable_name || m.id);
  const needUrl = newUrl !== oldUrl;
  const needFreq = oldFreq !== newFreq;

  if (!needUrl && !needFreq) {
    console.log('  = ' + name + '  （URL 与频率都已正确，跳过）');
    continue;
  }
  console.log('  · ' + name);
  if (needUrl) {
    console.log('      URL  旧 ' + oldUrl);
    console.log('           新 ' + newUrl);
  }
  if (needFreq) {
    console.log('      频率 旧 ' + oldFreq + 's → 新 ' + newFreq + 's');
  }

  if (apply) {
    try {
      const patch = {};
      if (needUrl) patch.url = newUrl;
      if (needFreq) patch.check_frequency = newFreq;
      await api('/monitors/' + m.id, { method: 'PATCH', body: JSON.stringify(patch) });
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
