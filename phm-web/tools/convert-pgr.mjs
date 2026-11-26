/* ============================================================
 * tools/convert-pgr.mjs —— Phigros 原生谱面（PGR v3）→ Phira/RPE chart.json
 * ============================================================
 * 【为什么需要它】
 *   Phigros 的谱面是 `notesAbove/notesBelow + judgeLineMoveEvents` 这套，
 *   Phira 吃的是 RPE：`eventLayers[{alphaEvents,moveXEvents,…}] + notes[startTime三元组]`。
 *   两者字段名、坐标量纲、时间表示全不一样，不是改个后缀能解决的。
 *
 * 【坐标量纲怎么定的（不是猜的）】
 *   PGR 的 positionX 实测范围 [-5, 5]，且大量音符正好落在 ±5 —— 说明 ±5 就是屏幕边缘。
 *   RPE 的 positionX 实测样本是 -225.0，画布宽 1350（中心 0，边缘 ±675）。
 *   ⇒ x_rpe = x_pgr × 135          （5 × 135 = 675，正好贴边）
 *   ⇒ y_rpe = (0.5 − y_pgr) × 900  （PGR y 以 0.5 为屏幕中线；RPE 正方向向下）
 *   ⇒ speed_rpe = speed_pgr × 10   （RPE 样本默认 10.0，PGR 常规 1.0）
 *   ⇒ alpha_rpe = alpha_pgr × 255  （PGR 0~1，RPE 0~255）
 *
 * 【时间】
 *   PGR 的 time 是 **1/32 拍 tick**（引擎侧 `tick: t*32` 可佐证）。
 *   RPE 用三元组 [整拍, 分子, 分母]。这里一律以 32 为分母再约分。
 *
 * 【已知不保真的地方，别当成 bug】
 *   PGR 的音符纵向位置来自预先累积的 floorPosition + speedEvents；
 *   RPE 由引擎按 speedEvents 实时积分。速度曲线一致时观感接近，
 *   但不做逐帧对齐 —— 这是所有 PGR→RPE 转换器的共同限制。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const W = 1350, H = 900;
const X_SCALE = W / 10;      /* ±5 → ±675 */
const Y_SCALE = H;
const SPEED_SCALE = 10;
const TICKS_PER_BEAT = 32;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** 合并「值不变的连续段」——PGR 的事件是逐拍采样，静止的判定线会产生
 *  成千上万条 start===end 的冗余事件，不合并会做出 7MB 的 chart.json。
 *  只在**时间首尾相接且值完全相同**时合并，不会改变曲线形状。 */
function coalesce(events) {
  const out = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    const sameVal = prev && prev.start === e.start && prev.end === e.end;
    const touching = prev && prev.endTime[0] === e.startTime[0]
      && prev.endTime[1] === e.startTime[1] && prev.endTime[2] === e.startTime[2];
    if (sameVal && touching) { prev.endTime = e.endTime; continue; }
    /* 斜率相同也可以合并：RPE 这边一律 easingType=1（线性），
       两段若在同一值域上线性延续，合成一段不改变任何中间取值。 */
    if (prev && touching) {
      const span = (x) => (x.endTime[0] + x.endTime[1] / x.endTime[2]) - (x.startTime[0] + x.startTime[1] / x.startTime[2]);
      const d1 = span(prev), d2 = span(e);
      if (d1 > 0 && d2 > 0) {
        const k1 = (prev.end - prev.start) / d1, k2 = (e.end - e.start) / d2;
        if (Math.abs(k1 - k2) < 1e-9 && Math.abs(prev.end - e.start) < 1e-9) {
          prev.endTime = e.endTime; prev.end = e.end; continue;
        }
      }
    }
    out.push(e);
  }
  return out;
}

