#!/usr/bin/env node
/* ============================================================
 * tools/backup.mjs —— 备份仓库里的「数据真源」
 * ============================================================
 * 备份重建成本高、且在 git 里不宜放大的文件：
 *   官谱/社区谱特征、语料 manifest、前端参照集、release 元数据、客户端 exe。
 * 不备份：31GB 原始语料（另做离线快照）、任何凭据。
 *
 * 用法：
 *   node tools/backup.mjs                 # → backups/YYYYMMDD-HHmmss/
 *   node tools/backup.mjs --out D:/phm-backup
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : null;
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = outArg ? path.resolve(outArg) : path.join(ROOT, 'backups', stamp);

const FILES = [
  'data/official.jsonl',
  'data/community.jsonl',
  'data/charts/manifest.jsonl',
  'phm-web/public/data/ref-com.json',
  'phm-web/public/js/ref-official.js',
  'phm-web/public/js/release.js',
  'phm-web/CHANGELOG.md',
  'phm-web/downloads/phira-huamei.exe',
];

function sha256(file) {
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), files: [] };
let bytes = 0, copied = 0, skipped = 0;
for (const rel of FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { skipped++; console.log('  - skip (missing): ' + rel); continue; }
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const size = fs.statSync(dst).size;
  bytes += size; copied++;
  manifest.files.push({ path: rel, bytes: size, sha256: sha256(dst) });
  console.log('  + ' + rel + '  ' + (size / 1048576).toFixed(1) + ' MB');
}
manifest.totalBytes = bytes;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'README.txt'),
  'P.H.M. data-source backup\ncreated: ' + manifest.createdAt + '\n' +
  'verify with manifest.json (sha256).\n' +
  'Does NOT include data/charts (31GB) or any credentials.\n');
console.log('\ndone: ' + copied + ' files, ' + (bytes / 1048576).toFixed(1) + ' MB, skipped ' + skipped);
console.log('out: ' + OUT);
