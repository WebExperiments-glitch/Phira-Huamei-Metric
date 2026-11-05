/* ============================================================
 * js/engine-v3.mjs —— v3 引擎：20 维事件序列特征 → 142 维池化 → 岭回归
 * ============================================================
 * v2 是 37 维手工统计量（物量 / NPS / strain / 判定线数），对玩家实测难度 ρ 0.774。
 * 离线这条路发现真正缺的是「移动」：走多远、走多快、三连音夹角多别扭。
 * 补上之后 142 权重的线性模型到 0.8024，与 69k 参数的 SSM（0.8162）配对检验不显著。
 *
 * ⚠ 口径必须与 tools/build_seq_dataset.py 的 to_feats 逐位一致：
 *   输入用**全部音符**（含 fake）并按时间排序 —— Python 侧不过滤 fake。
 *   正确性由 tools/verify-engine-v3.mjs 守着（定数差 > 0.05 级就红）。
 *
 * ⚠ 为什么单独成文件：engine.js 有 900 行硬上限（`lint-slop` 第 6 条），
 *   把这些塞进去会到 984 行。拆开之后两个文件各自可读。
 */
/* ══════════════════════════════════════════════════════════════
 * v3 引擎：20 维事件序列特征 → 142 维池化 → 岭回归 → IRT b → 定数
 * ══════════════════════════════════════════════════════════════
 * v2 是 37 维手工统计量（物量 / NPS / strain / 判定线数），对玩家实测难度 ρ 0.774。
 * 离线这条路发现真正缺的是「移动」：走多远、走多快、三连音夹角多别扭。
 * 补上之后 142 权重的线性模型到 0.8024，与 69k 参数的 SSM（0.8162）配对检验不显著。
 *
 * ⚠ 口径必须与 tools/build_seq_dataset.py 的 to_feats 逐位一致：
 *   输入用**全部音符**（含 fake）并按时间排序 —— Python 侧不过滤 fake。
 *   正确性靠 tools/export_engine_v3.py 留下的 5 条自检样本对拍，差 < 1e-6 才算完成。
 */
export const V3_DIMS = 20;
export function seqFeatures20(notes){
  const n=notes.length;
  const F=new Float64Array(n*V3_DIMS);
  const ts=new Float64Array(n), xs=new Float64Array(n);
  for(let i=0;i<n;i++){ ts[i]=notes[i].sec; xs[i]=notes[i].x||0; }
  let pt=-1, px=0, strain=0;
  for(let i=0;i<n;i++){
    const o=notes[i], t=ts[i], x=xs[i], b=i*V3_DIMS;
    const dt = pt>=0 ? Math.min(Math.max(t-pt,0),3) : 0;
    F[b]=dt; F[b+1]=Math.log1p(dt*1000);
    F[b+2]=x/675; F[b+3]=Math.abs(x)/675;
    const k=(o.type===1?0:o.type===2?1:o.type===3?2:o.type===4?3:0);
    F[b+4+k]=1;
    F[b+8]=o.above?1:0;
    F[b+9]=Math.log1p((o.hold||0)*1000);
    if(pt>=0){
      const dx=(x-px)/675, dist=Math.abs(dx);
      const sp=Math.min(dist/Math.max(dt,0.025),10);   /* osu! 的 25ms 下限 */
      F[b+10]=dx; F[b+11]=dist; F[b+12]=sp;
      F[b+15]=((x>=0)===(px>=0))?1:0;
      const w=(0.2+2*sp)*((k===0||k===2)?1:0.5);
      strain=strain*Math.exp(-dt/0.4)+w;
      F[b+18]=Math.log1p(Math.min(strain,200));
    }
    if(i>0&&i<n-1){
      const v1x=xs[i]-xs[i-1], v1t=Math.max(ts[i]-ts[i-1],0.025);
      const v2x=xs[i+1]-xs[i], v2t=Math.max(ts[i+1]-ts[i],0.025);
      /* ⚠ 分母的 +1e-9 不能省（原写法是 `||1`，只在 0 时兜底）。
         Python 侧是 norm1*norm2 + 1e-9；两个相邻步长都只有 0.025s 时，
         1e-9 相当于 1.6e-6 的相对修正，而 F+14 = sqrt(1−cos²) 在近直线处
         把它放大成 1.8e-3 的绝对差 —— 那一列的值本身约 1e-3，
         分位数直接错 2% 以上，定数偏 0.021（21029 号谱实测）。
         2026-11-05 对齐 Python 后，同一张谱的定数差 0.0210 → 0.0002。 */
      const cs=(v1x*v2x+v1t*v2t)/((Math.hypot(v1x,v1t)*Math.hypot(v2x,v2t))+1e-9);
      F[b+13]=cs; F[b+14]=Math.sqrt(Math.max(0,1-cs*cs));
    }
    F[b+16]=countWithin(ts,t,0.02);
    F[b+17]=countWithin(ts,t,0.25);
    F[b+19]=Math.log1p(Math.max(t-ts[0],0));
    pt=t; px=x;
  }
  return F;
}
/* 数 |ts[j] - t| <= win 的元素个数。ts 已按时间升序。
   ⚠ 用二分求上下界，**结果与全量扫描逐位相同**（比的是同一批浮点数），
   但复杂度从 O(n²) 降到 O(n log n)。
   为什么必须改：全量扫描在 8000 事件的谱上要 475 ms，而这段默认档（岭回归）
   也要付一次 —— 用户会觉得"拖进去卡了一下"，却看不出是谁的问题。
   双指针滑窗不行：它在边界取舍上与 numpy 差 1 个计数；二分没有这个问题。 */
