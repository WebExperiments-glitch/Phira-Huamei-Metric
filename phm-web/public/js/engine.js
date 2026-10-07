/* ============================================================
 * engine.js —— P.H.M. 谱面解析与难度特征引擎（ESM）
 * ============================================================
 * 【全站唯一的引擎真源】浏览器与 Node 服务端共用这同一份代码。
 *
 * 为什么必须同构 —— 这是「共享定数缓存可被投毒」的解药：
 *   客户端提交的结构特征不可信：攻击者可以伪造一张同名谱面，把假的
 *   ref_const 写进共享缓存，污染所有人看到的结果。
 *   服务端拿到 chart_id 后可以**自己下载谱面**（服务端不受 CORS 限制，
 *   浏览器受这个限制），用这份同样的引擎复算并比对 —— 一致才采纳，
 *   而且采纳的是**服务端算出来的值**，不是客户端报上来的值。
 *   只有一份实现，也就不存在「两份引擎算法漂移」的老问题。
 *
 * ⚠ 维护约束：本文件必须保持**纯计算**。
 *   不碰 DOM、不碰 localStorage、不发网络请求、不读文件系统。
 *   输入 ArrayBuffer → 输出特征对象。任何引入浏览器/Node 专有 API 的
 *   改动都会让另一端跑不起来。加功能前先问：Node 里能跑吗？
 *
 *   ⇒ 所以参照集**不在本文件里**，而是从 ref-official.js 导入 / 由调用方传入：
 *      · 官谱参照（1,037 张）体积小 → 静态导入，见下
 *      · 社区参照（9,509 张，680 KB）→ 调用方用 fetch/fs 读好后当参数传进来
 *     引擎本身不认识 fetch，也不认识 fs。
 * ============================================================ */
"use strict";
import { REF_OFFICIAL, REF_DIMS, ROW_LABELS } from './ref-official.js';
/* 引擎版本 —— 全站唯一来源。改打分/参照/维度/聚合方式都必须改它。
 * com-trim15-v0.5.0：聚合从「加权下中位」换成「加权截尾均值（15%）」——
 *   中位误差 0.500→0.453、均值误差 0.820→0.816，输出分辨率 104→1332 个不同值。
 * ⚠ 版本号一变，历史缓存里 ref_const 与新区间的可比性就断了，
 *   必须重算（tools/warm-cache.mjs --force + tools/reconcile-cache.mjs）。 */
