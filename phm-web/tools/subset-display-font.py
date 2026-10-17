#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把中文字体裁成「标题专用」子集（woff2）。

【为什么是标题专用，而不是全站换字体】
  中文标题字体完整版 10–20MB（思源宋体 11.2MB、霞鹜文楷 15.6MB），全站换等于把
  首屏拖死。但这个站里**只有标题用标题字体**：正文保持系统黑体
  （各平台都好看、且零下载）。标题用到的字就那么几百个 ——
  裁完只有几十 KB，代价可以忽略。

【现在做两套】
  serif = 思源宋体 SemiBold  → public/fonts/display-serif.woff2
  kai   = 霞鹜文楷 Regular   → public/fonts/display-kai.woff2
  两套共用**同一份字符集**（都是标题用字），所以一次跑完最省事。
  加第三套：往 FACES 里加一条即可，其余不用动。

【两步走，别跳过第一步】
  1) node tools/collect-display-chars.mjs <base>
     —— 从**渲染后的页面**采集 h1/h2/h3/.brand/.big 等元素里的字。
        不能靠 grep 源码：很多标题是 JS 用 t() 填的，源码里搜不到。
  2) python tools/subset-display-font.py            # 全部
     python tools/subset-display-font.py kai        # 只重做其中一套

【什么时候要重跑】
  改了标题文案（新增汉字）、加了新页面、或换了字重 —— 都要重跑两步。
  漏了不会崩：没覆盖到的字会**掉回** CSS 栈里的下一个字体，只是那一行不一致。

【授权】两套都是 SIL OFL 1.1，与本站 GPL-3.0 兼容，可随站分发。
  · Noto Serif SC  © Google / Adobe
  · LXGW WenKai（霞鹜文楷）© LXGW，基于 Fontworks Klee One
"""
import io, os, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, 'public', 'fonts')
CHARS = os.path.join(ROOT, 'tools', 'display-chars.txt')

FACES = {
    'serif': {
        'src':  os.path.join(FONTS, '.cache-NotoSerifSC-SemiBold.otf'),
        'out':  os.path.join(FONTS, 'display-serif.woff2'),
        'url':  ('https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/'
                 'Serif/SubsetOTF/SC/NotoSerifSC-SemiBold.otf'),
        'name': '思源宋体 SemiBold',
        'note': '约 11MB，只下一次',
    },
    'kai': {
        'src':  os.path.join(FONTS, '.cache-LXGWWenKai-Regular.ttf'),
        'out':  os.path.join(FONTS, 'display-kai.woff2'),
        'url':  ('https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai@latest/'
                 'fonts/TTF/LXGWWenKai-Regular.ttf'),
        'name': '霞鹜文楷 Regular',
        'note': '约 15MB，只下一次',
    },
}

wanted = [a for a in sys.argv[1:] if not a.startswith('-')] or list(FACES)
unknown = [k for k in wanted if k not in FACES]
if unknown:
    print('✗ 不认识的字体名：%s（可选：%s）' % (', '.join(unknown), ', '.join(FACES)))
    sys.exit(2)

if not os.path.exists(CHARS):
    print('✗ 缺少 ' + CHARS)
    print('  先跑：node tools/collect-display-chars.mjs <base>')
    sys.exit(2)

chars = io.open(CHARS, encoding='utf-8').read()
# 去重再数 —— 采集器是按出现顺序追加的，重复字不占容量但会让人误判"要裁很多字"
n_chars = len(set(chars))
print('字符集：%d 个不同字符' % n_chars)
os.makedirs(FONTS, exist_ok=True)

failed = []
for key in wanted:
    f = FACES[key]
    print('\n── %s ──' % f['name'])
    if not os.path.exists(f['src']):
        print('  下载%s（%s）…' % (f['name'], f['note']))
        try:
            urllib.request.urlretrieve(f['url'], f['src'])
        except Exception as e:                     # 网络不通不该让另一套白跑
            print('  ✗ 下载失败：%s' % e)
            failed.append(key)
            continue
    print('  源字体：%.1f MB' % (os.path.getsize(f['src']) / 1048576))

    cmd = [sys.executable, '-m', 'fontTools.subset', f['src'],
           '--text-file=' + CHARS,
           '--flavor=woff2',
           '--output-file=' + f['out'],
           '--layout-features=*',      # 子集很小，特性全留（含 locl，中日字形区分要用）
           '--no-hinting',             # 屏显字体不需要 hinting，去掉能小一截
           '--name-IDs=1,2,3,4,6',     # 只留必要命名记录
           '--drop-tables+=DSIG']
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError:
        print('  ✗ 裁剪失败')
        failed.append(key)
        continue
    print('  ✓ %s  %.0f KB（源字体的 %.1f%%）'
          % (os.path.basename(f['out']),
             os.path.getsize(f['out']) / 1024,
             os.path.getsize(f['out']) / os.path.getsize(f['src']) * 100))

print('\n⚠ .cache-* 是中间产物，已 gitignore；不要提交它们。')
if failed:
    print('✗ 有 %d 套没做出来：%s' % (len(failed), ', '.join(failed)))
    sys.exit(1)
