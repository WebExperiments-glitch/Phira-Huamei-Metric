# -*- coding: utf-8 -*-
"""法务词条：中英同步替换/新增。"""
import io
p = 'public/js/i18n/legal.js'
s = io.open(p, encoding='utf-8').read()
MAIL = 'mailto:kanqiao86413@163.com'
n = 0
def rep(old, new):
    global s, n
    assert old in s, '没找到：' + old[:70].replace('\n', ' ')
    s = s.replace(old, new, 1); n += 1

# ─────────── 中文 ───────────
rep("    'pv.t.5.b7': '同上（当前版本尚未提供自助注销入口，需人工处理）',",
"""    'pv.t.5.b7':
      '<a href="/settings#accounts">设置 · 账号管理</a> → 「注销账号」可<b>自助删除</b>本站在云端的资料'
      + '（Phira 绑定、显示名、访问计数）。<br>'
      + '⚠ <b>登录邮箱本身删不掉</b> —— 它在平台认证系统里，本站没有删除权限；'
      + '需要删除请发邮件（第 10 节），我们核验身份后协助处理。<br>'
      + '贡献过的成绩<b>不在注销范围</b>：它们本来就是匿名的，不挂在你的账号上。',""")

rep("""    'pv.h2.7': '7. 第三方服务',
    'pv.t.7.h1': '服务',
    'pv.t.7.h2': '用途',
    'pv.t.7.h3': '你的数据',
    'pv.t.7.a1': 'Phira 公开 API（api.phira.cn）',
    'pv.t.7.b1': '查询谱面与玩家公开资料',
    'pv.t.7.c1': '仅发送你查询的用户名 / UID；服务端日志由 Phira 控制',
    'pv.t.7.a2': 'WorkBuddy 云服务',
    'pv.t.7.b2': '数据库、认证、静态托管',
    'pv.t.7.c2': '存储上述成绩数据与账号信息',
    'pv.t.7.a3': 'jsDelivr CDN',
    'pv.t.7.b3': '加载云 SDK 脚本',
    'pv.t.7.c3': '会看到你的 IP，属常规 CDN 行为；脚本已用 SRI 完整性校验钉死版本',""",
"""    'pv.h2.7': '7. 个人信息对外提供清单',
    'pv.p.7.a':
      '本站<b>不向任何第三方出售</b>个人信息。下面是把个人信息交给外部服务商的<b>全部</b>情形 —— '
      + '逐项写明接收方、联系方式、处理目的、处理方式与信息种类。',
    'pv.p.7.b':
      '此外没有任何其它对外提供：本站不接入广告或数据分析 SDK，不向第三方出售或交换个人信息。',
    'pv.t.7.h1': '接收方',
    'pv.t.7.h2': '联系方式',
    'pv.t.7.h3': '处理目的',
    'pv.t.7.h4': '处理方式',
    'pv.t.7.h5': '个人信息种类',
    'pv.t.7.r1c1': 'WorkBuddy 云服务（腾讯）',
    'pv.t.7.r1c2': '平台客服；也可由本站转达（见第 10 节）',
    'pv.t.7.r1c3': '数据库托管、登录认证、静态分发',
    'pv.t.7.r1c4': '传输加密存储；启用行级安全，只有你本人能读写自己的资料行',
    'pv.t.7.r1c5': '登录邮箱、账号标识、绑定的 Phira UID 与显示名、贡献的成绩',
    'pv.t.7.r2c1': 'Phira（api.phira.cn）',
    'pv.t.7.r2c2': '以 phira.cn 公示的渠道为准',
    'pv.t.7.r2c3': '读取公开的谱面元数据与谱面文件，供定数计算',
    'pv.t.7.r2c4': '由本站<b>服务端</b>发起 HTTPS 只读请求，不随附你的账号身份或登录凭据',
    'pv.t.7.r2c5': '谱面 id、谱师 uid（均为公开数据）。你查询玩家时发送的用户名 / UID',
    'pv.t.7.r3c1': 'jsDelivr CDN',
    'pv.t.7.r3c2': 'jsdelivr.com',
    'pv.t.7.r3c3': '分发云服务 SDK 脚本',
    'pv.t.7.r3c4': '常规 CDN 静态分发；脚本版本已用 SRI 完整性校验钉死，本站不向其发送任何账号信息',
    'pv.t.7.r3c5': 'IP、User-Agent（CDN 服务的固有行为）',""")

