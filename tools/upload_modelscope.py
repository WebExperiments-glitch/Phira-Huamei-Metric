#!/usr/bin/env python3
"""把合并后的模型推到魔搭（ModelScope）。

用法：
    set MS_TOKEN=<你的令牌>            # modelscope.cn → 个人中心 → 访问令牌
    python tools/upload_modelscope.py <模型目录> <账号/模型名>

例：
    python tools/upload_modelscope.py release/phm-difficulty-qwen3-0.6b panduolaooo/phm-difficulty-qwen3-0.6b

⚠ 为什么要合并后再传：LoRA 单独发出去，使用者还得自己写注入代码（我们就是手写的那 20 行）。
   合并版的代价是 1.2 GB，但 `from_pretrained` 一行可用 —— 存档研究，可复现优先。
"""
import os
import sys


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    model_dir = sys.argv[1]
    repo_id = sys.argv[2]
    token = os.environ.get("MS_TOKEN")
    if not token:
        sys.exit("缺少 MS_TOKEN 环境变量（modelscope.cn → 个人中心 → 访问令牌）")
    if not os.path.isdir(model_dir):
        sys.exit(f"目录不存在：{model_dir}")
    files = os.listdir(model_dir)
    print(f"上传 {model_dir} → {repo_id}")
    print(f"  文件：{files}")
    if "MODEL_CARD.md" not in files:
        print("  ⚠ 目录里没有 MODEL_CARD.md（魔搭会用 README.md 作展示页）")

    from modelscope.hub.api import HubApi
    api = HubApi()
    api.login(token)

    try:
        api.create_model(model_id=repo_id, visibility=5,
                         license="GPL-3.0",
                         chinese_name="P.H.M. 难度预测（Qwen3-0.6B，可行性研究）")
        print(f"已创建 {repo_id}（公开）")
    except Exception as e:
        print(f"创建跳过（可能已存在）：{str(e)[:120]}")

    api.push_model(model_id=repo_id, model_dir=model_dir)
    print(f"完成：https://modelscope.cn/models/{repo_id}")


if __name__ == "__main__":
    main()
