# -*- coding: utf-8 -*-
"""结果卡重排（评审 P2 第 1 项）：双标度并列、区间轴、PS 迷你条、分组列表、提示框。
一次性脚本，跑完可删（改动已在文件里）。"""
import io

# ═══ ① i18n：把长段落 vague 拆成「引导句 + 三条短列表」═══
f = 'public/js/i18n/app.js'
s = io.open(f, encoding='utf-8').read()

old_zh = """    'app.res.vague':
      '\u26a0 \u8fd9 {n} \u5f20\u53c2\u7167\u8c31\u7684\u5b9a\u6570\u6a2a\u8de8 <b>{lo}\u2013{hi}</b>\uff08\u76f8\u5dee {span}\uff09\u2014\u2014\u8bf4\u660e\u8fd9\u5f20\u8c31\u7684\u7ed3\u6784'
      + '\u5728{desc}\u91cc<b>\u6ca1\u6709\u7d27\u5bc6\u5bf9\u5e94\u7269</b>\uff0c\u4e2d\u70b9\u53ea\u80fd\u5f53\u7c97\u7565\u53c2\u7167\u3002<br>'
      + '<b>\u8fd9\u79cd\u65f6\u5019\u8be5\u770b\u4ec0\u4e48\uff1a</b>'
      + '\u2460 \u770b\u5b83\u66f4\u9760\u8fd1\u8303\u56f4\u7684\u4e24\u7aef\u54ea\u4e00\u5934\uff08\u8bf4\u660e\u5b83\u504f\u5411\u540c\u7c7b\u91cc\u504f\u96be\u8fd8\u662f\u504f\u6613\u7684\u90a3\u6279\uff09\uff1b'
      + '\u2461 \u70b9\u5f00\u4e0b\u9762\u7684\u300c\u6700\u76f8\u8fd1 5 \u5f20\u300d\u81ea\u5df1\u6838\u5bf9\u540d\u5b57\u2014\u2014\u5982\u679c\u4f60\u89c9\u5f97\u54ea\u5f20\u6839\u672c\u4e0d\u50cf\uff0c\u90a3\u8fd9\u4e2a\u6570\u5c31\u4e0d\u8be5\u4fe1\uff1b'
      + '\u2462 \u6362\u4e00\u4e2a\u6807\u5ea6\u770b\u53e6\u4e00\u680f\uff08\u793e\u533a\u5171\u8bc6\u4e0e\u5b98\u8c31\u6807\u5ea6\u5f80\u5f80\u4e00\u5bbd\u4e00\u7a84\uff09\u3002',"""
new_zh = """    /* ⚠ 拆成「引导句 + 三条短列表」：原来是一整段 200 字、里面 ①②③ 三个加粗，
       读起来像一段免责声明。评审：改浅琥珀底的提示框 + 短列表。
       ⚠ 加粗预算：每段至多一处（引导句），列表条目不再加粗。 */
    'app.res.vague.lead':
      '\u8fd9 {n} \u5f20\u53c2\u7167\u8c31\u7684\u5b9a\u6570\u6a2a\u8de8 {lo}\u2013{hi}\uff08\u76f8\u5dee {span}\uff09\u2014\u2014'
      + '\u5728{desc}\u91cc<b>\u6ca1\u6709\u7d27\u5bc6\u5bf9\u5e94\u7269</b>\uff0c\u4e2d\u70b9\u53ea\u80fd\u5f53\u7c97\u7565\u53c2\u7167\u3002',
    'app.res.vague.see': '\u8fd9\u79cd\u65f6\u5019\u8be5\u770b\u4ec0\u4e48\uff1a',
    'app.res.vague.i1': '\u770b\u5b83\u66f4\u9760\u8fd1\u8303\u56f4\u7684\u54ea\u4e00\u7aef\uff08\u504f\u96be\u8fd8\u662f\u504f\u6613\uff09\uff1b',
    'app.res.vague.i2': '\u70b9\u5f00\u4e0b\u9762\u300c\u6700\u76f8\u8fd1 5 \u5f20\u300d\u6838\u5bf9\u540d\u5b57 \u2014\u2014 \u89c9\u5f97\u54ea\u5f20\u4e0d\u50cf\uff0c\u8fd9\u4e2a\u6570\u5c31\u4e0d\u8be5\u4fe1\uff1b',
    'app.res.vague.i3': '\u6362\u53e6\u4e00\u6807\u5ea6\u770b\u53e6\u4e00\u680f\uff08\u793e\u533a\u4e0e\u5b98\u8c31\u5f80\u5f80\u4e00\u5bbd\u4e00\u7a84\uff09\u3002',

    'app.res.poolnote': '{desc} {pool} \u5f20\u91cc\u6700\u76f8\u8fd1\u7684 {n} \u5f20',"""
