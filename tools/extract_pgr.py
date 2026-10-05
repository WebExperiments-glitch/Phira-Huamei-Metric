#!/usr/bin/env python3
"""
Phigros 官谱提取器（精简版）

基于 7aGiven/Phigros_Resource 的 resource.py 逻辑重写，
只提取我们需要的：官谱谱面 JSON + 定数，不提取音频/图片。

catalog.json 解析（Addressables）：
  m_KeyDataString   键表
  m_BucketDataString 桶表 → 每个桶给出一个 entry 索引
  m_EntryDataString  索引表 → 每项 28 字节，第 8/9 字节异或得 entry 位置

  key_type: 0=ASCII(1字节长度) 1=UTF16(1字节长度) 4=单字节整数

用法：
  python extract_pgr.py --apk phigros.apk --out . --charts
  python extract_pgr.py --apk phigros.apk --out . --difficulty-only
"""
import argparse
import base64
import json
import os
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor

from UnityPy import Environment
from UnityPy.enums import ClassIDType
from io import BytesIO


class ByteReader:
    """官方实现：小端 3 字节异或读 int"""

    def __init__(self, data):
        self.data = data
        self.position = 0

    def readInt(self):
        self.position += 4
        return (self.data[self.position - 4]
                ^ self.data[self.position - 3] << 8
                ^ self.data[self.position - 2] << 16)


