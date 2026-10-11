#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给所有 JS 模块 import 说明符加上版本号（`?v=<页面版本>`）。

【为什么必须加】
  模块之间一直是用**不带查询串**的固定 URL 互相 import 的（`./ui.js`），
  而 server.mjs 对不带 `?v=` 的 js 只发 no-cache、不长缓存 —— 看起来没问题，
  但它挡不住**已经缓存过旧副本**的浏览器：
  早先有一版 server 对不带 `?v=` 的 js 也发了 max-age=604800，那批副本
  在用户机器上会躺满 7 天，期间不会去协商。
  于是出现这种情况（真实发生过）：
    · 浏览器手里是旧版 ui.js（没有 applyStatic 这个导出）
    · 页面已经换成新版 charter.html，import { applyStatic } from '/js/ui.js'
    · ES 模块在"实例化"阶段就报错 → **整段 module 脚本不执行** → 整页空白
  给说明符带上版本号后，升版本 = 换 URL = 旧副本自动绕过。

【为什么全都要带同一个版本号】
  ES 模块按 **URL 字符串**去重。同一个文件用两种 URL
  （`/js/i18n.js` 与 `/js/i18n.js?v=X`）会被当成**两个模块**，两套状态分裂 ——
  这个坑真踩过（设置页切语言，ui.js 里的导航不跟着变）。
  所以规矩是：**每一个 import 说明符都带 `?v=`，且串值完全一致**。
  tools/smoke-page.mjs 有断言守着一致性。

用法：python tools/version-module-imports.py
"""
import io, json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VER = 'V' + json.load(io.open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['version']

# 静态 import/export ... from '<spec>'，spec 以 .js 结尾且还没带 ?v=
PAT = re.compile(r"""(from\s+)(['"])((?:\.{1,2}/|/js/)[^'"]*?\.js)(\2)""")


def add(m):
    spec = m.group(3)
    if '?v=' in spec:
        return m.group(0)
    return '%s%s%s?v=%s%s' % (m.group(1), m.group(2), spec, VER, m.group(4))


files = sorted(glob.glob(os.path.join(ROOT, 'public', '*.html'))
               + glob.glob(os.path.join(ROOT, 'public', 'js', '*.js'))
               + glob.glob(os.path.join(ROOT, 'public', 'js', 'i18n', '*.js')))
total = 0
for p in files:
    s = io.open(p, encoding='utf-8').read()
    s2, n = PAT.subn(add, s)
    if n:
        total += n
        print('  %-28s +%d' % (os.path.relpath(p, ROOT), n))
        io.open(p, 'w', encoding='utf-8', newline='').write(s2)
print('\n合计 %d 处 import 已带版本号 ?v=%s' % (total, VER))
