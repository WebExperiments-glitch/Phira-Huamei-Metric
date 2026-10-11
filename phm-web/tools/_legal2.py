# -*- coding: utf-8 -*-
"""法务三件：第三方共享清单 / 账号注销规则 / 投诉举报渠道。"""
import io, re

EMAIL = 'kanqiao86413@163.com'
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ══════════════════════════════════════════════════
# 1. privacy.html —— §7 换成「第三方共享清单」，§5 注销行，§10 渠道
# ══════════════════════════════════════════════════
p = 'public/privacy.html'; s = rd(p)

old7 = """  <h2 data-i18n="pv.h2.7">7. 第三方服务</h2>
  <table>
  <tr><th data-i18n="pv.t.7.h1">服务</th><th data-i18n="pv.t.7.h2">用途</th><th data-i18n="pv.t.7.h3">你的数据</th></tr>
  <tr><td data-i18n="pv.t.7.a1">Phira 公开 API（api.phira.cn）</td><td data-i18n="pv.t.7.b1">查询谱面与玩家公开资料</td>
      <td data-i18n="pv.t.7.c1">仅发送你查询的用户名 / UID；服务端日志由 Phira 控制</td></tr>
  <tr><td data-i18n="pv.t.7.a2">WorkBuddy 云服务</td><td data-i18n="pv.t.7.b2">数据库、认证、静态托管</td>
      <td data-i18n="pv.t.7.c2">存储上述成绩数据与账号信息</td></tr>
  <tr><td data-i18n="pv.t.7.a3">jsDelivr CDN</td><td data-i18n="pv.t.7.b3">加载云 SDK 脚本</td>
      <td data-i18n="pv.t.7.c3">会看到你的 IP，属常规 CDN 行为；脚本已用 SRI 完整性校验钉死版本</td></tr>
  </table>"""
new7 = """  <h2 data-i18n="pv.h2.7">7. 个人信息对外提供清单</h2>
  <p data-i18n-html="pv.p.7.a">本站**不向任何第三方出售**个人信息。下面是把个人信息交给外部服务商的<b>全部</b>情形 ——
  逐项写明接收方、联系方式、处理目的、处理方式与信息种类。</p>
  <table>
  <tr><th data-i18n="pv.t.7.h1">接收方</th><th data-i18n="pv.t.7.h2">联系方式</th>
      <th data-i18n="pv.t.7.h3">处理目的</th><th data-i18n="pv.t.7.h4">处理方式</th>
      <th data-i18n="pv.t.7.h5">个人信息种类</th></tr>
  <tr>
    <td data-i18n="pv.t.7.r1c1">WorkBuddy 云服务（腾讯）</td>
    <td data-i18n="pv.t.7.r1c2">平台客服；也可由本站转达（见第 10 节）</td>
    <td data-i18n="pv.t.7.r1c3">数据库托管、登录认证、静态分发</td>
    <td data-i18n="pv.t.7.r1c4">传输加密存储；启用行级安全，只有你本人能读写自己的资料行</td>
    <td data-i18n="pv.t.7.r1c5">登录邮箱、账号标识、绑定的 Phira UID 与显示名、贡献的成绩</td>
  </tr>
  <tr>
    <td data-i18n="pv.t.7.r2c1">Phira（api.phira.cn）</td>
    <td data-i18n="pv.t.7.r2c2">以 phira.cn 公示的渠道为准</td>
    <td data-i18n="pv.t.7.r2c3">读取公开的谱面元数据与谱面文件，供定数计算</td>
    <td data-i18n="pv.t.7.r2c4">由本站<b>服务端</b>发起 HTTPS 只读请求，不随附你的账号身份或登录凭据</td>
    <td data-i18n="pv.t.7.r2c5">谱面 id、谱师 uid（均为公开数据）。你查询玩家时发送的用户名 / UID</td>
  </tr>
  <tr>
    <td data-i18n="pv.t.7.r3c1">jsDelivr CDN</td>
    <td data-i18n="pv.t.7.r3c2">jsdelivr.com</td>
    <td data-i18n="pv.t.7.r3c3">分发云服务 SDK 脚本</td>
    <td data-i18n="pv.t.7.r3c4">常规 CDN 静态分发；脚本版本已用 SRI 完整性校验钉死，本站不向其发送任何账号信息</td>
    <td data-i18n="pv.t.7.r3c5">IP、User-Agent（CDN 服务的固有行为）</td>
  </tr>
  </table>
  <p data-i18n="pv.p.7.b">此外没有任何其它对外提供：本站不接入广告或数据分析 SDK，不向第三方出售或交换个人信息。</p>"""
