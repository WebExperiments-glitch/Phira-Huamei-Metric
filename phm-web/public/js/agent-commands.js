/* ============================================================
 * js/agent-commands.js —— 写谱 Agent 的命令注册表 + 权限审批
 * ============================================================
 * 【结构参照】`kclg-YSJ/rpe-next/src/core/agent-commands.mjs` + 各 *-tools.mjs
 * （PolyForm Noncommercial 1.0.0 —— **学模式，不抄实现**）。
 *
 * 【为什么要有注册表，而不是一个 switch】
 *   ① 每条命令自带 schema，工具定义由注册表**生成** —— 命令和描述不会脱节
 *   ② `kind` 决定要不要审批：read 直接跑，edit 必须过 approve()
 *   ③ 新命令只是多一行 defineCommand()，不改任何调用方
 *   ④ 测试可以对注册表逐个跑，不用遍历分支
 *
 * 【三类 kind（照抄它的思路，名字用我们的）】
 *   'read'   只读，不审批
 *   'edit'   改谱面，必须审批（会显示计划）
 *   'danger' 破坏性（覆盖已有内容 / 清空），即使 full 模式也要审批
 *
 * 【handler 契约】
 *   返回 `{ apply: () => any }` 表示要改动；返回普通对象表示只读结果。
 *   这样做的好处：**审批发生在改动之前**，而不是改完再问。
 * ============================================================ */

import { lintChart } from './chart-lint.js?v=V0.22.4.0';
import { extractGeometry } from './chart-geom.js?v=V0.22.4.0';
import { runScript } from './script-eval.js?v=V0.22.4.0';
import { loadChart, reportFromChart } from './engine.js?v=V0.22.4.0';
import { APP_VER } from './ui.js?v=V0.22.4.0';
import { beatValue, toBeat, chartBeatToSec, chartSecToBeat } from './beat-time.js?v=V0.22.4.0';

/* ── v2 权重（4 KB）──
   ⚠ 别再让 difficulty_estimate 当空壳：2026-10-25 实测里它只回了统计量加一句
     「宿主未注入」，模型只能拍脑袋标 Lv.14，和实际密度差一大截。
   拿不到权重不报错，退回 kNN（降级 ≠ 报错），但要在 basis 里说清楚。 */
let W2 = null, W2_STATE = '';
async function weightsV2() {
  if (W2_STATE === 'ok' || W2_STATE === 'fail') return W2;
  W2_STATE = 'loading';
  try {
    const r = await fetch('/data/engine-v2.json?v=' + encodeURIComponent(APP_VER));
    if (!r.ok) throw Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.w) || j.w.length !== 37) throw Error('权重结构异常（w 不是 37 维）');
    W2 = j; W2_STATE = 'ok';
  } catch (e) {
    W2_STATE = 'fail';
    console.warn('[agent] v2 权重加载失败，定数退回 kNN：' + (e.message || e));
  }
  return W2;
}

/* ── schema 构造器 ──
   最小够用：只要能让模型看懂参数含义与必填。不实现完整 JSON Schema。 */
const T = (desc) => ({ type: 'string', description: desc });
const N = (desc, min, max) => ({ type: 'number', description: desc, ...(min != null ? { minimum: min } : {}), ...(max != null ? { maximum: max } : {}) });
const I = (desc) => ({ type: 'integer', description: desc });
const B = (desc) => ({ type: 'boolean', description: desc });
const ENUM = (desc, values) => ({ type: 'string', description: desc, enum: values });
const ARR = (desc, items) => ({ type: 'array', description: desc, items });

export function obj(props, required = []) {
  const out = {};
  for (const [k, v] of Object.entries(props)) out[k] = v;
  return { type: 'object', properties: out, required, additionalProperties: false };
}

/* ── 谱面模型 ──
   我们生成的谱是 RPE v160：{ META, BPMList, judgeLineList[] }
   判定线的每个事件层有 moveX/moveY/rotate/alpha/speed 五类事件。
   ⚠ 音符统一放在 line.notes，靠 above 分上下（RPE 格式就是单数组，
     不是 notesAbove/notesBelow —— 那是 Phigros 官方 PGR 格式）。 */
const NOTE = { TAP: 1, HOLD: 2, FLICK: 3, DRAG: 4 };

/* ⚠ META 字段必须和 rulechart.js 的 buildPez 完全对齐 ——
   少一个（id / background / composer）打出来的 .pez 就是废包，
   而且症状是「导入 Phira 报找不到 chart.json」，跟真因毫无关系。 */
