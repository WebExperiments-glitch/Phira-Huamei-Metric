/* ============================================================
 * js/engine-seq.mjs —— 序列模型在浏览器里的前向（「精确计算」档）
 * ============================================================
 * 输入就是 engine-v3.mjs 的 seqFeatures20() 产出的 20 维事件序列，
 * 输出和 v3/v4 同一份 { b, ding }，所以各档位可以直接并排显示。
 *
 * ── 它和岭回归的区别（一句话）──
 *   岭回归把整条时间轴压成 7 个分位数（142 个数），「第 40 秒有一段 12 连、
 *   之后空 8 秒」这句话在 142 维里不存在；这个模型保留时间轴 ——
 *   每 8 个事件打成一个 token，用双向 GRU 走一遍。
 *
 * ── v2 起多了一样东西：谱级手型 256 维 ──
 *   时间轴之外，再把「整张谱的片段手型」拼在线性头前面（n_side=256）。
 *   两个输入互补：GRU 看「先后」，手型看「这一段摊开多大」。
 *   实测 ρ 短谱 0.7636 / 全 0.8511 / 长 0.8819（v1 是 0.8267 / 0.8323）。
 *   `meta.n_side = 0` 的旧权重照样能跑，走 v1 那条分支。
 *
 * ── 结构（与 tools/train_seq_model.py 的 SeqDiffNet **逐层对应**）──
 *   8 事件 → patch 162 维（20×8 原始值 ‖ 片内 Σdt ‖ 有效比例）
 *     → Linear 162→64 → LayerNorm → GELU(erf 版)
 *     → depthwise Conv1d k=5 pad=2 → GELU → pointwise Conv1d 1×1 → 残差 → LayerNorm
 *     → 双向 GRU（单向 hidden 32，PyTorch 门序 r,u,n）
 *     → attention pooling（学习 query，不是 mean）
 *     → LayerNorm → Linear → 标量 z → × σ + μ = b
 *
 * ⚠ 两个容易写错、且写错了不报错只偏差的地方：
 *   1. patch 里的 Σdt 是**标准化之后**的 dt 之和（训练代码就是拿 x[...,0] 求和的），
 *      不是原始秒数。照 build 的顺序写，不要"顺手修正"。
 *   2. 补齐位（最后一片不满 8 个事件）填 0 —— 是标准化**之后**的 0，
 *      不是 (0-μ)/σ。训练时 x 先标准化再乘 mask，所以补位就是 0。
 *
 * 正确性由 tools/verify-seq-model.mjs 守着（对拍 numpy 参考值，误差 > 1e-5 就红）。
 */
const D_IN = 20;
const PATCH = 8;
const SQRT2 = Math.SQRT2;
/* 训练时超过 8,000 事件的谱会被截断（tools/build_seq_dataset.py 的 MAX_EVENTS），
   这里必须用同一个上限，否则「5 万物量的观赏谱」在浏览器里喂进去的序列
   比训练时长了 6 倍 —— 分布外，而且白等。截断同时把最坏延迟钉死。 */
const MAX_EVENTS = 8000;

/* Abramowitz-Stegun 7.1.26，|误差| < 1.5e-7。
   与 tools/export_seq_model.py 的 erf() 同一套系数 —— GELU 必须是 erf 版，
   不是 tanh 近似（PyTorch nn.GELU 默认就是 erf 版）。 */
