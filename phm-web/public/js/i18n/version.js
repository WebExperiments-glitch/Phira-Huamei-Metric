/* ============================================================
 * js/i18n/version.js —— 版本历史页（/version）的外壳文案
 * ============================================================
 * ⚠ 每个版本**具体改了什么**不在这个文件里 —— 那些在 js/versions.js，
 *   和 zh/en 一起并排写在同一条条目上（见那边的说明）。
 *   这里只放页面的固定文字。
 * ============================================================ */
export default {
  zh: {
    'vn.title': '版本历史',
    'vn.sub':
      '这个工具改过什么、为什么改。'
      + '只列<b>你能感觉到</b>的变化——纯内部重构不占篇幅。',
    'vn.latest': '最新',
    'vn.count': '共 {n} 个版本',
    'vn.note':
      '想看得更深？仓库里有完整的 <span class="mono">CHANGELOG.md</span>（含每次的取舍与理由）'
      + '和架构文档。',
    'vn.back': '← 返回设置',
    'vn.tip':
      '每条都对应一个 Git tag，可以按版本号检出当时的状态。',
  },
  en: {
    'vn.title': 'Version history',
    'vn.sub':
      'What this tool changed and why. Only changes <b>you can actually feel</b> are listed — '
      + 'internal refactors do not get a line.',
    'vn.latest': 'latest',
    'vn.count': '{n} releases',
    'vn.note':
      'Want the full picture? The repository carries a complete <span class="mono">CHANGELOG.md</span> '
      + '(with the trade-offs and reasoning behind each change) plus the architecture docs.',
    'vn.back': '← Back to settings',
    'vn.tip': 'Each entry maps to a Git tag, so you can check out the exact state of any version.',
  },
};