function countWithin(ts,t,win){
  const lo=t-win, hi=t+win;
  let a=0, b=ts.length;
  while(a<b){ const m=(a+b)>>1; if(ts[m]<lo) a=m+1; else b=m; }
  const left=a;
  a=left; b=ts.length;
  while(a<b){ const m=(a+b)>>1; if(ts[m]<=hi) a=m+1; else b=m; }
  return a-left;
}
/* 142 维池化：mean/std/min/max(4×20) + p10/p50/p90(3×20) + [事件数, Σdt] */
export function pool142(F,n){
  const out=new Float64Array(142);
  const col=new Float64Array(n);
  for(let d=0;d<V3_DIMS;d++){
    let sum=0,mn=Infinity,mx=-Infinity;
    for(let i=0;i<n;i++){ const v=F[i*V3_DIMS+d]; col[i]=v; sum+=v; if(v<mn)mn=v; if(v>mx)mx=v; }
    const mean=sum/n;
    let sq=0; for(let i=0;i<n;i++){ const dv=col[i]-mean; sq+=dv*dv; }
    out[d]=mean; out[20+d]=Math.sqrt(sq/n); out[40+d]=mn; out[60+d]=mx;
    /* ⚠ 用 Float64Array.prototype.sort()（默认数值升序），不要 Array.from(col).sort(cmp)：
       结果逐位相同（同一批浮点数，同样的升序），但后者在 8,000 事件时每个维度
       要跑一次通用比较器排序 —— 实测占掉默认档 3/4 的时间（29.8 → 9 ms）。
       2026-11-05 换掉，v3 的五张自检谱定数差仍然是 0.0000。 */
    const sorted=col.slice().sort();
    const q=p=>{ const idx=(n-1)*p, lo=Math.floor(idx), hi=Math.ceil(idx);
      return sorted[lo]+(sorted[hi]-sorted[lo])*(idx-lo); };
    out[80+d]=q(0.10); out[100+d]=q(0.50); out[120+d]=q(0.90);
  }
  out[140]=n; out[141]=0;
  for(let i=0;i<n;i++) out[141]+=F[i*V3_DIMS];
  return out;
}
export function ridgeV3(notes,W){
  if(!W||!Array.isArray(W.w)||!notes.length) return null;
  const x=pool142(seqFeatures20(notes),notes.length);
  let s=W.b;
  for(let i=0;i<W.w.length;i++) s+=((x[i]-W.mu[i])/(W.sd[i]||1))*W.w[i];
  const m=W.b2d||{slope:1.12,inter:15.99};
  return { b:s, ding:m.slope*s+m.inter };
}

