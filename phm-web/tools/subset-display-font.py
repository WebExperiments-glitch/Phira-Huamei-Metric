#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把思源宋体裁成「标题专用」子集（woff2）。

【为什么是标题专用，而不是全站换字体】
  中文衬线字体完整版 10MB+，全站换等于把首屏拖死。
  但这个站里**只有标题用衬线**：正文保持系统黑体（各平台都好看、且零下载）。
  标题用到的字就那么几百个 —— 裁完只有几十 KB，代价可以忽略。

【两步走，别跳过第一步】
  1) node tools/collect-display-chars.mjs <base>
     —— 从**渲染后的页面**采集 h1/h2/h3/.big/.num 等元素里的字。
        不能靠 grep 源码：很多标题是 JS 用 t() 填的，源码里搜不到。
  2) python tools/subset-display-font.py
     —— 用上一步的字符集裁字体。

【什么时候要重跑】
  改了标题文案（新增汉字）、加了新页面、或换了字重 —— 都要重跑两步。
  漏了不会崩：没覆盖到的字会**掉回正文黑体**（fallback 栈接着），
  只是那一行标题会显得不一致。

【授权】Noto Serif SC 是 SIL OFL 1.1，与本站的 GPL-3.0 兼容，可随站分发。
"""
import io, os, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, 'public', 'fonts')
CHARS = os.path.join(ROOT, 'tools', 'display-chars.txt')
SRC = os.path.join(FONTS, '.cache-NotoSerifSC-SemiBold.otf')
OUT = os.path.join(FONTS, 'display-serif.woff2')
URL = ('https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/'
       'Serif/SubsetOTF/SC/NotoSerifSC-SemiBold.otf')

if not os.path.exists(CHARS):
    print('✗ 缺少 ' + CHARS)
    print('  先跑：node tools/collect-display-chars.mjs <base>')
    sys.exit(2)

if not os.path.exists(SRC):
    print('下载思源宋体 SemiBold（约 11MB，只下一次）…')
    os.makedirs(FONTS, exist_ok=True)
    urllib.request.urlretrieve(URL, SRC)
print('源字体：%.1f MB' % (os.path.getsize(SRC) / 1048576))

n_chars = len(io.open(CHARS, encoding='utf-8').read())
print('字符集：%d 个' % n_chars)

cmd = [sys.executable, '-m', 'fontTools.subset', SRC,
       '--text-file=' + CHARS,
       '--flavor=woff2',
       '--output-file=' + OUT,
       '--layout-features=*',          # 子集很小，特性全留（含 locl，中日字形区分要用）
       '--no-hinting',                 # 屏显字体不需要 hinting，去掉能小一截
       '--name-IDs=1,2,3,4,6',         # 只留必要命名记录
       '--drop-tables+=DSIG']
subprocess.run(cmd, check=True)

print('\n✓ 产出：public/fonts/display-serif.woff2  %.0f KB（源字体的 %.1f%%）'
      % (os.path.getsize(OUT) / 1024, os.path.getsize(OUT) / os.path.getsize(SRC) * 100))
print('  ⚠ .cache-*.otf 是中间产物，已 gitignore；不要提交它。')
