#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""改页面版本号：一处输入，全站同步。

【为什么要有这个工具】
  版本号散在四个地方，漏掉任何一处都会出问题：
    1. 每个 HTML 的 <meta name="app-version">
    2. 每个 HTML 的 <link ... ?v=>          —— 漏了：改了 CSS 用户看不到
    3. 所有 JS 模块 import 的 ?v=            —— 漏了：模块图分裂成两个实例
    4. package.json 的 version（无 V 前缀）
  人工改 9 个页面 + 26 处 import 一定会漏，所以做成一条命令。

【规矩】见 docs/ARCHITECTURE.md「版本策略」：
  V{a}.{b}.{c}.{d}
    {d}+1  小更新（纯前端效果，不碰后端）
    {c}+1  末位归零 —— UI 改动等（界面结构 / 交互逻辑）
    {b}+1  后两位归零 —— 后端 / 数据层改动（服务端、数据库、引擎、缓存）
    {a}    无规则，要动先问用户
  ⚠ 每次改版本号**之前必须先问用户**，不要自己判定落在哪一档。

用法：
  python tools/bump-version.py V0.10.0.0          # 直接指定
  python tools/bump-version.py --check            # 只校验当前是否处处一致
"""
import io, json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VER_RE = re.compile(r'^V\d+\.\d+\.\d+\.\d+$')


def current():
    meta = re.search(r'<meta name="app-version" content="([^"]+)">',
                     io.open(os.path.join(ROOT, 'public', 'index.html'), encoding='utf-8').read())
    return meta.group(1)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check = '--check' in sys.argv
    old = current()

    if check:
        bad = []
        for p in sorted(glob.glob(os.path.join(ROOT, 'public', '**', '*.html'), recursive=True)) \
                + sorted(glob.glob(os.path.join(ROOT, 'public', '**', '*.js'), recursive=True)):
            s = io.open(p, encoding='utf-8').read()
            for m in re.finditer(r'(?:content="|\?v=)(V\d+\.\d+\.\d+\.\d+)', s):
                if m.group(1) != old:
                    bad.append('%s → %s' % (os.path.relpath(p, ROOT), m.group(1)))
        pkg = json.load(io.open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['version']
        if pkg != old[1:]:
            bad.append('package.json → ' + pkg)
        if bad:
            print('✗ 版本号不一致（当前 index.html 是 %s）:' % old)
            for b in bad:
                print('   ' + b)
            return 1
        print('✓ 版本号处处一致：%s（package.json: %s）' % (old, pkg))
        return 0

    if len(args) != 1:
        print('用法: python tools/bump-version.py V0.10.0.0   （或 --check）')
        return 2
    new = args[0].strip()
    if not VER_RE.match(new):
        print('✗ 版本号必须是四段：V0.9.2.0 这样的形式。两段/三段都不合规。')
        return 2
    if new == old:
        print('版本号没变（%s）。' % old)
        return 0

    n = 0
    for p in sorted(glob.glob(os.path.join(ROOT, 'public', '**', '*.html'), recursive=True)) \
            + sorted(glob.glob(os.path.join(ROOT, 'public', '**', '*.js'), recursive=True)):
        s = io.open(p, encoding='utf-8').read()
        s2 = s.replace('content="%s"' % old, 'content="%s"' % new).replace('?v=%s' % old, '?v=%s' % new)
        if s2 != s:
            io.open(p, 'w', encoding='utf-8', newline='').write(s2)
            n += 1
            print('  %-34s' % os.path.relpath(p, ROOT))

    pk = os.path.join(ROOT, 'package.json')
    s = io.open(pk, encoding='utf-8').read()
    s2 = s.replace('"version": "%s"' % old[1:], '"version": "%s"' % new[1:])
    if s2 != s:
        io.open(pk, 'w', encoding='utf-8', newline='').write(s2)
        n += 1
        print('  %-34s' % 'package.json')

    print('\n%s → %s，共改动 %d 个文件（含 %s 里的模块 ?v=）' % (old, new, n, 'public/**'))
    print('⚠ 改完请跑：node tools/smoke-page.mjs <base> —— 它有一条断言守着「所有 ?v= 与 meta 同串」。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
