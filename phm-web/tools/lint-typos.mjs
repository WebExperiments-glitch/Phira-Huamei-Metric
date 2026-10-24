#!/usr/bin/env node
/* ============================================================
 * tools/lint-typos.mjs —— 拼写检查（对标 rust-lang 跑的 typos-cli）
 * ============================================================
 * 【为什么不用现成的 typos-cli】
 *   它是 Rust 二进制，要装、要联网拉词典。这个项目坚持**零依赖**
 *   （package.json 只有一个 pg，且是服务端才用），
 *   为了拼写检查引入一个二进制工具不划算。
 *
 * 【所以这是什么】
 *   一个**保守**的检查：只报「几乎不可能是正确拼写」的东西 ——
 *   ① 常见的英文拼写错误（人工整理的对照表，只收确定错的那种）
 *   ② 同一个词连续重复两次（"the the"、"的 的"）
 *   ③ 形近的两处写法不一致（同一份文件里同时出现 color / colour 这类）
 *
 *   ⚠ 它**不是**完整拼写检查器。宁可漏报，也不要把正常词报成错 ——
 *     一个满屏假警报的检查，三天后就会被人加进忽略名单。
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

let pass = 0;
let fail = 0;
const bad = (msg) => { fail++; console.log('  ✗ ' + msg); };
const ok = (msg) => { pass++; if (process.env.VERBOSE) console.log('  ✓ ' + msg); };

/* ── ① 人工整理的拼写对照 ──
   只收「这个拼法在任何语境下都不成立」的。像 "thru" / "lite" 这种口语缩写不收。 */
const TYPOS = new Map(Object.entries({
  recieve: 'receive', recieved: 'received',
  seperate: 'separate', seperated: 'separated',
  occured: 'occurred', occurence: 'occurrence',
  definately: 'definitely',
  acheive: 'achieve', acheived: 'achieved',
  lenght: 'length', widht: 'width', heigth: 'height',
  paramter: 'parameter', paramters: 'parameters',
  retrun: 'return', fucntion: 'function', funtion: 'function',
  teh: 'the', adn: 'and', thier: 'their', wich: 'which',
  becuase: 'because', beacuse: 'because',
  accomodate: 'accommodate',
  adress: 'address',
  arguement: 'argument',
  commited: 'committed',
  dependancy: 'dependency', dependancies: 'dependencies',
  existance: 'existence',
  independant: 'independent',
  neccessary: 'necessary', necesary: 'necessary',
  recomend: 'recommend', recomended: 'recommended',
  refered: 'referred',
  succesful: 'successful', sucessful: 'successful',
  treshold: 'threshold',
  untill: 'until',
  veiw: 'view',
  writen: 'written',
  alot: 'a lot',
  enviroment: 'environment', enviornment: 'environment',
  garantee: 'guarantee',
  immediatly: 'immediately',
  langauge: 'language', langage: 'language',
  occassion: 'occasion',
  priviledge: 'privilege',
  publically: 'publicly',
  reccomend: 'recommend',
  sophmore: 'sophomore',
  supress: 'suppress',
  syncronize: 'synchronize',
  tommorow: 'tomorrow',
  transfered: 'transferred',
  useable: 'usable',
  Wich: 'Which', Teh: 'The',
}));

/* ── ③ 同一份文件里不该混用的两组写法 ── */
const PAIRS = [
  ['color', 'colour'],
  ['behavior', 'behaviour'],
  ['initialize', 'initialise'],
  ['center', 'centre'],
];

const SKIP_DIRS = /(^|\/)(node_modules|build-app|downloads|shots|backups|vendor)(\/|$)/;
const TEXT = /\.(js|mjs|cjs|ts|json|html|css|md|yml|yaml|sql|py|txt|toml|sh)$/i;

function tracked() {
  try {
    const out = execSync('git ls-files -z', { cwd: REPO, encoding: 'buffer', maxBuffer: 64 << 20 });
    return out.toString('utf8').split('\0').filter(Boolean)
      .filter(f => TEXT.test(f) && !SKIP_DIRS.test(f))
      /* 参照集/数据表是机器生成的，里面全是曲名和数字，拼写检查没有意义 */
      .filter(f => !/public\/data\/ref-|behavior-diff\.json/.test(f))
      .map(f => ({ abs: path.join(REPO, f), rel: f }));
  } catch {
    return [];
  }
}

const files = tracked();
console.log('\n【拼写】另查 ' + files.length + ' 个文本文件');

/* ── ① 拼写错误 ── */
let hits = 0;
for (const f of files) {
  let txt;
  try { txt = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [wrong, right] of TYPOS) {
      /* 边界匹配：前后不能是字母，避免误伤 "tehran" */
      const re = new RegExp('(^|[^A-Za-z])' + wrong + '([^A-Za-z]|$)');
      if (re.test(lines[i])) {
        bad(f.rel + ':' + (i + 1) + '  「' + wrong + '」应为「' + right + '」');
        hits++;
        if (hits > 30) break;
      }
    }
    if (hits > 30) break;
  }
  if (hits > 30) break;
}
if (!hits) ok('没有已知拼写错误');

/* ── ② 连续重复词 ──
   ⚠ 只查英文与中文的「整词重复」，且忽略代码里的常见重复
     （`a a` / `x x` 这种在参数列表里合法），所以要求**两侧都是字母且长度 ≥3**。 */
let dup = 0;
for (const f of files) {
  /* ⚠ 只查散文。代码/命令里的「重复」天然合法：
     `--data data/x`（参数名 + 值）、JSON 键、CSS 属性都会命中。
     第一版没加这条，报了一堆 `--data data/official/...` 的假警。 */
  if (!/\.(md|txt|html)$/i.test(f.rel)) continue;
  let txt;
  try { txt = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    /* 含路径/等号/引号/命令行痕迹的行一律跳过 */
    if (/--|=>|==|\/|=|\\|`|"|'/.test(l)) continue;
    const m = /\b([A-Za-z]{3,})\s+\1\b/.exec(l);
    if (m) {
      /* 排除代码里的合法重复：`import x from 'x'` 之类不会命中；
         但像 `--flag --flag` 也不该报 —— 只报纯文字行（不含 = { } ; ( ) 等） */
      if (!/[={}();<>[\]]/.test(l)) {
        bad(f.rel + ':' + (i + 1) + '  重复词「' + m[1] + ' ' + m[1] + '」');
        dup++;
        if (dup > 10) break;
      }
    }
  }
  if (dup > 10) break;
}
if (!dup) ok('没有连续重复词');

/* ── ③ 同一文件里混用英美拼写 ── */
let mix = 0;
for (const f of files) {
  if (!/\.(md|txt)$/i.test(f.rel)) continue;    /* 只在散文里查，代码里的标识符不算 */
  let txt;
  try { txt = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
  for (const [a, b] of PAIRS) {
    const reA = new RegExp('\\b' + a + 's?\\b', 'i');
    const reB = new RegExp('\\b' + b + 's?\\b', 'i');
    if (reA.test(txt) && reB.test(txt)) {
      bad(f.rel + '  同时出现「' + a + '」和「' + b + '」，统一一个');
      mix++;
    }
  }
}
if (!mix) ok('没有英美拼写混用');

console.log('\n────────');
console.log('拼写检查：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