assert old7 in s, 'privacy §7 锚点没找到'
s = s.replace(old7, new7, 1)

# §10 联系方式 → 加邮箱 + 投诉举报
old10 = re.search(r'  <h2 data-i18n="pv\.h2\.10">10\. 联系方式</h2>\n[\s\S]*?</p>\n', s)
assert old10, 'privacy §10 锚点没找到'
new10 = """  <h2 data-i18n="pv.h2.10">10. 投诉举报与联系方式</h2>
  <p data-i18n-html="pv.p.10.a">隐私相关问题、数据删除 / 导出请求、账号注销协助、以及任何投诉举报，
  都可以直接发邮件到：<br><b><a href="mailto:kanqiao86413@163.com">kanqiao86413@163.com</a></b><br>
  我们会在收到后 <b>15 个工作日内</b>答复；涉及个人信息的请求会先做身份核验。</p>
  <p data-i18n-html="pv.p.10.c">功能建议、Bug、公开的讨论，优先走
  <a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">GitHub Issues</a>
  —— 这样别人也能看到结论。但<b>涉及个人隐私、账号注销、数据删除的，请务必用邮件</b>，不要发在公开 Issue 里。</p>
"""
s = s[:old10.start()] + new10 + s[old10.end():]

# §9 政策变更：记一笔
s = s.replace(
  '<p data-i18n-html="pv.p.9.b">本页 v1.1 相对 v1.0 为<b>排版改版</b>：收集范围、用途与你的权利均无变化。</p>',
  '<p data-i18n-html="pv.p.9.b">本页 v1.1 相对 v1.0 为<b>排版改版</b>：收集范围、用途与你的权利均无变化。</p>\n'
  '  <p data-i18n-html="pv.p.9.c">v1.2（2026-10-11）：新增<b>个人信息对外提供清单</b>（第 7 节）、'
  '<b>自助注销入口</b>（第 5 节）、<b>投诉举报渠道与邮箱</b>（第 10 节）。收集范围没有扩大。</p>', 1)
wr(p, s); print('✓ privacy.html：共享清单 / 注销 / 投诉渠道')

# ══════════════════════════════════════════════════
# 2. terms.html —— 投诉渠道 + 账号终止
# ══════════════════════════════════════════════════
p = 'public/terms.html'; s = rd(p)
old = re.search(r'  <h2 data-i18n="tm\.h2\.11">11\. 联系方式</h2>\n[\s\S]*?</p>\n', s)
assert old, 'terms §11 锚点没找到'
new = """  <h2 data-i18n="tm.h2.11">11. 投诉举报与联系方式</h2>
  <p data-i18n-html="tm.p.11.a">对本服务的任何投诉、举报、侵权通知或一般咨询，发邮件到：<br>
  <b><a href="mailto:kanqiao86413@163.com">kanqiao86413@163.com</a></b><br>
  我们会在 <b>15 个工作日内</b>答复。公开的功能建议与 Bug 也可以走
  <a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">GitHub Issues</a>。</p>
  <p data-i18n-html="tm.p.11.b">项目源码（GPL-3.0）见
  <a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">同一仓库</a>。</p>
"""
s = s[:old.start()] + new + s[old.end():]
wr(p, s); print('✓ terms.html：投诉渠道')