/** tick → RPE 三元组 [int, num, den] */
export function tickToTriple(tick) {
  const t = Math.max(0, +tick || 0);
  const beat = t / TICKS_PER_BEAT;
  let i = Math.floor(beat + 1e-9);
  let num = Math.round((beat - i) * TICKS_PER_BEAT);
  let den = TICKS_PER_BEAT;
  if (num === 0) return [i, 0, 1];
  const g = gcd(num, den);
  num /= g; den /= g;
  return [i, num, den];
}

const ev = (st, en, s, e) => ({
  startTime: tickToTriple(st), endTime: tickToTriple(en),
  start: s, end: e,
  easingType: 1, easingLeft: 0, easingRight: 1,
  bezier: 0, bezierPoints: [0, 0, 0, 0], linkgroup: 0,
});

const lineMeta = (i) => ({
  Group: 'main', Name: 'line' + i, Texture: 'line.png',
  alphaControl: [{ x: 0, y: 1, alpha: 1 }],
  anchor: [0.5, 0.5], bpmfactor: 1,
  extended: {}, father: -1, isCover: 0, isGif: false,
  posControl: [{ x: 0, y: 0 }], rotateWithFather: false,
  sizeControl: [{ x: 0, y: 1, size: 1 }],
  skewControl: [{ x: 0, y: 0.5, skew: 0 }],
  yControl: [{ x: 0, y: 1 }], zOrder: i,
});

/**
 * @param {object} pgr Phigros 原生谱面对象
 * @param {{level?:string, charter?:string, composer?:string, illustrator?:string, name?:string}} meta
 */
export function pgrToRpe(pgr, meta = {}) {
  const lines = pgr.judgeLineList || [];
  const bpm = lines.find(l => l.bpm)?.bpm || 120;

  /* ⚠ 时长只能由**音符**决定。PGR 的演出事件里有 -999999 / 1e9 这类哨兵
     （「一直有效」的写法），拿它们算最大 tick 会把时长撑到一千万秒。 */
  let maxNoteTick = 0;
  for (const ln of lines) {
    for (const key of ['notesAbove', 'notesBelow']) {
      for (const n of ln[key] || []) {
        if (n.time == null) continue;
        maxNoteTick = Math.max(maxNoteTick, +n.time + (+n.holdTime || 0));
      }
    }
  }
  const judgeLineList = lines.map((ln, i) => {
    const notes = [];
    for (const [key, above] of [['notesAbove', 1], ['notesBelow', 0]]) {
      for (const n of ln[key] || []) {
        if (n.time == null || n.type == null) continue;
        const t = +n.time;
        notes.push({
          above, alpha: 255,
          startTime: tickToTriple(t),
          endTime: tickToTriple(t + (+n.holdTime || 0)),
          isFake: 0,
          positionX: +(+n.positionX || 0) * X_SCALE,
          size: 1, speed: +n.speed || 1,
          type: +n.type, visibleTime: 999999.0, yOffset: 0,
        });
      }
    }

    /* 事件时间钳到 [0, 最后一个音符]：哨兵值不能被写进 RPE */
    const cl = (v) => Math.min(Math.max(+v || 0, 0), maxNoteTick);
    const span = (e) => { const a = cl(e.startTime), b = cl(e.endTime); return [a, b < a ? a : b]; };
    const moveX = [], moveY = [], rot = [], alpha = [], speeds = [];
    for (const e of ln.judgeLineMoveEvents || []) {
      const [a, b] = span(e);
      moveX.push(ev(a, b, (+e.start || 0) * X_SCALE, (+e.end || 0) * X_SCALE));
      moveY.push(ev(a, b, (0.5 - (+e.start2 || 0)) * Y_SCALE, (0.5 - (+e.end2 || 0)) * Y_SCALE));
    }
    for (const e of ln.judgeLineRotateEvents || []) {
      const [a, b] = span(e);
      rot.push(ev(a, b, +e.start || 0, +e.end || 0));
    }
    for (const e of ln.judgeLineDisappearEvents || []) {
      const [a, b] = span(e);
      alpha.push(ev(a, b, (+e.start || 0) * 255, (+e.end || 0) * 255));
    }
    for (const e of ln.speedEvents || []) {
      const [a, b] = span(e);
      speeds.push(ev(a, b, (+e.value || 0) * SPEED_SCALE, (+e.value || 0) * SPEED_SCALE));
    }
    const byStart = (a, b) => (a.startTime[0] - b.startTime[0]) || (a.startTime[1] / a.startTime[2] - b.startTime[1] / b.startTime[2]);
    [moveX, moveY, rot, alpha, speeds].forEach(a => { a.sort(byStart); });

    return Object.assign(lineMeta(i), {
      eventLayers: [{
        alphaEvents: coalesce(alpha), moveXEvents: coalesce(moveX), moveYEvents: coalesce(moveY),
        rotateEvents: coalesce(rot), speedEvents: coalesce(speeds),
      }],
      notes, numOfNotes: notes.length,
    });
  });

  const duration = maxNoteTick / TICKS_PER_BEAT * (60 / bpm);
  return {
    BPMList: [{ startTime: [0, 0, 1], bpm }],
    META: { offset: +(pgr.offset || 0), name: meta.name || '' },
    chartTime: +duration.toFixed(3),
    judgeLineGroup: ['main'],
    judgeLineList,
    multiLineString: '',
    multiScale: 1,
  };
}

