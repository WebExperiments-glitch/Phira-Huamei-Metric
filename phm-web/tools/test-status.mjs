/* ============================================================
 * tools/test-status.mjs —— 状态探测单测
 * ============================================================
 *  为什么这组断言值得单独写：
 *   状态页最危险的失败模式不是「报错」，而是**谎报健康**——
 *   页面绿着、实际全挂；或者刚启动没数据却显示「全部正常」。
 *   这类 bug 冒烟测试抓不到（页面能打开就算过），
 *   只能靠对 snapshot() 输出的断言守住。
 *
 *  零依赖、不联网（探测函数通过 _inject 灌样本，不真发 HTTP）。
 * ============================================================ */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  TARGETS, buildStatusSnapshot, _inject, _read, _reset, _stop,
} from '../lib/status.mjs';

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${extra}`); }
};

_stop(); /* 单测不跑探测循环 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DAY = 86400_000;
const NOW = Date.now();

console.log('\n【1】目标清单');
{
  T('至少 9 个目标', TARGETS.length >= 9, '实际 ' + TARGETS.length);
  T('每个目标有唯一 id',
    new Set(TARGETS.map(t => t.id)).size === TARGETS.length);
  /* ⚠ 分组必须落在页面真实渲染的那三个里。
     写错的后果很隐蔽：前端的GROUPS 数组按组过滤，
     不在数组里的组**整组消失** —— 页面上就是「少了一项」，
     既不报错也不留痕，只有逐项数才看得出来。
     （第一版就留了个 'group:' 占位符忘了改，靠肉眼看接口输出才发现。） */
  const KNOWN_GROUPS = ['page', 'api', 'data'];
  T('group 落在 page/api/data 之内',
    TARGETS.every(t => KNOWN_GROUPS.includes(t.group)),
    TARGETS.filter(t => !KNOWN_GROUPS.includes(t.group))
      .map(t => t.id + '=' + t.group).join(','));
  T('每个分组都至少有一个目标',
    KNOWN_GROUPS.every(g => TARGETS.some(t => t.group === g)),
    KNOWN_GROUPS.filter(g => !TARGETS.some(t => t.group === g)).join(','));
  T('每个目标有 label 与 path',
    TARGETS.every(t => t.label && t.path && t.path.startsWith('/')));
  /* ⚠ 这条是本次新增最关键的：**路径必须是干净 URL**。
     探真实路径才知道用户点导航会不会 404。
     写 '/index.html' 的探针永远绿，但用户点「首页」可能已经挂了。 */
  T('全部使用干净 URL（不带 .html）',
    TARGETS.every(t => !/\.html$/i.test(t.path)),
    TARGETS.filter(t => /\.html$/i.test(t.path)).map(t => t.path).join(','));
  /* ⚠ 更危险的一种：探一个**不存在**的路径，绿了也是假的绿。 */
  T('目标路径都在已知白名单页面或 API 上',
    TARGETS.every(t => {
      const KNOWN = ['/', '/app', '/data', '/user', '/charter', '/download',
                     '/developers', '/platform', '/version', '/rulechart',
                     '/settings', '/privacy', '/terms',
                     '/api/health', '/api/v1/meta', '/api/v1/stats',
                     '/api/v1/charts', '/api/stats', '/api/summary',
                     '/data/ref-com.json', '/data/ref-official.js'];
      /* 带查询串的（?limit=1）按路径部分比对 */
      const base = t.path.split('?')[0];
      return KNOWN.includes(base) || KNOWN.includes(t.path);
    }),
    TARGETS.map(t => t.path).filter(p => !p.startsWith('/api/') && !p.startsWith('/data/')).join(','));
}

_reset();
console.log('\n【1b】后端分组与前端 GROUPS 必须同步');
{
  /* ⚠ 上面那条守住「group 是合法值」，但**合法**不等于「前端画得出来」。
     前端 public/status.html 里写死了：
         const GROUPS = [['page','st.gpage'], ['api','st.gapi'], ['data','st.gdata']];
     后端加一个新组而前端没跟上 → 那一整组在页面上凭空消失，
     没有任何报错。这是「页面少了一项」最难查的一类原因。 */
  const html = readFileSync(path.join(HERE, '..', 'public', 'status.html'), 'utf8');
  const m = html.match(/const GROUPS = \[([\s\S]*?)\];/);
  T('status.html 里能读到 GROUPS 定义', !!m);
  if (m) {
    const pageGroups = [...m[1].matchAll(/'([a-z]+)'\s*,\s*'(st\.g\w+)'/g)].map(x => x[1]);
    T('前端至少声明 3 个分组', pageGroups.length >= 3, '实际 ' + pageGroups.length);
    T('★ 后端每个分组都在前端 GROUPS 里',
      TARGETS.every(t => pageGroups.includes(t.group)),
      TARGETS.filter(t => !pageGroups.includes(t.group))
        .map(t => t.group).filter((v, i, a) => a.indexOf(v) === i).join(','));
    /* 前端声明了但后端没有的组 → 页面会渲染一个**空标题**，
       视觉上像"加载到一半卡住了"。 */
    T('前端没有多余的空分组',
      pageGroups.every(g => TARGETS.some(t => t.group === g)),
      pageGroups.filter(g => !TARGETS.some(t => t.group === g)).join(','));
    /* i18n 键必须存在，否则分组标题会渲染成字面 'st.gpage' */
    const i18n = readFileSync(path.join(HERE, '..', 'public', 'js', 'i18n', 'status.js'), 'utf8');
    for (const key of [...m[1].matchAll(/'(st\.g\w+)'/g)].map(x => x[1])) {
      T(`i18n 有 ${key}`, i18n.includes("'" + key + "'"));
    }
  }
}

console.log('\n【2】无样本时不得谎报「正常」');
/* ⚠ 这是整份文件最重要的一条。刚启动、还没跑到第一轮探测时，
 *   所有目标都没有样本。若此时 overall === 'operational'，
 *   页面会亮起一片绿 —— 而实际上什么都不知道。 */
{
  const s = await buildStatusSnapshot('24h');
  T('无样本时 overall 不是 operational', s.overall !== 'operational',
    '实际 ' + s.overall);
  T('无样本时 overall 是 unknown', s.overall === 'unknown', '实际 ' + s.overall);
  T('每个 monitor 的 up 为 null', s.monitors.every(m => m.up === null),
    JSON.stringify(s.monitors.map(m => m.up)));
  T('返回的 monitor 数 = 目标数', s.monitors.length === TARGETS.length);
}

/* 每组独立计数：不清的话样本会累积进同一个环形缓冲，
 * 断言就会因为自己的记账错误而红（第一版就这么栽了）。 */
_reset();
console.log('\n【3】灌入全绿样本 → 应报 operational');
{
  for (const t of TARGETS) {
    for (let i = 0; i < 10; i++) {
      _inject(t.id, { t: NOW - (10 - i) * 60_000, ok: 1, ms: 100 + i });
    }
  }
  const s = await buildStatusSnapshot('24h');
  T('overall = operational', s.overall === 'operational', '实际 ' + s.overall);
  T('全部 up = 100', s.monitors.every(m => m.up === 100),
    JSON.stringify(s.monitors.map(m => m.up)));
  T('每项都有 lastMs', s.monitors.every(m => typeof m.lastMs === 'number'));
  T('每项都有 avgMs', s.monitors.every(m => typeof m.avgMs === 'number'));
  T('series 非空', s.monitors.every(m => m.series.length === 10),
    JSON.stringify(s.monitors.map(m => m.series.length)));
}

/* 每组独立计数：不清的话样本会累积进同一个环形缓冲，
 * 断言就会因为自己的记账错误而红（第一版就这么栽了）。 */
_reset();
console.log('\n【4】一次失败 → 不得仍是 100%');
{
  const t = TARGETS[0];
  /* 10 个绿 + 1 个坏 = 10/11 = 90.9% */
  for (let i = 0; i < 10; i++) _inject(t.id, { t: NOW - (10 - i) * 60_000, ok: 1, ms: 100 });
  _inject(t.id, { t: NOW, ok: 0, ms: 0, status: 500 });
  const s = await buildStatusSnapshot('24h');
  const m = s.monitors.find(x => x.id === t.id);
  T('可用率降到 90.9（10绿+1坏/11）', Math.abs(m.up - 90.909) < 0.01, '实际 ' + m.up);
  T('overall 不再是 operational', s.overall !== 'operational', s.overall);
  /* ⚠ 失败样本的 ms=0 不能污染平均值：
     失败不是「0 毫秒」，把它算进去会把 avg 拉低成假的「很快」。 */
  T('avgMs 排除失败样本（否则会被拉成 90.9）', m.avgMs === 100, '实际 ' + m.avgMs);
}

_reset();
console.log('\n【5】大多数失败 → 应报 outage');
{
  const t = TARGETS[1];
  for (let i = 0; i < 20; i++) {
    _inject(t.id, { t: NOW - i * 60_000, ok: 0, ms: 0, status: 0 });
  }
  const s = await buildStatusSnapshot('24h');
  const m = s.monitors.find(x => x.id === t.id);
  T('可用率为 0', m.up === 0, '实际 ' + m.up);
  T('overall = outage', s.overall === 'outage', '实际 ' + s.overall);
  /*⚠ 这条是本组真正的收获：全失败时平均延迟**无意义**。
     第一版返回 null，前端会把它渲染成空白格 —— 看着像加载卡住了。
     约定：全失败时 lastMs/avgMs 报**最后一次成功的延迟**（若有过成功），
     一次都没成功过才报 null，页面显示「—」。*/
  T('全失败时 avgMs 为 null（不是 0）', m.avgMs === null, '实际 ' + m.avgMs);
}

/* 每组独立计数：不清的话样本会累积进同一个环形缓冲，
 * 断言就会因为自己的记账错误而红（第一版就这么栽了）。 */
_reset();
console.log('\n【5】大多数失败 → 应报 outage');
{
  const t = TARGETS[1];
  for (let i = 0; i < 20; i++) {
    _inject(t.id, { t: NOW - i * 60_000, ok: 0, ms: 0, status: 0 });
  }
  const s = await buildStatusSnapshot('24h');
  const m = s.monitors.find(x => x.id === t.id);
  T('可用率为 0', m.up === 0, '实际 ' + m.up);
  T('overall = outage', s.overall === 'outage', '实际 ' + s.overall);
  /* ⚠ 这条是本组真正的收获：全失败时平均延迟**无意义**。
     第一版让 null 一路传到前端，页面渲染成空白格，
     看着像加载卡住而不是「没有成功过」。
     约定：全失败时 avgMs 报 null，页面显示「—」。 */
  T('全失败时 avgMs 为 null（不是 0）', m.avgMs === null, '实际 ' + m.avgMs);
  T('全失败时 up 仍是 0 而不是 null（有样本≠有成功）',
    typeof m.up === 'number' && m.up === 0, '实际 ' + m.up);
}

/* 每组独立计数：不清的话样本会累积进同一个环形缓冲，
 * 断言就会因为自己的记账错误而红（第一版就这么栽了）。 */
_reset();
console.log('\n【6】少量失败（≥99%）→ degraded');
{
  /* 199 绿 + 1 坏 = 99.5% → 既不是 operational 也不该是 outage */
  const id = TARGETS[2].id;
  for (let i = 0; i < 199; i++) _inject(id, { t: NOW - i * 60_000, ok: 1, ms: 100 });
  _inject(id, { t: NOW, ok: 0, ms: 0, status: 502 });
  const s = await buildStatusSnapshot('24h');
  const m = s.monitors.find(x => x.id === id);
  T('可用率 99.5', Math.abs(m.up - 99.5) < 0.01, '实际 ' + m.up);
  T('overall = degraded（不是 outage，也不是 operational）',
    s.overall === 'degraded', '实际 ' + s.overall);
}

/* 每组独立计数：不清的话样本会累积进同一个环形缓冲，
 * 断言就会因为自己的记账错误而红（第一版就这么栽了）。 */
_reset();
console.log('\n【7】环形缓冲不无界增长');
/* ⚠ 若 probe 用的是 array.push，长跑一天就是 1440 个对象，
 *   30 天后 4 万+。环形缓冲的意义就在这里，断言它真的绕回。 */
{
  const t = TARGETS[3];
  for (let i = 0; i < 2000; i++) {
    _inject(t.id, { t: NOW - i * 1000, ok: 1, ms: 50 });
  }
  const got = _read(t.id);
  T('样本数被截断到 1440', got.length === 1440, '实际 ' + got.length);
  T('绕回后仍按时间升序', (() => {
    for (let i = 1; i < got.length; i++) if (got[i].t < got[i - 1].t) return false;
    return true;
  })());
}

console.log('\n【8】30 天视图');
{
  const s = await buildStatusSnapshot('30d');
  T('range 回显 30d', s.range === '30d', s.range);
  T('monitor 数不变', s.monitors.length === TARGETS.length);
  /* ⚠ DB 没迁移时必须优雅降级（返回 0 个历史点），
   * 而不是抛错把状态页带崩。 */
  T('DB 不可用时不抛异常（降级为仅内存）', Array.isArray(s.monitors));
  T('每项 series 都是数组', s.monitors.every(m => Array.isArray(m.series)));
}

console.log('\n【9】不泄露内部信息');
/* ⚠ 状态页是公开页面，绝不能顺带把 Node 版本、数据库地址、
 *   监听端口之类的东西吐出去 —— /api/health 之前就因为这个被删过内容。 */
{
  const s = await buildStatusSnapshot('24h');
  const text = JSON.stringify(s);
  T('不泄露 node 版本', !text.includes('v22') && !text.includes('process.version'));
  T('不泄露数据库地址', !/postgres|supabase|\.db\./i.test(text));
  T('不泄露主机名', !text.includes('127.0.0.1') && !text.includes('localhost'));
  T('不暴露写凭据', !text.includes('secret'));
  /* 探测目标路径本身是公开路由，写出来不算泄露 ——
     但每个 monitor 只应暴露 path，不能带内部查询参数。 */
  T('monitor 结构只有公开字段',
    s.monitors.every(m => Object.keys(m).sort().join(',') ===
      'avgMs,group,id,label,lastMs,n,path,series,up'),
    JSON.stringify(Object.keys(s.monitors[0] || {}).sort()));
}

console.log('\n────────');
console.log(`状态探测 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);