assert old_zh in s, 'app.js zh vague 没匹配'
s = s.replace(old_zh, new_zh, 1)

old_en = """    'app.res.vague':
      '⚠ These {n} reference charts span <b>{lo}–{hi}</b> (a gap of {span}) — meaning this chart has '
      + '<b>no close match</b> in {desc}, so the midpoint is only a rough guide.<br>'
      + '<b>What to look at instead:</b> '
      + '(1) which end of the range it leans toward (whether it is on the harder or easier side of its kind); '
      + '(2) open the "5 closest" table below and check the names yourself — if any of them looks nothing like it, '
      + 'don’t trust the number; '
      + '(3) read the other column for the other scale (community consensus and the official scale usually run '
      + 'one wide and one narrow).',"""
assert old_en in s, 'app.js en vague 没匹配'
s = s.replace(old_en, new_en, 1)


assert old_en in s, 'app.js en vague 没匹配'
s = s.replace(old_en, new_en, 1)
io.open(f, 'w', encoding='utf-8', newline='').write(s)
print('i18n: vague 拆成 5 条 + 新增 poolnote')

# ═══ ② 结果卡模板重排 ═══
f = 'public/app.html'
a = io.open(f, encoding='utf-8').read()

start = a.index("  return '<div class=\"card\">'")
end = a.index("'</div>';\n}", start) + len("'</div>';\n}")
old_tmpl = a[start:end]

