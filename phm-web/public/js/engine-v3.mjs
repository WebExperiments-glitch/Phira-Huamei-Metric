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
      const cs=(v1x*v2x+v1t*v2t)/((Math.hypot(v1x,v1t)*Math.hypot(v2x,v2t))||1);
      F[b+13]=cs; F[b+14]=Math.sqrt(Math.max(0,1-cs*cs));
    }
    F[b+16]=countWithin(ts,t,0.02);
    F[b+17]=countWithin(ts,t,0.25);
    F[b+19]=Math.log1p(Math.max(t-ts[0],0));
    pt=t; px=x;
  }
  return F;
}
/* 与 Python 的 np.sum(np.abs(ts - t) <= win) **逐元素同义**。
   之前用双指针滑窗，理论等价，但实测在某张谱上与 numpy 的浮点比较差 1 个计数
   （边界处 t-ts 与 win 相等时的舍入）。这里直接全量扫，n≈2000 → 4M 次比较，
   单谱约 5 ms，可接受；正确性优先于这点性能。 */
function countWithin(ts,t,win){
  let c=0;
  for(let j=0;j<ts.length;j++) if(Math.abs(ts[j]-t)<=win) c++;
  return c;
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
    const sorted=Array.from(col).sort((a,b)=>a-b);
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