export const ENGINE_VER = 'com-trim15-v0.5.0';
/* 官谱参照（向后兼容既有调用方：攻坚测试探针、tools/*.mjs 都在用它） */
export const OFFICIAL_REF = REF_OFFICIAL;
export { REF_DIMS, REF_OFFICIAL, ROW_LABELS };
/* ── ZIP 读取（无依赖）：EOCD → 中央目录 → 本地头 → 数据 ── */
export function zipParse(buf){
  const u8=new Uint8Array(buf), dv=new DataView(buf);
  // 从尾部找 EOCD 签名 0x06054b50
  let e=-1;
  for(let i=u8.length-22;i>=0 && i>u8.length-66000;i--){
    if(dv.getUint32(i,true)===0x06054b50){e=i;break;}
  }
  if(e<0) throw new Error("不是有效的 ZIP（找不到中央目录）");
  const count=dv.getUint16(e+10,true), cdOff=dv.getUint32(e+16,true);
  /* zip bomb 防护：条目数与解压后总大小都要有硬顶（此前只限制了压缩包体积） */
  const MAX_ENTRIES=800, MAX_TOTAL=400*1024*1024;
  if(count>MAX_ENTRIES) throw new Error("ZIP 条目过多（"+count+" > "+MAX_ENTRIES+"），已拒绝");
  const dec=new TextDecoder(), entries=[];
  let p=cdOff, total=0;
  for(let i=0;i<count;i++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true), csize=dv.getUint32(p+20,true);
    const usize=dv.getUint32(p+24,true);            /* 解压后大小 */
    const nameLen=dv.getUint16(p+28,true), extLen=dv.getUint16(p+30,true),
          cmtLen=dv.getUint16(p+32,true), lho=dv.getUint32(p+42,true);
    const flag=dv.getUint16(p+8,true);
    total+=usize;
    if(total>MAX_TOTAL) throw new Error("ZIP 解压后过大（超过 "
      +Math.round(MAX_TOTAL/1048576)+" MB），可能是压缩炸弹，已拒绝");
    const nameRaw=u8.subarray(p+46,p+46+nameLen);
    const name=dec.decode(nameRaw);
    entries.push({name,method,csize,usize,lho,utf8:!!(flag&0x800)});
    p+=46+nameLen+extLen+cmtLen;
  }
  return {files:entries.map(en=>({
    name:en.name,
    size:en.usize,          /* 解压后大小 —— 用来判断「哪个文件才像谱面」 */
    read:async ()=>{
      const lp=en.lho;
      if(dv.getUint32(lp,true)!==0x04034b50) throw new Error("本地头损坏: "+en.name);
      const nl=dv.getUint16(lp+26,true), el=dv.getUint16(lp+28,true);
      const start=lp+30+nl+el;
      const raw=u8.subarray(start,start+en.csize);
      if(en.method===0) return raw;
      if(en.method===8){
        if(typeof DecompressionStream==="undefined")
          throw new Error("浏览器不支持 DecompressionStream，请换新版 Chrome/Edge");
        const ds=new DecompressionStream("deflate-raw");
        const stream=new Blob([raw]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error("不支持的压缩方法 "+en.method+": "+en.name);
    }
  }))};
}
/* ── 谱面解析：RPE（社区）与 PGR（官方）双格式
   对照 tools/add_community_dims.py 的 read_rpe / read_pgr 逐条一致 ── */
/* ============================================================
 * pickUniqueChart —— 从 Phira 搜索结果里挑出**唯一确定**的那张谱
 * ============================================================
 * 【为什么必须有这个函数】
 * 同一首歌通常有 EZ / HD / IN / AT 四个难度，而它们的 name **完全相同**。
 * 原来的写法只按名字取搜索结果里的第一个：
 *
 *     const hit = list.filter(c => c.name === want)[0];   // ← 危险
 *
 * 于是拖入「Song A IN.pez」，若第一个同名结果是 Song A HD，
 * 就会把 IN 的结构特征写到 HD 的 chart_id 上 —— 这不是理论攻击，
 * 是普通用户正常操作就可能触发的数据错误，而且会污染全站共享缓存。
 *
 * 【策略】逐级消歧，只要无法确定就**放弃**（宁可不写，不可写错）：
 *   1. 名字精确匹配（不区分大小写）
 *   2. 候选只有一个 → 直接用
 *   3. 用难度标签（EZ/HD/IN/AT）筛
 *   4. 用标称定数（±0.05）筛
 *   5. 仍不唯一 → 返回 null，由调用方提示「未写入共享缓存」
 *
 * 纯函数，浏览器与 Node 共用。
 * ============================================================ */
export function pickUniqueChart(list, local) {
  const want = String((local && local.name) || '').trim().toLowerCase();
  if (!want) return { hit: null, reason: 'local-name-missing' };
  let cands = (list || []).filter(c => String(c.name || '').trim().toLowerCase() === want);
  if (!cands.length) return { hit: null, reason: 'no-same-name' };
  if (cands.length === 1) return { hit: cands[0], reason: 'unique-name', candidates: 1 };
  const total = cands.length;
  /* ③ 难度标签 */
  const tier = String((local && local.tier) || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (tier) {
    const byTier = cands.filter(c => String(c.level || '').toUpperCase().indexOf(tier) >= 0);
    if (byTier.length === 1) return { hit: byTier[0], reason: 'unique-tier', candidates: total };
    if (byTier.length) cands = byTier;
  }
  /* ④ 标称定数。注意不要用 replace(/[^\d.]/g,'') 再 parseFloat ——
     'IN Lv.15' 会被滤成 '.15'，parseFloat 得 0.15，匹配直接失效（踩过）。
     用正则直接抓第一个数字。 */
  const lvMatch = String((local && local.levelTxt) || '').match(/(\d+(?:\.\d+)?)/);
  const lv = lvMatch ? parseFloat(lvMatch[1]) : NaN;
  if (isFinite(lv)) {
    const near = cands.filter(c => c.difficulty != null && Math.abs(+c.difficulty - lv) <= 0.05);
    if (near.length === 1) return { hit: near[0], reason: 'unique-difficulty', candidates: total };
    if (near.length) cands = near;
  }
  return { hit: null, reason: 'ambiguous', candidates: total };
}
export function tripleBeats(t){ const a=t[0],b2=t[1],c=t[2]; return c?a+b2/c:a; }
export function makeBpmList(ranges){
  const el=[]; let t=0, lb=0, lbp=null;
  for(const rg of ranges){
    if(lbp!=null) t+=(rg.t-lb)*(60.0/lbp);
    lb=rg.t; lbp=rg.bpm; el.push([rg.t,t,rg.bpm]);
  }
  return { el:el, tb:function(beats){
    if(!this.el.length) return beats*0.5;
    if(beats<this.el[0][0]){ const e0=this.el[0];
      return e0[1]+(beats-e0[0])*60.0/e0[2]; }
    let lo=0, hi=this.el.length-1;
    while(lo<hi){ const m=(lo+hi+1)>>1; if(this.el[m][0]<=beats) lo=m; else hi=m-1; }
    const e=this.el[lo]; return e[1]+(beats-e[0])*(60.0/e[2]);
  }};
}
/* ============================================================
 * PEC（PhiEditer Chart）—— 行式文本谱面格式
 * ============================================================
 * 【为什么必须有】
 *   Phira 上大量谱面是 PEC，而且**存在「文件名是 .json、内容其实是 PEC」的包**
 *   （Re:PhiEdit 的「导出为旧 PEC 格式」就会这样）。
 *   只按后缀名选文件会直接判成「包里没有 .json 谱面文件」或「JSON 解析失败」——
 *   实测金标集 631 张里有 **131 张（20.8%）** 因此算不出来。
 *
 * 【格式】对照 Phigros Wiki / Phigros 自制谱 Wiki：
 *   第 1 行  整数 = offset + 175（毫秒）。**实测不是判定线数**
 *            （样本里 30 / 175 / 0 都出现过，而最大判定线索引分别是 29 / 30 / 29）。
 *            它是全局时间平移，不影响任何相对特征 → 直接忽略。
 *   bp <拍> <bpm>                       速度
 *   cp <线> <拍> <x> <y>                位置（x 0..2048，y 0..1400）
 *   cm <线> <起拍> <终拍> <x> <y> <缓动>  移动
 *   cd <线> <拍> <度数> / cr <线> <起> <终> <度> <缓动>      旋转
 *   ca <线> <拍> <不透明度> / cf <线> <起> <终> <不透明度>    透明度
 *   cv <线> <拍> <速度>                  变速（运动步长 0.05 拍）
 *   n1 <线> <拍> <x> <朝向> <假>             Tap
 *   n2 <线> <起拍> <终拍> <x> <朝向> <假>     Hold
 *   n3 … Flick    n4 … Drag
 *   音符行后面可能各跟一行 `# <速度>` 与 `& <宽度>`，属于该音符的属性。
 *
 * 【两处量纲换算（都实测过，不是猜的）】
 *   ① x：RPE 的坐标系是 **±675**（实测 5 张谱最大 |positionX| 为 585/450/500/495/526，
 *      且取值都是 1350/20=67.5 的整数倍）；PEC 是 **±1024**。
 *      → `x_rpe = x_pec × 675/1024`。这一步不能省：交叉手判据是 `|Δx| > 3.0`，
 *        量纲错了这个特征就全废（而它进 PS 的「结构」项）。
 *   ② cv 速度：wiki 实测「RPE 的 10 ≈ PEC 的 17.111」→ `÷ 1.7111`。
 *      ⚠ 线速峰值（speed_peak）**已经不参与 k-NN 距离** —— 官谱侧它是档位标记
 *      而不是测量值（1,037 张里只有 90 个不同取值，IN 的中位是 999），
 *      拿它做距离会把所有 IN 谱挤成一团。换算保留只是为了特征展示与 PS。
 * ============================================================ */
const PEC_X2RPE = 675 / 1024;
const PEC_CV2RPE = 1 / 1.7111;
/* 判据取自 PhiZone Player：第 1 行是纯整数、第 2 行以 bp 开头 */
export function isPecText(txt) {
  if (!txt || typeof txt !== 'string') return false;
  const ls = txt.split(/\r?\n/);
  if (!/^\s*-?\d+\s*$/.test(ls[0] || '')) return false;
  return /^\s*bp\s/i.test(ls[1] || '') || /^\s*bp\s/i.test(ls[2] || '');
}
export function parsePec(txt) {
  const ls = String(txt).split(/\r?\n/);
  const bps = [];
  const raw = [];
  const lineSeen = new Set();
  let spPeak = 0, cvCount = 0, rotCount = 0, alphaCount = 0, moveDisp = 0;
  for (let i = 0; i < ls.length; i++) {
    const s = ls[i].trim();
    if (!s) continue;
    const sp = s.indexOf(' ');
    const tag = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
    if (tag === '#' || tag === '&') continue;          /* 音符属性行，特征用不到 */
    if (tag === 'bp') {
      const a = s.split(/\s+/);
      const beat = parseFloat(a[1]), bpm = parseFloat(a[2]);
      if (isFinite(beat) && isFinite(bpm) && bpm > 0) bps.push({ t: beat, bpm });
      continue;
    }
    if (tag === 'cv') {
      const a = s.split(/\s+/);
      const v = parseFloat(a[3]);
      if (isFinite(v)) spPeak = Math.max(spPeak, Math.abs(v) * PEC_CV2RPE);
      cvCount++;
      continue;
    }
    if (tag === 'cm') {                                 /* 只进明细展示，不进评分 */
      const a = s.split(/\s+/);
      const x = parseFloat(a[3]), y = parseFloat(a[4]);
      if (isFinite(x) && isFinite(y)) {
        moveDisp += Math.abs((x - 1024) / 1024 * 675) * 880
          + Math.abs((y - 700) / 700 * 675) * 880;
      }
      continue;
    }
    if (tag === 'cd' || tag === 'cr') { rotCount++; continue; }
    if (tag === 'ca' || tag === 'cf') { alphaCount++; continue; }
    if (/^n[1-4]$/.test(tag)) {
      const a = s.split(/\s+/);
      const ln = parseInt(a[1], 10);
      const type = +tag.slice(1);                       /* 与 RPE 的 1/2/3/4 一致 */
      let beat, x, fake;
      if (type === 2) {
        /* ⚠ n2 比 n1/n3/n4 多一个「结束拍数」，字段整体后移一位：
           n2 <线> <起拍> <终拍> <x> <朝向> <假>
           曾经把 x 当成 a[3]（终拍）、把「朝向」当成「假音符」标记读，
           结果一百多个 hold 被当成假音符丢掉，长条占比从 9.6% 掉到 0.4%。 */
        beat = parseFloat(a[2]); x = parseFloat(a[4]); fake = parseInt(a[6], 10) === 1;
      } else {
        /* n1/n3/n4 <线> <拍> <x> <朝向> <假> */
        beat = parseFloat(a[2]); x = parseFloat(a[3]); fake = parseInt(a[5], 10) === 1;
      }
      if (!isFinite(beat) || !isFinite(x)) continue;
      if (ln >= 0) lineSeen.add(ln);
      raw.push({ line: ln < 0 ? 0 : ln, beat, type, x: x * PEC_X2RPE, fake });
    }
  }
  if (!raw.length) throw new Error('PEC 里没有音符');
  if (!bps.length) bps.push({ t: 0, bpm: 120 });
  bps.sort((p, q) => p.t - q.t);
  const merged = [];                                    /* 同拍重复的 bp 合并，避免零长段 */
  for (const b of bps) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.t - b.t) < 1e-9) last.bpm = b.bpm;
    else merged.push({ t: b.t, bpm: b.bpm });
  }
  const bl = makeBpmList(merged.map(b => ({ t: b.t, bpm: b.bpm })));
  const notes = raw.map(n => ({
    sec: bl.tb(n.beat),
    tick: Math.round(n.beat * 32),
    type: n.type, x: n.x, line: n.line, fake: n.fake,
  }));
  notes.sort((a, b) => a.sec - b.sec || a.tick - b.tick);
  const real = notes.filter(n => !n.fake);
  if (!real.length) throw new Error('PEC 里没有真实音符');
  const secs = real.map(n => n.sec);
  const dur = Math.max(1e-3, Math.max.apply(null, secs) - Math.min.apply(null, secs));
  return {
    notes, real, dur, bpm: merged[0].bpm,
    nlines: Math.max(1, lineSeen.size ? Math.max.apply(null, [...lineSeen]) + 1 : 1),
    ev: { move: moveDisp, rot: rotCount, dis: alphaCount, tempo: new Array(cvCount).fill(0) },
    spPeak,
  };
}
export function loadChart(j){
  const lines=j.judgeLineList||[];
  if(!lines.length) throw new Error("没有 judgeLineList（不是 RPE/PGR 谱面）");
  const ev={move:0,rot:0,dis:0,tempo:[]};
  let notes=[], bpm=120.0;
  if(j.BPMList){
    /* RPE：BPMList + 拍三元组。tick = 拍整数部分 × 32（与社区管线一致）*/
    const ranges=(j.BPMList||[]).map(function(b){
        return {t:tripleBeats(b.startTime), bpm:+b.bpm};})
      .filter(function(x){return x.bpm>0;})
      .sort(function(a,b){return a.t-b.t;});
    if(!ranges.length) ranges.push({t:0,bpm:120});
    const bl=makeBpmList(ranges);
    bpm=ranges[0].bpm;
    lines.forEach(function(ln,li){
      /* ★ RPE 的演出事件在 eventLayers 里（对照 read_rpe）：
         speedEvents 计入变速、rotateEvents 计入旋转、posXEvents 计入位移 */
      for(const layer of (ln.eventLayers||[])){
        if(!layer||typeof layer!=="object") continue;
        for(const e of (layer.speedEvents||[])){
          const stt=e.startTime;
          if(stt&&stt.length===3) ev.tempo.push(stt[0]);
        }
        ev.rot+=(layer.rotateEvents||[]).length;
        ev.move+=(layer.posXEvents||[]).length;
      }
      ev.rot+=(ln.rotateEvents||[]).length;
      for(const n of (ln.notes||[])){
        if(n.isFake===1||n.isFake===true) continue;
        const stt=n.startTime;
        if(!stt||stt.length!==3||n.type==null) continue;
        notes.push({sec:bl.tb(tripleBeats(stt)), tick:stt[0]*32.0,
          type:n.type, x:n.positionX||0, line:li, fake:false});
      }
    });
  } else {
    /* PGR：time 为 1/32 拍 tick，bpm 取第一个非空行 */
    let bpm0=120.0;
    for(const ln of lines){ if(ln.bpm){ bpm0=+ln.bpm; break; } }
    bpm=bpm0;
    const r=60.0/32.0/bpm0;
    lines.forEach(function(ln,li){
      for(const e of (ln.judgeLineMoveEvents||[])){
        const st=e.startTime,en=e.endTime;
        if(st==null||en==null) continue;
        const dur=(en-st)*r; if(dur<=0) continue;
        const x0=e.start||0,x1=e.end||0,y0=e.start2||0,y1=e.end2||0;
        ev.move+=Math.abs((x1-x0)*880)+Math.abs((y1-y0)*880);
      }
      ev.rot+=(ln.judgeLineRotateEvents||[]).length;
      ev.dis+=(ln.judgeLineDisappearEvents||[]).length;
      const se=ln.speedEvents||[];
      for(let i=1;i<se.length;i++){
        if(se[i].startTime!=null) ev.tempo.push(se[i].startTime*r);
      }
      for(const key of ["notesAbove","notesBelow"]){
        for(const nn of (ln[key]||[])){
          const t=nn.time;
          if(t==null||nn.type==null) continue;
          notes.push({sec:t*r, tick:t*32.0, type:nn.type,
            x:nn.positionX||0, line:li, fake:false});
        }
      }
    });
  }
  if(!notes.length) throw new Error("谱面里没有音符");
  notes.sort(function(a,b){return a.sec-b.sec||a.tick-b.tick;});
  const real=notes.filter(function(n){return !n.fake;});
  const secs=real.map(function(n){return n.sec;});
  const dur=Math.max(1e-3,Math.max.apply(null,secs)-Math.min.apply(null,secs));
  return {notes:notes, real:real, dur:dur, bpm:bpm,
          nlines:lines.length, ev:ev};
}
/* ── 加权密度（对照 strain_features）── */
export function pyRound(x,d){ const m=Math.pow(10,d); return Math.round(x*m)/m; }
export function strainFeatures(ts,ty,window){
  window=window||1.0;
  const n=ts.length; if(!n) return {};
  const COST={1:1.0,2:1.0,3:0.35,4:0.55};
  const pre=new Array(n+1).fill(0);
  for(let i=0;i<n;i++) pre[i+1]=pre[i]+(COST[ty[i]]!=null?COST[ty[i]]:1.0);
  const step=window/20, vals=[];
  let t=ts[0]; const last=ts[n-1];
  const lb=(arr,x)=>{let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m]<x)lo=m+1;else hi=m;}return lo;};
  while(t<=last+1e-9){
    const i0=lb(ts,t), i1=lb(ts,t+window);
    let span=Math.min(t+window,last+1e-9)-t;
    if(span<=1e-6) span=window;
    if(i1-i0>=5) vals.push((pre[i1]-pre[i0])/span);
    t+=step;
  }
  if(!vals.length){
    const r2=pyRound(pre[n]/Math.max(last-ts[0],1e-6),4);
    return {strain_peak:r2,strain_p50:r2,strain_p90:r2,strain_p99:r2,strain_raw_max:r2};
  }
  const vs=vals.slice().sort((a,b)=>a-b);
  const pick=q=>vs[Math.min(Math.floor(vs.length*q),vs.length-1)];
  return {strain_peak:pyRound(pick(0.99),4),strain_p50:pyRound(pick(0.50),4),
          strain_p90:pyRound(pick(0.90),4),strain_p99:pyRound(pick(0.99),4),
          strain_raw_max:pyRound(vs[vs.length-1],4)};
}
/* ── 节奏（对照 rhythm_features）── */
export function rhythmFeatures(ts){
  const n=ts.length; if(n<3) return {};
  const d=[]; for(let i=0;i<n-1;i++) if(ts[i+1]>ts[i]) d.push(ts[i+1]-ts[i]);
  if(!d.length) return {};
  const ds=d.slice().sort((a,b)=>a-b);
  const sum=d.reduce((a,b)=>a+b,0);
  return {iv_mean:pyRound(sum/d.length,4),
    iv_median:pyRound(ds[Math.floor(ds.length/2)],4),
    chord_ratio:pyRound(d.filter(x=>x<0.050).length/d.length*100,3),
    fast_ratio:pyRound(d.filter(x=>x<0.150).length/d.length*100,3)};
}
/* ── 结构维度（历史参照：一个不在本仓库内的 Python 原型 dims14.py）── */
export function unionLen(iv){
  if(!iv.length) return 0;
  const s=iv.slice().sort((a,b)=>a[0]-b[0]);
  let total=0, cs=s[0][0], ce=s[0][1];
  for(let i=1;i<s.length;i++){
    if(s[i][0]>ce){total+=ce-cs;cs=s[i][0];ce=s[i][1];}
    else ce=Math.max(ce,s[i][1]);
  }
  return total+(ce-cs);
}
export function effCount(ticks){
  if(ticks.length<2) return ticks.length;
  let c=1;
  for(let i=1;i<ticks.length;i++) if(ticks[i]-ticks[i-1]>=1) c++;
  return c;
}
export function extractDims(notes,ev,dur,bpm,nlines){
  const n=notes.length; if(!n) return {};
  const ds=Math.max(dur,0.01);
  const ts=notes.map(x=>x.sec), ticks=notes.map(x=>x.tick),
        types=notes.map(x=>x.type), xs=notes.map(x=>x.x);
  const out={};
  const core=[]; for(let i=0;i<n;i++) if(types[i]===1||types[i]===2) core.push([ts[i],ticks[i]]);
  const coreT=core.map(a=>a[0]), coreK=core.map(a=>a[1]);
  out.real_core_notes_per_second=core.length/ds;
  out.real_notes_per_second=n/ds;
  let effPeak=0; const effVals=[];
  if(core.length>5){
    let r2=0;
    for(let l=0;l<coreT.length;l++){
      while(r2<coreT.length&&coreT[r2]-coreT[l]<=1.0) r2++;
      const e=effCount(coreK.slice(l,r2));
      if(e>effPeak) effPeak=e;
      effVals.push(e);
    }
  } else effVals.push(core.length);
  out.eff_peak_tps_1s=effPeak;
  out.eff_avg_tps_1s=effVals.length?effVals.reduce((a,b)=>a+b,0)/effVals.length:0;
  const rcnps=out.real_core_notes_per_second;
  if(coreT.length>5){
    const aw=[], ai=[];
    let left=0;
    for(let right=0;right<coreT.length;right++){
      while(coreT[right]-coreT[left]>1.0) left++;
      const w=right-left+1;
      if(w>=rcnps){aw.push(w);ai.push([Math.max(0,coreT[right]-1.0),coreT[right]]);}
    }
    out.above_avg_density_mean=aw.length?aw.reduce((a,b)=>a+b,0)/aw.length:rcnps;
    out.above_avg_duration_sec=unionLen(ai);
    out.above_avg_density_ratio=aw.length/Math.max(coreT.length,1);
  } else {out.above_avg_density_mean=rcnps;out.above_avg_duration_sec=0;}
  const byT=new Map();
  for(const nt of notes){const k2=nt.sec.toFixed(3);
    if(!byT.has(k2))byT.set(k2,[]); byT.get(k2).push(nt.x);}
  const sizes=[]; for(const[,v]of byT)sizes.push(v.length);
  if(sizes.length>1){
    const cnt={}; sizes.forEach(sz=>cnt[sz]=(cnt[sz]||0)+1);
    const tot=sizes.length, ks=Object.keys(cnt);
    let ent=0; for(const k2 of ks){const c=cnt[k2]/tot;ent-=c*Math.log2(c);}
    const mx=ks.length>1?Math.log2(ks.length):1;
    out.chord_size_entropy=mx>0?ent/mx:0;
  } else out.chord_size_entropy=0;
  out.avg_chord_size=sizes.length?sizes.reduce((a,b)=>a+b,0)/sizes.length:1.0;
  let mf=0,mf3=0;
  for(const[,v]of byT){const sz=v.length;if(sz>=3){mf+=sz*(sz-1)/2;mf3++;}}
  out.weighted_mf_score_per_sec=mf/ds;
  out.multi_finger_3plus_events=mf3;
  const stairs=[]; let run=[0];
  for(let i=1;i<n;i++){
    if(ts[i]-ts[i-1]<0.18&&types[i]===1&&types[i-1]===1) run.push(i);
    else{if(run.length>=4){const dd=ts[run[run.length-1]]-ts[run[0]];
      if(dd>0.01)stairs.push(run.length/dd);} run=[i];}
  }
  if(run.length>=4){const dd=ts[run[run.length-1]]-ts[run[0]];
    if(dd>0.01)stairs.push(run.length/dd);}
  out.stair_speed_avg=stairs.length?stairs.reduce((a,b)=>a+b,0)/stairs.length:0;
  out.stair_speed_max=stairs.length?Math.max.apply(null,stairs):0;
  out.stair_density=stairs.length/ds;
  let sw=0; for(let i=1;i<n;i++) if(types[i]!==types[i-1]) sw++;
  out.pattern_switch_rate=sw/ds; out.type_switch_per_sec=sw/ds;
  out.tempo_change_count=(ev.tempo||[]).length;
  out.hold_ratio=types.filter(t=>t===2).length/n;
  let fast=0; for(let i=1;i<n;i++) if(ts[i]-ts[i-1]<0.1) fast++;
  out.note_clutter_ratio=fast/Math.max(n-1,1)*100;
  out.drag_per_sec=types.filter(t=>t===4).length/ds;
  let ch=0; for(let i=1;i<n;i++)
    if(ts[i]-ts[i-1]<0.25&&Math.abs(xs[i]-xs[i-1])>3.0) ch++;
  out.cross_hand_density=ch/ds;
  const px={}; xs.forEach(x=>{px[x]=(px[x]||0)+1;});
  let pe=0; for(const k2 in px){const c=px[k2]/n; pe-=c*Math.log2(c);}
  out.position_entropy=pe;
  out.jline_move_disp_per_sec=ev.move/ds;
  out.jline_rotate_density=ev.rot/ds;
  out.jline_disappear_density=ev.dis/ds;
  out.duration_s=ds; out.bpm=bpm; out.lines=nlines; out.notes_real=n;
  return out;
}
/* ============================================================
 * k-NN 参考定数 —— 引擎的核心输出
 * ============================================================
 * 【方法】取出这张谱的 8 维结构特征 → 在参照集里找最近的 20 张 →
 *   按距离高斯加权取"加权中位数"。就这么简单，没有任何拟合系数。
 *
 * 【为什么是可审计的】输出就是「这 20 张谱的定价中位」，逐张可查、
 *   可以自己拿名字去 Phira 搜。没有黑箱参数，没有训练出来的权重。
 *
 * 【为什么是 8 维而不是更多】实测（docs/ENGINE-EXPERIMENT.md）：
 *   4 维 |偏差|均值 0.892 → 8 维 0.815 → 12 维 0.810 → 26 维（岭回归）1.042。
 *   8 → 12 的收益（0.005，不到 1%）不足以补偿多出来的参照集体积，
 *   所以停在 8。全局线性模型（岭回归）明显更差 —— 特征→定数是非线性的，
 *   这印证了「查表 + 局部近邻」比「拟合公式」更合适。
 *
 * 【两份参照集，不是一个】
 *   官谱标度 = Phigros 官谱的人工标注，是**与官方一致**的绝对标度；
 *   社区共识 = Phira 社区谱的谱师声明值，是**站内同行实际定价**的共识。
 *   两者结构分布不同（社区谱 p50 15.1 vs 官谱 10.6；长条占比只有官谱 1/3），
 *   所以对同一张谱会给出不同的数字 —— 这不是误差，这是**信息**。
 *   前端并列展示两个值，而不是假装只有一个真值。
 * ============================================================ */
