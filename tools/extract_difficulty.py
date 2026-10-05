#!/usr/bin/env python3
"""
官谱定数提取器

数据源：assets/bin/Data/data.unity3d 里的 GameInformation MonoBehaviour
        （不在 Addressables catalog 里，所以 extract_pgr.py 拿不到）

逻辑严格对齐 7aGiven/Phigros_Resource 的 gameInformation.py：
  - 用 typetree.json 的 GameInformation 定义解析 MonoBehaviour
  - 遍历 song → 跳过 otherSongs
  - difficulty 长度 5 则 pop()（SP）
  - 末位为 0.0 则同时 pop difficulty 与 charter
  - 定数保留 1 位小数
  - songsId 去掉末尾 2 字符

输出：
  info/difficulty.tsv  <songsId>\t<EZ>\t<HD>\t<IN>\t<AT>
  info/info.tsv         <songsId>\t<曲名>\t<曲师>\t<画师>\t<各难度谱师>
"""
import argparse
import json
import os
import sys
import zipfile
from io import BytesIO

from UnityPy import Environment


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True)
    ap.add_argument("--out", default=".")
    ap.add_argument("--typetree", required=True, help="typetree.json 路径")
    ap.add_argument("--dump", action="store_true", help="同时导出完整 GameInformation")
    args = ap.parse_args()

    with open(args.typetree, encoding="utf-8") as f:
        typetree = json.load(f)
    print(f"[init] typetree 键: {list(typetree.keys())[:6]}")

    apkf = os.path.abspath(args.apk)
    out = os.path.abspath(args.out)
    info_dir = os.path.join(out, "info")
    os.makedirs(info_dir, exist_ok=True)

    env = Environment()
    with zipfile.ZipFile(apkf) as apk:
        names = apk.namelist()
        target = None
        if "assets/bin/Data/data.unity3d" in names:
            target = "assets/bin/Data/data.unity3d"
        elif "assets/bin/Data/globalgamemanagers.assets" in names:
            target = "assets/bin/Data/globalgamemanagers.assets"
        print(f"[step1] 目标: {target}")
        with apk.open(target) as f:
            env.load_file(BytesIO(f.read()), name=target)
        if target.endswith("globalgamemanagers.assets") and "assets/bin/Data/level0" in names:
            with apk.open("assets/bin/Data/level0") as f:
                env.load_file(BytesIO(f.read()))

    print(f"[step2] 扫描 {len(list(env.objects))} 个对象 ...")
    gi = None
    n_mono = 0
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        n_mono += 1
        try:
            data = obj.read()
            script = data.m_Script.get_obj()
            if script is None:
                continue
            script_name = script.read().name
        except Exception:
            continue
        if script_name == "GameInformation":
            print(f"  找到 GameInformation (pathID={obj.path_id})")
            gi = obj.read_typetree(typetree["GameInformation"])
            break

    if gi is None:
        print("[FAIL] 未找到 GameInformation")
        return 2

    if args.dump:
        with open(os.path.join(out, "GameInformation.json"), "w", encoding="utf-8") as f:
            json.dump(gi, f, ensure_ascii=False, indent=1)
        print("[dump] 已导出 GameInformation.json")

    print(f"[step3] song 分组: {list(gi.get('song', {}).keys())}")

    difficulty_rows, info_rows = [], []
    for key, songs in gi.get("song", {}).items():
        if key == "otherSongs":
            continue
        for song in songs:
            diff = list(song.get("difficulty", []))
            charter = list(song.get("charter", []))
            if len(diff) == 5:
                diff.pop()                      # 去掉 SP
            if diff and diff[-1] == 0.0:
                diff.pop()
                if charter:
                    charter.pop()
            diff = [str(round(d, 1)) for d in diff]
            sid = song.get("songsId", "")
            if sid.endswith("0"):
                sid = sid[:-2]
            difficulty_rows.append([sid] + diff)
            info_rows.append([sid, song.get("songsName", ""),
                              song.get("composer", ""),
                              song.get("illustrator", "")] + list(charter))

    with open(os.path.join(info_dir, "difficulty.tsv"), "w", encoding="utf-8") as f:
        for r in difficulty_rows:
            f.write("\t".join(map(str, r)) + "\n")
    with open(os.path.join(info_dir, "info.tsv"), "w", encoding="utf-8") as f:
        for r in info_rows:
            f.write("\t".join(map(str, r)) + "\n")

    print(f"[done] difficulty.tsv {len(difficulty_rows)} 行")
    print(f"[done] info.tsv        {len(info_rows)} 行")
    print(f"[done] 输出 {info_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