def build_table(catalog_path, zf):
    """解析 catalog.json → [(key, bundle_name), ...]"""
    with zf.open(catalog_path) as f:
        data = json.load(f)

    key = base64.b64decode(data["m_KeyDataString"])
    bucket = base64.b64decode(data["m_BucketDataString"])
    entry = base64.b64decode(data["m_EntryDataString"])

    table = []
    reader = ByteReader(bucket)
    for _ in range(reader.readInt()):
        key_position = reader.readInt()
        key_type = key[key_position]
        key_position += 1
        if key_type == 0:
            length = key[key_position]
            key_position += 4
            key_value = key[key_position:key_position + length].decode()
        elif key_type == 1:
            length = key[key_position]
            key_position += 4
            key_value = key[key_position:key_position + length].decode("utf16")
        elif key_type == 4:
            key_value = key[key_position]
        else:
            continue

        entry_value = None
        for _i in range(reader.readInt()):
            entry_position = reader.readInt()
            ev = entry[4 + 28 * entry_position: 4 + 28 * entry_position + 28]
            entry_value = ev[8] ^ ev[9] << 8
        table.append([key_value, entry_value])

    # 解析 entry 间接引用
    for i in range(len(table)):
        if table[i][1] != 65535:
            table[i][1] = table[table[i][1]][0]

    # 只保留 Assets/Tracks/ 与 avatar.，并剥掉前缀
    out = []
    for i in range(len(table) - 1, -1, -1):
        k = table[i][0]
        if type(k) is int or k[:15] == "Assets/Tracks/#" or \
                (k[:14] != "Assets/Tracks/" and k[:7] != "avatar."):
            del table[i]
        elif k[:14] == "Assets/Tracks/":
            table[i][0] = k[14:]

    for i, (k, v) in enumerate(table):
        if isinstance(v, str) and "_" in v:
            table[i][1] = v.split("_", 1)[1]
    out = table
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True)
    ap.add_argument("--out", default=".")
    ap.add_argument("--charts", action="store_true", help="提取谱面 JSON")
    ap.add_argument("--difficulty-only", action="store_true", help="只提取定数相关")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    apkf = os.path.abspath(args.apk)
    out = os.path.abspath(args.out)
    chart_dir = os.path.join(out, "chart")
    os.makedirs(chart_dir, exist_ok=True)
    print(f"[init] APK {apkf} ({os.path.getsize(apkf)/1073741824:.2f} GB)")

    with zipfile.ZipFile(apkf) as zf:
        print("[step1] 解析 catalog.json ...")
        t0 = time.time()
        table = build_table("assets/aa/catalog.json", zf)
        print(f"       表项 {len(table)} 条，耗时 {time.time()-t0:.1f}s")

        # 只取谱面
        charts = [(k, v) for k, v in table
                  if k[-14:-7] == "/Chart_" and k[-5:] == ".json"]
        print(f"[step2] 找到谱面 {len(charts)} 条")

        # 统计
        songs = {}
        for k, _v in charts:
            # 形如  <song_id>.0/Chart_EZ.json
            base = k[:-14]
            lv = k[-7:-5]
            songs.setdefault(base, []).append(lv)
        print(f"       涉及歌曲 {len(songs)} 首")
        cnt = {}
        for b, lvs in songs.items():
            for l in lvs:
                cnt[l] = cnt.get(l, 0) + 1
        print(f"       难度分布: {cnt}")

        if not args.charts:
            # 只导出清单，供后续分析
            with open(os.path.join(out, "pgr_chart_manifest.json"), "w",
                      encoding="utf-8") as f:
                json.dump({k: v for k, v in table if isinstance(k, str)}, f,
                          ensure_ascii=False, indent=1)
            print(f"[done] 已导出清单 {len(table)} 条")
            return 0

        # 分组 bundle，减少重复打开
        by_bundle = {}
        for k, v in charts:
            by_bundle.setdefault(v, []).append(k)
        print(f"[step3] 需打开 {len(by_bundle)} 个 bundle")

        CLASSES = (ClassIDType.TextAsset,)
        n_ok = n_fail = 0
        t0 = time.time()
        done = 0

        def work(bundle_name):
            """UnityPy 1.10 中 env.files 的 key 是内部 pathID（如 '121620130626'），
            谱面文件名保存在 TextAsset.m_Name（如 'Chart_HD'）。
            因此遍历该 bundle 内所有 TextAsset，按 m_Name 匹配。"""
            global n_ok, n_fail
            fn = bundle_name if bundle_name.endswith(".bundle") else bundle_name + ".bundle"
            path = f"assets/aa/Android/{fn}"
            want = {}          # {TextAsset.m_Name: song_id}，m_Name 形如 'Chart_HD'
            for key in by_bundle[bundle_name]:
                want["Chart_" + key[-7:-5]] = key[:-14]
            try:
                with zf.open(path) as bf:
                    env = Environment()
                    env.load_file(BytesIO(bf.read()))
                    for _k, f in env.files.items():
                        for o in f.get_filtered_objects(CLASSES):
                            d = o.read()
                            name = getattr(d, "m_Name", None)
                            if name not in want:
                                continue
                            song = want[name]
                            data = d.script
                            if isinstance(data, memoryview):
                                data = data.tobytes()
                            elif isinstance(data, str):
                                data = data.encode("utf-8")
                            # m_Name 形如 Chart_HD → 难度取后两位
                            lv = name[-2:] if name.startswith("Chart_") else name
                            ddir = os.path.join(chart_dir, song)
                            os.makedirs(ddir, exist_ok=True)
                            with open(os.path.join(ddir, f"{lv}.json"), "wb") as fp:
                                fp.write(data)
                            n_ok += 1
            except Exception as e:
                n_fail += len(want)
                if n_fail <= 5:
                    print(f"  [bundle fail] {fn}: {type(e).__name__} {e}")

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for i, b in enumerate(by_bundle, 1):
                pool.submit(work, b)
                done += 1
                if done % 200 == 0 or done == len(by_bundle):
                    el = time.time() - t0
                    print(f"  [{done}/{len(by_bundle)}] ok={n_ok} fail={n_fail} "
                          f"| {el:.0f}s | {done/max(el,1e-9):.1f} bundle/s")

    print(f"[done] 提取谱面 {n_ok} 个，失败 {n_fail}")
    print(f"       输出 {chart_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
