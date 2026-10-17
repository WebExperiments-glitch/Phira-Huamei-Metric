#!/usr/bin/env node
/* 校验 tools/backup.mjs 产出的备份：逐文件比 sha256 与大小。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/backup-verify.mjs <backup-dir>'); process.exit(2); }
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
let bad = 0;
for (const f of man.files) {
  const p = path.join(dir, f.path);
  if (!fs.existsSync(p)) { console.error('  x missing ' + f.path); bad++; continue; }
  const size = fs.statSync(p).size;
  const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (size !== f.bytes || h !== f.sha256) { console.error('  x checksum ' + f.path); bad++; }
  else console.log('  ok ' + f.path);
}
console.log(bad ? 'backup corrupted: ' + bad + ' files' : 'backup verified OK');
process.exit(bad ? 1 : 0);
