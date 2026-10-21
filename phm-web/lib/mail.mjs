/* ============================================================
 * lib/mail.mjs —— 发验证码用的邮件发送
 * ============================================================
 * 【为什么不再用平台那个发信服务】
 *   原来的验证码是让平台（CloudBase 的 auth 服务）发的：我们调
 *   `/.cloud/auth/v1/verification`，它发信并给我们一个 verification_id。
 *   2026-10-21 那个服务随数据库一起挂了（`send_failed`），
 *   于是**新用户完全注册不了** —— 账号体系里唯一还依赖平台的一环。
 *
 * 【为什么自己生成码，而不是继续"平台发、平台验"】
 *   一旦发信换成别人，平台就不再知道这个码，验证也只能自己做。
 *   所以改成：我们生成 6 位码 → 只把 **哈希** 存进 hm_email_codes.vid →
 *   发信 → 校验时比对哈希。旧的平台行仍然能走老路（vid 带 `plt:` 前缀），
 *   所以升级不会把已经发出去的码弄失效。
 *
 * 【为什么全是 HTTP API，不引 nodemailer】
 *   三个候选都提供 HTTPS 接口，用内置 fetch 就够。多一个依赖就多一份
 *   ARM/构建/升级的麻烦（这个项目已经为 pg 破例过一次）。
 * ============================================================ */

/* 免费额度的现实（2026-10 核实）：
     SMTP2GO  1000/月、200/天，**无卡、不插品牌**，未验证域名时 25 封/小时
     Brevo    300/天，无卡，但开号要审核、送达率中等
     Resend   3000/月、100/天，无卡，但**必须验证自有域名**才能发给任意人
   我们这个场景是低频（注册/重置），三家都够；SMTP2GO 的「无品牌 + 不卡卡」
   最省事，所以默认推荐它，但代码对三家一视同仁。 */
export const PROVIDERS = ['smtp2go', 'brevo', 'resend'];

function cfg() {
  const env = process.env;
  return {
    provider: String(env.PHM_MAIL_PROVIDER || '').toLowerCase().trim(),
    key: String(env.PHM_MAIL_KEY || '').trim(),
    from: String(env.PHM_MAIL_FROM || '').trim(),      /* 必须是服务商那边验证过的发件邮箱 */
    name: String(env.PHM_MAIL_NAME || 'P.H.M. Standard').trim(),
  };
}

/** 配置齐了没有。没齐就自动退回平台那条老路（也就等于"发不出去"，但不会崩）。 */
export function mailReady() {
  const c = cfg();
  return PROVIDERS.includes(c.provider) && !!c.key && !!c.from;
}

export function mailProvider() {
  const c = cfg();
  return mailReady() ? c.provider : '';
}

/**
 * 发一封邮件。永不抛异常 —— 调用方要的是"发成没发成"，不是栈。
 * @returns {Promise<{ok:boolean, error?:string, detail?:string}>}
 */
export async function sendMail({ to, subject, text, html }) {
  const c = cfg();
  if (!mailReady()) return { ok: false, error: 'mail_not_configured' };

  const from = c.name ? `${c.name} <${c.from}>` : c.from;
  let url, init;

  if (c.provider === 'smtp2go') {
    url = 'https://api.smtp2go.com/v3/email/send';
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: c.key,
        sender: from,
        to: [to],
        subject,
        text_body: text,
        html_body: html,
      }),
    };
  } else if (c.provider === 'brevo') {
    url = 'https://api.brevo.com/v3/smtp/email';
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': c.key },
      body: JSON.stringify({
        sender: { email: c.from, name: c.name },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
    };
  } else if (c.provider === 'resend') {
    url = 'https://api.resend.com/emails';
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    };
  } else {
    return { ok: false, error: 'mail_provider_unknown' };
  }

  try {
    const r = await fetch(url, Object.assign(init, { signal: AbortSignal.timeout(15000) }));
    const txt = await r.text().catch(() => '');
    /* SMTP2GO 有个坑：HTTP 200 但 body 里 emailed=0 且 data.error 非空 ——
       只看状态码会把"没发出去"当成成功。 */
    if (c.provider === 'smtp2go' && r.ok) {
      let j = null;
      try { j = JSON.parse(txt); } catch { /* 忽略 */ }
      const emailed = j && j.data && Number(j.data.succeeded);
      const failed = j && j.data && Number(j.data.failed);
      if (Number.isFinite(failed) && failed > 0 && !(emailed > 0)) {
        return { ok: false, error: 'send_rejected', detail: String(txt).slice(0, 200) };
      }
    }
    if (!r.ok) {
      /* 只把服务商的原文截短记日志，**不回给客户端**（里面有账号/额度信息） */
      console.warn('[mail] ' + c.provider + ' 拒绝：', r.status, String(txt).slice(0, 200));
      return { ok: false, error: 'send_failed', detail: String(r.status) };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[mail] ' + c.provider + ' 请求异常：', String(e.message || e).slice(0, 160));
    return { ok: false, error: 'send_failed' };
  }
}
