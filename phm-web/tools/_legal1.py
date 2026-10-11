# -*- coding: utf-8 -*-
"""法务三件 + 自助注销（一次性脚本）。"""
import io, re

EMAIL = 'kanqiao86413@163.com'
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ══════════════════════════════════════════════════
# 1. settings.html —— 账号区块加「注销账号」入口 + 处理逻辑
# ══════════════════════════════════════════════════
p = 'public/settings.html'; s = rd(p)
anchor = """        <div class="srow">
          <div class="sl">
            <b data-i18n="set.acct.bound">已绑定 Phira</b>
            <span id="bindState">—</span>
          </div>
          <div class="sc" id="bindActions"></div>
        </div>
      </div>"""
add = """        <div class="srow">
          <div class="sl">
            <b data-i18n="set.acct.bound">已绑定 Phira</b>
            <span id="bindState">—</span>
          </div>
          <div class="sc" id="bindActions"></div>
        </div>
        <!-- ── 注销：**自助删数据** ──
             ⚠ 能删什么、不能删什么，必须和 /privacy 第 5 节一字不差 ——
             政策里承诺了做不到的事，比不写更糟。这里如实分成两块：
               能删 = phm_profiles 那一行（Phira 绑定 / 显示名 / 访问计数）
               删不掉 = 登录邮箱本身（在平台认证系统里，本站没有删除权限）
             数据库侧已加 DELETE 策略（owner_id = auth.uid()），所以只会删到自己那行。 -->
        <div class="srow">
          <div class="sl">
            <b data-i18n="set.acct.del">注销账号</b>
            <span data-i18n-html="set.acct.del.desc">删除本站云端资料（Phira 绑定与显示名）。<b>登录邮箱需另行申请</b>。</span>
          </div>
          <div class="sc"><button class="sbtn danger" type="button" id="acctDel" data-i18n="set.acct.del.go">删除本站资料…</button></div>
        </div>
      </div>"""
assert anchor in s, 'settings.html 账号区块锚点没找到'
s = s.replace(anchor, add, 1)

js_anchor = """$('#cidReset').addEventListener('click', function () {"""
js_add = """/* ── 注销：删除本站云端资料 + 登出 ──
   ⚠ 范围只到「本站资料」：
     · 删 phm_profiles 那一行（Phira 绑定、显示名、访问计数）
     · **删不掉登录邮箱** —— 它在平台认证系统里，客户端没有这个权限。
       所以文案与 /privacy 第 5 节都写明「邮箱需另行申请」，不能含糊。
     · 贡献的成绩**不在注销范围**：它本来就是匿名的（表里没有 owner_id），
       不挂在账号上，删账号也不会带走它。
   失败时不假装成功 —— 把错误显示出来，并给出邮件兜底渠道。 */
$('#acctDel').addEventListener('click', async function () {
  const user = await currentUser();
  if (!user) { acctMsg(t('set.acct.del.nologin'), 'warn'); return; }
  if (!window.confirm(t('set.acct.del.confirm'))) return;
  if (!cloudDB) { acctMsg(t('set.acct.del.nocloud'), 'err'); return; }
  const btn = this;
  btn.disabled = true;
  try {
    /* RLS 已经限定 owner_id = auth.uid()，这里再显式带上 uid，语义更清楚 */
    const r = await cloudDB.from('phm_profiles').delete().eq('owner_id', user.id);
    if (r && r.error) {
      acctMsg(t('set.acct.del.fail', { e: String(r.error.message || r.error) }), 'err');
      btn.disabled = false;
      return;
    }
    acctMsg(t('set.acct.del.done'), 'ok');
    try { if (cloud && cloud.auth && cloud.auth.signOut) await cloud.auth.signOut(); } catch (e) {}
    setTimeout(function () { location.reload(); }, 1200);
  } catch (e) {
    acctMsg(t('set.acct.del.fail', { e: String((e && e.message) || e) }), 'err');
    btn.disabled = false;
  }
});

$('#cidReset').addEventListener('click', function () {"""
assert js_anchor in s, 'settings.html cidReset 锚点没找到'
s = s.replace(js_anchor, js_add, 1)
wr(p, s); print('✓ settings.html：注销入口 + 处理逻辑')

# ══════════════════════════════════════════════════
# 2. i18n/settings.js —— 注销相关文案（中英）
# ══════════════════════════════════════════════════
p = 'public/js/i18n/settings.js'; s = rd(p)
zh_anchor = "    'set.acct.clearcid': '重置匿名标识',"
zh_add = zh_anchor + """

    /* ── 注销（自助删本站资料；邮箱删不掉，如实写）── */
    'set.acct.del': '注销账号',
    'set.acct.del.desc': '删除本站云端资料（Phira 绑定与显示名）。<b>登录邮箱需另行申请</b>。',
    'set.acct.del.go': '删除本站资料…',
    'set.acct.del.nologin': '你还没有登录，没有可注销的资料。',
    'set.acct.del.nocloud': '云端未连接，暂时无法删除 —— 请改用邮件申请（见隐私政策第 10 节）。',
    'set.acct.del.confirm': '确定要删除本站在云端的资料吗？\\n\\n会删掉：Phira 绑定关系、显示名、访问计数。\\n不会删：登录邮箱本身（需要另行申请），以及你贡献过的成绩（它们本来就是匿名的，不挂在账号上）。\\n\\n此操作不可撤销。',
    'set.acct.del.done': '本站资料已删除 ✓ 正在登出…',
    'set.acct.del.fail': '删除失败：{e} —— 可改用邮件申请（见隐私政策第 10 节）。',"""
assert zh_anchor in s
s = s.replace(zh_anchor, zh_add, 1)

en_anchor = "    'set.acct.clearcid': 'Reset anonymous ID',"
en_add = en_anchor + """

    /* ── account deletion (self-service for site data; the login e-mail cannot be deleted) ── */
    'set.acct.del': 'Delete account',
    'set.acct.del.desc': 'Removes this site\u2019s cloud data (Phira binding and display name). <b>The login e-mail needs a separate request.</b>',
    'set.acct.del.go': 'Delete site data\u2026',
    'set.acct.del.nologin': 'You are not signed in, so there is nothing to delete.',
    'set.acct.del.nocloud': 'Cloud is not connected, so this cannot be done here \u2014 please use e-mail instead (see section 10 of the privacy policy).',
    'set.acct.del.confirm': 'Delete this site\u2019s cloud data?\\n\\nDeleted: the Phira binding, display name, visit counter.\\nNot deleted: the login e-mail itself (needs a separate request), and any scores you contributed (those are anonymous and are not tied to your account).\\n\\nThis cannot be undone.',
    'set.acct.del.done': 'Site data deleted \u2713 signing out\u2026',
    'set.acct.del.fail': 'Delete failed: {e} \u2014 you can use e-mail instead (see section 10 of the privacy policy).',"""
assert en_anchor in s
s = s.replace(en_anchor, en_add, 1)
wr(p, s); print('✓ i18n/settings.js：注销文案（中英各 8 条）')
