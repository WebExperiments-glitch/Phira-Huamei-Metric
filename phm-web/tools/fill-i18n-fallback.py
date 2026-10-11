#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 data-i18n* 元素的中文兜底填回 HTML。

【为什么必须做】
  上一轮做 i18n 时，一部分页面把静态文案**清空**成了 <h2 data-i18n="ch.title"></h2>，
  只等 applyStatic() 把字填进去。结果是：**只要模块链有一个环节失败，
  整页就没有文字** —— 不是"样式坏了"，是"内容根本没渲染"。
  真发生过：浏览器缓存里还是旧版 ui.js（旧版没有 applyStatic 这个导出），
  新页面 import 失败 → 谱师页只剩两张空卡片。
  静态 HTML 的中文原文就是**天然的无 JS 兜底**，不该删。
  （privacy / terms / index / 404 当时保留了原文，做对了；这里把其余页面补齐。）

【语义要和 applyStatic 完全一致，否则 JS 一跑会看到跳变】
  data-i18n        → textContent  → 填**转义后**的文本
  data-i18n-html   → innerHTML    → 原样填
  data-i18n-ph     → setAttribute('placeholder') → 元素没有 placeholder 时补上
  data-i18n-title  → setAttribute('title')       → 元素没有 title 时补上

用法：python tools/fill-i18n-fallback.py [--check]
"""
import io, json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZH = json.load(io.open('/tmp/zh-dict.json', encoding='utf-8'))
CHECK = '--check' in sys.argv


def esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


# 只匹配「开标签 → 紧跟闭标签」且中间只有空白的情况：那才是被清空的元素。
EMPTY = re.compile(
    r'<(?P<tag>[a-zA-Z][a-zA-Z0-9]*)(?P<attrs>[^>]*?)'
    r'data-i18n(?P<kind>-html)?="(?P<key>[^"]+)"(?P<attrs2>[^>]*?)>'
    r'(?P<inner>\s*)</(?P=tag)>')


def fill(m):
    tag, key, kind = m.group('tag'), m.group('key'), m.group('kind')
    if key not in ZH:
        print('  !! 字典里没有这个词条: ' + key)
        return m.group(0)
    val = ZH[key]
    if re.search(r'\{\w+\}', val):
        print('  !! 词条含模板变量，不该用于 data-i18n: ' + key)
        return m.group(0)
    body = val if kind else esc(val)
    attrs = m.group('attrs') + m.group('attrs2')
    return '<%s%sdata-i18n%s="%s"%s>%s</%s>' % (
        tag, attrs, kind or '', key, '', body, tag)


# 属性型：元素本身没有 placeholder / title 时补一个中文兜底
ATTR = re.compile(r'<(?P<tag>[a-zA-Z][a-zA-Z0-9]*)(?P<attrs>[^>]*?)'
                  r'data-i18n-(?P<which>ph|title)="(?P<key>[^"]+)"(?P<attrs2>[^>]*?)>')


def add_attr(m):
    which, key = m.group('which'), m.group('key')
    if key not in ZH:
        return m.group(0)
    attr = 'placeholder' if which == 'ph' else 'title'
    if re.search(r'\b' + attr + r'=', m.group('attrs') + m.group('attrs2')):
        return m.group(0)          # 已经有兜底，别覆盖
    return '<%s%sdata-i18n-%s="%s"%s %s="%s">' % (
        m.group('tag'), m.group('attrs'), which, key, m.group('attrs2'),
        attr, esc(ZH[key]))


total_fill = total_attr = 0
for p in sorted(glob.glob(os.path.join(ROOT, 'public', '*.html'))):
    s = io.open(p, encoding='utf-8').read()
    s2, n1 = EMPTY.subn(fill, s)
    s2, n2 = ATTR.subn(add_attr, s2)
    if n1 or n2:
        total_fill += n1
        total_attr += n2
        rel = os.path.relpath(p, ROOT)
        print('  %-20s 补文本 %-3d 补属性 %-3d' % (rel, n1, n2))
        if not CHECK:
            io.open(p, 'w', encoding='utf-8', newline='').write(s2)

print('\n合计：补文本兜底 %d 处，补属性兜底 %d 处%s'
      % (total_fill, total_attr, '（--check 模式，未落盘）' if CHECK else ''))