rep("""    'pv.p.10.a':
      '隐私相关问题、数据删除请求、投诉与建议：<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',""",
"""    'pv.p.10.a':
      '隐私相关问题、数据删除 / 导出请求、账号注销协助、以及任何投诉举报，都可以直接发邮件到：<br>'
      + '<b><a href="mailto:kanqiao86413@163.com">kanqiao86413@163.com</a></b><br>'
      + '我们会在收到后 <b>15 个工作日内</b>答复；涉及个人信息的请求会先做身份核验。',
    'pv.p.10.c':
      '功能建议、Bug、公开的讨论，优先走 '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">GitHub Issues</a>'
      + ' —— 这样别人也能看到结论。但<b>涉及个人隐私、账号注销、数据删除的，请务必用邮件</b>，不要发在公开 Issue 里。',""")

rep("'pv.p.9.b'>本页 v1.1".split('>')[0] if False else
    "      '本页 v1.1 相对 v1.0 为<b>排版改版</b>：收集范围、用途与你的权利均无变化。',",
"""      '本页 v1.1 相对 v1.0 为<b>排版改版</b>：收集范围、用途与你的权利均无变化。',
    'pv.p.9.c':
      'v1.2（2026-10-11）：新增<b>个人信息对外提供清单</b>（第 7 节）、'
      + '<b>自助注销入口</b>（第 5 节）、<b>投诉举报渠道与邮箱</b>（第 10 节）。收集范围没有扩大。',""")

rep("    'tm.h2.11': '11. 联系方式',",
    "    'tm.h2.11': '11. 投诉举报与联系方式',")
rep("""    'tm.p.11.a':
      '对本协议的疑问、投诉或建议：<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',""",
"""    'tm.p.11.a':
      '对本服务的任何投诉、举报、侵权通知或一般咨询，发邮件到：<br>'
      + '<b><a href="mailto:kanqiao86413@163.com">kanqiao86413@163.com</a></b><br>'
      + '我们会在 <b>15 个工作日内</b>答复。公开的功能建议与 Bug 也可以走 '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">GitHub Issues</a>。',""")
rep("""    'tm.p.11.b':
      '涉及个人数据删除等隐私请求，请<b>不要</b>发在公开 Issue 里，'
      + '改用<a href="/privacy">隐私政策</a>「如何安全地联系我们」一节中的私密渠道。',""",
"""    'tm.p.11.b':
      '项目源码（GPL-3.0）见'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">同一仓库</a>。'
      + '涉及个人数据删除等隐私请求，请<b>不要</b>发在公开 Issue 里，改用上面的邮箱。',""")
print('中文侧替换 %d 处' % n)

# ─────────── 英文 ───────────
n0 = n
rep("    'pv.t.5.b7': 'As above (the current version offers no self-service deletion, so it is handled manually)',",
"""    'pv.t.5.b7':
      '<a href="/settings#accounts">Settings \\u00b7 Account</a> \\u2192 "Delete account" removes this site\\u2019s '
      + 'cloud data (Phira binding, display name, visit counter) <b>self-service</b>.<br>'
      + '\\u26a0 <b>The login e-mail itself cannot be deleted</b> \\u2014 it lives in the platform\\u2019s '
      + 'authentication system and this site has no permission to remove it; e-mail us (section 10) and we '
      + 'will help after verifying your identity.<br>'
      + 'Contributed scores are <b>out of scope</b>: they are anonymous and are not tied to your account.',""")

