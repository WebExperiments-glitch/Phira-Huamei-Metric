"""补齐缺失的谱面（有玩家标签但没下载过文件）。

流程：GET https://api.phira.cn/chart/{id} → file URL → 下载 .pez → 解出谱面本体
存成 data/charts/{id}/chart.json（或 .pec）+ info.yml，与现有目录结构一致。

用法：
    python tools/fetch_missing_charts.py --n 5
    python tools/fetch_missing_charts.py --workers 32
"""
import argparse
import io
import json
import os
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHARTS = os.path.join(ROOT, "data", "charts")
IDS = os.path.join(ROOT, "data", "missing-chart-ids.txt")
FAILED = os.path.join(ROOT, "data", "fetch-failed.txt")
API = "https://api.phira.cn/chart/"
UA = {"User-Agent": "phm-research/1.0 (difficulty modelling)"}
CHART_NAMES = ("chart.json", "chart.pec", "chart.yml", "chart.yaml")


def get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _write_info(d, info, chart_file):
    path = os.path.join(d, "info.yml")
    if os.path.exists(path):
        return
    lines = [
        "chart: " + os.path.basename(chart_file),
        "name: " + str(info.get("name", "")),
        "difficulty: " + str(info.get("difficulty", 0)),
        "level: " + str(info.get("level", "")),
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def save_chart(cid, info, blob):
    """把下载到的 .pez 落成 data/charts/{id}/chart.*"""
    d = os.path.join(CHARTS, cid)
    os.makedirs(d, exist_ok=True)

    if blob[:2] != b"PK":
        is_json = blob.lstrip()[:1] == b"{"
        out = os.path.join(d, "chart.json" if is_json else "chart.pec")
        with open(out, "wb") as f:
            f.write(blob)
        _write_info(d, info, out)
        return out

    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = z.namelist()
        # info.yml 的 chart: 字段才是真正的文件名（形如 70578096.json）
        target = None
        yml = [n for n in names if n.split("/")[-1].lower() in ("info.yml", "info.yaml")]
        if yml:
            txt = z.read(yml[0]).decode("utf-8", "replace")
            for line in txt.splitlines():
                if line.strip().startswith("chart:"):
                    target = line.split(":", 1)[1].strip().strip('"').strip("'")
                    break
        if target not in names:
            hits = [n for n in names if n.split("/")[-1].lower() in CHART_NAMES]
            target = hits[0] if hits else None
        if target is None:
            raise ValueError("压缩包里找不到谱面本体")

        data = z.read(target)
        ext = target.rsplit(".", 1)[-1].lower()
        out = os.path.join(d, "chart." + ext)
        with open(out, "wb") as f:
            f.write(data)
        if yml:
            with open(os.path.join(d, "info.yml"), "wb") as f:
                f.write(z.read(yml[0]))
        else:
            _write_info(d, info, out)
        return out


def one(cid, retries=3):
    """下载单张，返回 (状态, 字节数)。"""
    d = os.path.join(CHARTS, cid)
    if os.path.isdir(d) and any(f.startswith("chart.") for f in os.listdir(d)):
        return "skip", 0
    last = "?"
    for attempt in range(retries):
        try:
            info = json.loads(get(API + cid, timeout=20))
            blob = get(info["file"], timeout=120)
            save_chart(cid, info, blob)
            return "ok", len(blob)
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
            time.sleep(1.5 * (attempt + 1))
    return "fail:" + last, 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0, help="0 = 全部")
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()

    ids = [x.strip() for x in open(IDS, encoding="utf-8") if x.strip()]
    if a.n:
        ids = ids[:a.n]
    print("待下载 %d 张，%d 线程" % (len(ids), a.workers), flush=True)

    ok = skip = fail = 0
    total = 0
    fails = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(one, cid): cid for cid in ids}
        for k, fu in enumerate(as_completed(futs), 1):
            cid = futs[fu]
            st, n = fu.result()
            if st == "ok":
                ok += 1
                total += n
            elif st == "skip":
                skip += 1
            else:
                fail += 1
                fails.append(cid)
            if k % 100 == 0 or k == len(ids):
                el = max(time.time() - t0, 1e-6)
                rate = k / el
                print("  %d/%d  成功 %d 跳过 %d 失败 %d  %.2f GB  %.1f 张/s  剩约 %.1f 分"
                      % (k, len(ids), ok, skip, fail, total / 1e9, rate,
                         (len(ids) - k) / max(rate, 0.01) / 60), flush=True)

    if fails:
        with open(FAILED, "w", encoding="utf-8") as f:
            f.write("\n".join(fails))
        print("失败清单已写 data/fetch-failed.txt（%d 张）" % len(fails))
    print("\n完成：成功 %d，已存在 %d，失败 %d，共 %.2f GB，耗时 %.1f 分"
          % (ok, skip, fail, total / 1e9, (time.time() - t0) / 60))


if __name__ == "__main__":
    main()
