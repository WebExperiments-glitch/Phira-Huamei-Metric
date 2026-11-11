/* ============================================================
 * js/ui.js —— **兼容层**：把所有 UI 模块再导出一次
 * ============================================================
 * 【为什么留这个文件】
 *   21 个页面都从 ui.js 里取 esc / renderNav 这些名字。
 *   拆模块时如果直接改 import 路径，等于同时改 21 个文件 + 漏一个就白屏。
 *   所以保留 ui.js 作为**唯一入口**，内部 re-export。
 *
 * 【拆分动机】
 *   原文件 533 行，混了五类职责：导航 / 格式化 / 徽章 / 分页 / 数据加载。
 *   只想用 esc() 的页面也得整包下载；改分页样式要在 500 行里找。
 *   现在：
 *     ui/format.js   纯格式化，无依赖
 *     ui/nav.js      导航
 *     ui/data.js     缓存与派生计算（IO）
 *     ui/widgets.js  徽章 / 分页 / 术语 / 标签组
 *
 * 【以后】新代码请直接 import 具体模块，不要再往这里加东西。
 *   这个文件只减不增。
 * ============================================================ */

export * from './ui/format.js?v=V0.30.3.0';
export * from './ui/nav.js?v=V0.30.3.0';
export * from './ui/data.js?v=V0.30.3.0';
export * from './ui/widgets.js?v=V0.30.3.0';

/* ⚠ 这几个是**再导出**（re-export），不是本文件的实现。
   原始 ui.js 第 14 行就是 `export { PHIRA_API, t, applyStatic, onLangChange, currentLang, setLang };`
   —— 页面从 ui.js 里取 t / applyStatic，靠的就是这一行。
   拆模块时漏了它，导致 17 个页面报 "does not provide an export named 'applyStatic'"
   并整体不执行（导航空白）。这类"隐式中转"是胶水层最容易被忽略的部分。 */
export { PHIRA_API } from './phira.js?v=V0.30.3.0';
export { t, applyStatic, onLangChange, currentLang, setLang } from './i18n.js?v=V0.30.3.0';