/* 参照集行格式：[定数, 档位码, 曲名, 谱面ID, ...REF_DIMS]（ROW_LABELS 由生成器导出，
   单一真源在 tools/gen-ref.mjs —— 不要在这里硬编码 3 或 4）
   ⚠ 特征从**下标 ROW_LABELS** 开始 —— 前面几列是标签，不是特征。
     踩过的坑：曾写成 `c<3 ? v : log1p(v)` 直接 map 整行，于是把"曲名"
     这个字符串也 log1p 了，得到 NaN，所有距离全废（表现为每张谱都返回恒定值）。 */
const featOf = r => {
  const x = new Array(REF_DIMS.length);
  for (let c = 0; c < x.length; c++) x[c] = Math.log1p(Math.max(+r[ROW_LABELS + c] || 0, 0));
  return x;
};

/** 参照集预索引：把 9,509 行 × 8 维的 log/z-score 统计量算一次并缓存。
 *  不缓存的话每张谱都要重算一遍 76,000 次 log 与方差，纯浪费。
 *  用 Map 以数组自身为键 —— 同一份参照集只算一次。 */
const _idxCache = new Map();
export function makeRefIndex(rows) {
  if (!rows || !rows.length) return null;
  const hit = _idxCache.get(rows);
  if (hit) return hit;
  const p = REF_DIMS.length;
  const X = rows.map(featOf);
  const mu = new Array(p).fill(0), sd = new Array(p).fill(0), n = X.length;
  for (const x of X) for (let c = 0; c < p; c++) mu[c] += x[c] / n;
  for (const x of X) for (let c = 0; c < p; c++) sd[c] += (x[c] - mu[c]) ** 2 / n;
  for (let c = 0; c < p; c++) sd[c] = Math.sqrt(sd[c]) || 1;
  /* ★ Z 预标准化。踩过的坑：只存原始 log 值（X）、却在距离里拿它去减
     已经标准化的 q，量纲差了整整一个 sd，于是每张谱都匹配到最"小"的参照行
     （返回恒为 1.0/2.0）。"参照侧与查询侧必须在同一坐标系"这件事
     在这个项目里已经错过两次了（另一次是岭回归实验），所以这里显式命名 Z 并只用它。 */
  const Z = X.map(x => x.map((v, c) => (v - mu[c]) / sd[c]));
  const idx = { rows, Z, mu, sd, p, n, zVector: v => v.map((raw, c) => (raw - mu[c]) / sd[c]) };
  _idxCache.set(rows, idx);
  return idx;
}
/** 把一张谱的特征对象转成参照集行格式的 8 维（去掉前面的 定数/档位/曲名 三列） */
function featsToDims(f, spPeak) {
  /* speed_peak 刻意不进 8 维：官谱侧它是档位标记不是测量值
     （1,037 张里只有 90 个不同取值：IN 中位 999），拿它做距离会把 IN 谱全挤在一起。
     实测去掉它在官谱 4 维上几乎无变化（0.700→0.700）。*/
  void spPeak;
  const x = new Array(REF_DIMS.length);
  for (let c = 0; c < x.length; c++) {
    const v = +f[REF_DIMS[c]];
    x[c] = Math.log1p(isFinite(v) && v > 0 ? v : 0);
  }
  return x;
}
const K_NEIGHBORS = 20;      /* 近邻数：k=10/20/30/40 实测差异 <1%，取 20 兼顾小区间 */
const BANDWIDTH = 2.0;       /* 高斯核带宽系数（对照 phm/core.py KNN_BW） */
/**
 * 求参考定数。
 * @param {object}  f        特征对象（extractDims 的输出）
 * @param {number}  spPeak   线速峰值（当前不参与距离，保留签名以兼容调用方）
 * @param {Array}   refRows  参照集；不传 = 用官谱参照
 * @param {string}  basis    参照集标识（'official' / 'community' / 自定义）
 * @param {number}  excludeId 已知 chart_id 时排除自身（见下）
 * @returns {{ref,tier,lo,hi,q1,q3,n20,near,basis,spread,d1,dMean,selfExcluded}|null}
 *
 * ★ 为什么要 excludeId：参照集里装着被测谱**自己**。
 *   不排除就是"拿它自己的声明值当中位"——距离 0 的自匹配，
 *   误差看起来完美（0.00），实际整个工具退化成了橡皮图章。
 *   这个坑非常隐蔽，实测时它把 |偏差| 从 0.81 伪装成 0.34。
 *   前端从搜索结果/缓存点进来时能拿到 chart_id，必须传进来；
 *   拖入本地 zip 时不知道 id，就排除不了（此时通常也还没入参照集）。
 */
