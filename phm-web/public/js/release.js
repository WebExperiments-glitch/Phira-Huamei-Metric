/* ============================================================
 * js/release.js —— 下载页的构建元数据
 * ============================================================
 * ⚠ **本文件由 tools/gen-release.mjs 生成，不要手改**（改了会被 --check 判红）。
 *   大小与 sha256 是从 downloads/phira-huamei.exe **实际算出来**的，
 *   客户端版本从 phira-huamei/phira/src/client.rs 抠出来 ——
 *   手抄这三样必然过期，而过期的 sha256 会让用户合理地怀疑包被投毒。
 * ============================================================ */

export const RELEASE = {
  "siteVer": "V0.11.0.2",
  "clientVer": "0.8.2-huamei.12",
  "built": "2026-10-12",
  "file": "phira-huamei.exe",
  "url": "/download/phira-huamei.exe",
  "bytes": 36627456,
  "size": "34.9 MB",
  "sha256": "a8e9af4c5e124407c60436c8785988e7fa78dd9f83325278dc796a6e8ca9b958",
  "source": "https://github.com/WebExperiments-glitch/Phira-Huamei-Metric"
};
