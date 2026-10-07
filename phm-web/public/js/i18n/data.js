/* ============================================================
 * js/i18n/data.js —— 数据页词条（dt.*）
 * ============================================================
 * 这一页是只读的全库表格浏览：汇总卡 / 分布条 / 工具栏 / 表头 / 分页。
 * 列名（dt.col.*）在 JS 里是**排序字段名 → 词条名**的映射，不在页面里写字面量。
 * ============================================================ */
export default {
  zh: {
    'dt.title': '共享定数缓存 · 数据管理',
    'dt.sub': '全站共享缓存里每一行都在这里。<b>只读</b> —— 写入只能由服务端复算后经凭据入库，这一页没有任何写入口。',
    'dt.eng': '当前引擎 {v}',

    'dt.sum.rows': '缓存行数',
    'dt.sum.dual': '有双标度',
    'dt.sum.dual.n': '{p}% 含官谱标度',
    'dt.sum.diff': '有过标称',
    'dt.sum.diff.n': '谱师填了难度',
    'dt.sum.stale': '过期行',
    'dt.sum.stale.n': '引擎换代未重算',
    'dt.sum.fresh.n': '全部最新',
    'dt.sum.failTitle': '汇总',
    'dt.sum.fail': '读取失败',

    'dt.search.ph': '搜曲名…',
    'dt.filter.allTier': '全部档位',
    'dt.filter.allKind': '全部分类',
    'dt.filter.official': '有官谱标度',
    'dt.filter.stale': '引擎版本过期',

    /* 表头：键名与排序字段一一对应（见 data.html 的 COLS） */
    'dt.col.chart_id': 'ID',
    'dt.col.name': '曲名',
    'dt.col.level': '档',
    'dt.col.difficulty': '标称',
    'dt.col.ref_const': '社区共识',
    'dt.col.ref_official': '官谱标度',
    'dt.col.ps_score': 'PS',
    'dt.col.nps': 'NPS',
    'dt.col.notes': '物量',
    'dt.col.engine_build': '引擎',
    'dt.col.computed_at': '计算时间',

    'dt.reading': '读取中…',
    'dt.empty': '没有符合条件的行',
    'dt.hint': '{a} 行 · 每页 {b}',
    'dt.stale.tip': '不是当前引擎算的',
    'dt.stale.old': '旧版',
    'dt.latest': '最新',
    'dt.fail': '读取失败：{e}',

    'dt.foot.src': '数据来源：本站云数据库 <span class="mono">phm_charts</span>（只读接口 <span class="mono">/api/charts</span>）。',
    'dt.foot.note': '总数来自数据库的 <span class="mono">Content-Range</span> 响应头（<span class="mono">Prefer: count=exact</span>），是<b>真实总数</b>而不是"这一页有多少条"。排序字段走服务端白名单。',
  },

  en: {
    'dt.title': 'Shared constant cache · Data',
    'dt.sub': 'Every row of the shared cache is here. <b>Read-only</b> — rows can only be written by the server after recomputing, through a credential. This page has no write path.',
    'dt.eng': 'Engine {v}',

    'dt.sum.rows': 'Cached rows',
    'dt.sum.dual': 'Both scales',
    'dt.sum.dual.n': '{p}% carry an official-scale value',
    'dt.sum.diff': 'Has a nominal',
    'dt.sum.diff.n': 'the charter filled one in',
    'dt.sum.stale': 'Stale rows',
    'dt.sum.stale.n': 'computed by an older engine',
    'dt.sum.fresh.n': 'all current',
    'dt.sum.failTitle': 'Summary',
    'dt.sum.fail': 'load failed',

    'dt.search.ph': 'Search chart names…',
    'dt.filter.allTier': 'All tiers',
    'dt.filter.allKind': 'All kinds',
    'dt.filter.official': 'Has official scale',
    'dt.filter.stale': 'Stale engine version',

    'dt.col.chart_id': 'ID',
    'dt.col.name': 'Chart',
    'dt.col.level': 'Tier',
    'dt.col.difficulty': 'Nominal',
    'dt.col.ref_const': 'Community',
    'dt.col.ref_official': 'Official scale',
    'dt.col.ps_score': 'PS',
    'dt.col.nps': 'NPS',
    'dt.col.notes': 'Notes',
    'dt.col.engine_build': 'Engine',
    'dt.col.computed_at': 'Computed at',

    'dt.reading': 'Loading…',
    'dt.empty': 'No rows match these filters',
    'dt.hint': '{a} rows · {b} per page',
    'dt.stale.tip': 'Computed by an older engine',
    'dt.stale.old': 'legacy',
    'dt.latest': 'current',
    'dt.fail': 'Load failed: {e}',

    'dt.foot.src': 'Source: this site\u2019s cloud database <span class="mono">phm_charts</span> (read-only endpoint <span class="mono">/api/charts</span>).',
    'dt.foot.note': 'The total comes from the database\u2019s <span class="mono">Content-Range</span> response header (<span class="mono">Prefer: count=exact</span>) — it is the <b>real total</b>, not "how many rows are on this page". Sortable fields go through a server-side whitelist.',
  },
};