export function knnReference(f, spPeak, refRows, basis, excludeId) {
  const idx = makeRefIndex(refRows || REF_OFFICIAL);
  if (!idx) return null;
  const q = idx.zVector(featsToDims(f, spPeak));
  const skip = excludeId != null && excludeId !== 0;
  const dists = [];
  let selfExcluded = false;
  for (let i = 0; i < idx.n; i++) {
    if (skip && idx.rows[i][3] === excludeId) { selfExcluded = true; continue; }
    const x = idx.Z[i];
    let d2 = 0;
    for (let c = 0; c < idx.p; c++) { const t = x[c] - q[c]; d2 += t * t; }
    dists.push([Math.sqrt(d2), i]);
  }
  if (dists.length < K_NEIGHBORS) return null;
  dists.sort((a, b) => a[0] - b[0]);
  const near = dists.slice(0, K_NEIGHBORS);
  const scale = Math.max(near[near.length - 1][0], 1e-6);
  /* ══ 聚合：加权**截尾均值**（去掉按定数排序后首尾各 15% 权重，再加权平均）══
     一度用的是加权中位数。换掉的原因是可测量的（见 docs/ENGINE-EXPERIMENT.md）：

       方案              |偏差|中位  |偏差|均值    p90    ≤1.0    唯一输出值数
       加权下中位            0.500      0.820   1.40   84.2%      104
       加权截尾均值          0.453      0.816   1.41   81.8%     1332   ← 现在用这个
       加权平均              0.521      0.872   1.62   77.0%     1325
       插值分位              0.464      0.818   1.40   82.9%      920

     中位数的问题**不在准确度，在分辨率**：它的输出必然是某个邻居的真实取值，
     而 Phira 上谱师声明的定数在 14/15/16 有巨大尖峰（"15" 一档就占 12%）。
     结果是 650 张谱只产出 **104 个不同数字**、14.6% 恰好是整数 ——
     连算几张都会看到同一个 15.0，看起来像没算。
     截尾均值把唯一输出提到 1332（12.8 倍）、整数占比降到 0.0%，
     同时中位数误差与均值误差都**变好**（0.500→0.453 / 0.820→0.816）。
     只付了 ≤1.0 命中率 84.2%→81.8%（−2.4pp）的代价。

     为什么是"截尾"而不是直接平均：官谱/社区定数都是人工标注、噪声约 2.8 级，
     直接平均会被一张标错的谱整个拽走（实测：加权平均的 p90 从 1.41 恶化到 1.62）。
     砍掉两端各 15% 权重等于"先扔掉最极端的 3 张再平均"，抗离群与连续兼得。 */
  const TRIM = 0.15;
  const pairs = near.map(([d, i]) => [idx.rows[i][0], Math.exp(-((d / scale) ** 2) * BANDWIDTH)])
    .sort((a, b) => a[0] - b[0]);
  let tot = 0; for (const p of pairs) tot += p[1];
  const cut = tot * TRIM;
  const mid = (function () {
    let acc = 0, sw = 0, sv = 0;
    for (const [v, w] of pairs) {
      const lo = acc, hi = acc + w; acc = hi;
      /* 与 [cut, tot-cut] 区间的重叠权重 —— 被截到一半的两端邻居按比例计入 */
      const keep = Math.min(hi, tot - cut) - Math.max(lo, cut);
      if (keep > 0) { sw += keep; sv += v * keep; }
    }
    return sw > 0 ? sv / sw : pairs[Math.floor(pairs.length / 2)][0];
  })();
  /* 档位：邻居里出现最多的那个（只是给个"这谱大概是什么难度"的直觉） */
  const lvCount = {};
  near.forEach(([, i]) => { const lv = idx.rows[i][1]; lvCount[lv] = (lvCount[lv] || 0) + 1; });
  let tier = -1, best = -1;
  for (const lv in lvCount) if (lvCount[lv] > best) { best = lvCount[lv]; tier = +lv; }
  /* ★ 不确定度 —— 这是这个工具最该公开的东西。
     20 个邻居的定数跨度就是这个数的不确定范围：跨度大 = 模型自己也没把握。
     只给一个中点数字（"你的谱是 11.6"）是不诚实的，因为那 20 个邻居
     可能从 9.5 横跨到 14.5 —— 单看中点等于假装精确。 */
  const d20 = near.map(([, i]) => idx.rows[i][0])
    .filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  /* 平均邻居距离（z-score 空间）：用来说明「这张谱在参照集里有多边缘」。
     官谱参照下社区谱的这个值普遍偏大 —— 那正是换参照集的实测依据。 */
  let dsum = 0; for (const [d] of near) dsum += d;
  const dMean = dsum / near.length;
  return {
    ref: mid, tier: tier < 0 ? '?' : ['EZ', 'HD', 'IN', 'AT', 'SP'][tier] || '?',
    basis: basis || 'official',
    lo: d20.length ? d20[0] : null, hi: d20.length ? d20[d20.length - 1] : null,
    q1: d20.length ? d20[Math.floor(d20.length * 0.25)] : null,
    q3: d20.length ? d20[Math.floor(d20.length * 0.75)] : null,
    spread: d20.length ? d20[d20.length - 1] - d20[0] : null,
    d1: near[0][0], dMean, n20: d20.length, selfExcluded,
    near: near.slice(0, 5).map(([, i]) => ({
      name: idx.rows[i][2], level: ['EZ', 'HD', 'IN', 'AT', 'SP', '?'][idx.rows[i][1]],
      diff: idx.rows[i][0],
    })),
  };
}
/* ── 线速峰值（speedEvents |value| 最大值，eventLayers + 顶层）── */
export function speedPeakOfChart(j){
  /* ⚠️ RPE 170 speedEvents 用 start/end 表示线速倍率（无 value）；
     实测：正常 AT ~110，演出陷阱谱 3550（32 倍） */
  let mx=0;
  for(const ln of (j.judgeLineList||[])){
    for(const layer of (ln.eventLayers||[])){
      if(!layer||typeof layer!=="object") continue;
      for(const e of (layer.speedEvents||[])){
        if(!e) continue;
        for(const fk of ["start","end","value"]){
          if(e[fk]!=null && isFinite(+e[fk])) mx=Math.max(mx,Math.abs(+e[fk]));
        }
      }
    }
    for(const e of (ln.speedEvents||[])){
      if(!e) continue;
      for(const fk of ["start","end","value"]){
        if(e[fk]!=null && isFinite(+e[fk])) mx=Math.max(mx,Math.abs(+e[fk]));
      }
    }
  }
  return mx;
}
/* ── P.H.M. Standard 公式（**唯一真源就是这里**；曾与一个仓库外的 Python 原型逐常数对照）── */
export function sat(v,k){ return v<=0?0:1-Math.exp(-v/k); }
export function satd(v,k){ return v<=0?0:Math.exp(-v/k); }
export const K={strain_p99:20.4,above_avg_density_mean:10.7081,
  real_notes_per_second:9.5682,iv_mean:0.1413,
  stair_speed_max:33.7778,cross_hand_density:7.5408,
  note_clutter_ratio:68.2235,pattern_switch_rate:3.0663,
  avg_chord_size:1.4539,multi_finger_3plus_events:0.3366,
  chord_size_entropy:0.6203,real_core_notes_per_second:6.7287,
  notes_real:1441.0};
