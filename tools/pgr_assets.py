#!/usr/bin/env python3
"""
Phigros 官谱「资源」提取器 —— 从 phigros.apk 里取出某一首曲子的
音乐 / 曲绘(低清) / 谱面，并打包成 Phira 可读的 .pez 谱面包。

与 tools/extract_pgr.py 的分工：
  extract_pgr.py   全量扫谱面 JSON（分析用，不碰音频图片）
  pgr_assets.py    单曲按需取「音频 + 图片 + 谱面」，产出可游玩的 .pez

依赖：UnityPy（装在工作区 venv 里）

用法：
  python tools/pgr_assets.py --apk _research/pgr/phigros.apk \
        --manifest _research/pgr/pgr_chart_manifest.json \
        --song 重生.姜米條 --levels EZ HD IN --out 谱面数据包/重生

⚠ 谱面包扩展名默认 **zip**，不是 pez —— iOS 的 Files App 按扩展名判类型，
  `.pez` 没有注册 UTI，选中它根本不会出现「用 Phira 打开」。内容完全一样
  （就是个 zip），Phira 的 ZipFileSystem 也不看扩展名。
⚠ zip 内部**不要建顶层目录条目**：`prpr/src/fs.rs:130` 会在「恰好一个顶层
  目录」时把它当 root 前缀，反而找不到 info.yml。全平铺才对。
"""
import argparse
import io
import json
import os
import struct
import sys
import zipfile

from UnityPy import Environment
from UnityPy.enums import ClassIDType

# 这三类都要
WANTED = (ClassIDType.TextAsset, ClassIDType.AudioClip,
          ClassIDType.Sprite, ClassIDType.Texture2D)


def load_manifest(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pick_bundle(manifest, logical_name):
    """logical_name 形如 '重生.姜米條.0/music.wav' → bundle 哈希"""
    return manifest.get(logical_name)


def extract_bundle_song(apk_zip, bundle_hash, song_prefix):
    """
    打开一个 bundle，返回：
      {('TextAsset', 'Chart_HD'): bytes,
       ('AudioClip',  'music'):   bytes(原始 m_AudioData),
       ('Texture2D',  'IllustrationLowRes'): Texture2D 对象}
    bundle 里 m_Name 是 'music' / 'Chart_HD' / 'IllustrationLowRes'（不带扩展名）。
    """
    path = "assets/aa/Android/%s" % (
        bundle_hash if bundle_hash.endswith(".bundle") else bundle_hash + ".bundle")
    env = Environment()
    env.load_file(io.BytesIO(apk_zip.read(path)))
    out = {}
    for o in env.objects:
        if o.type not in WANTED:
            continue
        try:
            d = o.read()
        except Exception as e:                      # noqa: BLE001
            print("  [warn] %s read fail: %s" % (o.type.name, e))
            continue
        name = getattr(d, "m_Name", None) or "<unnamed>"
        if o.type == ClassIDType.TextAsset:
            data = d.script
            if isinstance(data, memoryview):
                data = data.tobytes()
            elif isinstance(data, str):
                data = data.encode("utf-8")
            out[("TextAsset", name)] = data
        elif o.type == ClassIDType.AudioClip:
            data = d.m_AudioData
            if isinstance(data, memoryview):
                data = data.tobytes()
            out[("AudioClip", name)] = (bytes(data), d)
        else:                                        # Sprite / Texture2D
            out[(o.type.name, name)] = d
    return out


def audio_to_wav(clip):
    """AudioClip → RIFF WAV bytes。

    UnityPy 1.10 的 `AudioClip.samples` 会自己走 FSB5 → PCM 解码，
    返回 {原名: wav_bytes}；比手撸 FSB5 稳得多。
    """
    smp = clip.samples
    if isinstance(smp, dict) and smp:
        blob = next(iter(smp.values()))
        return bytes(blob)
    raise RuntimeError("AudioClip.samples 为空，无法解码")


def transcode(src, dst_codec="ogg", quality="5"):
    """用 ffmpeg 把 wav 压成 ogg；失败就原样返回 wav"""
    import shutil
    import subprocess
    if not shutil.which("ffmpeg"):
        print("  [warn] 无 ffmpeg，保留 wav")
        return src
    dst = os.path.splitext(src)[0] + "." + dst_codec
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
           "-c:a", "libvorbis", "-q:a", quality, dst]
    if dst_codec == "mp3":
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
               "-c:a", "libmp3lame", "-q:a", quality, dst]
    try:
        subprocess.run(cmd, check=True)
        if os.path.getsize(dst) > 0:
            os.remove(src)
            return dst
    except Exception as e:                           # noqa: BLE001
        print("  [warn] ffmpeg 转码失败，保留 wav: %s" % e)
    return src


def write_png(texture2d, dst):
    """Texture2D → png，优先用 UnityPy 自己的 image 接口"""
    img = texture2d.image
    if img is None:
        raise RuntimeError("Texture2D 无 image（可能未解压）")
    img.save(dst, "png")


