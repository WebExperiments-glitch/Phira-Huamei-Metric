"""只取 Kaggle kernel 的小产物（结果 json + 日志），跳过 1.4 GB 模型权重。

⚠ 为什么需要：kernel 把 Qwen3-0.6B 下到 /kaggle/working，于是整个模型目录
成了产物的一部分。`kernels_output` 默认全量下载，1.4 GB 会先把时间耗光，
结果文件反而拿不到。
⚠ `file_pattern` 是**正则**不是通配符：写 `*.log` 会报
"nothing to repeat at position 0"，必须写 `.*\.log$`。
"""
import sys

from kaggle.api.kaggle_api_extended import KaggleApi

REF = sys.argv[1] if len(sys.argv) > 1 else "panduolaooo/phm-difficulty-lora"
OUT = sys.argv[2] if len(sys.argv) > 2 else "data/kaggle/out"
PATTERN = r"^(?!Qwen3-0\.6B/).*\.(json|log)$"   # 负向断言：模型目录里的 config.json 也会命中 .json

api = KaggleApi()
api.authenticate()
files, _ = api.kernels_output(REF, path=OUT, file_pattern=PATTERN)
small = [f for f in files if "Qwen3" not in f]
print("拿到:", small)