export function gDensity(f){ return 0.35*sat(f.strain_p99,K.strain_p99)
  +0.25*sat(f.above_avg_density_mean,K.above_avg_density_mean)
  +0.25*sat(f.real_notes_per_second,K.real_notes_per_second)
  +0.15*satd(f.iv_mean,K.iv_mean); }
export function gPattern(f){ return 0.35*sat(f.stair_speed_max,K.stair_speed_max)
  +0.30*sat(f.cross_hand_density,K.cross_hand_density)
  +0.20*sat(f.note_clutter_ratio,K.note_clutter_ratio)
  +0.15*sat(f.pattern_switch_rate,K.pattern_switch_rate); }
export function gCoord(f){ return 0.35*sat(f.avg_chord_size,K.avg_chord_size)
  +0.35*sat(f.multi_finger_3plus_events/Math.max(f.duration_s,0.01),K.multi_finger_3plus_events)
  +0.30*sat(f.chord_size_entropy,K.chord_size_entropy); }
export function gStamina(f){ return 0.60*sat(f.real_core_notes_per_second,K.real_core_notes_per_second)
  +0.40*sat(f.notes_real,K.notes_real); }
export function psScore(f){
  const g={density:gDensity(f),pattern:gPattern(f),
           coord:gCoord(f),stamina:gStamina(f)};
  return {total:20*(0.40*g.density+0.30*g.pattern+0.15*g.coord+0.15*g.stamina),g:g};
}
/* 从「已归一化的谱面」构建报告 —— RPE/PGR 与 PEC 三条路共用同一套特征与打分。
   有了它，「支持新格式」就只是「把新格式归一成 {notes,real,dur,bpm,nlines,ev}」这一件事。

   ★ 双标度：同一张谱同时在**两份参照集**上查一次。
     knn      = 社区参照（9,509 张 Phira 社区谱）→ 主结果。谱师实际会看到的就是这个标度。
     knnOff   = 官谱参照（1,037 张 Phigros 官谱）→ 与官方一致的绝对标度。
     两者之差是**系统性分布差异**，不是误差 —— 前端必须并列展示并说明来源，
     只报一个数字才是真的误导（"IN 14 算出 11.6"就是只报官谱标度的产物）。 */