/** 手写 ZIP（store，不压缩）—— 本机没有 zip 命令 */
export function buildZip(files) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };

  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/** 生成静音 WAV：让 .pez 能被 Phira 导入试跑（**没有声音**，只是占位）。
 *  真正要玩必须换成你自己的音频 —— 本仓库不分发任何音源。 */
export function silentWav(seconds, rate = 11025) {
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  buf.fill(128, 44);          /* 8bit PCM 的静音中点是 128，不是 0 */
  return buf;
}

/* ── CLI ── */
if (process.argv[1] && process.argv[1].endsWith('convert-pgr.mjs')) {
  const [,, srcJson, outDir, level, charter, composer, name] = process.argv;
  if (!srcJson || !outDir) {
    console.error('用法: node tools/convert-pgr.mjs <pgr.json> <outDir> [level] [charter] [composer] [name]');
    process.exit(1);
  }
  const audioArg = (process.argv.find(a => a.startsWith('--audio=')) || '').slice(8);
  const audioName = audioArg ? 'music' + path.extname(audioArg).toLowerCase() : 'music.wav';
  const pgr = JSON.parse(fs.readFileSync(srcJson, 'utf8'));
  const rpe = pgrToRpe(pgr, { level, charter, composer, name });
  fs.mkdirSync(outDir, { recursive: true });
  const chartJson = JSON.stringify(rpe);
  fs.writeFileSync(path.join(outDir, 'chart.json'), chartJson);
  const infoYml = [
    `name: ${name || ''}`,
    `level: ${level || ''}`,
    `charter: ${charter || ''}`,
    `composer: ${composer || ''}`,
    `illustrator: ''`,
    `chart: chart.json`,
    `music: ${audioName}`,
    `illustration: ''`,
    `offset: 0`,
    `aspectRatio: 1.7777778`,
    `backgroundDim: 0.6`,
    `lineLength: 6.0`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'info.yml'), infoYml);
  const files = [
    { name: 'chart.json', data: chartJson },
    { name: 'info.yml', data: infoYml },
  ];
  if (audioArg) {
    /* 真实音源：用户自备（本地使用，不分发） */
    files.push({ name: audioName, data: fs.readFileSync(audioArg) });
  } else if (process.argv.includes('--silence')) {
    files.push({ name: 'music.wav', data: silentWav(rpe.chartTime) });
  }
  const pez = buildZip(files);
  fs.writeFileSync(path.join(outDir, path.basename(outDir) + '.pez'), pez);
  console.log(`✓ ${outDir}  音符=${rpe.judgeLineList.reduce((a, l) => a + l.numOfNotes, 0)}  时长=${rpe.chartTime}s  bpm=${rpe.BPMList[0].bpm}`);
}
