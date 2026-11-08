/* ============================================================
 * js/i18n-sanitize.js —— data-i18n-html 的白名单清洗
 * ============================================================
 * 【为什么单独一个文件】
 *   1. 它是**安全边界**：字典文件会从远端合并，那份内容不保证是我们写的，
 *      直接 innerHTML 插进 DOM 就是把远端内容当代码执行。
 *      清洗逻辑必须独立成模块，才有自己的单测与评审。
 *   2. CodeQL 的 js/xss-through-dom 不跟踪自定义清洗逻辑，
 *      而针对 template.innerHTML 这个 sink，抑制注释也不生效
 *      （2026-11-08 实测：注释在紧邻上一行、queries-excludes 精确到
 *      规则+文件，都压不住）。所以本文件在
 *      .github/codeql/codeql-config.yml 里按**文件级**排除 ——
 *      不是目录级豁免，也不动其它文件的其它规则。
 *
 * 【规则】
 *   标签白名单：按字典里**真实用到**的列（b/strong/i/em/br/code/span/
 *   li/ul/ol/a/p/u/s/small/sub/sup），不在表里的一律拆成纯文本。
 *   属性：只留 a[href]，且协议限 http/https/协议相对/锚点；其余一律剥掉。
 * ============================================================ */

/* ── i18n-html 白名单清洗 ────────────────────────────────────
   ⚠ 为什么需要：i18n.js 会从远端合并字典，那份内容**不保证**是我们写的。
     直接 innerHTML 插进 DOM 就是把远端内容当代码执行。
   ⚠ 只放行字典里真实用到的标签 + a[href]（协议限 http/https/相对/锚点），
     其余标签拆成文本、其余属性一律剥掉。 */
const I18N_ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'br', 'code', 'span',
  'li', 'ul', 'ol', 'a', 'p', 'u', 's', 'small', 'sub', 'sup']);
const I18N_SAFE_URL = /^(https?:\/\/|\/\/|#)/i;

export function sanitizeI18nHtml(html) {
  const src = String(html == null ? '' : html);
  if (!src) return '';
  if (typeof document === 'undefined' || !document.createElement) return '';
  /* ⚠ 用 <template> 而不是 DOMParser：
     template 的内容是**惰性**的（里面的 <script> 不会执行、<img> 不会加载），
     比 DOMParser 更适合当"先解析再清洗"的暂存区。
     而且 CodeQL 对 DOMParser.parseFromString 也当 HTML sink 报，
     换成 template 之后告警回到可抑制注释的那一处。 */
  const tpl = document.createElement('template');
  // codeql[js/xss-through-dom] template 内容惰性不执行；下方 walk() 再按白名单清洗
  tpl.innerHTML = src;
  const root = tpl.content;
  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      walk(child);
      const tag = child.tagName.toLowerCase();
      if (!I18N_ALLOWED_TAGS.has(tag)) {
        /* 不在白名单：拆成文本 + 子节点（保留里面的合法内容） */
        const frag = document.createDocumentFragment();
        while (child.firstChild) frag.appendChild(child.firstChild);
        child.replaceWith(frag);
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const keep = tag === 'a' && attr.name === 'href' && I18N_SAFE_URL.test(attr.value);
        if (!keep) child.removeAttribute(attr.name);
      }
    }
  };
  walk(root);
  // codeql[js/xss-through-dom] 这里是**读取**（序列化已清洗的 template），不是写入 DOM
  return tpl.innerHTML;
}
