/* ============================================================
 * public/js/salience.js —— 音乐事件选择（纯函数，零依赖）
 * ============================================================
 * 【为什么需要这个文件】
 *   以前是「选了 onset 源 → 按 targetNps 截断或补齐」：
 *     · 数量不够时，用 `beats[i] + s * beatSec / 4` **凭空造音符**
 *       —— 那段音频里根本没有那个声音，玩家打到的是一张假的谱
 *     · 数量太多时，按 strength 直接砍 —— 但 **强度不等于音乐意义**：
 *       一个响亮的镲片可能只是噪声，而一处安静的乐句起点才是真正的重音
 *     · 完全不看「这一句在歌里是什么位置」，于是每段都一个样
 *
 * 【这里做什么】
 *   ① **给每个候选事件打音乐显著性分**（不是响度，是"值不值得放一个音符"）
 *   ② **按分数从高到低选到目标数量，但有下限** ——
 *      分数低于阈值的**一个都不取**。候选不够就少给，并如实报告差多少。
 *   ③ **映射到判定线**：左右手按"哪只手更空"分配，而不是机械 i%2 交替
 *
 * 【⚠ 最重要的一条：绝不凭空造音符】
 *   谱面的可信度来自「每一个音符都对应音频里一个真实事件」。
 *   为了凑密度去造音，等于把整张谱变成假的 —— 而且玩家一打就听出来。
 *   候选不够就少给，报告里写 shortfall，让用户知道「这首歌就这么多音」。
 * ============================================================ */

import { phraseAt } from './rhythm.js?v=V0.22.0.0';

/** 细分折扣：同一个「节拍位置」上，格子越细，可靠性越低。
 *  ⚠ 这一层不能省。早先只按 beatInBar 算权重，结果**小节头上一个
 *    1/8 的噪声格子能拿到 1.0** —— 而它明明只是检测抖动。
 *    实测：极弱（strength 0.05）的 1/8 小节头 onset 总分 0.57，
 *    越过了 0.5 的阈值被选进谱面。加了折扣后落到 0.37，正常被拒。 */
function subdivDiscount(subdiv) {
  switch (subdiv) {
    case 1: return 1.0;
    case 2: return 0.90;
    case 3: return 0.80;   // 三连音：音乐性够，但读谱贵
    case 6: return 0.68;
    case 4: return 0.62;
    case 8: return 0.46;
    default: return 0.55;
  }
}

/** 拍位权重：小节头最重，越细的格子越轻。
 *  这是「音乐重音在哪」最便宜也最可靠的近似 —— 不需要音高分析。
 *  最终值 = 节拍位置基础分 × 细分折扣。 */
function beatWeightOf(ev, beatsPerBar) {
  const b = ev.beatInBar;
  const isInt = Math.abs(b - Math.round(b)) < 1e-6;
  let base;
  if (isInt) {
    const k = Math.round(b) % beatsPerBar;
    if (k === 0) base = 1.0;          // 小节头：最强的位置
    else if (beatsPerBar >= 4 && k === Math.floor(beatsPerBar / 2)) base = 0.85;  // 4 拍里的第 3 拍
    else base = 0.70;                  // 其它整拍
  } else if (ev.subdiv === 2) {
    base = 0.58;                       // 半拍：切分骨架，值得保留
  } else if (ev.subdiv === 3 || ev.subdiv === 6) {
    base = 0.52;                       // 三连音 / 六连音
  } else if (ev.subdiv === 4) {
    base = 0.38;                       // 十六分
  } else if (ev.subdiv === 8) {
    base = 0.26;
  } else {
    base = 0.34;
  }
  return base * subdivDiscount(ev.subdiv || 1);
}

/** 声部权重：鼓点是节奏骨架，旋律次之，混合 onset 最不可信。 */
function layerWeight(layer) {
  if (layer === 'drum') return 1.0;
  if (layer === 'piano') return 0.72;
  return 0.60;
}

/**
 * 给量化后的事件打显著性分（0–1）。
 *
 * @param {Array} events quantizeOnsets 的返回（会被原地加 salience 等字段）
 * @param {object} grid buildGrid 的返回
 * @param {{phrases?:Array, patternWindowBeats?:number}} [ctx]
 */