export function reportFromChart(r,name,meta,spPeak,refCom,excludeId){
  const ts=r.real.map(n=>n.sec), ty=r.real.map(n=>n.type);
  const f=Object.assign({},
    strainFeatures(ts,ty), rhythmFeatures(ts),
    extractDims(r.real,r.ev,r.dur,r.bpm,r.nlines));
  f.notes_all=r.notes.length;
  const ps=psScore(f);
  const sp=(spPeak==null?0:spPeak);
  const knnOff=knnReference(f,sp,REF_OFFICIAL,'official');
  const knn =refCom&&refCom.length?knnReference(f,sp,refCom,'community',excludeId):knnOff;
  return {name:meta.name||name, level:meta.level||knn.tier||"", charter:meta.charter||"",
    feats:f, ps:ps, knn:knn, knnOff:knnOff, engineVer:ENGINE_VER, spPeak:sp, bpm:r.bpm};
}
/* ── analyze(fileBytes, fileName[, opts]) → 报告对象数组 ──
   opts.refCom：社区参照集行数组（由调用方读文件/fetch 后传入）。
   不传也能跑 —— 退回只用官谱参照，只是少了"社区共识"那一栏。 */
export async function analyzeChart(buf,fileName,opts){
  const refCom=(opts&&opts.refCom)||null;
  const excludeId=(opts&&opts.excludeId!=null)?+opts.excludeId:null;
  const zip=zipParse(buf);
  const reports=[];
  /* ⚠ 谱面文件靠**内容嗅探**，不靠后缀名。
     Phira 上确实存在「文件名叫 .json、内容其实是 PEC」的包
     （Re:PhiEdit 的「导出为旧 PEC 格式」就是这样），按后缀名会直接判错。
     先把媒体/资源排除掉，剩下的不多了，逐个读进来嗅。 */
  const MEDIA=/\.(mp3|ogg|wav|flac|m4a|aac|opus|jpg|jpeg|png|gif|webp|bmp|mp4|mov|webm|avi|ttf|otf|woff2?|pbc|pdb|dll|exe|zip|7z|rar)$/i;
  const cands=zip.files.filter(x=>!MEDIA.test(x.name))
    .sort((a,b)=>(b.size||0)-(a.size||0))    /* 谱面通常是包里最大的那个文本文件 */
    .slice(0,12);                            /* 最多看 12 个，别把整包都读了 */
  if(!cands.length) throw new Error("包里没有可解析的文件");
  let meta={};
  const yml=zip.files.find(x=>/info\.ya?ml$/i.test(x.name));
  if(yml){
    try{
      const txt=new TextDecoder("utf-8").decode(await yml.read());
      const pick=re=>{const m2=txt.match(re);
        return m2?m2[1].trim().replace(/^["']|["']$/g,""):null;};
      meta={name:pick(/^name:\s*(.+)$/m),level:pick(/^level:\s*(.+)$/m),
            charter:pick(/^charter:\s*(.+)$/m)};
    }catch(e){}
  }
  for(const en of cands){
    let txt;
    try{ txt=new TextDecoder("utf-8").decode(await en.read()); }
    catch(e){ continue; }                    /* 解压失败（二进制等）→ 跳过，不是错误 */
    if(txt.charCodeAt(0)===0xFEFF) txt=txt.slice(1);
    if(isPecText(txt.slice(0,512))){
      try{
        const r=parsePec(txt);
        reports.push(Object.assign(reportFromChart(r,en.name,meta,r.spPeak,refCom,excludeId),{file:fileName}));
      }catch(e){
        reports.push({file:fileName,name:en.name,error:"PEC 解析失败: "+e.message});
      }
      continue;
    }
    /* 不是 PEC 又不以 { 开头 → info.txt / .csv / yml 之类，静默跳过（别制造假报错）*/
    if(txt.trimStart()[0]!=="{") continue;
    let j;
    try{ j=JSON.parse(txt); }
    catch(e){ reports.push({file:fileName,name:en.name,error:"JSON 解析失败: "+e.message}); continue; }
    if(!j.judgeLineList) continue;           /* 非 RPE/PGR 谱面（如 meta json） */
    const r=loadChart(j);
    reports.push(Object.assign(reportFromChart(r,en.name,meta,speedPeakOfChart(j),refCom,excludeId),{file:fileName}));
  }
  if(!reports.length) throw new Error("包里没有找到可解析的谱面（支持 RPE / PGR / PEC）");
  return reports;
}