function erf(x){
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
function gelu(x){ return 0.5 * x * (1 + erf(x / SQRT2)); }
function sigmoid(x){ return 1 / (1 + Math.exp(-x)); }

/* 权重文件是嵌套数组，每次按 [o][i] 取会多一层解引用。
   这里展平一次并缓存在 WeakMap 里（不污染调用方传进来的对象）。 */
const FLAT = new WeakMap();
function flat(W){
  let c = FLAT.get(W);
  if (c) return c;
  const w = W.weights || {};
  /* ⚠ 权重是嵌套数组（Linear 是 2 维、Conv1d 是 3 维），必须**深**展平。
     直接 Float64Array.from(二维数组) 得到的是 NaN —— 它会把每个子数组
     Number() 一遍。这条写错过一次，表现是整个输出 NaN。 */
  const f = k => Float64Array.from(w[k].flat(Infinity));
  c = {
    eW: f('embed.0.weight'), eB: f('embed.0.bias'),
    nW: f('embed.1.weight'), nB: f('embed.1.bias'),
    dW: f('dw.weight'),      dB: f('dw.bias'),
    pW: f('pw.weight'),      pB: f('pw.bias'),
    mW: f('norm.weight'),    mB: f('norm.bias'),
    gi: Object.assign([f('gru.weight_ih_l0'), f('gru.bias_ih_l0'),
         f('gru.weight_hh_l0'), f('gru.bias_hh_l0')], { rev: false }),
    gr: Object.assign([f('gru.weight_ih_l0_reverse'), f('gru.bias_ih_l0_reverse'),
         f('gru.weight_hh_l0_reverse'), f('gru.bias_hh_l0_reverse')], { rev: true }),
    aW: f('att.weight'),     aB: f('att.bias'),
    hW: f('head.0.weight'),  hB: f('head.0.bias'),
    oW: f('head.1.weight'),  oB: f('head.1.bias'),
    mu: Float64Array.from(W.meta.mu), sd: Float64Array.from(W.meta.sd),
    ym: +W.meta.ym, ys: +W.meta.ys,
    D: (+W.meta.d_model) || 64, H: (+W.meta.hidden) || 32,
    eps: (+W.meta.layernorm_eps) || 1e-5,
    /* v2 起：谱级手型特征（256 维）拼在池化向量后面再进线性头。
       n_side=0 就是 v1 的结构（head.1 是 1×64），老权重照样能跑。 */
    nS: (+W.meta.n_side) || 0,
    smu: W.meta.side_mu ? Float64Array.from(W.meta.side_mu) : null,
    ssd: W.meta.side_sd ? Float64Array.from(W.meta.side_sd) : null,
    sclip: W.meta.side_clip == null ? 8 : +W.meta.side_clip,
    b2d: W.b2d || { slope: 1.12, inter: 15.99 },
  };
  FLAT.set(W, c);
  return c;
}

/* LayerNorm 就地算在长度为 d 的切片上：in[off..off+d) → out[off..off+d) */
function layerNorm(v, off, d, w, b, eps){
  let mu = 0;
  for (let i = 0; i < d; i++) mu += v[off + i];
  mu /= d;
  let va = 0;
  for (let i = 0; i < d; i++){ const t = v[off + i] - mu; va += t * t; }
  va /= d;
  const inv = 1 / Math.sqrt(va + eps);
  for (let i = 0; i < d; i++) v[off + i] = (v[off + i] - mu) * inv * w[i] + b[i];
}

/* 单向 GRU 整条扫一遍，PyTorch 门序 r,u,n。
   n = tanh(W_in x + b_in + r ⊙ (W_hn h + b_hn))；h' = (1-u) ⊙ n + u ⊙ h */
function gru(g, X, T, D, H, out, oOff){
  const [wi, bi, wh, bh] = g, rev = !!g.rev;
  const h = new Float64Array(H);
  const gi = new Float64Array(3 * H), gh = new Float64Array(3 * H);
  for (let k = 0; k < T; k++){
    const t = rev ? T - 1 - k : k;
    const xo = t * D;
    for (let g = 0; g < 3 * H; g++){
      let s = bi[g];
      const ro = g * D;
      for (let i = 0; i < D; i++) s += X[xo + i] * wi[ro + i];
      gi[g] = s;
      let u = bh[g];
      const r2 = g * H;
      for (let i = 0; i < H; i++) u += h[i] * wh[r2 + i];
      gh[g] = u;
    }
    for (let j = 0; j < H; j++){
      const r = sigmoid(gi[j] + gh[j]);
      const u = sigmoid(gi[H + j] + gh[H + j]);
      const n = Math.tanh(gi[2 * H + j] + r * gh[2 * H + j]);
      h[j] = (1 - u) * n + u * h[j];
      out[t * 2 * H + oOff + j] = h[j];
    }
  }
}

/* seq：seqFeatures20() 的返回值（长度 n×20 的 Float64Array）
   side：可选的 256 维片段手型（handshape256() 的原始值，**未经标准化**）。
         v2 权重（meta.n_side = 256）必须给，否则返回 null；
         v1 权重给了也忽略（head.1 只有 64 个输入）。
   返回 { b, ding }；ding = 1.12b + 15.99，与 v3 同一映射。
   数据不足（0 个事件）或权重结构不对 → null，调用方据此隐藏入口。 */
export function predictSeq(seq, W, side){
  if (!seq || !W || !W.weights || !W.meta) return null;
  const n = Math.min(Math.floor(seq.length / D_IN), MAX_EVENTS);
  if (!n) return null;
  const m = flat(W);
  if (m.nS && !side) return null;
  const D = m.D, H = m.H;
  const T = Math.ceil(n / PATCH);

  /* ── patch 嵌入输入：162 维 ──
     每片 = [8 个事件的 20 维（标准化后）] ‖ Σdt ‖ 有效比例 */
  const feat = new Float64Array(T * (PATCH * D_IN + 2));
  for (let t = 0; t < T; t++){
    const fo = t * (PATCH * D_IN + 2);
    let dtSum = 0, nvalid = 0;
    for (let j = 0; j < PATCH; j++){
      const i = t * PATCH + j;
      if (i >= n) break;                    /* 补齐位保持 0（标准化后的 0） */
      const so = i * D_IN, bo = fo + j * D_IN;
      for (let d = 0; d < D_IN; d++){
        const v = (seq[so + d] - m.mu[d]) / m.sd[d];
        feat[bo + d] = v;
      }
      dtSum += feat[bo];                    /* 标准化后的 dt，与训练一致 */
      nvalid++;
    }
    feat[fo + PATCH * D_IN] = dtSum;
    feat[fo + PATCH * D_IN + 1] = nvalid / PATCH;
  }

  /* ── Linear 162→64 → LayerNorm → GELU ── */
  const z = new Float64Array(T * D);
  const Fw = PATCH * D_IN + 2;
  for (let t = 0; t < T; t++){
    const fo = t * Fw, zo = t * D;
    for (let o = 0; o < D; o++){
      let s = m.eB[o];
      const ro = o * Fw;
      for (let k = 0; k < Fw; k++) s += feat[fo + k] * m.eW[ro + k];
      z[zo + o] = s;
    }
    layerNorm(z, zo, D, m.nW, m.nB, m.eps);
    for (let o = 0; o < D; o++) z[zo + o] = gelu(z[zo + o]);
  }

  /* ── 深度可分离卷积：depthwise k=5（pad=2，零填充）→ GELU → pointwise 1×1 ──
     时间轴上的邻居先混一次（约 4 秒），降低 GRU 的记忆负担。 */
  const K = 5, PAD = 2;
  const dwv = new Float64Array(T * D);        /* gelu(depthwise) 的结果 */
  for (let o = 0; o < D; o++){
    for (let t = 0; t < T; t++){
      let s = m.dB[o];
      for (let j = 0; j < K; j++){
        const tt = t + j - PAD;
        if (tt < 0 || tt >= T) continue;      /* 边界外补 0 */
        s += z[tt * D + o] * m.dW[o * K + j];
      }
      dwv[t * D + o] = gelu(s);
    }
  }
  const h = new Float64Array(T * D);
  for (let t = 0; t < T; t++){
    const ho = t * D;
    for (let o = 0; o < D; o++){
      let s = m.pB[o];
      const ro = o * D;
      for (let c = 0; c < D; c++) s += dwv[ho + c] * m.pW[ro + c];
      h[ho + o] = z[ho + o] + s;              /* 残差 */
    }
    layerNorm(h, ho, D, m.mW, m.mB, m.eps);
  }

  /* ── 双向 GRU：两个方向各 32 维，拼成 64 ── */
  const hh = new Float64Array(T * 2 * H);
  gru(m.gi, h, T, D, H, hh, 0);
  gru(m.gr, h, T, D, H, hh, H);

  /* ── attention pooling：学习一个 query 给每个 token 打分 ──
     不是 mean —— 难段是稀疏的，平均会把尖峰抹平。单谱无 padding，
     所有 token 都有效，等价于普通 softmax。 */
  const a = new Float64Array(T);
  let amax = -Infinity;
  for (let t = 0; t < T; t++){
    let s = m.aB[0];
    const ho = t * 2 * H;
    for (let i = 0; i < 2 * H; i++) s += hh[ho + i] * m.aW[i];
    a[t] = s;
    if (s > amax) amax = s;
  }
  let den = 0;
  for (let t = 0; t < T; t++){ a[t] = Math.exp(a[t] - amax); den += a[t]; }
  const g = new Float64Array(2 * H);
  for (let t = 0; t < T; t++){
    const w = a[t] / den, ho = t * 2 * H;
    for (let i = 0; i < 2 * H; i++) g[i] += w * hh[ho + i];
  }

  /* ── head：LayerNorm → [池化 ‖ 手型] → 标量（标准化难度 z）──
     v2 把 256 维手型**标准化后拼在池化向量后面**（训练代码是
     `g = cat([g, side])`，side 已在 numpy 侧 clip 到 ±8）。不标准化直接用
     原始量纲，头层的权重是对不上的 —— 手型值是几十到几千的量级。 */
  layerNorm(g, 0, 2 * H, m.hW, m.hB, m.eps);
  let zs = m.oB[0];
  for (let i = 0; i < 2 * H; i++) zs += g[i] * m.oW[i];
  for (let i = 0; i < m.nS; i++){
    let v = (side[i] - m.smu[i]) / (m.ssd[i] || 1);
    v = v > m.sclip ? m.sclip : (v < -m.sclip ? -m.sclip : v);
    zs += v * m.oW[2 * H + i];
  }
  const b = zs * m.ys + m.ym;
  return { b: b, ding: m.b2d.slope * b + m.b2d.inter };
}