/* ══════════════════════════════════════════════════════════════
 * v4：142 维池化 ‖ 256 维片段手型（A_extent）→ 岭回归
 * ══════════════════════════════════════════════════════════════
 * 手型特征的动机（一句话）：142 维只描述「相邻两个音符」，看不到
 * 「这一小段整体摊开多大」—— 短谱缺的正是这个（短谱 ρ 0.7089 → 0.7614）。
 * 实测 46 个候选指标里只有这 8 个值钱；曲率 / 换向 / 换手 / 同押全部无效。
 *
 * 规格：tools/handshape_spec.md（Python 侧 tools/handshape_features.py）。
 * 布局：index = ((segIdx*8 + statIdx)*8 + metricIdx)，顺序是契约，禁止重排。
 *   segIdx  0:n8(连续8事件) 1:n16(连续16) 2:t05(0.5s 窗) 3:t10(1s 窗)
 *   statIdx 0:mean 1:std 2:min 3:max 4:p10 5:p50 6:p90 7:skew
 *   metricIdx 0:path 1:disp 2:eff 3:bbox_area 4:diag 5:aspect 6:span_x 7:span_y
 *
 * ⚠ 三处**必须照 Python 写、别"顺手修正"**的地方：
 *   1. 路径 / 位移 / 包围盒先在**原始坐标**上求和再除 675（先归一化再求和
 *      会在最后一位上不同，逐位对拍过不去）。
 *   2. `aspect = rx / (ry + 1.0)` 的 +1 是**原始坐标**上的 1 单位平滑。
 *      spec 第 3 节把它写成"归一化后 +1"是笔误 —— 以 engine-v4.json 的
 *      checks（Python 现场算的）为准，JS 这边按 Python 实现。
 *   3. skew 用总体矩 m3/m2^1.5，m2 ≤ 1e-18 时取 0，结果裁 ±20。
 * 输入坐标用**判定线运动后的屏幕坐标**（line-geom.mjs），拿不到就退回
 * positionX / sy=0 —— 那正是 Python 对 PEC 的口径。
 */
/* 屏幕坐标在这里再导出一份：engine.js 的 import 行已经贴着 900 行上限，
   多一行就会把 lint-slop 的第 6 条打红。两份说明符必须带同样的 ?v=。 */
export { withScreenCoords } from './line-geom.mjs?v=V0.26.0.0';
export const HS_DIMS = 256;
const HS_UNIT = 675;
/* [每片事件数 或 窗宽, 是否时间窗] */
const HS_SEGS = [[8, 0], [16, 0], [0.5, 1], [1.0, 1]];
const HS_MIN_EVENTS = 4;