export function scoreEvents(events, grid, ctx) {
  const c = ctx || {};
  const phrases = c.phrases || [];
  const winBeats = c.patternWindowBeats || grid.beatsPerBar * 2;
  const arr = (events || []).filter(Boolean);

  /* 先算「节奏型签名」，用于后面判断重复。
     签名 = 层级 + 该层级内的位置。同一签名反复出现 = 有辨识度的动机。 */
  const sigs = arr.map(e => (e.dropped ? '' : e.subdiv + ':' + e.sub));

  for (let i = 0; i < arr.length; i++) {
    const ev = arr[i];
    if (ev.dropped) { ev.salience = 0; continue; }

    const bw = beatWeightOf(ev, grid.beatsPerBar);
    const lw = layerWeight(ev.layer);
    const st = Math.max(0, Math.min(1, ev.strength || 0));
    const cf = Math.max(0, Math.min(1, ev.conf || 0));

    /* ⚠ 公式是「强度打底 × 拍位 × 声部」，**不是加权求和**。
       求和的问题：各因子互相补偿 —— 一个 strength 0.03 的 1/8 噪声，
       靠小节头权重 + 声部权重就能凑到 0.34 越过阈值。
       实测就是这么错的（0.345 > 0.30）。
       乘子结构里强度是**下限**：几乎没有能量的东西，拍位再好也高不了。 */
    const base = 0.35 + 0.65 * st;
    let s = base * (0.55 + 0.45 * bw) * (0.70 + 0.30 * lw);
    /* 置信度只在强度之上做轻微修正，不参与主结构 */
    s *= (0.85 + 0.15 * cf);
    const why = { beatWeight: bw, layerWeight: lw, strength: st, conf: cf, bonus: 0, penalty: 0 };

    /* 乐句起点：换气口上的音最该保留 —— 那是听众感知到的"重音" */
    const ph = phraseAt(phrases, ev.beat);
    if (ph && Math.abs(ev.beat - ph.startBeat) < 1e-6) {
      s += 0.10; why.bonus += 0.10; why.phraseStart = true;
    }

    /* 节奏型重复：前后 winBeats 内出现同样的签名 ≥2 次 → 这是动机，加分。
       ⚠ 这条是「有辨识度」的可执行版本：重复出现的节奏型才是音乐元素，
         只出现一次的细碎格子多半是检测噪声。 */
    if (sigs[i] && ev.subdiv >= 2) {
      let same = 0;
      for (let j = 0; j < arr.length; j++) {
        if (j === i || sigs[j] !== sigs[i]) continue;
        if (Math.abs(arr[j].beat - ev.beat) <= winBeats) same++;
      }
      if (same >= 2) { s += 0.08; why.bonus += 0.08; why.repeated = true; }
    }

    /* 弱起：小节线前一拍以内的非整拍音。
       音乐上成立（pickup），但对读谱不友好 → 轻微降权，**不删**。 */
    const toBar = grid.beatsPerBar - ev.beatInBar;
    if (toBar <= 1 + 1e-6 && ev.subdiv >= 2) {
      s -= 0.06; why.penalty += 0.06; why.pickup = true;
    }

    ev.salience = Math.max(0, Math.min(1, s));
    ev.salienceWhy = why;
  }
  return arr;
}

/**
 * 选事件：按显著性从高到低取，直到目标数量，**但有下限**。
 *
 * @param {Array} scored scoreEvents 的返回
 * @param {{targetNotes?:number, minSalience?:number}} opts
 * @returns {{picked:Array, threshold:number, shortfall:number, candidates:number,
 *            rejectedByThreshold:number}}
 */
export function selectEvents(scored, opts) {
  const o = opts || {};
  const minSalience = Number.isFinite(o.minSalience) ? o.minSalience : 0.30;
  const arr = (scored || []).filter(e => e && !e.dropped);

  /* 过阈值才有资格被选。这一步是「宁可少也不硬凑」的落点。 */
  const eligible = arr.filter(e => e.salience >= minSalience);
  const rejectedByThreshold = arr.length - eligible.length;

  const target = Math.max(0, Math.floor(Number(o.targetNotes) || 0));
  let picked;
  if (!target || eligible.length <= target) {
    picked = eligible.slice();
  } else {
    /* 取分数最高的 target 个 —— 但**先按时间排回去**，
       否则后面算 Hold 长度、左右手分配都会乱。 */
    picked = eligible
      .slice()
      .sort((a, b) => b.salience - a.salience)
      .slice(0, target);
  }
  picked.sort((a, b) => a.beat - b.beat);

  return {
    picked,
    threshold: minSalience,
    /* ⚠ 这个数字必须如实报给用户：
       「你要 5.5 NPS，但这首歌只有 3.9 NPS 的音乐事件」是信息，
       悄悄补齐成 5.5 才是骗人。 */
    shortfall: target ? Math.max(0, target - picked.length) : 0,
    candidates: arr.length,
    rejectedByThreshold,
  };
}

/**
 * 映射到判定线。
 *
 * 规则（2 指自由分散）：
 *   · 左右手各占半屏；同一只手在 [-405,-202.5] 或 [202.5,405] 内选位置
 *   · **按"哪只手更空"分配**，不是 i%2 机械交替 ——
 *     机械交替会在长音/密集段出现"一只手连续打 8 个"的错觉，
 *     实际是因为另一只手刚打完长音还没回来
 *   · 同侧连续超过 maxSameSide 强制换手
 *
 * @param {Array} picked 已按时间排序的事件
 * @param {{maxSameSide?:number, sideOf?:Function}} [opts]
 */
