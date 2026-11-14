"""用魔搭 API-Inference 生图（Qwen-Image-2.1-Turbo）。

【为什么走 API 而不是本地跑】
  那个 checkpoint 32.44 GB，本机是 Intel CPU，出一张图要几十分钟；
  API-Inference 一次 1 魔粒，几秒到几十秒出图。

【接口是异步任务制，三步】
  ① POST /v1/images/generations  带 X-ModelScope-Async-Mode: true  → task_id
  ② GET  /v1/tasks/{id}          带 X-ModelScope-Task-Type: image_generation
     ⚠ 这个头缺了会报 task not found —— 文档里没强调，实测踩过
  ③ 下载 output_images[0]

用法：
    python tools/gen-logo.py --token ms-xxxx --prompt "..." --size 1024x1024 --out assets/logo

Token 在 https://modelscope.cn/my/myaccesstoken 获取（ms- 开头）。
"""
import argparse
import json
import os
import sys
import time
import urllib.request

BASE = "https://api-inference.modelscope.cn"


def _post(url, body, key, extra_headers=None):
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def _get(url, key, extra_headers=None):
    headers = {"Authorization": "Bearer " + key}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def generate(prompt, model, size, key, negative=None, seed=None, timeout=300):
    body = {"model": model, "prompt": prompt, "size": size}
    if negative:
        body["negative_prompt"] = negative
    if seed is not None:
        body["seed"] = seed

    sub = _post(
        BASE + "/v1/images/generations",
        body,
        key,
        {"X-ModelScope-Async-Mode": "true"},
    )
    task_id = sub.get("task_id")
    if not task_id:
        raise RuntimeError("提交失败：" + json.dumps(sub, ensure_ascii=False)[:300])
    print(f"  任务 {task_id} 已提交，轮询中…", flush=True)

    deadline = time.time() + timeout
    while time.time() < deadline:
        st = _get(
            f"{BASE}/v1/tasks/{task_id}",
            key,
            {"X-ModelScope-Task-Type": "image_generation"},
        )
        status = st.get("task_status")
        if status == "SUCCEED":
            return st.get("output_images") or []
        if status in ("FAILED", "CANCELED"):
            raise RuntimeError("生成失败：" + json.dumps(st, ensure_ascii=False)[:300])
        time.sleep(5)
    raise TimeoutError(f"{timeout}s 内没有完成")


def download(url, out_base, idx):
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
        ctype = r.headers.get("Content-Type", "")
    ext = ".png" if "png" in ctype else ".jpg"
    path = f"{out_base}-{idx}{ext}"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path, len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=os.environ.get("MODELSCOPE_API_KEY"))
    ap.add_argument("--model", default="Qwen/Qwen-Image-2.1-Turbo")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--negative", default=None)
    ap.add_argument("--size", default="1024x1024")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", default="assets/logo")
    ap.add_argument("--n", type=int, default=1, help="跑几次（每次一个新任务）")
    a = ap.parse_args()

    if not a.token:
        print("缺 token：--token ms-xxxx 或设环境变量 MODELSCOPE_API_KEY", file=sys.stderr)
        return 2

    for i in range(a.n):
        print(f"[{i + 1}/{a.n}] {a.model} {a.size}")
        try:
            urls = generate(a.prompt, a.model, a.size, a.token, a.negative, a.seed)
        except Exception as e:
            print("  失败：", e, file=sys.stderr)
            continue
        for j, u in enumerate(urls):
            p, n = download(u, a.out, i * 10 + j)
            print(f"  保存 {p}（{n // 1024} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