export function emptyChart({ name = '未命名', charter = '', composer = 'Unknown',
                            bpm = 120, offset = 0, level = '', id = null } = {}) {
  const cid = id || ('ai' + Math.random().toString(36).slice(2, 8));
  return {
    formatVersion: 3,
    offset,
    judgeLineGroup: ['Default'],
    judgeLineList: [{
      Group: 0, Name: 'Default', Texture: 'line.png', anchor: [0.5, 0.5],
      eventLayers: [blankLayer()],
      father: -1, isCover: 1, notes: [], numOfNotes: 0, zOrder: 0,
      isGif: false, rotateWithFather: true,
    }],
    BPMList: [{ bpm, startTime: [0, 0, 1] }],
    META: {
      RPEVersion: 160, background: 'background.png',
      charter, composer, illustration: '',
      id: cid, level, name, offset, song: 'audio.ogg', duration: 0,
    },
  };
}

function blankLayer() {
  return { moveXEvents: [], moveYEvents: [], rotateEvents: [], alphaEvents: [], speedEvents: [] };
}

/* 判定线动画事件汇总：{moveX: 12, rotate: 3} + 总数。
   ⚠ 存在的意义是让「有没有动画」变成可核对的事实 ——
     否则模型只会在报告里写"加了动画"，而谱面里一条事件都没有。 */
function animSummary(chart) {
  const out = {};
  let total = 0;
  for (const ln of (chart?.judgeLineList ?? [])) {
    for (const layer of (ln.eventLayers ?? [])) {
      for (const [k, v] of Object.entries(layer ?? {})) {
        if (!k.endsWith('Events') || !Array.isArray(v)) continue;
        const name = k.slice(0, -'Events'.length);
        out[name] = (out[name] || 0) + v.length;
        total += v.length;
      }
    }
  }
  return { total, byChannel: out };
}

/* 拍 ↔ 秒换算统一在 js/beat-time.js —— 纯函数、可单测，别在这里再写一份。 */

