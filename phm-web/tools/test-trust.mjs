/* tools/test-trust.mjs —— 协议自洽性评分的单测
 *
 * 跑法： node tools/test-trust.mjs
 *
 * 【为什么每条"不误伤"的断言比"能抓到"更重要】
 *   这是无感判定：判错的代价是真实用户突然被要求做 PoW，或者更糟——
 *   被当成攻击者。所以先证明"真人不掉分"，再证明"伪装会掉分"。
 */
import { trustSignals } from '../lib/api-trust.mjs';

let pass = 0, fail = 0;
const T = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + JSON.stringify(got)); }
};
const req = (headers, url = '/api/v1/charts') => ({ headers, url });

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/136.0.0.0 Safari/537.36';

/* ── 不该被怀疑的：真实浏览器 ── */
const realBrowser = req({
  'user-agent': CHROME,
  'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="24"',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  origin: 'https://phm.app.workbuddy.host',
  referer: 'https://phm.app.workbuddy.host/app',
});
let r = trustSignals(realBrowser);
T('★ 真实浏览器满分且不触发挑战', r.score === 100 && r.sus === false, r);

/* ── 不该被怀疑的：承认自己是机器的客户端 ── */
for (const ua of [
  'curl/8.5.0',
  'python-requests/2.32.3',
  'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
  'Better Uptime Bot (https://betterstack.com/better-uptime)',
  'okhttp/4.12.0',
  'Go-http-client/2.0',
  'PostmanRuntime/7.39.0',
]) {
  const x = trustSignals(req({ 'user-agent': ua }));
  T(`★ 诚实脚本不扣分：${ua.slice(0, 28)}`, x.score === 100 && x.sus === false, x);
}

/* ── 不该被怀疑的：隐私插件剥掉 Client Hints 的真人 ── */
const privacyBrowser = req({
  'user-agent': CHROME,
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  origin: 'https://phm.app.workbuddy.host',
});
r = trustSignals(privacyBrowser);
T('隐私插件（无 sec-ch-ua）仍不触发挑战', r.sus === false && r.score === 70, r);

/* ── 不该被怀疑的：旧浏览器没有 Fetch Metadata ── */
const oldBrowser = req({
  'user-agent': CHROME,
  'sec-ch-ua': '"Chromium";v="136"',
  'sec-ch-ua-platform': '"Windows"',
  origin: 'https://phm.app.workbuddy.host',
});
r = trustSignals(oldBrowser);
T('旧浏览器（无 sec-fetch）仍不触发挑战', r.sus === false, r);

/* ── 该被怀疑的：声称 Chrome 但什么都没带 ── */
r = trustSignals(req({ 'user-agent': CHROME }));
T('★★ 伪装 Chrome（无 hints/fetch/origin）→ 触发挑战', r.sus === true, r);
T('  原因码齐全', r.reasons.length >= 3, r.reasons);

/* ── 该被怀疑的：跨层矛盾 ── */
r = trustSignals(req({
  'user-agent': CHROME,                     /* 说是 Windows */
  'sec-ch-ua': '"Chromium";v="136"',
  'sec-ch-ua-platform': '"macOS"',          /* 却是 macOS */
  'sec-fetch-mode': 'cors',
  origin: 'https://phm.app.workbuddy.host',
}));
T('UA 与 sec-ch-ua-platform 矛盾 → 扣分', r.reasons.includes('platform_mismatch'), r);

/* ── 该被怀疑的：导航请求打 API ── */
r = trustSignals(req({
  'user-agent': CHROME,
  'sec-ch-ua': '"Chromium";v="136"',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  origin: 'https://phm.app.workbuddy.host',
}));
T('导航模式调 API → 扣分', r.reasons.includes('navigate_on_api'), r);
/* ⚠ 单独一个信号不该触发：用户在地址栏直接打开 API 地址也是 navigate。
   判定是**叠加**的，不是任一命中就打死 —— 这条断言正是防止把权重调过头。 */
T('  但单独不触发（避免误伤直接打开 API 地址的用户）', r.sus === false && r.score === 75, r);

/* 叠加三个信号才该触发 */
r = trustSignals(req({
  'user-agent': CHROME,
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}));
T('★ 三个信号叠加（无 hints + navigate + 无 origin）→ 触发', r.sus === true, r);

/* ── 空 UA：可疑但不该一棍子打死（有些原生客户端不带 UA） ── */
r = trustSignals(req({}));
T('空 UA 扣 20 但不触发挑战（避免误伤原生客户端）', r.score === 80 && r.sus === false, r);

/* ── Firefox / Safari 不送 Client Hints 是正常的，不能扣分 ── */
for (const ua of [
  'Mozilla/5.0 (Windows NT 10.0; rv:141.0) Gecko/20100101 Firefox/141.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
]) {
  const x = trustSignals(req({
    'user-agent': ua,
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    origin: 'https://phm.app.workbuddy.host',
  }));
  T(`★ ${ua.includes('Firefox') ? 'Firefox' : 'Safari'} 不送 hints 也不扣分`, x.sus === false && x.score === 100, x);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