/* 线性插值分位数（与 numpy 默认 / pool142 同口径）。sorted 升序。 */
function hsQuantile(sorted, n, q){
  if(!n) return 0;
  if(n === 1) return sorted[0];
  const h = (n - 1) * q, lo = Math.floor(h), hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/* 一个片段的 8 个指标（入参是原始屏幕坐标）→ out[o..o+8) */
function segExtent(xs, ys, i0, i1, out, o){
  let path = 0;
  for(let i = i0 + 1; i < i1; i++) path += Math.hypot(xs[i] - xs[i-1], ys[i] - ys[i-1]);
  const disp = Math.hypot(xs[i1-1] - xs[i0], ys[i1-1] - ys[i0]);
  let xmn = Infinity, xmx = -Infinity, ymn = Infinity, ymx = -Infinity;
  for(let i = i0; i < i1; i++){
    const x = xs[i], y = ys[i];
    if(x < xmn) xmn = x; if(x > xmx) xmx = x;
    if(y < ymn) ymn = y; if(y > ymx) ymx = y;
  }
  const rx = xmx - xmn, ry = ymx - ymn;
  const p = path / HS_UNIT, d = disp / HS_UNIT;
  out[o]     = p;
  out[o + 1] = d;
  out[o + 2] = d / (p + 1e-9);
  out[o + 3] = (rx * ry) / (HS_UNIT * HS_UNIT);
  out[o + 4] = Math.hypot(rx, ry) / HS_UNIT;
  out[o + 5] = rx / (ry + 1.0);
  out[o + 6] = rx / HS_UNIT;
  out[o + 7] = ry / HS_UNIT;
}

/* 一个指标的片段值序列 → 8 个统计量，写进 out 的 stat 维度 */
function statsInto(col, S, out, seg, metric){
  const base = seg * 64 + metric;
  if(!S) return;                       /* S=0 → 全 0（缓冲已经是 0），不要 NaN */
  const sorted = col.slice().sort();
  let sum = 0;
  for(let i = 0; i < S; i++) sum += col[i];
  const mean = sum / S;
  let m2 = 0, m3 = 0;
  for(let i = 0; i < S; i++){
    const dv = col[i] - mean, q = dv * dv;
    m2 += q; m3 += q * dv;
  }
  m2 /= S; m3 /= S;
  let sk = 0;
  if(m2 > 1e-18){ sk = m3 / Math.pow(m2, 1.5); if(sk > 20) sk = 20; else if(sk < -20) sk = -20; }
  out[base]      = mean;
  out[base + 8]  = Math.sqrt(m2);
  out[base + 16] = sorted[0];
  out[base + 24] = sorted[S - 1];
  out[base + 32] = hsQuantile(sorted, S, 0.10);
  out[base + 40] = hsQuantile(sorted, S, 0.50);
  out[base + 48] = hsQuantile(sorted, S, 0.90);
  out[base + 56] = sk;
}

/* 片段边界 → 扁平 Int32Array（偶数位 i0、奇数位 i1）。
   ⚠ 时间窗是**从首音符起算的全局等宽分箱**，不是滑窗（b 单调不减，一遍扫完）。 */
function segRanges(ts, n, k, isTime){
  if(!isTime){
    const S = Math.floor(n / k);
    const rg = new Int32Array(S * 2);
    for(let i = 0; i < S; i++){ rg[2*i] = i * k; rg[2*i + 1] = i * k + k; }
    return rg;
  }
  const t0 = ts[0];
  const out = [];
  let i = 0;
  while(i < n){
    const b = Math.floor((ts[i] - t0) / k);
    let j = i + 1;
    while(j < n && Math.floor((ts[j] - t0) / k) === b) j++;
    if(j - i >= HS_MIN_EVENTS){ out.push(i, j); }
    i = j;
  }
  return Int32Array.from(out);
}

/* notes → 256 维。screen 可选：{sx, sy}（loadChart 由 line-geom.mjs 算好）。
   没有 screen 时逐音符读 note.sx / note.sy，再退回 note.x / 0（PEC 口径）。 */
export function handshape256(notes, screen){
  const out = new Float64Array(HS_DIMS);
  const total = notes ? notes.length : 0;
  if(total < HS_MIN_EVENTS) return out;
  /* 训练侧在 8,000 事件处截断（先按时间排序再截），这里照做。 */
  const n = Math.min(total, 8000);
  const secs = new Float64Array(n), xs = new Float64Array(n), ys = new Float64Array(n);
  for(let i = 0; i < n; i++){
    const o = notes[i];
    /* 分箱用的是 Python 口径的秒（screen.t）；拿不到才退回 note.sec */
    secs[i] = (screen && screen.t) ? screen.t[i] : o.sec;
    if(screen){ xs[i] = screen.sx[i]; ys[i] = screen.sy[i]; }
    else { xs[i] = o.sx != null ? o.sx : (o.x || 0); ys[i] = o.sy != null ? o.sy : 0; }
  }
  /* 同刻音符按屏幕 x 左→右（Python: np.lexsort((xs, t))，稳定排序）。
     ⚠ 必须稳定：同一 (t, x) 的音符顺序变了，路径长度不变但 round-off 会变。*/
  const idx = new Int32Array(n);
  for(let i = 0; i < n; i++) idx[i] = i;
  const ord = Array.from(idx).sort((a, b) => (secs[a] - secs[b]) || (xs[a] - xs[b]));
  const ts = new Float64Array(n), px = new Float64Array(n), py = new Float64Array(n);
  for(let i = 0; i < n; i++){ const j = ord[i]; ts[i] = secs[j]; px[i] = xs[j]; py[i] = ys[j]; }

  for(let s = 0; s < 4; s++){
    const rg = segRanges(ts, n, HS_SEGS[s][0], HS_SEGS[s][1]);
    const S = rg.length >> 1;
    if(!S) continue;
    const vals = new Float64Array(S * 8);
    for(let i = 0; i < S; i++) segExtent(px, py, rg[2*i], rg[2*i + 1], vals, i * 8);
    const col = new Float64Array(S);
    for(let m = 0; m < 8; m++){
      for(let i = 0; i < S; i++) col[i] = vals[i * 8 + m];
      statsInto(col, S, out, s, m);
    }
  }
  return out;
}

/* v4 推理：398 维（池化 142 ‖ 手型 256）→ 裁 ±clip_z → 岭回归 → IRT b。
   ⚠ 必须裁：398 维里有十几列在训练集上近似常量，sd+1e-6 会把 1e-4 的偏离
     放大成 z≈4000，单列就把 b 推到 −20。漏掉这步是"看着能跑、个别谱离谱"。 */
export function ridgeV4(notes, W, screen){
  if(!W || !Array.isArray(W.w) || !notes.length) return null;
  /* 训练侧在 8,000 事件处截断（load_notes_ex(max_events=8000)），
     pooled 与手型都必须是**截断后**那批 —— notes 已按时间升序，切前 N 个
     与 Python「排序后截断」等价。超过 8,000 的观赏谱不切会落到分布外，
     顺带也把最坏耗时钉死。 */
  const n = Math.min(notes.length, 8000);
  const cur = n === notes.length ? notes : notes.slice(0, 8000);
  const pool = pool142(seqFeatures20(cur), n);
  const ext = handshape256(cur, screen);
  const dp = W.dims_pooled || 142;
  const C = W.clip_z || 8;
  let s = W.b;
  for(let i = 0; i < W.w.length; i++){
    const x = i < dp ? pool[i] : ext[i - dp];
    let z = (x - W.mu[i]) / (W.sd[i] || 1);
    if(z > C) z = C; else if(z < -C) z = -C;
    s += z * W.w[i];
  }
  const m = W.b2d || {slope:1.12, inter:15.99};
  return { b:s, ding:m.slope*s+m.inter };
}

/* 默认档的三级降级：v4(398) → v3(142) → null（调用方退回 v2，再退回 kNN）。
   返回 { ding, basis }，basis 是页面文案要用的算法标识。
   【为什么放在这里】engine.js 贴着 900 行硬上限（lint-slop 第 6 条），
   而这条链是纯数值，搬过来不牵扯解析。顺序不能反：v4 拿得到就用它，
   **不要**同时算 v3 —— 多一次池化只会让默认档变慢，结果也用不上。 */
export function pickRidge(notes, wV4, wV3, screen){
  if(!notes || !notes.length) return null;
  if(wV4){
    const r = ridgeV4(notes, wV4, screen);
    if(r) return { ding:r.ding, basis:'ridge-hs398' };
  }
  if(wV3){
    const r = ridgeV3(notes, wV3);
    if(r) return { ding:r.ding, basis:'ridge-seq20' };
  }
  return null;
}