/* ── 注册表 ── */
export function createCommands({ approve = async () => true, getChart, setChart, getState } = {}) {
  const entries = new Map();
  const undo = [];

  function defineCommand(name, description, parameters, kind, handler) {
    if (entries.has(name)) throw Error(`命令重复注册：${name}`);
    if (!['read', 'edit', 'danger'].includes(kind)) throw Error(`kind 无效：${kind}`);
    entries.set(name, { name, description, parameters, kind, handler });
  }

  /* 审批：edit 走 approve，danger 无论什么模式都走 */
  async function execute(name, args, { signal } = {}) {
    const cmd = entries.get(name);
    if (!cmd) return { ok: false, error: `未知命令：${name}` };
    if (signal?.aborted) return { ok: false, cancelled: true, error: '任务已停止' };
    let out;
    try {
      out = await cmd.handler(args ?? {}, { signal });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    if (!out || typeof out.apply !== 'function') return { ok: true, result: out };

    /* 有 apply → 先审批，再执行 */
    if (cmd.kind !== 'read') {
      const plan = out.plan ?? {};
      const allowed = await approve({ name, kind: cmd.kind, args, plan });
      if (!allowed) return { ok: false, cancelled: true, error: '用户拒绝了这次修改' };
    }
    if (signal?.aborted) return { ok: false, cancelled: true, error: '任务已停止' };
    try {
      const before = getChart ? structuredClone(getChart()) : null;
      const value = await out.apply();
      /* ⚠ 关键：apply() 返回 `{chart, ...}` 时，**必须真的写回去**。
         第一版漏了这一步 —— 命令报告成功、审批也走了，但谱面根本没变，
         后续 chart_lint / chart_query 读到的还是旧谱，报「0 个音符」。
         那种"成功但没生效"的 bug 极难查，因为每一步的返回值都正常。 */
      if (value && value.chart) {
        setChart(value.chart);
        undo.push({ name, before });
      }
      return { ok: true, result: value };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /* 模型看到的工具定义，由注册表生成 —— 命令改了描述自动跟着改 */
  const tools = () => [...entries.values()].map(c => ({
    type: 'function',
    function: { name: c.name, description: c.description, parameters: c.parameters },
  }));

  /* ── 以下为命令实现 ── */

  /* ═══ 只读 ═══ */

  defineCommand('editor_context', '读取当前状态：谱面摘要、BPM、判定线数、音符数、时长。任何任务开始前先调它，不要假设当前状态。',
    obj({}), 'read', () => {
      const chart = getChart();
      const st = getState ? getState() : {};
      const notes = (chart.judgeLineList ?? []).reduce((n, l) => n + (l.notes?.length ?? 0), 0);
      return {
        name: chart.META?.song ?? '', charter: chart.META?.charter ?? '',
        bpm: chart.BPMList?.[0]?.bpm ?? null, bpmPoints: chart.BPMList?.length ?? 0,
        lines: chart.judgeLineList?.length ?? 0, notes,
        /* 动画事件数：模型要据此判断「我到底写没写动画」。
           空谱面 0 是对的；如果它声称做了动画而这里是 0，就是没生效。 */
        anim: animSummary(chart),
        ...st,
      };
    });

  defineCommand('chart_read', '按 JSON Pointer 读取谱面任意字段，如 /judgeLineList/0/notes。读取量大时先看摘要再缩小范围。',
    obj({ path: T('JSON Pointer，如 /META 或 /judgeLineList/0/notes') }, ['path']), 'read',
    ({ path: p }) => {
      const parts = String(p || '').slice(1).split('/').filter(Boolean)
        .map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'));
      let v = getChart();
      for (const k of parts) {
        if (!v || typeof v !== 'object' || !Object.hasOwn(v, k)) throw Error(`不存在路径：${p}`);
        v = v[k];
      }
      const s = JSON.stringify(v);
      return s.length > 20000
        ? { truncated: true, characters: s.length, hint: '结果过大，请用更具体的路径或 chart_query' }
        : v;
    });

  defineCommand('chart_query', '在谱面上做统计或筛选，不返回原始数据。mode=notes 数音符，mode=lines 列判定线，mode=density 出逐段 NPS。',
    obj({
      mode: ENUM('查询类型', ['notes', 'lines', 'density']),
      line: I('限定判定线下标，省略=全部'),
    }, ['mode']), 'read', ({ mode, line }) => {
      const chart = getChart();
      const lines = chart.judgeLineList ?? [];
      const pick = line == null ? lines : [lines[line]].filter(Boolean);
      if (mode === 'lines') return lines.map((l, i) => ({ index: i, name: l.Name, notes: l.notes?.length ?? 0, father: l.father }));
      const all = pick.flatMap(l => l.notes ?? []);
      if (mode === 'notes') {
        const by = {};
        for (const n of all) by[n.type] = (by[n.type] || 0) + 1;
        return { total: all.length, byType: by, fake: all.filter(n => n.isFake).length };
      }
      /* density：按 2 秒窗统计 */
      const dur = Math.max(1, ...all.map(n => chartBeatToSec(beatValue(n.startTime), chart.BPMList)));
      const w = 2, curve = [];
      for (let t = 0; t < dur; t += w) {
        curve.push(+(all.filter(n => {
          const s = chartBeatToSec(beatValue(n.startTime), chart.BPMList);
          return s >= t && s < t + w;
        }).length / w).toFixed(2));
      }
      return { duration: +dur.toFixed(2), nps: +(all.length / dur).toFixed(2), curve };
    });

  defineCommand('chart_templates', '列出可用的基础模板（judgeLine / notes / events），生成前先看能拿到什么。',
    obj({ what: ENUM('要什么模板', ['chart', 'notes', 'events']) }), 'read', ({ what = 'chart' }) => {
      if (what === 'notes') return { kinds: NOTE, note: 'type 1 Tap / 2 Hold / 3 Flick / 4 Drag；above=1 线上侧；isFake=1 假音符' };
      if (what === 'events') return { layer: blankLayer(), note: 'startTime/endTime 是 [整数,分子,分母] 的拍；alpha 0~255，负数会连音符一起隐藏' };
      return { chart: emptyChart({}), note: 'BPMList 可多段；offset 单位毫秒' };
    });

  defineCommand('difficulty_estimate', '用 v2 引擎算出当前谱面的预估定数。生成后调一次，把数字如实报给用户（它不是「这首歌应该多少分」）。',
    obj({}), 'read', async () => {
      const chart = getChart();
      const notes = (chart?.judgeLineList ?? []).reduce((n, l) => n + (l.notes?.length ?? 0), 0);
      if (!notes) throw Error('当前谱面还没有音符，先 chart_generate');
      const W = await weightsV2();
      let r;
      try { r = loadChart(chart); } catch (e) { throw Error('谱面结构无法解析：' + (e.message || e)); }
      const meta = chart.META || {};
      const rep = reportFromChart(r, meta.name || '', meta, null, null, null, W);
      const level = rep?.v2 ?? rep?.knn?.ref ?? null;
      return {
        level: level == null ? null : +Number(level).toFixed(1),
        basis: rep?.v2 != null ? 'ridge-beta (v2)' : 'knn 参照集（v2 权重没取到，已降级）',
        notes,
        nps: rep?.feats?.notes_all ? +(rep.feats.notes_all / Math.max(1, (chart.META?.duration || 1))).toFixed(2) : null,
        engineVer: rep?.engineVer ?? null,
        caveat: '这是按谱面结构算的，不是这首歌「应该」多少分。',
      };
    });

  defineCommand('chart_lint', '五层体检：语法 / 密度 / 配置 / 手序 / 深度。生成后必须调它；不通过就改，别交出去。',
    obj({}), 'read', () => {
      const g = extractGeometry(getChart());
      const r = lintChart(g, {});
      return { grade: r.grade, ok: r.ok, errors: r.errors, warnings: r.warnings, stats: r.stats };
    });

  defineCommand('history', '查看本会话的修改记录，用于判断能否回退。',
    obj({}), 'read', () => ({ count: undo.length, entries: undo.map((u, i) => ({ index: i, name: u.name })) }));

  /* ═══ 需要审批的修改 ═══ */

  defineCommand('chart_generate', '执行一段生成脚本，产出整张谱面。脚本里可用 tap(b) / hold(b1,b2) / drag(b) / flick(b) / at(b,x,type)，以及 beats / sections / bpm 等只读变量。**不要手写几百个音符 JSON，用脚本。**',
    obj({
      script: T('生成脚本源码。可用 tap/hold/drag/flick/at 与 beats/sections/bpm/energy'),
      name: T('曲名'),
      charter: T('谱师名'),
      level: T('难度标签，如 IN Lv.14'),
    }, ['script']), 'edit', ({ script, name, charter, level }) => {
      const st = getState ? getState() : {};
      const bpm = st.bpm || 120;
      const chart = emptyChart({ name: name || st.song || '未命名', charter: charter || '',
                                composer: st.composer || 'Unknown', bpm, level: level || '' });
      /* ── 多条判定线 ──
         ⚠⚠ 这是「1D 谱」的根因。实测爬来的 184 份真实谱面：
            判定线数中位 **27**（p25 24 / p75 46，最多 161），
            其中真正承载音符的线中位 **14**；
            而 `yOffset` 只有 3/290 份用过（官方 wiki 也说它「难以使用」）。
         也就是说 Phigros 的二维感**来自多条线并存**，不是靠移动单条线：
         单线在任何一瞬间都只有一个 y，音符全落在同一条直线上。
         所以给脚本 addLine(y, rot) + sel(i)：建线、切线，之后 tap/hold/key 都作用在当前线上。 */
      const lines = [chart.judgeLineList[0]];
      let cur = 0;
      const notes = [];                       /* 全局，用于时长/统计/告警 */
      const push = (beat, type, x = 0, endBeat = null, above = 1) => {
        const n = {
          type, above: above ? 1 : 0, alpha: 255, isFake: 0, positionX: x, size: 1, speed: 1,
          startTime: toBeat(beat), endTime: toBeat(endBeat ?? beat), yOffset: 0,
        };
        notes.push(n);
        lines[cur].notes.push(n);
      };
      /* 一条新线：基准高度 y、旋转 rot（度）。用一条覆盖全曲的常量事件把它钉在那儿。 */
      const addLine = (y = 0, rot = 0) => {
        const tpl = structuredClone(chart.judgeLineList[0]);
        tpl.Name = 'L' + lines.length;
        tpl.notes = []; tpl.numOfNotes = 0; tpl.father = -1;
        tpl.eventLayers = [blankLayer()];
        const span = { startTime: [0, 0, 1], endTime: [9999, 0, 1], easingType: 1,
                       bezier: 0, bezierPoints: [0, 0, 0, 0] };
        tpl.eventLayers[0].moveYEvents = [{ ...span, start: Number(y) || 0, end: Number(y) || 0 }];
        if (rot) tpl.eventLayers[0].rotateEvents = [{ ...span, start: Number(rot) || 0, end: Number(rot) || 0 }];
        chart.judgeLineList.push(tpl);
        lines.push(tpl);
        return lines.length - 1;
      };
      const sel = (i) => {
        const k = Number(i);
        if (!Number.isInteger(k) || k < 0 || k >= lines.length) {
          throw Error(`没有第 ${i} 条判定线（现在共 ${lines.length} 条，编号 0~${lines.length - 1}）`);
        }
        cur = k;
        return k;
      };
      /* 音符类型接受**数字或名字**。
         ⚠ 模型实测会写 `at(b, x, 'flick')` / `at(b, x, NOTE.FLICK)` ——
           第一版只认数字，字符串原样存进 type，产出的谱面 Drag/Flick 全是 0，
           而错误要到体检/试玩才发现。这里统一归一化，认不出就报错。 */
      const TYPE_OF = { tap: NOTE.TAP, hold: NOTE.HOLD, flick: NOTE.FLICK, drag: NOTE.DRAG };
      const normType = (t) => {
        if (typeof t === 'string') {
          const k = t.trim().toLowerCase();
          if (TYPE_OF[k]) return TYPE_OF[k];
          throw Error('不认识的音符类型「' + t + '」—— 只能用 tap / hold / flick / drag，或 1~4');
        }
        const n = Number(t);
        if (n === NOTE.TAP || n === NOTE.HOLD || n === NOTE.FLICK || n === NOTE.DRAG) return n;
        throw Error('音符类型只能是 1(Tap) / 2(Hold) / 3(Flick) / 4(Drag)，收到 ' + t);
      };
      /* ⚠ 每一个生成函数都带 `above` 末参：模型要写上下方轮流时
         `tap(b, x, 0)` 必须真的落到下方。原来 at() 没有这个参数，
         aboveRatio 一直卡在 1.0，体检里那条「全在判定线上方」永远修不掉。 */
      /* ── 判定线动画（自由关键帧）──
         ⚠ 这里以前什么都没有：模型只能往一条**静止不动**的判定线上撒音符，
           产出的东西本质上就是规则写谱。用户的原话：「这 TM 还是规则写谱」。
           三种预设轨迹（sway/orbit/pulse）也是规则，所以给的是**通用关键帧**：
           模型自己决定在哪一拍、用多久、从多少到多少、用什么缓动。
           RPE 的每条事件就是一段 [b1, b2] 的插值，够表达 build / drop / 淡入淡出。 */
      const EVK = {
        moveX: 'moveXEvents', moveY: 'moveYEvents', rotate: 'rotateEvents',
        alpha: 'alphaEvents', speed: 'speedEvents',
      };
      const events = [];
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      function key(ch, b1, b2, v1, v2, ez = 6) {
        const k = EVK[ch];
        if (!k) throw Error('通道只能是 moveX / moveY / rotate / alpha / speed，收到「' + ch + '」');
        const a = Number(b1), b = Number(b2);
        if (!isFinite(a) || !isFinite(b)) throw Error('key() 的起止拍必须是数字');
        if (b <= a) throw Error('key() 的结束拍必须大于起始拍（收到 ' + a + ' → ' + b + '）');
        let s = Number(v1), e = Number(v2);
        if (!isFinite(s) || !isFinite(e)) throw Error('key() 的起止值必须是数字');
        /* 数值范围：alpha 0~255（负数会把音符一起隐藏），speed 0.1~8，
           rotate 不设限（可以转好几圈），位移不设限（超出会被裁）。 */
        if (ch === 'alpha') { s = clamp(s, 0, 255); e = clamp(e, 0, 255); }
        if (ch === 'speed') { s = clamp(s, 0.1, 8); e = clamp(e, 0.1, 8); }
        events.push({ ch, k, b1: a, b2: b, v1: s, v2: e, ez: clamp(Math.round(ez), 0, 29), line: cur });
      }
      const api = {
        tap: (b, x = 0, above = 1) => push(b, NOTE.TAP, x, null, above),
        drag: (b, x = 0, above = 1) => push(b, NOTE.DRAG, x, null, above),
        flick: (b, x = 0, above = 1) => push(b, NOTE.FLICK, x, null, above),
        hold: (b1, b2, x = 0, above = 1) => push(b1, NOTE.HOLD, x, b2, above),
        at: (b, x, type = NOTE.TAP, above = 1) => push(b, normType(type), x, null, above),
        key,
        mx: (b1, b2, v1, v2, ez) => key('moveX', b1, b2, v1, v2, ez),
        my: (b1, b2, v1, v2, ez) => key('moveY', b1, b2, v1, v2, ez),
        rot: (b1, b2, v1, v2, ez) => key('rotate', b1, b2, v1, v2, ez),
        fade: (b1, b2, v1, v2, ez) => key('alpha', b1, b2, v1, v2, ez),
        addLine,
        sel,
        lineCount: () => lines.length,
        beats: st.beats || [], sections: st.sections || [], bpm,
        /* ⚠ 单位混用是本项目最容易踩的坑：`beats[]` 里是**秒**（onset 时刻），
           而 tap()/key() 收的是**拍**。模型把 beats 的秒当拍用，铺出来只有
           实际长度的 40%（24 秒的曲子只铺到 10 秒），而它自己以为是"铺满了"。
           所以把总拍数和两个换算函数直接给出去，别让它猜。 */
        totalBeats: +(chartSecToBeat(st.duration ?? 0, chart.BPMList)).toFixed(2),
        duration: st.duration ?? null,
        beat2sec: (b) => +chartBeatToSec(Number(b) || 0, chart.BPMList).toFixed(4),
        sec2beat: (s) => +chartSecToBeat(Number(s) || 0, chart.BPMList).toFixed(4),
        energy: (t) => (typeof st.energy === 'function' ? st.energy(t) : 0.5),
        report: (msg) => { api._log = String(msg); },
      };
      /* ⚠ 这里原来用 Function 构造 执行 —— 在浏览器里**永远跑不起来**：
         站点 CSP 是 `script-src 'self' 'unsafe-inline'`，没有 'unsafe-eval'，
         每一次生成都死在 "Evaluating a string as JavaScript violates the
         following Content Security Policy directive"（2026-10-25 实测）。
         现在走自写的解释器（script-eval.js）：只认白名单里的名字，
         宿主全局一个都摸不到 —— 比 Function 构造更严，且不碰 CSP。 */
      runScript(script, api);
      if (!notes.length) throw Error('脚本没有产生任何音符');
      /* 每条线各自排序、各自计数 —— 音符已经由 push() 落到各自的目标线上 */
      for (const ln of lines) {
        ln.notes.sort((a, b) => beatValue(a.startTime) - beatValue(b.startTime));
        ln.numOfNotes = ln.notes.length;
      }
      /* 关键帧落盘：按**目标线**分组，按通道归位，按起始拍排序。
         每条事件是一段插值，相邻段首尾相接才不会出现"跳一下"。 */
      for (const ln of lines) {
        if (!ln.eventLayers || !ln.eventLayers.length) ln.eventLayers = [blankLayer()];
      }
      for (const e of events) {
        const layer0 = lines[e.line].eventLayers[0];
        layer0[e.k] = layer0[e.k] || [];
        layer0[e.k].push({
          startTime: toBeat(e.b1), endTime: toBeat(e.b2),
          start: +e.v1.toFixed(2), end: +e.v2.toFixed(2),
          easingType: e.ez, bezier: 0, bezierPoints: [0, 0, 0, 0],
        });
      }
      for (const ln of lines) {
        for (const k of Object.values(EVK)) {
          const arr = ln.eventLayers[0][k];
          if (arr?.length) arr.sort((x, y) => beatValue(x.startTime) - beatValue(y.startTime));
        }
      }
      const secs = notes.map(n => chartBeatToSec(beatValue(n.endTime), chart.BPMList));
      chart.META.level = level || '';
      /* ⚠ 结尾必须留**余量**：rulechart 的可玩性校验会判「音符落在结束边界之后」，
         只把 duration 设成最后一个音符的时刻，最后几个音符必然违规。
         留 2 拍尾巴，和开头 2 拍 lead-in 对称。 */
      const beatSec = 60 / bpm;
      chart.META.duration = +(Math.max(...secs) + 2 * beatSec).toFixed(3);
      chart.META.song = st.audioName || 'audio.ogg';
      /* 开头没留 lead-in 要**报给模型**，别让它悄悄交出违规谱。
         rulechart 的可玩性校验要求前 2 拍留空，谱师也是这么写的。 */
      /* ⚠ 单位是**拍**不是秒：rulechart.js:592 判的是 start < 2 拍。
         我第一版按秒算（2*beatSec），等于什么都没查。 */
      const early = notes.filter(n => beatValue(n.startTime) < 2 - 1e-6).length;
      const warnings = [];
      if (early) warnings.push(early + ' 个音符起始拍 < 2，可玩性校验会判「before lead-in」——请从第 2 拍之后开始写');
      /* 类型摘要按**名字**报，不按数字：模型看到的 type=3 未必记得是 Flick，
         而它自己写的报告要转述给用户，中间错一次就是"我写了 flick"却出现 Tap。 */
      const NAME_OF = { 1: 'tap', 2: 'hold', 3: 'flick', 4: 'drag' };
      function typeSummary() {
        const m = {};
        for (const n of notes) { const k = NAME_OF[n.type] || String(n.type); m[k] = (m[k] || 0) + 1; }
        return m;
      }
      /* 承载音符的线条数 —— 这是「二维感」的真正来源。
         实测真实谱面中位 14 条线有音符；只有 1 条就是一条横线。 */
      const linesWithNotes = lines.filter((l) => l.notes.length > 0).length;
      return {
        plan: { notes: notes.length, types: typeSummary(), events: events.length,
                lines: lines.length, linesWithNotes, duration: chart.META.duration },
        apply: () => ({ chart, notes: notes.length, duration: chart.META.duration,
                        types: typeSummary(), events: events.length,
                        lines: lines.length, linesWithNotes,
                        ...(warnings.length ? { warnings } : {}) }),
      };
    });

  defineCommand('chart_patch', '用 JSON Pointer 逐项改谱面。op=set/insert/remove/append。只改指定路径，保留其余全部字段。',
    obj({
      operations: ARR('修改列表', obj({
        op: ENUM('操作', ['set', 'insert', 'remove', 'append']),
        path: T('JSON Pointer'),
        value: { description: 'set/insert/append 的新值' },
      }, ['op', 'path'])),
    }, ['operations']), 'edit', ({ operations }) => {
      const next = structuredClone(getChart());
      for (const op of operations) {
        const parts = String(op.path || '').slice(1).split('/').filter(Boolean);
        if (!parts.length) throw Error('不支持改根路径');
        let parent = next;
        for (const k of parts.slice(0, -1)) {
          if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, k)) throw Error(`父路径不存在：${op.path}`);
          parent = parent[k];
        }
        const key = parts.at(-1);
        if (op.op === 'remove') {
          if (Array.isArray(parent)) parent.splice(Number(key), 1);
          else delete parent[key];
        } else if (op.op === 'insert') {
          if (!Array.isArray(parent)) throw Error('insert 只能用于数组');
          parent.splice(Number(key), 0, structuredClone(op.value));
        } else if (op.op === 'append') {
          if (!Array.isArray(parent[key]) || !Array.isArray(op.value)) throw Error('append 要求两边都是数组');
          parent[key].push(...structuredClone(op.value));
        } else {
          parent[key] = structuredClone(op.value);
        }
      }
      for (const l of next.judgeLineList ?? []) l.numOfNotes = l.notes?.length ?? 0;
      return { plan: { operations: operations.length }, apply: () => ({ chart: next, operations: operations.length }) };
    });

  defineCommand('event_shake', '给指定判定线写一段衰减振动。末端严格回到基线，不留残差。',
    obj({
      line: I('判定线下标'),
      track: ENUM('作用通道', ['moveXEvents', 'moveYEvents', 'rotateEvents']),
      start: N('起始拍'),
      duration: N('持续拍数'),
      amplitude: N('振幅'),
      cycles: N('周期数'),
      decayEasing: I('衰减缓动编号 1~29'),
      baseline: N('基线值'),
    }, ['line', 'track', 'start', 'duration', 'amplitude', 'cycles']), 'edit', (a) => {
      const chart = structuredClone(getChart());
      const line = chart.judgeLineList[a.line];
      if (!line) throw Error('判定线不存在');
      const decay = a.decayEasing ?? 1;
      if (!(a.duration > 0) || !(a.cycles > 0) || !(a.amplitude !== 0)) throw Error('振动参数无效');
      if (!Number.isInteger(decay) || decay < 1 || decay > 29) throw Error('decayEasing 必须是 1~29');
      const per = 16, count = Math.ceil(a.cycles * per);
      if (count > 2000) throw Error('振动事件过多，请降低周期');
      const base = a.baseline ?? 0;
      const layer = line.eventLayers[0];
      const evs = [];
      for (let i = 0; i < count; i++) {
        const p0 = i / count, p1 = (i + 1) / count;
        const v = (p) => base + a.amplitude * (1 - p) * Math.sin(p * a.cycles * Math.PI * 2);
        evs.push({
          startTime: toBeat(a.start + a.duration * p0),
          endTime: toBeat(a.start + a.duration * p1),
          start: i === count - 1 ? base : v(p0),   /* ⚠ 最后一段强制回基线 */
          end: i === count - 1 ? base : v(p1),
          easingType: decay, bezier: 0, bezierPoints: [0, 0, 0, 0],
        });
      }
      layer[a.track] = [...(layer[a.track] ?? []), ...evs].sort(
        (x, y) => beatValue(x.startTime) - beatValue(y.startTime));
      return { plan: { track: a.track, events: evs.length }, apply: () => ({ chart, events: evs.length }) };
    });

  defineCommand('line_manage', '增删判定线。删除时必须同时修好子线的 father 指向，否则会出现悬空引用。',
    obj({
      action: ENUM('动作', ['add', 'remove']),
      index: I('remove 时的判定线下标'),
      name: T('add 时的线名'),
    }, ['action']), 'danger', ({ action, index, name }) => {
      const chart = structuredClone(getChart());
      if (action === 'add') {
        const base = structuredClone(chart.judgeLineList[0]);
        base.Name = name || `Line ${chart.judgeLineList.length}`;
        base.notes = []; base.numOfNotes = 0; base.father = -1;
        base.eventLayers = [blankLayer()];
        chart.judgeLineList.push(base);
        return { plan: { added: chart.judgeLineList.length - 1 }, apply: () => ({ chart, index: chart.judgeLineList.length - 1 }) };
      }
      if (!chart.judgeLineList[index]) throw Error('判定线不存在');
      chart.judgeLineList.splice(index, 1);
      for (const l of chart.judgeLineList) {
        if (l.father === index) l.father = -1;
        else if (l.father > index) l.father -= 1;
      }
      return { plan: { removed: index, lines: chart.judgeLineList.length }, apply: () => ({ chart, lines: chart.judgeLineList.length }) };
    });

  defineCommand('trajectory_generate', '给判定线写一段连续轨迹（判定线动画）。style=sway 左右摆 / orbit 绕圈 / pulse 按拍伸缩。x/y/rotate 可单独开关。',
    obj({
      line: I('判定线下标'),
      start: N('起始拍'),
      duration: N('持续拍数'),
      style: ENUM('风格', ['sway', 'orbit', 'pulse']),
      amplitude: N('幅度（像素或度）'),
      cycles: N('周期数'),
      channels: ARR('作用通道，默认 ["moveX"]', ENUM('通道', ['moveX', 'moveY', 'rotate'])),
      easingType: I('缓动编号 0~29，默认 6（Sine InOut）'),
    }, ['line', 'start', 'duration', 'style']), 'edit', (a) => {
      const chart = structuredClone(getChart());
      const line = chart.judgeLineList[a.line];
      if (!line) throw Error('判定线不存在');
      const ch = a.channels && a.channels.length ? a.channels : ['moveX'];
      const amp = a.amplitude ?? 60, cyc = a.cycles ?? Math.max(1, Math.round(a.duration / 4));
      const ez = a.easingType ?? 6;
      const N = Math.max(24, Math.min(2000, Math.round(a.duration * 8)));
      const layer = line.eventLayers[0];
      const evs = { moveX: [], moveY: [], rotate: [] };
      for (let i = 0; i < N; i++) {
        const p0 = i / N, p1 = (i + 1) / N;
        /* 三种风格的形状差别只在「怎么把进度映射成偏移」，
           采样与缓动完全共用 —— 加第四种风格只需再加一个 val()。 */
        const val = (p) => {
          if (a.style === 'orbit') {
            const th = p * cyc * Math.PI * 2;
            return { moveX: Math.cos(th) * amp, moveY: Math.sin(th) * amp, rotate: 0 };
          }
          if (a.style === 'pulse') {
            return { moveX: 0, moveY: 0, rotate: Math.abs(Math.sin(p * cyc * Math.PI)) * amp };
          }
          const w = Math.sin(p * cyc * Math.PI * 2) * amp;
          return { moveX: w, moveY: 0, rotate: w * 0.15 };
        };
        const v0 = val(p0), v1 = val(p1);
        for (const c of ch) {
          const key = c + 'Events';
          evs[c].push({
            startTime: toBeat(a.start + a.duration * p0), endTime: toBeat(a.start + a.duration * p1),
            start: +v0[c].toFixed(2), end: +v1[c].toFixed(2),
            easingType: ez, bezier: 0, bezierPoints: [0, 0, 0, 0],
          });
        }
      }
      for (const c of ch) layer[c + 'Events'] = [...(layer[c + 'Events'] ?? []), ...evs[c]]
        .sort((x, y) => beatValue(x.startTime) - beatValue(y.startTime));
      const total = ch.reduce((n, c) => n + evs[c].length, 0);
      return { plan: { style: a.style, channels: ch, events: total, beats: [a.start, a.start + a.duration] },
               apply: () => ({ chart, events: total }) };
    });

  defineCommand('chart_export', '把当前谱面打成 .pez 并给出下载链接。生成完调它一次就能拿到可玩文件；没有音频时自动配节拍器音轨。',
    obj({ filename: T('文件名（不含扩展名）') }), 'read', async ({ filename }) => {
      const st = getState ? getState() : {};
      if (!st.buildPez) throw Error('宿主没有提供打包函数，无法导出');
      /* ⚠ 不要因为「没拖 MP3」就拒绝导出：buildPez 在没有音频时会合成一条
         节拍器音轨，谱面照样能导进 Phira 打。第一版在这里 throw，
         结果是「谱子明明生成好了，用户却拿不到文件」。 */
      const out = await st.buildPez(getChart(), {
        audio: st.audio || null,
        audioName: st.audioName || 'audio.wav',
      });
      const size = out?.pez?.length ?? out?.pez?.size ?? 0;
      return { ok: true, name: (filename || 'chart') + '.pez',
               bytes: size, audio: st.audio ? 'user' : 'click-track',
               download: out.download ? 'ready' : 'host' };
    });

  defineCommand('audio_query', '读取已分析音频的摘要：BPM、拍点数、段落、时长、踩音密度。不知道能怎么写时先调它。',
    obj({}), 'read', () => {
      const st = getState ? getState() : {};
      return {
        bpm: st.bpm ?? null, bpmAlt: st.bpmAlt ?? null,
        beats: (st.beats || []).length, sections: (st.sections || []).length,
        duration: st.duration ?? null, onsets: st.onsets ?? null,
        hint: st.bpm == null ? '还没有音频。先让用户在页面上拖入 MP3。' : '可以开始生成了。',
      };
    });

  defineCommand('ask_user', '向用户提一个必须澄清的问题。缺参数会影响结果时才问，且一次问清；用户已明说的不要重复问。',
    obj({ question: T('问题正文'), options: ARR('可选项，2~4 个短语', T('选项')) }, ['question']), 'read',
    ({ question, options }) => ({ needUser: true, question, options: options ?? [] }));

  /* ═══ 网络（经 llm-hub 代理，Key 不出服务端）═══ */

  defineCommand('web_search', '搜索音乐名/曲师/BPM 等外部信息。**必须给出真实来源 URL**，并区分原曲与混音/变速版。',
    obj({ query: T('查询词') }, ['query']), 'read', async ({ query }, { signal }) => {
      const r = await fetch('/api/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }), signal,
      });
      if (!r.ok) throw Error(`搜索失败：HTTP ${r.status}`);
      return r.json();
    });

  defineCommand('web_fetch', '抓取一个网页并转成纯文本，用于核验搜索到的事实。',
    obj({ url: T('完整 URL') }, ['url']), 'read', async ({ url }, { signal }) => {
      const r = await fetch('/api/fetch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }), signal,
      });
      if (!r.ok) throw Error(`抓取失败：HTTP ${r.status}`);
      return r.json();
    });

  return { defineCommand, execute, tools, entries, undo };
}