rep("""    'pv.h2.7': '7. Third-party services',
    'pv.t.7.h1': 'Service',
    'pv.t.7.h2': 'Purpose',
    'pv.t.7.h3': 'Your data',
    'pv.t.7.a1': 'Phira public API (api.phira.cn)',
    'pv.t.7.b1': 'Looking up public chart and player profiles',
    'pv.t.7.c1': 'Only the username / UID you look up is sent; server logs are controlled by Phira',
    'pv.t.7.a2': 'WorkBuddy cloud service',
    'pv.t.7.b2': 'Database, authentication, static hosting',
    'pv.t.7.c2': 'Stores the score data and account information described above',
    'pv.t.7.a3': 'jsDelivr CDN',
    'pv.t.7.b3': 'Loading the cloud SDK script',
    'pv.t.7.c3': 'It sees your IP, which is normal CDN behaviour; the script version is pinned by SRI integrity checking',""",
"""    'pv.h2.7': '7. Where your personal information goes',
    'pv.p.7.a':
      'We <b>never sell</b> personal information. Below is the <b>complete</b> list of cases where personal '
      + 'information reaches an external provider \\u2014 with recipient, contact, purpose, method and data type.',
    'pv.p.7.b':
      'There is nothing else: no advertising or analytics SDKs, and no selling or trading of personal information.',
    'pv.t.7.h1': 'Recipient',
    'pv.t.7.h2': 'Contact',
    'pv.t.7.h3': 'Purpose',
    'pv.t.7.h4': 'Method',
    'pv.t.7.h5': 'Data type',
    'pv.t.7.r1c1': 'WorkBuddy cloud service (Tencent)',
    'pv.t.7.r1c2': 'Platform support; we can also relay for you (see section 10)',
    'pv.t.7.r1c3': 'Database hosting, sign-in, static delivery',
    'pv.t.7.r1c4': 'Encrypted in transit and at rest; row-level security means only you can read or write your own row',
    'pv.t.7.r1c5': 'Login e-mail, account identifier, linked Phira UID and display name, contributed scores',
    'pv.t.7.r2c1': 'Phira (api.phira.cn)',
    'pv.t.7.r2c2': 'As published on phira.cn',
    'pv.t.7.r2c3': 'Reading public chart metadata and chart files for the difficulty calculation',
    'pv.t.7.r2c4': 'Read-only HTTPS requests made by our <b>server</b>, carrying no account identity or credentials of yours',
    'pv.t.7.r2c5': 'Chart id and charter uid (both public). The username / UID you submit when looking up a player',
    'pv.t.7.r3c1': 'jsDelivr CDN',
    'pv.t.7.r3c2': 'jsdelivr.com',
    'pv.t.7.r3c3': 'Delivering the cloud SDK script',
    'pv.t.7.r3c4': 'Ordinary static CDN delivery; the script version is pinned by SRI and we send it no account information',
    'pv.t.7.r3c5': 'IP and User-Agent (inherent to any CDN)',""")

rep("""    'pv.p.10.a':
      'Privacy questions, data deletion requests, complaints and suggestions:<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',""",
"""    'pv.p.10.a':
      'Privacy questions, data deletion or export requests, help with account deletion, and any complaint or '
      + 'report, can all be sent directly to:<br>'
      + '<b><a href="mailto:kanqiao86413@163.com">kanqiao86413@163.com</a></b><br>'
      + 'We reply within <b>15 working days</b>; requests touching personal information require identity verification first.',
    'pv.p.10.c':
      'For feature requests, bugs and open discussion, prefer '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">GitHub Issues</a>'
      + ' so others can see the outcome. But <b>anything involving privacy, account deletion or data deletion must go by e-mail</b> \\u2014 never in a public Issue.',""")

rep("      'The page v1.1 was a <b>layout revision</b> relative to v1.0: collection scope, purposes and your rights are all unchanged.'," if False else
    "      'This page: v1.1 was a <b>layout revision</b> relative to v1.0 \\u2014 collection scope, purposes and your rights are all unchanged.',",
"""      'This page: v1.1 was a <b>layout revision</b> relative to v1.0 \\u2014 collection scope, purposes and your rights are all unchanged.',
    'pv.p.9.c':
      'v1.2 (2026-10-11): added the <b>personal-information disclosure list</b> (section 7), the '
      + '<b>self-service deletion entry</b> (section 5) and the <b>complaint channel and e-mail</b> (section 10). '
      + 'Collection scope has not expanded.',""")

rep("    'tm.h2.11': '11. Contact',",
    "    'tm.h2.11': '11. Complaints and contact',")
rep("""    'tm.p.11.a':
      'Questions, complaints or suggestions about this agreement:<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',""",
"""    'tm.p.11.a':
      'Any complaint, report, takedown notice or general enquiry about this Service can be sent to:<br>'
      + '<b><a href="mailto:kanqiao86413@163.com">kanqiao86413@163.com</a></b><br>'
      + 'We reply within <b>15 working days</b>. Public feature requests and bugs can also go to '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">GitHub Issues</a>.',""")
rep("""    'tm.p.11.b':
      'For privacy requests such as deletion of personal data, please <b>do not</b> post in a public '
      + 'Issue; use the private channel described in the "How to contact us safely" section of the '
      + '<a href="/privacy">Privacy Policy</a> instead.',""",
"""    'tm.p.11.b':
      'The project source (GPL-3.0) is in '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">the same repository</a>. '
      + 'For privacy requests such as deletion of personal data, please <b>do not</b> post in a public Issue; '
      + 'use the e-mail address above instead.',""")
print('英文侧替换 %d 处' % (n - n0))

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('合计 %d 处' % n)
