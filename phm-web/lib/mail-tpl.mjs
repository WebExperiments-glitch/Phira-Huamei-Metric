/* ============================================================
 * lib/mail-tpl.mjs —— 验证码邮件的正文模板
 * ============================================================
 * 【为什么单独一个文件】
 *   邮件客户端**不支持 CSS 变量**（Gmail/Outlook 会把 var(--x) 直接丢掉），
 *   所以这里的颜色只能写死十六进制。而项目有一条「颜色必须走令牌」的规矩，
 *   于是把这块单独拆出来、在 lint-slop 的 COLOR_OK 里显式豁免 ——
 *   和 `make-og.mjs`（生成分享图）、`404.html`（自包含）是同一个理由：
 *   **渲染目标不在我们自己的主题体系里**。
 *
 * 【为什么样式全用内联】
 *   Gmail 会删掉 <style> 块里的内容（尤其是 head 里的）；内联是唯一稳的。
 * ============================================================ */

/**
 * @param {string} code 6 位验证码
 * @param {number} mins 有效期（分钟）
 * @returns {{subject:string, text:string, html:string}}
 */
export function codeMail(code, mins) {
  const subject = `P.H.M. 验证码：${code}（${mins} 分钟内有效）`;

  /* 纯文本版：有些客户端默认不渲染 HTML，而且它更不容易进垃圾箱 */
  const text = [
    `你的验证码是 ${code}，${mins} 分钟内有效。`,
    '',
    '不是你本人操作？忽略这封邮件即可。',
    '—— P.H.M. Standard',
  ].join('\n');

  const html = `<div style="margin:0;padding:24px 0;background:#F6F3EE">
  <div style="max-width:440px;margin:0 auto;padding:28px 26px;background:#FFFDF9;border:1px solid #EFEBE4;border-radius:12px;font:16px/1.7 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1D1A16">
    <p style="margin:0 0 6px;font-size:13px;letter-spacing:.08em;color:#8A8378">P.H.M. STANDARD</p>
    <p style="margin:0 0 16px">你的验证码是</p>
    <p style="margin:0 0 18px;font:700 30px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:7px;color:#9A6208">${code}</p>
    <p style="margin:0 0 6px;color:#4A443C">${mins} 分钟内有效。</p>
    <p style="margin:0;color:#665F55;font-size:14px">不是你本人操作？忽略这封邮件即可，不会有任何影响。</p>
  </div>
</div>`;

  return { subject, text, html };
}
