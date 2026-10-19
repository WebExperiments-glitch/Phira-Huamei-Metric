/* ============================================================
 * js/i18n/status.js —— 服务状态页（/status）的外壳文案
 * ============================================================
 * ⚠ 指标**名称**（可用率 / 当前延迟 / 平均延迟）在这里，
 *   但探测目标的名字（首页 / 算谱面 / …）不在这——
 *   那些在 lib/status.mjs 的 TARGETS 里，跟探测配置待在一起。
 *   分开的理由：改一个目标名不该去动翻译文件，
 *   反过来改文案也不该碰服务端配置。两边混一起必然漂。
 * ============================================================ */
export default {
  zh: {
    'st.title': '运行状态',
    'st.sub':
      '服务每分钟自检一次，测的是<b>真实处理耗时</b>——从请求进来到响应出去，' +
      '不含网络往返，所以数字比外部测速小得多。',

    /* ── 顶部横幅 ── */
    'st.operational': '所有服务运行正常',
    'st.degraded': '部分服务性能下降',
    'st.outage': '服务中断',
    'st.unknown': '正在采集首次数据',
    'st.unknownHint':
      '刚启动，还没有攒够样本。第一轮探测完成后这里会亮起来。',
    'st.updated': '更新于 {t}',
    'st.interval': '每 {n} 秒检查一次',

    /* ── 时间范围切换 ── */
    'st.range': '范围',
    'st.range24': '24 小时',
    'st.range30': '30 天',

    /* ── 指标表头 ── */
    'st.up': '可用率',
    'st.latency': '延迟',
    'st.current': '当前',
    'st.avg': '平均',
    'st.path': '探测路径',

    /* ── 分组 ── */
    'st.gpage': '页面',
    'st.gapi': '接口',
    'st.gdata': '数据',

    /* ── 状态词 ── */
    'st.normal': '正常',
    'st.slow': '偏慢',
    'st.down': '不可用',
    'st.nodata': '暂无数据',
    'st.dash': '—',
    'st.few': 'Not enough samples yet',

    /* ── 底部说明 ── */
    'st.noteTitle': '关于这些数字',
    'st.note1':
      '探测从<b>服务器内部</b>发起，走和你的请求完全相同的路径。' +
      '所以它反映的是处理耗时，不含网络往返——' +
      '比外部测速站看到的数字小是正常的。',
    'st.note2':
      '延迟只统计<b>成功</b>的请求。失败不是「0 毫秒」，' +
      '把它算进平均会伪装成「很快」。',
    'st.note3':
      '近 24 小时的数据存在运行内存里，<b>重启后会清零</b>；' +
      '30 天视图存在数据库里，跨重启留存。',
    'st.note4':
      '这是<b>我们自己的监控</b>。如果连状态页都打不开，' +
      '那说明问题比这里显示的更严重——直接刷新试试。',
    'st.retry': '刷新',
    'st.loading': '正在读取探测数据…',
    'st.nohist': '30 天历史还没启用（数据库迁移未执行），当前只显示近 24 小时。',
  },

  en: {
    'st.title': 'Status',
    'st.sub':
      'Services check themselves once a minute, measuring <b>real processing time</b> ' +
      '— from request in to response out, excluding network round-trips.',

    'st.operational': 'All systems operational',
    'st.degraded': 'Degraded performance',
    'st.outage': 'Service outage',
    'st.unknown': 'Collecting first data',
    'st.unknownHint':
      'Just started — not enough samples yet. This light turns on after the first round.',
    'st.updated': 'Updated {t}',
    'st.interval': 'Checked every {n}s',

    'st.range': 'Range',
    'st.range24': '24 hours',
    'st.range30': '30 days',

    'st.up': 'Uptime',
    'st.latency': 'Latency',
    'st.current': 'Current',
    'st.avg': 'Average',
    'st.path': 'Path',

    'st.gpage': 'Pages',
    'st.gapi': 'API',
    'st.gdata': 'Data',

    'st.normal': 'Operational',
    'st.slow': 'Slow',
    'st.down': 'Down',
    'st.nodata': 'No data',
    'st.dash': '—',
    'st.few': '样本还太少，画不出趋势',

    'st.noteTitle': 'About these numbers',
    'st.note1':
      'Probes run <b>from inside the server</b>, over the exact path your request takes. ' +
      'So they measure processing time without network round-trips — ' +
      'smaller numbers than an external speed test are expected.',
    'st.note2':
      'Averages count <b>successful</b> requests only. A failure is not "0 ms"; ' +
      'including it would fake a fast average.',
    'st.note3':
      'The last 24 hours live in process memory and <b>reset on restart</b>; ' +
      'the 30-day view is stored in the database.',
    'st.note4':
      'This is <b>our own monitoring</b>. If this page itself will not load, ' +
      'the problem is worse than shown here — just try reloading.',
    'st.retry': 'Reload',
    'st.loading': 'Loading probe data…',
    'st.nohist': '30-day history is not enabled yet (database migration not run). Showing the last 24 hours only.',
  },
};