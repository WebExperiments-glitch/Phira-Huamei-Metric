#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract-pgr-audio.py —— 从 Phigros APK 的 Unity bundle 里取出歌曲音频（ogg）

【为什么需要】
  谱面 JSON 用 tools/convert-pgr.mjs 能转成 Phira 的 RPE，
  但 .pez 里没有音源就只是个哑巴谱面；官方音源压在 APK 的 UnityFS bundle
  里，格式是 FSB5（内含 Vorbis 子流），不能当普通 ogg 直接拷。

【怎么做的】
  1. `_research/pgr/pgr_chart_manifest.json` 把 `X.Y.0/music.wav` 映射到一个
     bundle 文件名（如 `e7ad92545c24ab9fb10799bca0e064ef.bundle`）
  2. 从 APK 的 `assets/aa/Android/` 取出该 bundle
  3. UnityPy 读出 AudioClip，`fsb5.rebuild_sample()` 还原成 ogg 字节流

【依赖】UnityPy==1.10.18、fsb5
  ⚠ 本机有两个 Python：pip 装的是
    C:/Users/30500/.workbuddy/binaries/python/envs/default/Scripts/python.exe
  而 PATH 上的 `python` 是另一套（没装 UnityPy）。要用前者跑。

【用法】
  python tools/extract-pgr-audio.py "ClassMemories.AntistarfeatCtymax" out/audio
  可一次给多个前缀。
"""
import io
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APK = os.path.join(ROOT, "_research", "pgr", "phigros.apk")
MANIFEST = os.path.join(ROOT, "_research", "pgr", "pgr_chart_manifest.json")


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1
    out_dir = os.path.abspath(argv[-1])          # 后面会 chdir，先转绝对
    prefixes = argv[1:-1]
    os.makedirs(out_dir, exist_ok=True)

    manifest = json.load(io.open(MANIFEST, encoding="utf-8"))
    zf = zipfile.ZipFile(APK)

    # fsb5 解码 Vorbis 要 libvorbis.dll；它随 Phigros_Resource 一起在仓库里，
    # 不在系统 PATH 上。Python 3.8+ 必须显式声明 DLL 目录，否则报
    # LibraryNotFoundException: Could not load the library 'vorbis'。
    # ⚠ fsb5 的 load_lib() 只按 **当前工作目录** 找 `libvorbis.dll`
    #   （源码里写死 os.getcwd() + '/lib%s.dll'），add_dll_directory 对它无效。
    #   而 libvorbis.dll 随 Phigros_Resource 放在子目录里，所以必须 chdir 过去。
    dll_dir = os.path.join(ROOT, "_research", "Phigros_Resource-master")
    if os.path.isdir(dll_dir):
        os.chdir(dll_dir)

    import UnityPy
    from fsb5 import FSB5

    for prefix in prefixes:
        hits = [k for k in manifest if k.startswith(prefix) and k.endswith("/music.wav")]
        if not hits:
            print("✗ %s：manifest 里没有 music.wav" % prefix)
            continue
        key = hits[0]
        bundle_name = manifest[key]
        inner = "assets/aa/Android/" + bundle_name
        try:
            blob = zf.read(inner)
        except KeyError:
            print("✗ %s：APK 里没有 %s" % (prefix, inner))
            continue

        env = UnityPy.load(io.BytesIO(blob))
        got = False
        for obj in env.objects:
            if obj.type.name != "AudioClip":
                continue
            clip = obj.read()
            fsb = FSB5(clip.m_AudioData)
            ogg = fsb.rebuild_sample(fsb.samples[0])
            out_path = os.path.join(out_dir, prefix.split(".")[0] + ".ogg")
            io.open(out_path, "wb").write(ogg)
            print("✓ %s → %s（%.2f MB，%d 个采样流）"
                  % (prefix, out_path, len(ogg) / 1048576, len(fsb.samples)))
            got = True
            break
        if not got:
            print("✗ %s：bundle 里没找到 AudioClip" % prefix)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