export function assignHands(picked, opts) {
  const o = opts || {};
  const maxSameSide = Math.max(1, Math.floor(o.maxSameSide || 6));
  const arr = picked || [];
  let lastSide = null, run = 0;
  let leftFreeAt = -Infinity, rightFreeAt = -Infinity;

  arr.forEach((ev, i) => {
    const t = ev.beat;
    /* 空闲更久的那只手优先；相同则交替 */
    let side;
    if (run >= maxSameSide && lastSide) {
      side = lastSide === 'L' ? 'R' : 'L';
    } else if (t - leftFreeAt > t - rightFreeAt) {
      side = 'L';
    } else if (t - rightFreeAt > t - leftFreeAt) {
      side = 'R';
    } else {
      side = lastSide === 'L' ? 'R' : 'L';
    }
    ev.hand = side;
    /* 该手占用到下一个音（Hold 会在 assignNotes 里被拉长） */
    if (side === 'L') leftFreeAt = t; else rightFreeAt = t;
    run = side === lastSide ? run + 1 : 1;
    lastSide = side;

    /* 同侧内的位置：按"离中线远近"在两手间轮换，
       让手指有横向移动而不是一直点同一个点。 */
    const within = Math.floor((run - 1) / 2) % 2;
    ev.slot = within;
  });
  return arr;
}

/**
 * 决定音符类型 + 最终 x 坐标。
 *
 * 类型依据（不是随机）：
 *   · 到下一个音的间隔 ≥ 1 拍 → 可以考虑 Hold（有空间放长条）
 *   · 小节头 + 强 → Tap 或 Flick
 *   · 细网格（十六分以上）或弱起 → Drag（好读、不打断手）
 *
 * @param {Array} picked assignHands 的返回（按时间排序）
 * @param {{weights?:object, holds?:number[], beatSec:number, rng?:Function,
 *          maxHoldBeats?:number, lanes?:number[]}} opts
 */
export function assignNotes(picked, opts) {
  const o = opts || {};
  const arr = picked || [];
  const weights = o.weights || { tap: 0.58, hold: 0.10, flick: 0.07, drag: 0.25 };
  const holds = Array.isArray(o.holds) && o.holds.length ? o.holds : [0.5, 1];
  const beatSec = Number(o.beatSec) || 0.5;
  const maxHold = Number.isFinite(o.maxHoldBeats) ? o.maxHoldBeats : 2;
  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  const LEFT = [-405, -202.5], RIGHT = [202.5, 405];

  arr.forEach((ev, i) => {
    const next = arr[i + 1];
    const gap = next ? next.beat - ev.beat : Infinity;
    const strong = Math.abs(ev.beatInBar - Math.round(ev.beatInBar)) < 1e-6
      && Math.round(ev.beatInBar) % 4 === 0;

    let type = 'tap';
    /* ① 有空档 → Hold。长度取「不超过空档」的最长预设时值。 */
    if (gap >= Math.min.apply(null, holds) + 0.25 && weights.hold > 0) {
      const fit = holds.filter(h => h <= Math.min(gap - 0.25, maxHold));
      if (fit.length) {
        const r = rng();
        /* Hold 用概率决定，别把所有空档都变成 Hold（那样整张谱全是长条） */
        if (r < weights.hold * 2.2) {
          type = 'hold';
          ev.holdBeats = fit[fit.length - 1];
        }
      }
    }
    /* ② 细网格 / 弱起 → Drag：好读，且不打断手的节奏 */
    if (type === 'tap' && (ev.subdiv >= 4 || ev.salienceWhy && ev.salienceWhy.pickup)) {
      if (rng() < (weights.drag || 0) + 0.25) type = 'drag';
    }
    /* ③ 小节头 + 强 + 不是 Hold → 少量 Flick 做重音 */
    if (type === 'tap' && strong && (weights.flick || 0) > 0 && rng() < weights.flick * 1.6) {
      type = 'flick';
    }

    ev.kind = type;
    const pool = ev.hand === 'L' ? LEFT : RIGHT;
    ev.x = pool[ev.slot % pool.length];
    /* Hold 占用该手到结束 —— 记录一下，给可玩性审计用 */
    ev.busyUntilBeat = type === 'hold' ? ev.beat + (ev.holdBeats || 0) : ev.beat;
    ev.gapBeats = Number.isFinite(gap) ? gap : null;
    ev.gapMs = Number.isFinite(gap) ? gap * beatSec * 1000 : null;
  });
  return arr;
}

/** 选择 / 映射的汇总，给页面报告用。 */
export function selectionReport(sel, picked) {
  const arr = picked || [];
  const byKind = { tap: 0, hold: 0, flick: 0, drag: 0 };
  const byHand = { L: 0, R: 0 };
  let maxSameHand = 0, runHand = null, run = 0;
  for (const e of arr) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    byHand[e.hand] = (byHand[e.hand] || 0) + 1;
    run = e.hand === runHand ? run + 1 : 1;
    runHand = e.hand;
    if (run > maxSameHand) maxSameHand = run;
  }
  return {
    picked: arr.length,
    candidates: sel ? sel.candidates : arr.length,
    rejectedByThreshold: sel ? sel.rejectedByThreshold : 0,
    shortfall: sel ? sel.shortfall : 0,
    threshold: sel ? sel.threshold : null,
    byKind,
    byHand,
    maxSameHand,
  };
}
