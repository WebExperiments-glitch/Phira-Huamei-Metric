/* ============================================================
 * js/markdown.js —— 极简 markdown 渲染（转义优先 + 白名单）
 * ============================================================
 * 【为什么不用 marked + DOMPurify】
 *   两个库加起来约 100 KB（gzip 后 35 KB），而我们需要的就是
 *   粗体 / 列表 / 标题 / 行内代码 / 代码块 / 链接 —— 六种。
 *
 *   更关键的是**安全面**：marked 出 HTML 之后必须再过 DOMPurify 才敢插进 DOM，
 *   少配一条就等于开了 XSS。这里反过来做 —— **先全量转义，再只把认得的结构
 *   换成标签**。天然没有注入面：任何用户内容都已经是 `&lt;` 这类实体了。
 *
 * 【支持】
 *   # 标题（1~3 级）    **粗体**   *斜体*   `行内代码`
 *   ```代码块```        - / * 无序列表    1. 有序列表
 *   [文字](https://…) 链接（只放行 http/https）
 *   段落之间空一行
 *
 * 【不支持（故意的）】
 *   表格、图片、HTML 内联、脚注 —— 写谱对话里用不到，
 *   每加一种就多一块必须测的攻击面。
 * ============================================================ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/* 行内：在**已转义**的文本上做，所以不可能插进标签 */
function inline(text) {
  return text
    /* 行内代码先做，避免里面的星号被当成粗体 */
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。]|$)/g, '$1<em>$2</em>')
    /* 链接：只放行 http/https。javascript: 之类在这里就被挡掉 */
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
}

/**
 * 渲染成 HTML 字符串。**输入不需要预先转义**。
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n');

  /* 代码块先切出去，块内的星号/井号不能被当格式。
     ⚠ 占位符**必须独占一行**（前后各补换行）。原来直接返回 `\0BLOCK0\0`，
     而围栏常常紧贴正文（`…40 拍。```js`），替换后占位符粘在句子尾巴上，
     整行匹配不上，于是 `BLOCK0` 这三个字原样印到用户脸上。 */
  const blocks = [];
  const withTokens = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre data-lang="${escapeHTML(lang || '')}">${escapeHTML(code.replace(/\n$/, ''))}</pre>`);
    return `\n\u0000BLOCK${blocks.length - 1}\u0000\n`;
  });

  const out = [];
  let list = null;   /* 'ul' | 'ol' | null */

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const raw of withTokens.split('\n')) {
    const line = raw.trimEnd();

    if (!line.trim()) { closeList(); continue; }

    /* 代码块占位 */
    const token = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (token) { closeList(); out.push(blocks[+token[1]]); continue; }

    /* 标题 */
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(escapeHTML(h[2]))}</h${lv}>`);
      continue;
    }

    /* 无序列表 */
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(escapeHTML(ul[1]))}</li>`);
      continue;
    }

    /* 有序列表 */
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(escapeHTML(ol[1]))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(escapeHTML(line))}</p>`);
  }
  closeList();
  /* 兜底：任何没被认出来的占位符都不许漏到界面上（宁可丢一个代码块，
     也不要让用户看见 BLOCK0 这种东西 —— NUL 字节在 DOM 里还是隐形的，
     排查时会以为模型在说胡话）。 */
  return out.join('\n').replace(/\u0000BLOCK\d+\u0000/g, '');
}