new_tmpl = """  return '<div class="card">'
    +'<h2>'+esc(r.name)+'</h2>'
    +'<div class="sub">'+esc(r.sub||"")+'</div>'

    /* ── 双标度**并列**：主结果高亮 ──
       产品核心是"两个数字"，那就把两个数字摆成两张并排的卡，而不是
       一个巨大、另一个缩在灰条里。 */
    +'<div class="scales">'
      +'<div class="scalecard'+(isCom?' on':'')+'">'
        +'<div class="lbl">'+esc(basisName)+'</div>'
        +'<div class="v">'+f1(kn.ref)+'</div>'
        +'<div class="note">'+t("app.res.poolnote",{desc:basisDesc,pool:poolN,n:(kn.n20)||0})+'</div>'
      +'</div>'
      +(knOff&&knOff.ref!=null
        ?'<div class="scalecard">'
          +'<div class="lbl">'+esc(t("app.res.basis.off"))+'</div>'
          +'<div class="v">'+f1(knOff.ref)+'</div>'
          +'<div class="note">'+esc(t("app.res.off.note",{n:REF_OFFICIAL?REF_OFFICIAL.length:0}))
          +(gap!=null?' '+esc(gap>=0
              ? t("app.res.off.hi",{d:Math.abs(gap).toFixed(1)})
              : t("app.res.off.lo",{d:Math.abs(gap).toFixed(1)})):'')+'</div></div>':'')
    +'</div>'

    /* ── 区间轴：两端 + 两个标度画在同一条轴上 ──
       原来只标 0/10/20，两个标度一个在灰条里一个没有 —— 读者根本看不出
       "社区共识和官谱标度差多少"。现在：轴就是**不确定范围**（lo..hi），
       两端标出数值，两个标度各一根标记 —— 差距一眼可见。 */
    +(kn.lo!=null&&kn.hi!=null
      ?'<div class="meter" style="--min:'+kn.lo.toFixed(2)+';--max:'+kn.hi.toFixed(2)
        +';--a:'+kn.ref.toFixed(2)+(knOff&&knOff.ref!=null?';--b:'+knOff.ref.toFixed(2):'')+'">'
        +'<span class="meter__range"></span>'
        +'<span class="meter__pin meter__pin--a"><span class="meter__label">'
          +(isCom?esc(basisName):esc(t("app.res.basis.com")))+' '+f1(kn.ref)+'</span></span>'
        +(knOff&&knOff.ref!=null
          ?'<span class="meter__pin meter__pin--b"><span class="meter__label">'
            +(isCom?esc(t("app.res.basis.off")):'')+' '+f1(knOff.ref)+'</span></span>':'')
        +'<span class="meter__tick" style="--at:0">'+f1(kn.lo)+'</span>'
        +'<span class="meter__tick" style="--at:100">'+f1(kn.hi)+'</span>'
      +'</div>'
      /* 换个标度看另一栏 */
      +(vague?'<div class="callout callout--warn">'
        +'<span class="callout__lead">'+t("app.res.vague.see")+'</span>'
        +'<ul><li>'+t("app.res.vague.i1")+'</li><li>'+t("app.res.vague.i2")
        +'</li><li>'+t("app.res.vague.i3")+'</li></ul>'
        +'<div class="callout__lead" style="margin-top:.6em">'
        +t("app.res.vague.lead",{n:(kn.n20)||0,lo:f1(kn.lo),hi:f1(kn.hi),
          span:span.toFixed(1),desc:basisDesc})+'</div></div>':'')
      :'')

    /* ── PS 四个维度：四根迷你条（之前算了但没渲染，是一行文字） ── */
    +'<div class="bars">'+bars+'</div>'

    /* ── 明细：13 行长表 → 分组的两列定义列表，页面高度省一半 ── */
    +'<div class="kv-groups">'+GROUPS_ROW.map(function(sec){
      return '<section class="kv"><h4>'+esc(sec.label)+'</h4><dl>'
        +sec.rows.map(function(x){ return '<div class="row"><dt>'+esc(x[0])
          +'</dt><dd>'+esc(x[1])+'</dd></div>'; }).join('')
        +'</dl></section>'; }).join('')+'</div>'

    +'<div class="srow"><span class="slabel">'+esc(t("app.res.share.label"))+'</span>'
      +'<button class="sbtn" type="button" data-share="wide" data-i="'+idx+'">'
      +esc(t("app.res.share.wide"))+'</button>'
      +'<button class="sbtn" type="button" data-share="tall" data-i="'+idx+'">'
      +esc(t("app.res.share.tall"))+'</button></div>'
    +'<table style="margin-top:8px"><tr><th>'+esc(t("app.res.near",{desc:basisDesc}))+'</th>'
    +'<th>'+esc(t("c.tier"))+'</th><th>'+esc(t("app.res.th.const"))+'</th></tr>'+nearRows+'</table>'
    +'<div class="playstat" id="playstat-'+STATE.sel+'" style="display:none"></div>'
    +'<div class="punch'+(OPTN()?"":" off")+'" id="punch-'+STATE.sel+'" data-i="'+STATE.sel+'">'
      +'<div class="ptitle">'+esc(t("app.res.punch.title"))
      +'<span style="font-weight:400;color:var(--fg3)">'+esc(t("app.res.punch.opt"))+'</span></div>'
      +'<div class="pdesc">'+t("app.res.punch.desc")+'</div>'
      +'<div class="prow"><input id="pacc" inputmode="decimal" autocomplete="off"'
      +' placeholder="'+esc(t("app.res.punch.ph"))+'" maxlength="9" value="'+esc(r._acc||"")+'">'
      +'<button id="pgo" type="button">'+esc(t("app.res.punch.go"))+'</button></div>'
      +'<label class="popt"><input type="checkbox" id="popt"'+(OPTN()?" checked":"")+'>'
      +'<span>'+t("app.res.punch.label")+'</span></label>'
      +'<div class="pmsg"></div></div>'
  +'</div>';"""

# 把旧的 ps / dualscale / scale / tick / psline 相关变量与新模板对齐
old_ps = ("  const psline = t(\"app.res.psline\",{ total:f1(ps.total), d:f2(ps.g.density),\n"
          "    p:f2(ps.g.pattern), c:f2(ps.g.coord), s:f2(ps.g.stamina) });\n")
if old_ps in a: a = a.replace(old_ps, '', 1)

old_u = ("""  const uSpan = t("app.res.u",{ basis:basisName, desc:basisDesc, pool:poolN, n:(kn.n20)||0 })
    + (kn.lo!=null ? '　·　'+t("app.res.u.span",{ lo:f1(kn.lo), hi:f1(kn.hi) }) : '');\n""")
if old_u in a: a = a.replace(old_u, '', 1)

a = a[:start] + new_tmpl + a[end:]
io.open(f, 'w', encoding='utf-8', newline='').write(a)
print('app.html: 结果卡模板已重排')

# ═══ ③ 明细表改成「分组」结构的数据 ═══
s = a
old_rows = """  const rows=[
"""
if old_rows in s:
    s = s.replace(old_rows, "  const ROWS_ALL=[\n", 1)
    io.open(f,'w',encoding='utf-8',newline='').write(a if False else s)
    print('rows 数组已改名 ROWS_ALL（下一步分组）')