def build_pez(pez_path, info_fields, files):
    """files: [(磁盘路径, 包内名)]"""
    with zipfile.ZipFile(pez_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("info.yml", info_fields)
        for src, arc in files:
            z.write(src, arc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--song", required=True, help="manifest 前缀，如 重生.姜米條")
    ap.add_argument("--levels", nargs="*", default=["EZ", "HD", "IN"])
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--codec", default="ogg", choices=["ogg", "mp3", "wav"],
                    help="音乐编码（默认 ogg）")
    ap.add_argument("--ext", default="zip", choices=["zip", "pez"],
                    help="谱面包扩展名。⚠ iOS 上必须用 zip —— "
                         "Files App 按扩展名判类型，.pez 没有注册 UTI，"
                         "根本不会出现「用 Phira 打开」的选项。")
    ap.add_argument("--no-pez", action="store_true", help="只落原始文件，不打 pez")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest)
    prefix = args.song + ".0"
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    apk = os.path.abspath(args.apk)
    print("[init] APK %s (%.2f GB)" % (apk, os.path.getsize(apk) / 1073741824))

    with zipfile.ZipFile(apk) as zf:
        # ---------- 谱面 ----------
        charts = {}
        for lv in args.levels:
            logical = "%s/Chart_%s.json" % (prefix, lv)
            bh = pick_bundle(manifest, logical)
            if not bh:
                print("  [miss] %s" % logical)
                continue
            items = extract_bundle_song(zf, bh, prefix)
            key = ("TextAsset", "Chart_%s" % lv)
            if key not in items:
                print("  [miss] bundle %s 内无 %s" % (bh, key[1]))
                continue
            dst = os.path.join(out, "%s.json" % lv)
            with open(dst, "wb") as f:
                f.write(items[key])
            charts[lv] = dst
            print("  [ok] %s → %s (%d KB)" % (logical, dst,
                                              len(items[key]) // 1024))

        # ---------- 音乐 ----------
        music_path = None
        mh = pick_bundle(manifest, "%s/music.wav" % prefix)
        if mh:
            items = extract_bundle_song(zf, mh, prefix)
            clip = next((v[1] for k, v in items.items()
                         if k[0] == "AudioClip"), None)
            if clip is not None:
                wav = audio_to_wav(clip)
                raw = os.path.join(out, "music.wav")
                with open(raw, "wb") as f:
                    f.write(wav)
                print("  [ok] music → %s (%d KB, wav)"
                      % (raw, len(wav) // 1024))
                music_path = transcode(raw, args.codec)
                print("  [ok] music → %s (%d KB, %s)"
                      % (music_path, os.path.getsize(music_path) // 1024,
                         os.path.splitext(music_path)[1][1:]))
        else:
            print("  [miss] music")

        # ---------- 曲绘 ----------
        pic_path = None
        for logical, tag in (("%s/IllustrationLowRes.jpg" % prefix, "IllustrationLowRes"),
                             ("%s/Illustration.jpg" % prefix, "Illustration")):
            ph = pick_bundle(manifest, logical)
            if not ph:
                continue
            items = extract_bundle_song(zf, ph, prefix)
            tex = items.get(("Texture2D", tag))
            if tex is None:
                continue
            pic_path = os.path.join(out, "Illustration.png")
            write_png(tex, pic_path)
            print("  [ok] %s → %s" % (logical, pic_path))
            break
        if pic_path is None:
            print("  [miss] illustration")

    # ---------- 组装 pez（一个难度一个包，因为定数/谱师不同） ----------
    if not args.no_pez and music_path:
        info = info_from_manifest(args.manifest, args.song)
        m_ext = os.path.splitext(music_path)[1]
        for lv in args.levels:
            if lv not in charts:
                continue
            files = [(charts[lv], "chart.json"),
                     (music_path, "music%s" % m_ext)]
            if pic_path:
                files.append((pic_path, "Illustration.png"))
            yml = make_info_yml(info, lv, music_path, pic_path)
            pez_path = os.path.join(out, "%s [%s].%s" % (args.song, lv, args.ext))
            build_pez(pez_path, yml, files)
            print("[pez] %s" % pez_path)
    return 0


def info_from_manifest(manifest_path, song):
    """从 info.tsv 取曲名/曲师/谱师/定数"""
    base = os.path.dirname(os.path.abspath(manifest_path))
    res = {"name": song, "composer": "", "illustrator": "", "charters": [], "diff": []}
    info_tsv = os.path.join(base, "info", "info.tsv")
    diff_tsv = os.path.join(base, "info", "difficulty.tsv")
    if os.path.exists(info_tsv):
        with open(info_tsv, encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if p and p[0] == song:
                    res["name"], res["composer"], res["illustrator"] = p[1], p[2], p[3]
                    res["charters"] = p[4:]
                    break
    if os.path.exists(diff_tsv):
        with open(diff_tsv, encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if p and p[0] == song:
                    res["diff"] = p[1:]
                    break
    return res


LEVEL_ENUM = {"EZ": "EZ", "HD": "HD", "IN": "IN", "AT": "AT"}


def make_info_yml(info, lv, music_path, pic_path):
    """产出 Phira 的 info.yml（prpr/src/info.rs 的结构），单难度"""
    idx = {"EZ": 0, "HD": 1, "IN": 2, "AT": 3}.get(lv, 0)
    diff = info["diff"][idx] if idx < len(info["diff"]) else ""
    charter = info["charters"][idx] if idx < len(info["charters"]) else ""
    lines = [
        "id: 0",
        "uploader: 0",
        "name: %s" % info["name"],
        "difficulty: %s" % (diff or "0"),
        "level: %s  Lv.%s" % (LEVEL_ENUM.get(lv, lv), diff),
        "charter: %s" % charter,
        "composer: %s" % info["composer"],
        "illustrator: %s" % info["illustrator"],
        "chart: chart.json",
        "format: pgr",
        "music: music%s" % os.path.splitext(music_path)[1],
        "illustration: %s" % ("Illustration.png" if pic_path else "null"),
        "unlockVideo: null",
        "previewStart: 0.0",
        "previewEnd: 0.0",
        "aspectRatio: 1.7777778",
        "backgroundDim: 0.6",
        "lineLength: 6.0",
        "offset: 0.0",
        "tip: null",
        "tags: []",
        "intro: ''",
        "holdPartialCover: false",
        "noteUniformScale: false",
        "forceAspectRatio: false",
        "useRpe170Speed: null",
        "useAttachUiFix: true",
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
