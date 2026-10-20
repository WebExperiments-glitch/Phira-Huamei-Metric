# Vendor

## web-audio-beat-detector

- Upstream: https://github.com/chrisguttandin/web-audio-beat-detector
- License: MIT (see `web-audio-beat-detector/LICENSE`)
- Version: 8.2.39
- Bundled with esbuild as `web-audio-beat-detector/beat-detector.mjs` (browser ESM, self-contained).
- Usage: `import { analyze } from "/vendor/web-audio-beat-detector/beat-detector.mjs";`
  `analyze(audioBuffer, { minTempo: 60, maxTempo: 200 })`.

## uqr

- Upstream: https://github.com/unjs/uqr
- License: MIT (see `uqr-LICENSE`)
- Version: 0.1.2
- 单文件 ESM（`dist/index.mjs` 原样放入，未改写）。
- Usage: `const { encode } = await import("/vendor/uqr.mjs"); const { size, data } = encode("https://…", { ecc: "M" });`
  `data[row][col] === true` 表示黑块。**不含静区**，绘制时四周要自己留 4 个模块的白边。
- 为什么用它而不是自己写：QR 的纠错块表、掩码评分、格式信息 BCH 都是硬规范，
  手写极易出「能生成但扫不出来」的错，而且没法靠肉眼发现。这个库 27KB、零依赖、MIT。
- 只在**导出分享卡**时才动态 import —— 首屏不为它付带宽。
