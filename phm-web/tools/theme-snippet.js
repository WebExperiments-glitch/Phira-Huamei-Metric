/* tools/theme-snippet.js —— 主题启动脚本的**唯一真源**
 *
 * 【为什么要有这个文件】
 *   之前这段脚本被手工复制到 26 个 HTML 的 <head> 里，实测已经漂成 5 个版本：
 *     · 404.html 漏了「字体/字号」两行 → 那页刷新后字体设置丢失
 *     · settings.html 直接 setAttribute(f) 不做白名单 → localStorage 被写脏值就应用脏值
 *     · 注释有三种写法
 *   复制粘贴必然漂移。这里定一份真源，由 tools/inject-theme.mjs 铺到所有页面，
 *   并由 npm run check 校验「页面里的内联 == 真源」—— 谁手工改了就会红。
 *
 * 【为什么不用外链 <script src>】
 *   这段必须在 <head> 里**同步**执行，否则会先按默认主题画一帧再切换（FOUC）。
 *   外链在 HTTP/1.1 下是额外阻塞请求，在 H2 下也要多一个往返。
 *   所以保留内联，但由生成器统一铺 —— 拿"可维护"而不是"少几 KB"。
 *
 * 【键名】phm_theme / phm_font / phm_size，与 /js/settings.js 的 KEYS 一致。
 * 【合法值】theme: auto|light|dark；font: serif|sans|kai；size: s|m|l
 *   非法值一律回落到默认 —— 这就是 settings.html 之前缺的那道校验。
 */
/* lint-slop:allow 裸-localStorage
   ↑ 本文件里那段 localStorage 是**要注入到 26 个页面 <head> 的模板内容**，
     不是散的页面代码。键名与默认值仍只在这里定义一次（这正是它的价值）。 */

export const SNIPPET = `(function(){var d=document.documentElement,t="auto",f="serif",z="m";
try{t=localStorage.getItem("phm_theme")||"auto";
f=localStorage.getItem("phm_font")||"serif";
z=localStorage.getItem("phm_size")||"m";}catch(e){}
var dark=t==="dark"||(t==="auto"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);
d.setAttribute("data-theme",dark?"dark":"light");
d.setAttribute("data-theme-mode",t==="light"||t==="dark"?t:"auto");
d.setAttribute("data-font",f==="sans"||f==="kai"?f:"serif");
d.setAttribute("data-size",z==="s"||z==="l"?z:"m");})();`;

/* 页面里这段脚本的识别模式。
   ⚠ 不能用"开头必须 var t=auto" —— 真源的第一行是 var d=document.documentElement。
     改成：<script> 后紧跟 (function(){var ... ，且 1.5k 字符内出现 data-theme。
     两个条件一起用，避免误伤页面里的其它内联脚本。 */
export const RE = /<script>\s*(?:\/\*[\s\S]{0,240}?\*\/\s*)?\(function\(\)\{[\s\S]{0,2000}?data-theme[\s\S]{0,2000}?\}\)\(\);?\s*<\/script>/;
