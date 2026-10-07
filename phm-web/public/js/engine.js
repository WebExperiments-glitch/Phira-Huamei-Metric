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
 * ============================================================ */

"use strict";
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

/* ── 结构维度（对照 tools/dims14.py extract_dims）── */
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

/* ── P.H.M. Standard 公式（对照 tools/phm_standard.py，逐常数一致）── */
/* ── 官谱参照：1,037 张官方谱（k-NN 参考定数的查表）
   [name, level, 官方定数, nps, hold%, notes, stair_avg]
   由 data/official.jsonl 裁剪生成 ── */
export const OFFICIAL_REF=[["000 -Ain Soph Aur-","EZ",2.5,1.181,26.32,171,0,1.5],["000 -Ain Soph Aur-","HD",8.4,2.563,37.47,371,0,100],["000 -Ain Soph Aur-","IN",14.4,5.157,12.19,689,11.79,999],["70 Minutes Fighters","EZ",7.5,2.859,6.58,365,8.67,1.8],["70 Minutes Fighters","HD",12.5,5.625,23.86,725,14.12,1.8],["70 Minutes Fighters","IN",16.5,11.482,31.6,1557,14.42,999],["996","EZ",4,2.722,46.94,392,0,2],["996","HD",9.4,3.146,29.58,453,0,9999],["996","IN",14.7,7.064,26.31,996,11.06,9999],["ABYSS MOTION 192.333","EZ",4,2.618,47.19,320,0,999],["ABYSS MOTION 192.333","HD",9.7,4.443,37.57,543,7.74,999],["ABYSS MOTION 192.333","IN",14.7,6.667,17.3,815,10.93,2.1],["ATHAZA","EZ",8.6,3.417,25.05,479,0,999],["ATHAZA","HD",12.9,4.723,22.96,662,11.56,999],["ATHAZA","IN",15.7,7.418,16.71,1137,16.51,999],["ATHAZA","AT",16.6,9.588,11.68,1344,19.74,2.3],["About The Universe","EZ",4.5,2.125,38.31,261,0,1.8],["About The Universe","HD",9.7,3.528,13.13,434,7.15,3.6],["About The Universe","IN",14.4,4.496,5.38,595,10.52,999],["AbsoluTe disoRdeR","EZ",6.5,4.127,67.1,766,0,999],["AbsoluTe disoRdeR","HD",12.4,6.13,43.98,1046,10.78,99],["AbsoluTe disoRdeR","IN",16.3,8.62,22,1600,20.07,999],["AbsoluTe disoRdeR","AT",17.2,11.368,19.41,2025,22.22,999],["Ad astra per aspera","EZ",6.5,5.101,55.46,696,8.21,1.8],["Ad astra per aspera","HD",12.1,6.772,58.98,924,11,999],["Ad astra per aspera","IN",16.3,10.481,25.31,1454,14.2,999],["After Dawn","EZ",3,1.933,31.44,194,0,9999],["After Dawn","HD",10.4,3.534,47.07,478,9.47,4],["After Dawn","IN",15.3,7.208,28.31,975,15.07,10000],["After ZABANIYA (MUG Edit)","EZ",5,2.62,17.31,364,0,1.7],["After ZABANIYA (MUG Edit)","HD",10.6,5.164,37.62,723,9.13,3.6],["After ZABANIYA (MUG Edit)","IN",15.8,8.134,11.33,1130,12.32,990],["A journey to the moonlight","EZ",4.5,1.72,4.13,242,0,514],["A journey to the moonlight","HD",10.7,3.945,20.9,555,8.52,514],["A journey to the moonlight","IN",14.5,8.522,48.62,1199,10.73,999],["Alb","EZ",3.5,1.681,47.52,242,0,999],["Alb","HD",8.9,4.778,64.63,687,0,5],["Alb","IN",14.7,6.118,30.07,898,13.41,999],["Aleph-0","EZ",3.5,1.168,11.11,153,0,1.8],["Aleph-0","HD",12.2,4.052,19.02,531,10.18,30],["Aleph-0","IN",16,7.064,7.91,885,16.7,9999],["Alice in a xxxxxxxx","EZ",5,1.602,42.26,239,0,999],["Alice in a xxxxxxxx","HD",9.5,2.903,42.49,433,0,999],["Alice in a xxxxxxxx","IN",15.8,6.181,27.44,922,14,999],["Ametrine","EZ",6,2.097,43.38,302,0,2.5],["Ametrine","HD",12.2,5.649,48.57,838,7.91,999],["Ametrine","IN",15,5.059,32.25,769,11.08,99],["Ametrine","AT",16.2,4.955,15.69,784,12.68,999],["Another Me","EZ",5,2.906,42.42,455,0,1000],["Another Me","HD",9.8,4.567,41.96,715,10.03,1000],["Another Me","IN",15.6,9.255,21.67,1449,13,9999],["Another Me","EZ",5.5,2.415,41.51,318,0,1.8],["Another Me","HD",9.3,3.228,25.65,425,6.74,2],["Another Me","IN",13.6,4.673,16.31,564,10.86,9999],["Another Round","EZ",2.5,1.011,15.44,136,0,1.8],["Another Round","HD",9.6,2.624,29.46,353,0,3],["Another Round","IN",13.3,3.741,14.85,505,11.09,9999],["Antithese","EZ",4.5,2.556,54.31,313,0,999],["Antithese","HD",10.8,6.523,46.44,801,6.89,77],["Antithese","IN",15.4,7.936,25.59,1063,12.69,8.8],["Antithese","AT",16.4,9.773,17.33,1200,17.77,514],["Aphasia","EZ",4,2.744,53,283,0,1.8],["Aphasia","HD",8.8,3.51,18.78,362,0,1.8],["Aphasia","IN",13.3,5.362,7.41,553,10.41,1.8],["Aphrodite's Child (short ver.)","EZ",3.5,1.716,35.06,251,0,1.6],["Aphrodite's Child (short ver.)","HD",8.1,3.517,20.54,516,0,2],["Aphrodite's Child (short ver.)","IN",13.3,4.384,10.09,674,11.1,999],["Apocalypse","EZ",4,1.361,0,207,0,2],["Apocalypse","HD",8.6,2.405,31.94,382,0,9999],["Apocalypse","IN",13.5,4.438,13.46,676,10.88,2],["Apocalyptic","EZ",3,2.301,54.96,282,0,10000],["Apocalyptic","HD",10.4,2.699,11.85,329,0,10000],["Apocalyptic","IN",14.1,6.265,14.79,676,11.38,10000],["Archidoxen","EZ",4,2.272,57.25,262,0,10],["Archidoxen","HD",10,4.476,47.88,543,0,10],["Archidoxen","IN",15.6,8.188,32.09,938,14.16,999],["Archidoxen","AT",16.9,11.137,1.26,1351,26.23,999],["Ark","EZ",3.5,1.942,46.9,290,0,2.5],["Ark","HD",9.5,3.502,39.01,523,12.14,3.5],["Ark","IN",15,4.862,3.03,726,13.17,10000],["Ark","AT",16.4,7.306,21.54,1091,14.92,999],["-Arkhei-","EZ",7.5,3.102,17.32,462,0,2.4],["-Arkhei-","HD",8.8,3.038,25.33,454,0,2.4],["-Arkhei-","IN",12.6,4.309,4.97,644,10.41,9999],["Artificial Existence","EZ",3.5,1.608,61,200,0,999],["Artificial Existence","HD",9.4,3.125,33.25,400,10,999],["Artificial Existence","IN",14.7,6.273,26.12,800,11.88,999],["Avataar ~Reincarnation of Kalpa~","EZ",2,0.781,38.52,122,0,1.7],["Avataar ~Reincarnation of Kalpa~","HD",8.2,1.911,82.86,887,0,999],["Avataar ~Reincarnation of Kalpa~","IN",13.2,5.963,61.08,979,12.66,555],["Avataar ~Reincarnation of Kalpa~","AT",16.6,6.542,20.11,1074,18.34,999],["Äventyr","EZ",3.5,2.223,49.86,345,0,1.7],["Äventyr","HD",9.9,4.083,52.24,626,0,2],["Äventyr","IN",13.7,6.219,41.3,954,13.16,2.2],["BANGING STRIKE","EZ",5,2.621,18.33,371,0,999],["BANGING STRIKE","HD",10.2,4.55,22.2,644,9.41,999],["BANGING STRIKE","IN",15.9,8.89,14.82,1248,14.97,999],["BANGING STRIKE","AT",16.8,11.848,19.02,1677,14.67,999],["BRAIN HACKER","EZ",4.5,2.053,40.87,230,0,2],["BRAIN HACKER","HD",9.3,3.321,20.43,372,9.22,2],["BRAIN HACKER","IN",14.8,6.963,11.28,780,16.1,999],["Believe Light (feat. 果丸哒呦)","EZ",2.5,1.653,28.41,264,0,1.8],["Believe Light (feat. 果丸哒呦)","HD",8.9,3.646,34.31,580,7.66,1000],["Believe Light (feat. 果丸哒呦)","IN",14.6,6.085,16.36,972,10.65,1000],["Better Graphic Animation","EZ",6,2.153,2.25,178,0,2],["Better Graphic Animation","HD",11.1,5.061,26.23,469,11.41,9000],["Better Graphic Animation","IN",15.3,7.027,18.02,616,9.77,999],["Bitterblossom","EZ",2.5,1.096,13.16,152,0,1.5],["Bitterblossom","HD",9.9,4.952,37.52,581,14.89,999],["Bitterblossom","IN",13.5,4.664,20.77,597,12.39,4],["Bloom","EZ",3.5,1.191,39.34,183,0,3],["Bloom","HD",11.2,4.714,75.28,724,0,25],["Bloom","IN",14.9,6.855,49.67,1053,12.17,500],["Bonus Time","EZ",3.5,1.937,50.47,214,0,1.6],["Bonus Time","HD",9.3,3.729,25.24,412,7.33,1.8],["Bonus Time","IN",13.8,6.235,14.51,689,12.59,10000],["Bougainvillea","EZ",4,2.685,44.33,300,0,1.6],["Bougainvillea","HD",8.3,3.098,31.99,347,0,1.8],["Bougainvillea","IN",13.2,6.365,31.42,662,10.11,999],["Bounded Quietude","EZ",7,7.589,95.56,1127,0,2],["Bounded Quietude","HD",7.5,2.123,0,303,0,2],["Bounded Quietude","IN",16.2,8.8,28.77,1286,18.17,999],["Brave Notes","EZ",5.5,2.718,22.07,299,0,1.8],["Brave Notes","HD",11.4,4.018,12.44,442,7.82,2],["Brave Notes","IN",14.6,6.982,13.93,768,11.45,9],["Break Over","EZ",5,2.46,16.67,300,0,1.6],["Break Over","HD",11.5,7.379,52.23,919,10.75,2],["Break Over","IN",14.1,7.384,26.92,910,13.87,9999],["Break Over","AT",14.9,5.021,11.23,570,11.5,8],["Break Through The Barrier","EZ",5.5,3.271,39.14,419,0,2.8],["Break Through The Barrier","HD",9.5,4.536,37.69,581,6.92,2.8],["Break Through The Barrier","IN",14.5,8.566,42.29,1090,11.08,8],["Broken Sky","EZ",3,1.144,13.61,169,0,1.5],["Broken Sky","HD",8.6,2.376,35.51,352,0,1.8],["Broken Sky","IN",13.3,3.198,38.34,459,10.91,99],["Burn","EZ",7,2.14,31.29,278,0,1.6],["Burn","HD",11.2,3.801,8.45,497,0,1.4],["Burn","IN",15.2,5.441,8.2,707,17.56,20],["CROSS†SOUL","EZ",7.5,3.989,32.11,517,0,2],["CROSS†SOUL","HD",12.6,6.883,42.49,892,11.11,2],["CROSS†SOUL","IN",16.4,10.069,35.25,1305,12.66,100],["Cereris","EZ",5.5,3.08,52.24,490,7.78,1.8],["Cereris","HD",10.9,4.406,44.51,701,7.36,1.8],["Cereris","IN",14.7,5.645,38.31,898,11.31,2],["Cervelle Connexion","EZ",5,2.192,32.56,301,0,3.2],["Cervelle Connexion","HD",11.3,4.143,38.14,569,0,3.2],["Cervelle Connexion","IN",14.5,4.1,9.24,563,10.07,999],["Chronologika","EZ",3.5,2.128,54.24,271,0,10],["Chronologika","HD",9.8,3.717,26.1,456,8,999],["Chronologika","IN",13.9,6.326,11.98,776,12.29,10000],["Chronomia","EZ",4.5,2.44,42.01,338,0,10],["Chronomia","HD",11.1,4.711,40.87,663,8.83,114],["Chronomia","IN",15.4,7.501,15.83,992,14.09,100],["Chronos Collapse - La Campanella","EZ",4.5,2.488,56.57,350,0,10],["Chronos Collapse - La Campanella","HD",12.5,5.469,45.67,773,7.15,1000],["Chronos Collapse - La Campanella","IN",16.3,10.647,36.27,1500,11.32,9999],["Chronostasis","EZ",6,2.307,18.56,291,0,500],["Chronostasis","HD",10.7,6.51,50.3,821,11.63,500],["Chronostasis","IN",16,9.756,39.59,1326,12.21,999],["Cipher : /2&//<|0","EZ",5,2.848,52.37,401,0,1.8],["Cipher : /2&//<|0","HD",10.3,3.36,29.18,473,8.59,2],["Cipher : /2&//<|0","IN",14.4,7.394,45.92,1041,12.68,1000],["Class Memories","EZ",6,2.793,12.98,393,0,1.8],["Class Memories","HD",10.8,5.48,38.13,771,0,2],["Class Memories","IN",13.8,8.25,40.95,1194,10.01,2],["Cleyera","EZ",5,2.806,67.75,338,0,999],["Cleyera","HD",11,6.298,75.18,822,8.49,999],["Cleyera","IN",15.4,7.067,22.52,777,11.9,999],["Clock Paradox","EZ",2,1.424,46.81,188,0,2],["Clock Paradox","HD",6,2.364,36.54,312,0,2],["Clock Paradox","IN",12.5,3.927,33.46,520,9,2],["Colorful Days♪","EZ",5,1.759,42.95,156,0,1.6],["Colorful Days♪","HD",7,2.082,34.41,186,0,1.6],["Colorful Days♪","IN",12.6,4.556,28.5,407,0,10000],["Comet","EZ",3,1.211,39.86,138,0,1.5],["Comet","HD",10.5,5.316,69.68,752,7.66,2.2],["Comet","IN",13.7,6.177,37.53,874,10.73,100],["Compute It With Some Devilish Alcoholic ","EZ",5.5,2.004,16.36,330,0,500],["Compute It With Some Devilish Alcoholic ","HD",10.6,4.391,43.98,723,0,3.4],["Compute It With Some Devilish Alcoholic ","IN",15.7,7.352,28.36,1213,26.27,999],["Concvssion","EZ",6,3.071,28.89,450,8.44,1.8],["Concvssion","HD",11.3,4.775,27.29,700,14.17,999],["Concvssion","IN",15.6,6.821,8.8,1000,15.33,9999],["Crave Wave","EZ",2.5,1.475,53.11,177,0,1.5],["Crave Wave","HD",8,3.257,44.19,396,0,2],["Crave Wave","IN",13.7,6.811,32.6,816,12.4,99],["Credits","EZ",4.5,1.961,55.32,188,0,1.4],["Credits","HD",10.4,3.703,49.58,355,7.79,1.2],["Credits","IN",13.6,5.581,24.49,535,8.33,2],["Credits","AT",15.8,6.644,18.34,638,11.81,2.2],["Cristalisia","EZ",4,1.924,41.91,241,0,999],["Cristalisia","HD",10.4,4.606,50.78,577,11.91,999],["Cristalisia","IN",14.4,5.904,32.04,721,16.09,999],["Crush BETA","EZ",4,2.25,24.81,270,0,1.6],["Crush BETA","HD",10.5,5.139,43.39,666,8.92,999],["Crush BETA","IN",15.1,8.142,15.05,977,14.07,1000],["Cryogenic","EZ",5,2.169,38.78,294,0,10],["Cryogenic","HD",11.8,4.649,33.81,630,0,10],["Cryogenic","IN",15.1,2.825,42.62,1063,24.25,9999],["Cthugha","EZ",6,2.621,18.78,378,0,2],["Cthugha","HD",10.4,4.833,17.36,697,8.99,9999],["Cthugha","IN",16,8.962,14.7,1333,13.67,10000],["Cthugha","AT",16.1,9.709,12.6,1444,13.34,1000],["Cuvism³","EZ",3,1.725,54.5,222,0,4],["Cuvism³","HD",12.2,5.126,17.35,761,10.7,2.2],["Cuvism³","IN",13.9,5.499,17.11,830,11.06,514],["Cuvism³","AT",16.7,7.453,13.97,1088,14.06,999],["DESTRUCTION 3,2,1","EZ",8.5,6.823,75.66,1060,0,50],["DESTRUCTION 3,2,1","HD",13.1,8.065,59.68,1250,13.42,500],["DESTRUCTION 3,2,1","IN",16.3,9.861,34.46,1532,16.52,999],["DESTRUCTION 3,2,1","AT",17.3,14.998,44.81,2330,19.74,999],["Dance with Silence","EZ",7,1.162,24.12,170,0,999],["Dance with Silence","HD",10.9,3.51,34.6,552,10.67,819.2],["Dance with Silence","IN",15.2,7.5,40.89,1125,16.4,99],["Dash","EZ",2.5,1.086,14.04,114,0,1.6],["Dash","HD",5.5,1.996,10,210,0,1.8],["Dash","IN",9.7,3.288,5.49,346,0,2],["DataErr0r","EZ",6,0.463,32,50,0,1919],["DataErr0r","HD",11.8,3.488,8.25,400,9.3,1919],["DataErr0r","IN",14.5,5.473,1.96,613,13.35,999],["Dead Soul","EZ",4.5,1.976,19.41,273,0,10000],["Dead Soul","HD",12.3,4.436,54,613,11.73,500],["Dead Soul","IN",14.4,5.695,33.93,787,11.73,5000],["Demiurge","EZ",1.5,0.68,11,100,0,1919],["Demiurge","HD",7.5,2.819,20.9,445,0,1.8],["Demiurge","IN",11.8,3.883,5,520,12,2],["Demonkin","EZ",4.5,3.555,55.63,426,0,9999],["Demonkin","HD",9.2,4.275,34.11,513,7.79,9999],["Demonkin","IN",13.8,6.324,4.22,829,11.19,10],["Der Richter","EZ",5.5,2.425,31.94,310,0,10],["Der Richter","HD",11.4,4.812,26.34,615,9.68,10],["Der Richter","IN",15.6,8.337,30.98,1149,12.88,999],["Der Richter","AT",16.9,10.144,28.56,1306,15.59,99],["Der Schneid","EZ",7,3.108,30.2,457,0,1.7],["Der Schneid","HD",12,4.829,19.01,710,15.39,999],["Der Schneid","IN",16.1,9.699,24.47,1426,13.53,27],["Der Schneid","AT",17.5,10.576,10.55,1555,16.88,499],["Desultory Signals","EZ",10,5.763,35.26,831,8.17,999],["Desultory Signals","HD",14,7.341,50.3,1002,13.03,200],["Desultory Signals","IN",17,14.779,40.96,2019,16.37,999],["Desultory Signals","AT",18,14.27,28.68,2026,19.12,9999],["DevIAtiOn (short ver.)","EZ",5,1.378,17.12,222,0,3.875],["DevIAtiOn (short ver.)","HD",11.1,4.944,48.97,827,0,10],["DevIAtiOn (short ver.)","IN",15.8,6.683,24.08,1117,13.73,500],["Devastating History","EZ",6,2.2,30.56,288,0,1.2],["Devastating History","HD",11.8,4.736,33.39,620,9.14,999],["Devastating History","IN",15.5,10.939,35.82,1432,15.99,999],["Devotion","EZ",4.5,2.121,43.53,317,0,2],["Devotion","HD",9.6,4.396,50.84,657,6.49,999],["Devotion","IN",13.7,5.306,20.18,793,11.28,999],["Diamond Dust","EZ",5,1.976,30.83,266,0,1.8],["Diamond Dust","HD",10.8,4.799,24.15,646,11.84,3],["Diamond Dust","IN",15.3,7.324,7.91,986,12.5,999],["Diamond Dust","AT",16.7,10.853,29.12,1518,16.01,999],["Diamond Eyes","EZ",3.5,2.755,62.94,340,0,1.8],["Diamond Eyes","HD",6.5,3.476,41.03,429,0,1.9],["Diamond Eyes","IN",13.4,6.271,35.01,774,11.28,2.1],["Disorder","EZ",6,3.446,66.22,444,0,1.7],["Disorder","HD",10.3,4.881,58.51,629,9.27,1.7],["Disorder","IN",14.8,7.124,25.6,918,14.2,10000],["Distorted Fate","EZ",8.1,3.992,41.75,594,0,700],["Distorted Fate","HD",13.5,6.736,23.71,970,12.8,9999],["Distorted Fate","IN",16.3,9.764,29.68,1449,16.31,999],["Distorted Fate","AT",17.4,8.634,8.96,1283,21.6,1000],["Dlyrotz","EZ",4,3.645,64.82,398,0,1.8],["Dlyrotz","HD",9.1,4.194,39.3,458,7.43,2],["Dlyrotz","IN",13.7,5.348,25.86,584,12.89,9999],["Don't Never Around","EZ",5,2.807,53.57,308,7,9999],["Don't Never Around","HD",11.3,5.824,45.85,639,9.35,99999],["Don't Never Around","IN",15.5,9.37,30.64,1028,12.28,9999],["Doppelganger","EZ",5,3.102,60.55,436,0,1.5],["Doppelganger","HD",9,4.204,48.56,591,0,1.7],["Doppelganger","IN",15.1,6.677,25.08,921,18.02,10000],["Dreamland","EZ",7,2.337,21.6,338,0,2],["Dreamland","HD",10.3,3.291,13.45,476,0,2],["Dreamland","IN",13.6,4.369,6.06,627,10.68,9999],["Drop It","EZ",4,2.555,60.99,505,0,1.6],["Drop It","HD",9.2,3.046,30.9,602,7.61,1.8],["Drop It","IN",14.2,5.23,8.05,1031,15.51,9999],["ENERGY SYNERGY MATRIX","EZ",5.5,3.709,56.22,450,0,16],["ENERGY SYNERGY MATRIX","HD",11.5,4.781,32.76,580,12.8,16],["ENERGY SYNERGY MATRIX","IN",14.4,6.25,5.73,750,18.05,10000],["+ERABY+E CONNEC+10N","EZ",5.5,3.442,48.78,492,0,2.5],["+ERABY+E CONNEC+10N","HD",11.6,6.324,53.43,904,11.6,3.4],["+ERABY+E CONNEC+10N","IN",16.3,10.138,48.89,1530,17.05,999],["+ERABY+E CONNEC+10N","AT",17.3,11.045,12.79,1579,23.95,999],["El Condor Pasa (Phigros Edit)","EZ",6.5,2.13,7.72,259,0,1000],["El Condor Pasa (Phigros Edit)","HD",12.5,4.811,34.36,585,13.33,1000],["El Condor Pasa (Phigros Edit)","IN",15.6,8.901,27.63,1140,18.78,9999],["Electron","EZ",3.5,1.972,27.85,219,0,1.4],["Electron","HD",9.4,3.809,34.04,423,0,2],["Electron","IN",13.2,5.187,9.9,576,11.41,2],["Eltaw","EZ",7,3.023,49.1,391,8.58,9999],["Eltaw","HD",10.6,4.701,39.8,608,7.95,9999],["Eltaw","IN",14.8,6.611,19.18,855,10.61,9999],["El último baile","EZ",4.5,2.44,48.66,261,0,999],["El último baile","HD",9.5,4.318,41.67,480,7.24,999],["El último baile","IN",14.1,5.521,14.1,610,9.79,999],["End Me","EZ",5.5,2.057,55.76,217,0,1.7],["End Me","HD",7.5,3.033,70.31,320,0,15],["End Me","IN",14.2,6.863,49.59,724,13.79,2],["Engine x Start!! (melody mix)","EZ",2.5,1.038,25.33,75,0,1.4],["Engine x Start!! (melody mix)","HD",8.3,2.657,14.06,192,8.27,1.7],["Engine x Start!! (melody mix)","IN",13.2,4.981,5.77,433,12.3,1.9],["Entrance to the Chaos","EZ",8.8,3.558,35.76,495,10.92,99],["Entrance to the Chaos","HD",13.7,5.75,33.12,800,18.63,999],["Entrance to the Chaos","IN",16.8,9.588,34.41,1334,16.91,999],["Entrance to the Chaos","AT",17.6,9.053,14.57,1249,18.19,999],["Eradication Catastrophe","EZ",3.5,1.68,44.75,181,0,1.8],["Eradication Catastrophe","HD",7.5,1.856,44.5,200,0,1.7],["Eradication Catastrophe","IN",12.7,4.952,25.46,593,9.86,9999],["Eternal Snow","EZ",4,1.939,55.56,288,0,1.8],["Eternal Snow","HD",9.6,3.621,23.26,533,0,2],["Eternal Snow","IN",13.5,4.64,7.14,700,10.95,999],["Evanescent","EZ",6.5,3.23,31.01,358,0,999],["Evanescent","HD",12.6,6.264,37.36,720,16.18,999],["Evanescent","IN",15.7,8.117,13.4,933,16.39,999],["Exoplanetary Mirage","EZ",8.7,4.288,64.03,670,0,999],["Exoplanetary Mirage","HD",13.4,5.66,37.51,941,14.15,20],["Exoplanetary Mirage","IN",16.8,12.361,50.8,2055,16.92,999],["Exoplanetary Mirage","AT",17.9,13.096,25.9,2077,21.58,1000],["FULi AUTO BUSTER","EZ",3.5,2.4,30.18,285,0,1.8],["FULi AUTO BUSTER","HD",9.7,5.01,26.68,596,0,1.8],["FULi AUTO BUSTER","IN",14.6,6.357,18.94,755,13.5,9999],["FULi AUTO SHOOTER","EZ",3,1.125,53.19,141,0,2],["FULi AUTO SHOOTER","HD",9,3.103,42.16,389,0,1.7],["FULi AUTO SHOOTER","IN",14.9,6.724,23.96,843,14.8,999],["Feast远东之宴","EZ",6.5,4.346,60.5,600,0,10],["Feast远东之宴","HD",12.1,5.795,48.5,800,9.89,10],["Feast远东之宴","IN",15.6,7.207,24.4,1000,15,9999],["Final Step!","EZ",5.5,2.669,29.01,355,0,2],["Final Step!","HD",11,4.541,33.28,604,12.13,2],["Final Step!","IN",14.1,7,9.67,931,12.83,100],["Find_Me","EZ",5.5,3.857,65.59,465,0,1.6],["Find_Me","HD",10.5,5.45,33.79,657,7.75,1.6],["Find_Me","IN",14.3,7.008,11.6,836,10.41,2.2],["Fixations Toward the Stars","EZ",3.5,1.209,23.32,193,0,1.6],["Fixations Toward the Stars","HD",10.9,3.069,11,491,0,1.8],["Fixations Toward the Stars","IN",14.5,5.219,39.4,835,12.1,999],["Flutter Echo","EZ",3.5,1.478,8.11,222,0,1.62],["Flutter Echo","HD",9.8,3.695,14.23,555,8.87,1.92],["Flutter Echo","IN",14.9,6.672,32.31,1046,14.42,100],["Fractured Angel","EZ",4,3.537,79.07,626,0,999],["Fractured Angel","HD",10.9,4.497,61.68,796,0,999],["Fractured Angel","IN",16.3,6.353,28.69,1084,21.57,999],["Freaky Undulations ~Noble Knights of Tun","EZ",7,2.313,46.92,292,0,500],["Freaky Undulations ~Noble Knights of Tun","HD",10.9,4.916,52.5,621,9.02,1000],["Freaky Undulations ~Noble Knights of Tun","IN",15.3,8.066,43.53,1020,11.19,999],["Frozen Heart","EZ",5,2.01,29.75,353,0,99],["Frozen Heart","HD",10.6,4.031,11.3,708,8.49,99],["Frozen Heart","IN",14.6,5.245,22.58,939,12.04,999],["Future Mind","EZ",4.5,2.976,44.66,365,0,9999],["Future Mind","HD",11,4.659,44.21,570,9.55,9999],["Future Mind","IN",14.2,6.783,26.21,866,10.48,9999],["GOODBOUNCE","EZ",7.5,4.594,40.82,588,7.54,1.7],["GOODBOUNCE","HD",11.9,6.227,39.4,797,7.35,1.7],["GOODBOUNCE","IN",14.5,7.016,16.04,898,11.74,10000],["GOODFORTUNE","EZ",7.5,3.503,21.98,455,7.27,1.6],["GOODFORTUNE","HD",8.7,6.181,59.89,733,7.27,2],["GOODFORTUNE","IN",15.7,8.525,6.92,1011,12.21,9999],["GOODRAGE","EZ",5,2.688,27.92,308,0,1000],["GOODRAGE","HD",8.5,5.432,61.46,628,9.4,1000],["GOODRAGE","IN",16,8.856,13.93,1034,15.23,100000],["GOODTEK","EZ",5,2.433,4.07,295,0,2],["GOODTEK","HD",10,5.022,21.84,609,7.91,1.8],["GOODTEK","IN",14.3,7.512,22.68,873,10.66,2.2],["GOODWORLD","EZ",3,1.68,46.98,215,0,1.3],["GOODWORLD","HD",11.4,6.289,48.82,805,14.67,5],["GOODWORLD","IN",14.9,7.5,17.19,960,12.99,10],["G.V.N. (Glitter,Vomitus and Neon)","EZ",5,3.983,75.12,635,0,999],["G.V.N. (Glitter,Vomitus and Neon)","HD",9.9,5.645,65.67,900,8.75,999],["G.V.N. (Glitter,Vomitus and Neon)","IN",15.8,9.729,40.56,1541,12.45,999],["Get Back","EZ",6.5,2.386,19.94,321,0,1.6],["Get Back","HD",10.7,4.074,46.91,550,8.53,4],["Get Back","IN",14.1,5.244,34.75,708,11.89,1000],["Get Ready!! ","EZ",6,2.983,31.4,363,0,1.8],["Get Ready!! ","HD",10.7,4.799,26.88,584,0,2],["Get Ready!! ","IN",13.8,6.73,13.06,819,12.02,100],["Glaciaxion","EZ",1,0.423,1.52,66,0,1.6],["Glaciaxion","HD",6.5,2.519,41.98,393,0,1000],["Glaciaxion","IN",12.6,4.673,53.36,729,10.79,9999],["Grimheart","EZ",3,0.987,11.36,132,0,3],["Grimheart","HD",8.9,2.609,31.23,349,0,999],["Grimheart","IN",13.8,3.978,11.96,577,8.08,500],["Gungnir Fracture","EZ",6,2.582,32.42,364,0,999],["Gungnir Fracture","HD",11.5,3.805,16.6,506,9.17,1.85],["Gungnir Fracture","IN",16.6,8.404,16.79,1185,14.92,999],["HAZARD","EZ",4.5,2.358,24.03,283,0,9999],["HAZARD","HD",11,4.225,22.68,507,10.15,9999],["HAZARD","IN",14.8,4.9,5.95,588,12.34,1000],["Hardcore Kwaya","EZ",4.5,2.891,20.88,340,0,1.8],["Hardcore Kwaya","HD",8.4,5.196,53.19,611,0,99999],["Hardcore Kwaya","IN",14.6,7.889,17.61,852,14.17,10000],["Helios","EZ",5.5,1.661,73.94,188,0,999],["Helios","HD",9.1,3.05,49.87,391,10,999],["Helios","IN",14.2,6.131,58.14,786,12.38,999],["Horizon Blue","EZ",6.5,3.24,39.69,519,0,2],["Horizon Blue","HD",11.6,4.576,25.65,733,13.25,114514],["Horizon Blue","IN",15.7,6.754,19.65,1084,17.63,999],["HumaN","EZ",3,0.962,28.83,111,0,1.5],["HumaN","HD",8,1.925,8.56,222,7.67,1.7],["HumaN","IN",12.9,4.776,11.37,554,8.96,999],["Hydra","EZ",6,1.97,38.16,283,0,1.8],["Hydra","HD",11.6,5.021,50.9,723,14.22,200],["Hydra","IN",15.4,7.457,11.61,1085,13.21,99],["Hydra","AT",17.1,10.743,21.4,1547,22.67,999],["I Must Say No","EZ",1.5,0.677,22.37,76,0,1.6],["I Must Say No","HD",9.2,3.587,8.79,364,6.97,99],["I Must Say No","IN",13.5,4.186,5.96,470,8.29,2.2],["INFiNiTE ENERZY -Overdoze-","EZ",6.5,2.973,20.42,333,0,999],["INFiNiTE ENERZY -Overdoze-","HD",12.3,5.946,26.13,666,8.71,999],["INFiNiTE ENERZY -Overdoze-","IN",14.8,7.929,12.84,888,11.31,999],["INFiNiTE ENERZY -Overdoze-","AT",16.9,8,0,888,18.75,999],["Igallta","EZ",7.5,3.542,46.62,414,0,2.2],["Igallta","HD",12.2,5.142,42.1,601,9.91,10000],["Igallta","IN",16.1,8.711,21.51,1018,13.32,1000],["Igallta","AT",17.4,9.532,10.86,1114,21.82,10000],["Implexrough","EZ",5.5,1.774,51.77,226,0,9999],["Implexrough","HD",10.2,4.058,45.45,517,0,99999],["Implexrough","IN",15.3,7.896,42.35,1006,12.45,999],["Incyde","EZ",7,2.892,56.43,521,0,999],["Incyde","HD",12.1,6.298,42.24,1141,8.91,2],["Incyde","IN",16.2,9.088,36.47,1648,12.4,200],["Indelible Scar","EZ",7,2.452,26.27,316,0,1.7],["Indelible Scar","HD",11.5,5.617,54.43,733,11.66,1.9],["Indelible Scar","IN",15.3,6.569,28.2,844,14.45,999],["Indelible Scar","AT",16.5,9.269,15.41,1207,18.89,999],["Infinity Heaven","EZ",3,1.121,21.34,164,0,1.3],["Infinity Heaven","HD",8.4,2.874,23.22,422,0,1.6],["Infinity Heaven","IN",13.9,7.009,48.79,1029,12.62,9999],["Initialize","EZ",2.5,0.975,29.06,117,0,1000],["Initialize","HD",7,2.95,45.76,354,0,1000],["Initialize","IN",11.6,4.842,35.46,581,10.67,1000],["Inverted World","EZ",5.5,2.103,10.98,246,0,1.8],["Inverted World","HD",11.2,5.237,39.74,614,9.63,1.8],["Inverted World","IN",15.5,6.994,12.56,820,12.19,999],["Journey with You","EZ",5,0.487,55,60,0,514],["Journey with You","HD",10,1.42,0,175,0,514],["Journey with You","IN",13.7,4.577,21.35,562,13.1,999],["JunXion Between Life And Death(VIP Mix)","EZ",3,1.885,85.88,262,0,1.4],["JunXion Between Life And Death(VIP Mix)","HD",8.7,4.294,76.21,597,0,1.7],["JunXion Between Life And Death(VIP Mix)","IN",13.4,5.422,31.44,722,12.68,1.8],["KIZUNA Resolution","EZ",8,2.449,25.95,262,10.67,99],["KIZUNA Resolution","HD",13.4,5.635,11.91,722,10.91,160],["KIZUNA Resolution","IN",16.4,8.109,10.68,1039,11.72,999],["K.Moe (VIP)","EZ",3,0.997,2.44,123,0,514],["K.Moe (VIP)","HD",8.4,3.433,30.32,432,8.07,514],["K.Moe (VIP)","IN",15.9,8.808,26.6,1060,15.15,100],["Kerberos","EZ",5.5,2.444,26.34,262,0,1.7],["Kerberos","HD",12.4,6.094,19.91,683,11.23,9999],["Kerberos","IN",15.8,8.362,4.5,978,13.56,9999],["Khalid","EZ",4,1.59,4.21,190,0,1.8],["Khalid","HD",8.2,2.972,30.62,356,0,1.8],["Khalid","IN",13,4.958,35.66,631,0,500],["Khronostasis Katharsis","EZ",6,2.999,52.3,369,0,9999],["Khronostasis Katharsis","HD",11.8,5.708,27.48,644,12.54,9999],["Khronostasis Katharsis","IN",14,7.035,8.48,861,12.87,2],["Kirakira Noel Story!!","EZ",4,2.094,25.75,268,0,100],["Kirakira Noel Story!!","HD",10.2,4.891,36.9,626,8.9,100],["Kirakira Noel Story!!","IN",14.2,7.969,36.04,935,12.41,500],["Komplexe","EZ",4,1.859,47.9,238,0,1.6],["Komplexe","HD",9.6,3.789,31.55,485,0,5],["Komplexe","IN",14.3,8.037,37.01,1051,12.65,2.3],["Labyrinth in Kowloon: Walled World","EZ",6,2.863,56.01,491,8.44,2.5],["Labyrinth in Kowloon: Walled World","HD",11.4,5.645,56.51,968,12.73,2.5],["Labyrinth in Kowloon: Walled World","IN",15.6,7.298,17.91,1150,14.66,999],["Leave All Behind","EZ",3,1.727,43.81,210,0,1.5],["Leave All Behind","HD",8.9,3.24,24.11,394,0,1.6],["Leave All Behind","IN",12.7,4.301,23.9,523,18.02,10],["Leave All Behind","AT",15,6.645,36.01,808,20.35,999],["Le temps perdu","EZ",4,1.914,42.75,262,0,1.8],["Le temps perdu","HD",9,4.295,52.38,588,8.36,2],["Le temps perdu","IN",12.3,5.74,50.29,698,9.37,2.2],["Locomotive","EZ",4,1.457,25,196,0,1.6],["Locomotive","HD",9.7,2.996,10.92,403,0,1.9],["Locomotive","IN",13.5,4.933,23.72,666,10.38,999],["Luminescence","EZ",5.5,2.979,46.95,443,0,999],["Luminescence","HD",11,5.294,45.28,689,8.43,999],["Luminescence","IN",14.5,6.696,24.62,987,10.52,8],["Luminescent","EZ",5.5,2.206,33.94,330,0,1.6],["Luminescent","HD",10.5,4.053,29.28,608,0,999],["Luminescent","IN",14.4,4.486,14.92,650,14.05,4],["Luminous Entities Lost Heart","EZ",5,1.72,34.55,275,0,99],["Luminous Entities Lost Heart","HD",10.7,2.883,33.84,461,8.19,99],["Luminous Entities Lost Heart","IN",15.2,5.777,18.08,929,13.34,99],["Lyrith -迷宮リリス-","EZ",5,1.734,14.52,248,0,4],["Lyrith -迷宮リリス-","HD",11.1,4.882,45.14,700,8.28,5],["Lyrith -迷宮リリス-","IN",16.1,9.252,20.92,1267,13.53,999],["Lyrith -迷宮リリス-","AT",16.5,8.592,21.68,1236,12.49,3000],["MARENOL","EZ",2,0.676,33.68,95,0,5],["MARENOL","HD",10.3,3.322,39.4,467,8.94,5],["MARENOL","IN",13.9,4.901,13.35,689,15.23,2],["MOBILYS","EZ",5.5,2.042,20.9,311,0,1.8],["MOBILYS","HD",9.3,3.48,13.96,530,0,1.8],["MOBILYS","IN",14.3,6.193,18.23,938,12.76,2.7],["Magenta Potion","EZ",6.5,2.372,37.43,334,0,2.4],["Magenta Potion","HD",11.3,4.478,32.17,631,0,2],["Magenta Potion","IN",14.4,5.618,16.06,791,11.17,10000],["Manifold Hypothesis","EZ",4,1.438,20.86,187,0,1.5],["Manifold Hypothesis","HD",9.1,3.028,22.94,401,6.63,999],["Manifold Hypothesis","IN",14.6,6.187,23.35,895,11.71,999],["Message","EZ",3,2.865,66,100,0,1.8],["Message","HD",13.2,3.749,27.39,544,12.07,999],["Message","IN",15.6,6.107,29.35,886,14.52,999],["Message","AT",16.5,5.342,13.64,777,14.65,999],["Miracle Forest (VIP Mix)","EZ",3,2.019,64.4,323,0,1.6],["Miracle Forest (VIP Mix)","HD",7.5,3.663,63.48,586,8.53,100],["Miracle Forest (VIP Mix)","IN",13.1,5.547,36,839,8.15,9999],["NO ONE YES MAN","EZ",7,3.288,34.26,394,7.56,9999],["NO ONE YES MAN","HD",10.9,5.108,29.9,612,7.58,9999],["NO ONE YES MAN","IN",15.5,7.044,19.79,844,12.58,10000],["NO x","EZ",4.5,1.4,29.29,198,0,999],["NO x","HD",10.1,5.329,59.29,700,7.94,10],["NO x","IN",16.1,8.401,40.26,1150,11.84,990],["[NWAD]","EZ",5.5,2.501,36.73,343,0,1.7],["[NWAD]","HD",9.2,5.036,74.3,782,0,2.4],["[NWAD]","IN",15.6,8.049,31.53,1259,15.83,999],["NYA!!! (Phigros ver.)","EZ",2,0.828,35.25,122,0,1.3],["NYA!!! (Phigros ver.)","HD",8.6,2.853,30.14,428,0,1.6],["NYA!!! (Phigros ver.)","IN",13.1,4.423,9.61,666,0,8],["Next Time","EZ",6,2.244,45.42,240,6.48,1000],["Next Time","HD",8.7,2.833,33.66,303,6.49,1000],["Next Time","IN",12.4,3.618,18.09,387,9.87,1000],["Nhelv","EZ",1.5,1.372,55.61,196,0,5],["Nhelv","HD",12,3.996,20.67,571,8.52,1000],["Nhelv","IN",15.6,5.83,0,833,12.23,999],["Nick of Time","EZ",6,2.729,40.85,328,23.33,1.6],["Nick of Time","HD",9.3,3.263,13.05,429,15.8,1.8],["Nick of Time","IN",14.7,6.104,5.23,745,9.93,9999],["NightTheater","EZ",4,2.177,33.98,256,0,99],["NightTheater","HD",10.6,5.237,46.92,616,12.58,99],["NightTheater","IN",14.3,6.627,15.41,811,13.22,2.2],["Non-Melodic Ragez (MUG Edit)","EZ",5.5,2.964,41.5,347,0,1.4],["Non-Melodic Ragez (MUG Edit)","HD",11.6,5.766,26.52,675,10.05,3.5],["Non-Melodic Ragez (MUG Edit)","IN",16.1,9.248,33.04,1235,12.79,4.5],["Now Is The Time, Do It","EZ",4.5,2.024,13.82,246,0,1.8],["Now Is The Time, Do It","HD",11.2,6.394,35.78,777,0,2],["Now Is The Time, Do It","IN",14.3,6.542,23.02,795,24.43,999],["On And On!!","EZ",5,1.748,14.36,195,0,1.6],["On And On!!","HD",9.6,2.757,31.58,323,6.65,1.6],["On And On!!","IN",15.2,7.083,17.11,830,10.48,999],["Originally","EZ",1,0.994,68.38,136,0,99],["Originally","HD",9.3,3.311,31.57,453,8.43,99],["Originally","IN",14.5,6.952,19.35,951,10.54,999],["Orthodox","EZ",4.5,2.302,34.29,312,0,2.6],["Orthodox","HD",8.5,3.291,15.47,446,6.43,2.6],["Orthodox","IN",13.7,6.969,21.81,963,9.68,100],["PANIC PARADISE","EZ",6.5,3.095,22.07,367,0,20],["PANIC PARADISE","HD",11.5,4.495,5.07,533,11.4,20],["PANIC PARADISE","IN",15.5,7.091,5.68,881,12.05,50],["PANIC PARADISE","AT",16.6,8.943,11.88,1111,14.42,99],["PRAGMATISM -RESURRECTION-","EZ",7.5,6.935,82.88,1057,7.52,3.6],["PRAGMATISM -RESURRECTION-","HD",12.9,4.337,20.42,661,14.39,5],["PRAGMATISM -RESURRECTION-","IN",16,6.555,29.43,999,10.35,999],["PRAGMATISM -RESURRECTION-","AT",16.6,7.585,28.03,1156,11.5,999],["[PRAW]","EZ",6,2.78,49.15,413,0,1.7],["[PRAW]","HD",10.6,4.124,33.57,575,9.86,1.8],["[PRAW]","IN",15.1,7.882,29.29,1171,12.94,100],["Palescreen","EZ",5.5,1.615,29.46,224,0,2],["Palescreen","HD",12.3,5.469,50,772,9.68,2000],["Palescreen","IN",15.9,7.634,35.13,1059,12.33,10000],["Parallel Retrogression(Game Ver.)","EZ",7,3.772,52.27,507,6.67,9999],["Parallel Retrogression(Game Ver.)","HD",10.9,5.186,55.24,697,8.33,9999],["Parallel Retrogression(Game Ver.)","IN",14.2,6.332,30.67,851,10.67,9999],["Petrichor","EZ",7.5,2.666,43.33,420,0,900],["Petrichor","HD",13.8,4.859,33.76,779,13.24,325],["Petrichor","IN",16.5,7.883,21.18,1242,17.22,999],["Petrichor","AT",17.5,9.115,11.35,1436,22.94,999],["Pixel Rebelz","EZ",4.5,2.127,56.14,285,0,2],["Pixel Rebelz","HD",9.7,3.757,47.92,505,0,9999],["Pixel Rebelz","IN",15.3,7.001,18.07,941,17.51,10000],["Poison AND÷OR Affection","EZ",3.5,1.199,8.57,140,0,114],["Poison AND÷OR Affection","HD",9.9,2.381,13.67,278,10.19,114],["Poison AND÷OR Affection","IN",15.7,7.324,0,888,15.95,999],["Pont des souvenirs","EZ",5.5,3.035,45.55,461,0,9999],["Pont des souvenirs","HD",10.7,3.733,22.22,567,10.32,9999],["Pont des souvenirs","IN",15.3,5.549,15.46,899,14.32,4.6],["Ποσειδών","EZ",6,4.798,75.8,533,23.33,1.4],["Ποσειδών","HD",8.8,3.574,33.5,397,9.55,9999],["Ποσειδών","IN",12.8,4.051,27.56,450,10.17,9999],["Ποσειδών","AT",16.2,11.055,46.25,1228,12.66,999],["Protoflicker","EZ",3.5,1.653,51.74,259,0,1.5],["Protoflicker","HD",9.7,3.116,24.46,511,0,10000],["Protoflicker","IN",15.4,7.398,9.75,1210,10.76,10000],["QZKago Requiem","EZ",7,2.306,10.47,296,0,99],["QZKago Requiem","HD",13.3,7.42,48.36,1007,10.61,999],["QZKago Requiem","IN",16.3,9.44,35.27,1259,15.8,999],["QZKago Requiem","AT",17.4,12.925,27.34,1723,23.95,999],["Quantum Hyperspace","EZ",6,4.024,38.83,443,0,999],["Quantum Hyperspace","HD",11.2,7.175,43.29,790,16.65,999],["Quantum Hyperspace","IN",15,8.065,21.06,888,16.82,514],["RESSiSTANCE","EZ",6.5,3.612,36.27,499,0,999],["RESSiSTANCE","HD",11.2,5.386,24.33,744,10.2,999],["RESSiSTANCE","IN",16.1,7.654,3.22,1026,14.59,999],["RIPPER","EZ",6.5,2.814,30.77,520,0,1.5],["RIPPER","HD",11.7,3.81,38.78,704,9.39,1.6],["RIPPER","IN",15.4,6.418,38.87,1186,15.81,5],["Radiance","EZ",3.5,1.564,46.79,218,0,6.8],["Radiance","HD",11.9,4.585,38.03,639,0,4],["Radiance","IN",14.1,4.786,9.15,667,11.36,999],["Radiance","AT",15.6,6.645,13.61,926,17.26,514],["Rainy Heart","EZ",4,1.38,28.35,194,0,99],["Rainy Heart","HD",9.4,2.355,22.66,331,0,999],["Rainy Heart","IN",12.9,3.13,4.77,440,9.88,3],["Rainy Season","EZ",5.5,2.977,29.93,304,0,1.8],["Rainy Season","HD",10.7,5.798,24.58,594,10.22,2],["Rainy Season","IN",14.2,6.324,10.76,660,13.93,99999],["Ramification","EZ",5,1.76,68.47,222,0,1.6],["Ramification","HD",10.4,4.082,70.68,515,7.78,3],["Ramification","IN",14.8,5.802,22.81,732,12.83,999],["Random","EZ",5.5,2.176,34.55,275,0,9999],["Random","HD",12.2,4.377,24.82,568,0,999],["Random","IN",14.7,5.641,6.42,732,13.61,4.3],["Re：End of a Dream","EZ",7.5,3.02,24.47,421,9.42,999],["Re：End of a Dream","HD",13,6.141,29.32,856,13.82,999],["Re：End of a Dream","IN",15.9,8.509,16.02,1186,14.23,999],["Re：End of a Dream","AT",16.9,10.52,20.48,1377,15.36,999],["Re_Nascence (Psystyle Ver.) ","EZ",5.5,2.755,44.97,378,0,999],["Re_Nascence (Psystyle Ver.) ","HD",11.7,5.875,41.56,806,0,999],["Re_Nascence (Psystyle Ver.) ","IN",14.4,6.099,23.22,827,12.28,999],["Realms","EZ",3.5,1.785,46.3,216,0,999],["Realms","HD",10.2,4.643,46.62,562,7.37,999],["Realms","IN",13.8,6.099,27.93,673,11.37,1000],["Re：birth","EZ",6,2.171,37.19,320,17.42,999],["Re：birth","HD",12,4.973,47.34,733,15.58,999],["Re：birth","IN",15.4,6.451,17.15,939,14.1,999],["Reimei","EZ",6.5,2.455,19.77,344,8.22,1.6],["Reimei","HD",11.7,4.602,24.69,644,8.07,1.8],["Reimei","IN",15.1,7.024,7.93,983,11.81,2.1],["Resolver","EZ",3,0.866,10.94,128,0,999],["Resolver","HD",8.4,2.294,20.35,339,7.43,999],["Resolver","IN",14.4,6.718,30.11,993,17.61,999],["Retribution","EZ",6,4.266,47.03,555,7.92,999],["Retribution","HD",11.6,6.672,50.81,868,10.62,999],["Retribution","IN",16.2,10.438,41.97,1358,15.44,999],["Retribution ~ Cycle of Redemption ~ ","EZ",6,2.4,23.66,393,0,5],["Retribution ~ Cycle of Redemption ~ ","HD",11.3,4.819,35.11,789,11.33,5],["Retribution ~ Cycle of Redemption ~ ","IN",16.2,8.773,32.29,1502,17.55,999],["Rrhar'il","EZ",7,3.603,57.17,446,7.92,1.5],["Rrhar'il","HD",12.7,5.655,49.14,700,9.54,1000],["Rrhar'il","IN",16.1,10.502,31.54,1300,16.87,999],["Rrhar'il","AT",17.6,10.502,3.38,1300,18.07,999],["Rubbish Sorting","EZ",3.5,1.471,40.61,229,0,1.5],["Rubbish Sorting","HD",9.4,3.052,26.74,475,0,1.6],["Rubbish Sorting","IN",13.1,3.939,30.02,613,0,1000],["S.A.T.E.L.L.I.T.E.","EZ",5,2.156,51.88,345,0,999],["S.A.T.E.L.L.I.T.E.","HD",9.9,3.578,23,600,0,999],["S.A.T.E.L.L.I.T.E.","IN",14.3,4.992,17.17,897,28.24,999],["S.A.T.E.L.L.I.T.E.","AT",16.2,6.129,8.01,1098,26.22,999],["SIGMA","EZ",5,3.056,47.73,352,0,1.5],["SIGMA","HD",10.5,4.479,43.41,516,8.33,2.2],["SIGMA","IN",15.8,7.434,6.75,785,11.57,9999],["-SURREALISM-","EZ",5,2.305,42.31,338,8,25.6],["-SURREALISM-","HD",9.4,3.893,53.59,571,8,25.6],["-SURREALISM-","IN",13.4,6.232,48.36,914,10.28,4],["Schadenfreude","EZ",4.5,2.354,47.01,351,0,16],["Schadenfreude","HD",10.6,4.024,44.5,600,18.13,16],["Schadenfreude","IN",15.1,8.431,38.42,1257,13.09,99],["Secret Illumination","EZ",5,1.951,33.1,281,0,1.5],["Secret Illumination","HD",10.2,6.18,66.28,863,10.48,3],["Secret Illumination","IN",14.7,6.454,29.19,901,10.72,999],["Sein","EZ",5,1.737,15.27,203,0,1.4],["Sein","HD",10.1,4.048,47.36,473,13.13,1.7],["Sein","IN",15.1,6.262,22.75,721,13.7,7426],["Shadow","EZ",6.5,2.816,29.26,393,10.03,2],["Shadow","HD",10.5,4.74,18.58,549,9.99,2],["Shadow","IN",14.6,6.02,17.62,840,10.87,100000],["Shadow","AT",16.2,7.804,18.27,1089,11.23,999],["Shelter","EZ",3.5,2.216,70.19,265,0,1.8],["Shelter","HD",8.8,3.119,38.14,388,6.48,1.8],["Shelter","IN",13.2,6.403,57.61,696,7.09,1000],["Shine After","EZ",4,1.734,60.31,262,0,2.83],["Shine After","HD",9.7,4.248,62.6,647,0,99],["Shine After","IN",14.6,5.302,9.12,800,11.21,999],["Silence is Golden, Speech is Golden","EZ",5,2.411,28.19,376,0,1.5],["Silence is Golden, Speech is Golden","HD",9.3,5.098,53.46,795,7.26,999],["Silence is Golden, Speech is Golden","IN",15.7,8.683,27.34,1273,13.28,500],["Snow Dance","EZ",4,1.531,1.18,170,0,1.3],["Snow Dance","HD",8.3,3.07,32.26,341,7.36,1.6],["Snow Dance","IN",12.4,5.355,30.47,558,9.29,999],["Snow Desert","EZ",5,2.986,57.42,364,0,1.8],["Snow Desert","HD",10.3,3.765,48.58,459,7.26,1.8],["Snow Desert","IN",13.4,5.054,37.1,655,11.28,9999],["So laggy! (feat. Uzumaki)","EZ",5,1.869,2.75,218,0,999],["So laggy! (feat. Uzumaki)","HD",9.5,3.803,14.83,445,9.52,999],["So laggy! (feat. Uzumaki)","IN",14.6,7.051,22.79,825,11.53,999],["Sparkle New Life","EZ",4,2.383,40.66,305,0,1.5],["Sparkle New Life","HD",9.2,3.883,31.59,497,0,1.6],["Sparkle New Life","IN",12.8,5.352,29.39,684,11.56,1.8],["Spasmodic","EZ",8.2,4.281,32.18,637,0,1.6],["Spasmodic","HD",12.9,6.069,22.7,903,9.48,1.9],["Spasmodic","IN",15.5,9.335,35.64,1389,10.16,2.2],["Spasmodic","AT",16.7,11.23,37.22,1671,12.21,2.2],["Speed Up!","EZ",4.5,2.016,33.97,262,0,2],["Speed Up!","HD",10.3,3.544,17.71,463,0,2],["Speed Up!","IN",14,5.332,20.39,711,11.92,10000],["Spotlight","EZ",4.5,2.327,46.53,288,0,999],["Spotlight","HD",9.9,3.454,25.58,430,0,999],["Spotlight","IN",14.4,6.279,8.11,777,12.48,999],["Stardust:RAY","EZ",6,2.551,37.59,399,0,999],["Stardust:RAY","HD",12.3,5.39,47.16,844,12.3,999],["Stardust:RAY","IN",16.5,8.892,31.18,1392,16.08,999],["Stardust:RAY","AT",17.2,9.937,19.62,1570,19.95,999],["Starduster","EZ",5.5,2.292,38.21,280,0,1000],["Starduster","HD",11.4,4.731,47.4,578,9.14,1000],["Starduster","IN",15.2,7.153,25.17,874,12.97,10000],["Stasis","EZ",5,3.101,57.85,446,0,1.75],["Stasis","HD",10.1,6.271,58.98,902,7,100],["Stasis","IN",15.3,9.191,38.5,1322,10.42,9999],["Stasis","AT",16.7,11.916,32.59,1700,12.05,9999],["Sultan Rage","EZ",4,1.475,32.08,159,0,2],["Sultan Rage","HD",7,3.093,54.49,334,0,2],["Sultan Rage","IN",12.2,4.491,36.49,485,11.81,2],["Swing Skip Drop","EZ",4.5,1.902,37.44,219,0,1.7],["Swing Skip Drop","HD",9.1,2.84,36.7,327,0,2],["Swing Skip Drop","IN",15.5,8.409,15.05,977,20.1,999],["TECHNOPOLIS 2085","EZ",5,1.078,27.66,141,0,999],["TECHNOPOLIS 2085","HD",10.2,3.496,31.6,443,11.91,2],["TECHNOPOLIS 2085","IN",14.1,6.125,15.24,820,17.44,100],["TECHNOPOLIS 2085","AT",15.9,6.155,16.26,824,15.65,999],["Temporal Shifting","EZ",4,0.932,14.96,127,0,900],["Temporal Shifting","HD",11.5,3.413,27.53,465,12.4,14.4],["Temporal Shifting","IN",15.2,7.038,14.81,959,13.57,999],["The Chariot ~REVIIVAL~","EZ",5,3.977,43.27,520,0,1.8],["The Chariot ~REVIIVAL~","HD",9,5,44.85,660,7.59,999],["The Chariot ~REVIIVAL~","IN",14,7.1,21.41,1009,11.63,10000],["The Mountain Eater","EZ",5.5,1.876,3.81,210,0,1.6],["The Mountain Eater","HD",9.6,3.419,10.88,386,0,1.8],["The Mountain Eater","IN",14.8,6.173,5.6,697,12.51,2],["The Whole Rest","EZ",5,1.774,23.96,217,0,999],["The Whole Rest","HD",9.9,3.597,65.29,484,0,999],["The Whole Rest","IN",13.6,6.113,23.31,785,12.12,99],["Thrash force","EZ",4.5,1.548,35.16,219,0,999],["Thrash force","HD",10.7,4.757,38.93,673,12.67,999],["Thrash force","IN",15.3,6.249,11.99,884,13.24,99],["Time to Night Sky (feat. Lee Yu Jin)","EZ",3,1.473,4.24,165,0,1.4],["Time to Night Sky (feat. Lee Yu Jin)","HD",10.1,4.658,45.97,559,0,1.8],["Time to Night Sky (feat. Lee Yu Jin)","IN",13.6,4.571,0,540,10.44,9999],["Träne","EZ",1.5,1.125,62.16,148,0,1.4],["Träne","HD",7,3.014,43.81,420,0,5],["Träne","IN",14.2,4.748,19.06,661,13.38,9999],["Triumph & Regret","EZ",5,3.545,55.56,423,0,1.8],["Triumph & Regret","HD",10.3,5.75,47.84,694,11.16,1.8],["Triumph & Regret","IN",15,8.402,27.32,1014,11.69,1000],["Trojan","EZ",5.5,2.421,28.7,345,0,1.8],["Trojan","HD",10.8,5.2,42.24,741,0,2],["Trojan","IN",15,9.158,64.21,1305,21.72,999],["True Home, True World (Rework)","EZ",5,2.565,60.14,424,0,4],["True Home, True World (Rework)","HD",11.9,4.965,26.77,807,11.26,999],["True Home, True World (Rework)","IN",15.8,7.841,34.33,1142,15.26,4],["Unorthodox Thoughts","EZ",5.5,3.993,66.21,512,0,1.7],["Unorthodox Thoughts","HD",12,5.023,55.43,644,11.12,9999],["Unorthodox Thoughts","IN",13.9,5.686,30.32,729,11.7,999],["Upshift","EZ",6,4.677,73.17,630,0,1.8],["Upshift","HD",10.8,4.414,36.88,545,0,9999],["Upshift","IN",15.5,6.943,19.56,946,19.17,8.8],["Verrückt","EZ",7,2.359,21.25,273,0,1700],["Verrückt","HD",12.7,5.367,24.96,621,12.94,2],["Verrückt","IN",16.5,11.826,30.97,1285,16.71,999],["WATER","EZ",4.5,2.253,27.81,338,0,9999],["WATER","HD",9.5,4.643,23.19,703,8.98,2],["WATER","IN",13.6,4.287,4.04,643,11.74,9999],["Wavetapper","EZ",6,3.005,58.3,470,0,1.867],["Wavetapper","HD",9.4,3.241,37.87,507,9.54,1.867],["Wavetapper","IN",13.9,2.763,4.73,866,10.15,9999],["What do you want more than a Happy endin","EZ",0.5,0.107,25,4,0,6],["What do you want more than a Happy endin","HD",11.5,5.243,26.65,818,17.36,999],["What do you want more than a Happy endin","IN",16.1,7.89,5.26,1217,17.45,999],["What do you want more than a Happy endin","AT",17.1,10.063,17.22,1568,19.29,999],["Winter ↑cube↓","EZ",3.5,2.009,35.29,306,0,1.8],["Winter ↑cube↓","HD",8.2,3.126,52.78,449,0,999],["Winter ↑cube↓","IN",13.3,4.887,12.01,733,10.41,2],["With You","EZ",3.5,1.889,10.62,226,0,1.5],["With You","HD",9.1,5.466,51.83,654,8.79,1.8],["With You","IN",13.5,6.469,15.5,774,13.93,100],["XING","EZ",5.5,2.394,8.71,310,0,1.8],["XING","HD",10.8,4.51,28.62,587,8.37,1.8],["XING","IN",14,5.578,11.67,711,8.38,10100],["Xenolith","EZ",4,1.585,18.32,202,0,2],["Xenolith","HD",8.5,4.071,43.34,533,9.21,2],["Xenolith","IN",14.2,6.754,23.32,789,10.4,6],["Xenophobia","EZ",6.5,2.576,31.97,366,7.73,1.6],["Xenophobia","HD",12.6,6.145,45.25,873,8.73,1.9],["Xenophobia","IN",14.9,10.889,45.45,1562,11.93,999],["Xep+ion","EZ",2.5,1.21,86.18,123,0,999],["Xep+ion","HD",9.8,3.258,19.02,368,6.88,999],["Xep+ion","IN",14.8,6.681,14.61,698,12.53,999],["You are the Miserable","EZ",6,3.114,51.23,486,0,3.2],["You are the Miserable","HD",11.7,5.281,50,762,0,12],["You are the Miserable","IN",14.1,5.722,21.84,893,12.43,9999],["You are the Miserable","AT",15.8,8.611,28.65,1344,15.77,10000],["a truth seeker -Communication with Utopi","EZ",6.5,3.132,43.9,328,9.16,999],["a truth seeker -Communication with Utopi","HD",12.4,5.3,26.31,555,11.2,999],["a truth seeker -Communication with Utopi","IN",15.7,8.647,24.85,986,15.53,999],["bye","EZ",4,1.319,36.56,186,0,1.5],["bye","HD",9.1,2.313,24.92,333,0,2.3],["bye","IN",14.8,5.035,27.03,725,12.04,500],["cryout","EZ",3.5,1.844,38.01,221,0,1.7],["cryout","HD",9.9,4.414,38,529,7.33,1.7],["cryout","IN",13.6,5.942,22.61,712,9.64,100],["c.s.q.n.","EZ",5,2.991,40.3,330,0,9999],["c.s.q.n.","HD",12.2,6.497,55.36,755,9.33,4],["c.s.q.n.","IN",15.9,9.201,23.92,1066,13.03,999],["dB doll","EZ",1.5,0.668,25,60,0,1.6],["dB doll","HD",3.5,1.38,62.9,124,0,1.8],["dB doll","IN",8.3,2.637,46.84,237,0,1.5],["dB doll","AT",13.4,4.728,6.63,377,11,1000],["energy trixxx","EZ",5,1.953,37.3,252,0,9999],["energy trixxx","HD",10.4,3.698,25.37,477,0,9999],["energy trixxx","IN",15.4,7.23,11.61,930,17.3,99999],["iL-Artifact","EZ",5.5,3.27,53.32,482,0,99999],["iL-Artifact","HD",10.5,6.276,54.05,925,12.6,6],["iL-Artifact","IN",15.7,8.104,30.34,1279,12.95,999],["inferior","EZ",7,2.354,0,226,13.33,999],["inferior","HD",7.5,5.094,55.83,489,0,999],["inferior","IN",14.6,7.964,22.12,755,13.69,9999],["life flashes before weeb eyes","EZ",6.5,3.79,58.2,567,0,1.8],["life flashes before weeb eyes","HD",11.9,6.406,48.96,960,10.32,1.8],["life flashes before weeb eyes","IN",14.9,7.119,32.11,1065,14.2,4],["mechanted","EZ",3,1.8,41.3,184,0,1.5],["mechanted","HD",11.3,4.892,41.8,500,9.84,1000],["mechanted","IN",14.9,6.48,9.06,662,12.54,5000],["micro.wav","EZ",6,1.756,0,196,0,1.5],["micro.wav","HD",10.5,4.112,27.89,459,8.2,1.8],["micro.wav","IN",14.7,5.814,0.31,649,9.49,2],["modulus","EZ",4.5,2.275,44.19,258,0,2],["modulus","HD",10.4,4.236,18.67,482,10.53,2.2],["modulus","IN",14.9,6.802,15.63,774,27.52,10000],["opia","EZ",5.5,1.688,17.6,233,0,9999],["opia","HD",10.6,3.97,51.28,548,0,9999],["opia","IN",15.6,5.745,26.86,793,12,100000],["ρars/ey","EZ",4,1.554,24.31,181,0,1919],["ρars/ey","HD",11.7,4.216,12.92,449,8.75,1919],["ρars/ey","IN",14.6,7.296,28.19,777,10.43,9999],["sølips","EZ",7.5,2.664,43.25,363,0,999],["sølips","HD",12.8,6.801,48.88,935,14.44,999],["sølips","IN",16,8.204,44.33,1128,14.43,199],["sølips","AT",16.8,8.546,23.57,1175,16.45,999],["valor/starcross","EZ",6.5,3.141,41.75,479,7.05,5],["valor/starcross","HD",12.7,5.475,19.88,835,10.41,2],["valor/starcross","IN",15.8,7.102,15.6,1083,11.75,999],["volcanic","EZ",7.5,7.898,80.8,1052,0,3],["volcanic","HD",12.1,7.4,39.7,985,10.03,2.4],["volcanic","IN",14.7,9.014,26.23,1178,11.94,10000],["volcanic","AT",16.6,12.874,25.39,1650,12.25,9999],["いざ、参ります","EZ",3.5,1.993,15.96,188,0,1.8],["いざ、参ります","HD",9.2,4.676,23.58,441,7.67,2],["いざ、参ります","IN",15,9.172,10.98,865,14.03,9999],["ぱぴぷぴぷぴぱ","EZ",5,3.693,60.13,637,0,9.6],["ぱぴぷぴぷぴぱ","HD",12.3,7.452,37.91,1290,8.19,999],["ぱぴぷぴぷぴぱ","IN",15.9,7.206,2.01,1243,10.84,100],["もぺもぺ","EZ",2,1.177,21.6,125,0,1.6],["もぺもぺ","HD",6.5,2.721,22.49,289,0,99],["もぺもぺ","IN",11.1,3.879,22.82,412,10.17,99],["もぺもぺ","AT",15.4,6.723,19.17,720,14.33,1000],["アンビバレンス","EZ",3.5,1.898,48.83,299,0,999],["アンビバレンス","HD",8.7,3.672,43.52,579,9.26,999],["アンビバレンス","IN",14.2,7.16,28.28,1128,13.91,999],["インフェルノシティ","EZ",4.5,3.255,63.92,352,0,9999],["インフェルノシティ","HD",11.5,5.338,22.66,578,10.26,9999],["インフェルノシティ","IN",15.7,11.318,30.59,1275,14.55,9999],["インマイマインド","EZ",1.5,0.553,47.19,89,0,999],["インマイマインド","HD",9.2,2.975,30.69,479,0,500],["インマイマインド","IN",12.5,3.49,17.08,562,0,999],["ジングルベル(Jingle Bell)","EZ",4.5,3.982,67.29,639,0,1000],["ジングルベル(Jingle Bell)","HD",8.5,3.066,30.28,492,9.82,9999],["ジングルベル(Jingle Bell)","IN",14.5,7.689,50.44,1239,10.56,9999],["ストレイソウル・アラウンド","EZ",6,2.565,36.73,324,0,999],["ストレイソウル・アラウンド","HD",9.8,3.809,38.48,486,0,999],["ストレイソウル・アラウンド","IN",14.3,7.116,32.93,908,12.35,100],["ニライカナイ (NiraicA_nai Mix)","EZ",3,1.466,24.64,207,0,999],["ニライカナイ (NiraicA_nai Mix)","HD",8.3,2.401,12.71,354,0,1.8],["ニライカナイ (NiraicA_nai Mix)","IN",13.5,4.408,10.77,650,11.38,999],["ハテ","EZ",9,6.567,68.06,1049,9.32,999],["ハテ","HD",13.9,6.25,33.1,1000,11.45,20],["ハテ","IN",16.7,6.338,6.8,1014,14.35,999],["ハテ","AT",17.9,8.441,16.75,1397,15.96,1000],["万吨匿名信","EZ",4.5,2.007,21.82,307,0,1.2],["万吨匿名信","HD",9.5,4.235,39.97,648,0,1.5],["万吨匿名信","IN",13,5.358,18.31,781,9.83,1.8],["下一秒","EZ",4,1.082,30.97,155,0,888],["下一秒","HD",8.5,1.69,27.27,242,0,999],["下一秒","IN",13.6,3.811,10.8,500,13.33,999],["亂★舞","EZ",2,1.007,28.57,119,0,1.4],["亂★舞","HD",7.5,2.725,38.23,327,0,2],["亂★舞","IN",13.2,4.59,29.93,548,12.08,99],["云女孩","EZ",2,1.269,60.91,220,0,1.6],["云女孩","HD",8.9,3.102,22.3,538,0,1.8],["云女孩","IN",12.8,3.858,4.48,669,10.79,2],["今天不是明天","EZ",2.5,1.92,72.79,294,0,999],["今天不是明天","HD",8.3,3.533,45.24,546,0,999],["今天不是明天","IN",13.4,5.564,23.44,913,12.43,500],["光","EZ",2,1.19,39.13,138,0,1.4],["光","HD",7.5,2.716,17.14,315,7.5,1.6],["光","IN",12.4,4.044,15.09,517,9.17,1.8],["千紫万紅","EZ",4.5,1.728,28.75,240,0,999],["千紫万紅","HD",12.1,5.596,43,779,9.94,2],["千紫万紅","IN",15.5,8.638,33.08,1200,13.03,999],["双重间谍 (Double Agent)","EZ",4.5,2.507,44.8,346,0,99],["双重间谍 (Double Agent)","HD",11.8,5.262,27.64,738,13.87,999],["双重间谍 (Double Agent)","IN",15.7,9.615,28.46,1353,16.53,999],["君往何处 (Quo Vadis)","EZ",4,1.617,19.23,208,0,1000],["君往何处 (Quo Vadis)","HD",8.6,3.023,20,390,0,1000],["君往何处 (Quo Vadis)","IN",14.1,7.323,16.04,935,13.95,999],["夢の降る日に","EZ",2.5,1.081,12.5,128,0,1.5],["夢の降る日に","HD",9.8,3.842,46.15,455,0,64],["夢の降る日に","IN",16.6,10.026,27.92,1243,18.78,3.6],["大和撫子 -Wild Dances-","EZ",5.5,2.283,24.45,274,0,2],["大和撫子 -Wild Dances-","HD",11.8,4.575,22.04,549,10.2,1.8],["大和撫子 -Wild Dances-","IN",15.1,8.246,20.06,1002,15.89,10000],["宇宙残骸少女 (Cosmic Dusty Girl)","EZ",6,0.583,27.14,70,0,9],["宇宙残骸少女 (Cosmic Dusty Girl)","HD",10.2,2.627,72.98,322,0,10],["宇宙残骸少女 (Cosmic Dusty Girl)","IN",13.7,5.677,28.94,691,10.55,3],["尊師 ～The Guru～","EZ",6,3.217,28.24,386,0,1.8],["尊師 ～The Guru～","HD",11.6,4.771,25.84,565,0,2],["尊師 ～The Guru～","IN",15.4,6.232,27.24,738,21.51,30],["幻影鬼魅 (PLEASE)","EZ",5.5,2.346,49.12,283,0,128],["幻影鬼魅 (PLEASE)","HD",9.6,5.296,56.65,639,0,128],["幻影鬼魅 (PLEASE)","IN",15.2,8.89,28.15,1080,12.78,77],["幻影鬼魅 (PLEASE)","AT",17,9.483,3.32,1145,16.85,514],["幽世桔梗","EZ",4.5,1.611,23.32,223,0,1.5],["幽世桔梗","HD",10.1,3.805,20.46,562,7.5,2],["幽世桔梗","IN",14.8,6.583,22.53,981,11.37,999],["开心病","EZ",7,3.63,36.09,399,0,999],["开心病","HD",11.9,5.467,39.77,601,11.64,999],["开心病","IN",13.8,7.642,18.1,840,12.24,2.25],["彩","EZ",6,2.472,45.5,378,0,99],["彩","HD",12.5,5.343,39.17,817,9.26,100],["彩","IN",16.4,9.432,31.41,1439,13.95,999],["彼方へ、名もなき海辺より","EZ",3.5,1.382,35.48,217,0,99],["彼方へ、名もなき海辺より","HD",8.1,2.606,32.03,409,0,1.8],["彼方へ、名もなき海辺より","IN",14.5,5.358,27.47,841,12.13,2.2],["心の記憶","EZ",3.5,1.944,69.45,311,0,999],["心の記憶","HD",9.1,3.931,71.07,629,0,999],["心の記憶","IN",13.4,5.025,31.34,804,11.96,1000],["心之所向","EZ",4,1.784,41.59,226,0,1.7],["心之所向","HD",8.2,3.297,22.27,422,7.95,2],["心之所向","IN",13.8,5.57,9.82,713,11.95,999],["明鏡烈火","EZ",6,3.316,57.98,376,0,999],["明鏡烈火","HD",11.1,4.991,32.86,566,8.33,999],["明鏡烈火","IN",15.9,7.239,5.08,886,13.35,999],["星拂云锦 feat. koi","EZ",4,1.435,19.38,227,0,1.8],["星拂云锦 feat. koi","HD",9,3.726,47.5,600,8.09,5],["星拂云锦 feat. koi","IN",15.5,7.624,28.42,1235,11.58,5.85],["暗夜苏醒 (REANIMATE)","EZ",5,1.592,7.2,236,0,1.8],["暗夜苏醒 (REANIMATE)","HD",12.8,5.679,39.55,842,8.64,514],["暗夜苏醒 (REANIMATE)","IN",15.3,8.511,33.84,1262,11.09,999],["最高傑作","EZ",4.5,1.68,25.12,203,0,99],["最高傑作","HD",9.3,2.863,31.5,346,0,99],["最高傑作","IN",13.9,5.163,27.12,697,37.33,999],["月下缭乱","EZ",4.5,3.078,51.31,419,0,9999],["月下缭乱","HD",9.4,4.224,32.83,533,7.46,9999],["月下缭乱","IN",14.9,2.353,31.17,969,11.82,9999],["月詠に鳴る","EZ",6,2.445,71.33,293,0,1000],["月詠に鳴る","HD",11.4,4.169,53.12,544,10.37,999],["月詠に鳴る","IN",14.5,6.571,23.78,858,14.87,999],["月詠に鳴る","AT",15.7,7.333,16.84,938,12.49,999],["望影の方舟Six","EZ",6.5,2.53,27.17,276,0,999],["望影の方舟Six","HD",11.9,4.822,34.6,526,8.77,999],["望影の方舟Six","IN",15.9,9.67,35.18,1066,14.49,999],["桜樹街道","EZ",3.5,2.161,39.38,292,0,1.7],["桜樹街道","HD",8.1,3.116,40.86,421,0,2],["桜樹街道","IN",13,3.586,3.05,459,12.64,4],["混乱-Confusion","EZ",4,2.629,57.99,319,0,1.8],["混乱-Confusion","HD",10,3.94,57.32,478,13.22,2.5],["混乱-Confusion","IN",14.8,8.06,30.78,978,11.95,10000],["游园地","EZ",2.5,1.833,57.73,220,0,9999],["游园地","HD",7.5,3.7,66.44,444,0,9999],["游园地","IN",13,4.581,19.96,481,9.77,1000],["狂喜蘭舞","EZ",7,3.109,26.27,472,9.58,1.6],["狂喜蘭舞","HD",11.7,4.288,16.28,651,9.97,3],["狂喜蘭舞","IN",14.3,6.376,26.03,968,11.04,999],["狂喜蘭舞","AT",16.4,8.727,21.51,1325,13.89,20],["玩具狂奏曲 -終焉-","EZ",8.4,3.363,63.8,489,0,999],["玩具狂奏曲 -終焉-","HD",13.1,3.562,37.04,513,10.62,99],["玩具狂奏曲 -終焉-","IN",16,9.571,44.92,1418,11.31,999],["玩具狂奏曲 -終焉-","AT",17,9.825,14.34,1374,19.33,999],["瓷岁","EZ",2,0.791,21.67,120,0,50],["瓷岁","HD",6.5,2.037,28.48,309,0,1.8],["瓷岁","IN",7,2.563,60,365,0,9999],["白と黒のバケモノ","EZ",4,1.727,43.29,231,0,99],["白と黒のバケモノ","HD",11.4,6.789,54.81,914,8.77,514],["白と黒のバケモノ","IN",15.9,8.969,14.79,1197,14.71,999],["百鬼֎夜行","EZ",4.5,1.972,24.9,253,0,1.8],["百鬼֎夜行","HD",10.1,4.858,34.88,625,12.76,100],["百鬼֎夜行","IN",15.8,7.81,17.78,956,14.87,999],["盏茗","EZ",1.5,0.679,12.05,83,0,1.3],["盏茗","HD",4.5,1.439,21.59,176,0,1.3],["盏茗","IN",13.4,5.667,30.45,706,11.48,9999],["祈 -我ら神祖と共に歩む者なり-","EZ",7,3.903,53.6,666,9.53,514],["祈 -我ら神祖と共に歩む者なり-","HD",13.2,6.511,41.04,1111,17.4,99],["祈 -我ら神祖と共に歩む者なり-","IN",16.4,13.018,48.69,2222,16.31,999],["祈 -我ら神祖と共に歩む者なり-","AT",17.3,10.082,37.94,2222,18.82,514],["神話","EZ",4,2.189,44.29,289,0,1.5],["神話","HD",8.7,3.475,36.95,433,0,1.75],["神話","IN",13.5,5.728,22.99,735,10.32,8],["聖夜讃歌","EZ",4.5,2.364,36.57,402,0,999],["聖夜讃歌","HD",10.1,3.487,14.5,593,8.35,999],["聖夜讃歌","IN",15.2,7.453,30.69,1339,11.99,999],["華灯爱","EZ",6,3.389,62.82,312,0,2],["華灯爱","HD",10.6,3.878,39.78,357,13.71,2],["華灯爱","IN",13.7,4.809,28.08,520,18.84,9999],["萤火虫の怨","EZ",4,1.65,17.14,245,0,1.4],["萤火虫の怨","HD",9.8,5.024,52.01,746,8.08,1.6],["萤火虫の怨","IN",13.1,5.948,30.4,885,10.32,1.8],["蝎虎天体 -Lacertid-","EZ",4.5,1.955,36.26,273,0,4],["蝎虎天体 -Lacertid-","HD",10.8,4.268,22.82,596,9.25,4],["蝎虎天体 -Lacertid-","IN",15.5,9.447,23.59,1238,13.07,100],["贝多芬祝福 (Beethoven Blessing)","EZ",4.5,2.396,43.52,301,0,1.7],["贝多芬祝福 (Beethoven Blessing)","HD",10.3,3.542,40.22,445,15.23,999],["贝多芬祝福 (Beethoven Blessing)","IN",15,7.266,27.49,913,11.55,999],["重生","EZ",4.5,2.571,48.02,354,0,2],["重生","HD",8.8,4.721,60.77,650,0,2.2],["重生","IN",14.3,6.536,17.67,900,9.64,99],["雪降り、メリクリ","EZ",4.5,2.054,55.38,316,0,15000],["雪降り、メリクリ","HD",10.8,3.634,23.79,559,8.78,15000],["雪降り、メリクリ","IN",15.4,6.559,10.01,939,11.45,10000],["雪降り ~雪が降っている~","EZ",1.5,0.784,19.82,111,0,1.6],["雪降り ~雪が降っている~","HD",7.5,2.57,50,364,0,1.8],["雪降り ~雪が降っている~","IN",12,3.031,19.11,429,0,999],["雪降り ~雪が降っている~","AT",14,3.75,8.66,531,0,999],["零號車輛","EZ",7.5,4.258,49.33,594,0,5],["零號車輛","HD",12.1,7.53,65.22,1058,10.2,99],["零號車輛","IN",16.2,9.43,31.69,1240,15.85,999],["青丘","EZ",5.5,1.942,28.87,284,0,1.7],["青丘","HD",10.5,3.264,43.45,534,19.5,1.8],["青丘","IN",15.5,8.916,43.63,1304,14.15,13],["青芽","EZ",5,2.889,60.93,366,0,9999],["青芽","HD",10.4,4.105,28.08,520,8.97,9999],["青芽","IN",15.2,7.982,23.68,1102,12.7,999],["风屿","EZ",5.5,2.117,20.65,368,0,1.2],["风屿","HD",9.8,4.619,60.22,802,6.91,1.5],["风屿","IN",14,6.65,36.59,1156,10.28,2],["风屿","AT",15.1,7.296,18.85,1236,11.87,99],["黄金之城 (GOLD TOWN)","EZ",2,0.896,33.33,90,0,514],["黄金之城 (GOLD TOWN)","HD",10.2,3.443,38.48,408,0,3.1],["黄金之城 (GOLD TOWN)","IN",14.7,7.232,16.69,857,13.42,999]];

/* k-NN 参考定数：全语料无门控纯特征匹配（对垃圾难度标签免疫），
   距离 = 4 维 log 特征 z-score 欧氏（对照 phm/core.py knn_feats），
   输出 = 20 邻居官方定数的加权中位 */
export function knnReference(f,spPeak){
  const q=[Math.log1p(f.real_notes_per_second),Math.log1p(f.hold_ratio*100),
           Math.log1p(Math.max(f.notes_real,1)),Math.log1p(f.stair_speed_avg||0),
           Math.log1p(Math.max(spPeak||0,0))];
  const p=5,n=OFFICIAL_REF.length;
  const mu=new Array(p).fill(0),sd=new Array(p).fill(0);
  for(const row of OFFICIAL_REF){
    const v=[Math.log1p(row[3]),Math.log1p(row[4]),Math.log1p(Math.max(row[5],1)),
             Math.log1p(Math.max(row[6],0)),Math.log1p(Math.max(row[7],0))];
    for(let c=0;c<p;c++)mu[c]+=v[c]/n;
  }
  for(const row of OFFICIAL_REF){
    const v=[Math.log1p(row[3]),Math.log1p(row[4]),Math.log1p(Math.max(row[5],1)),
             Math.log1p(Math.max(row[6],0)),Math.log1p(Math.max(row[7],0))];
    for(let c=0;c<p;c++)sd[c]+=(v[c]-mu[c])**2/n;
  }
  for(let c=0;c<p;c++)sd[c]=Math.sqrt(sd[c])||1;
  const qz=q.map((x,c)=>(x-mu[c])/sd[c]);
  const dists=[];
  for(let i=0;i<n;i++){
    const row=OFFICIAL_REF[i];
    const v=[Math.log1p(row[3]),Math.log1p(row[4]),Math.log1p(Math.max(row[5],1)),
             Math.log1p(Math.max(row[6],0)),Math.log1p(Math.max(row[7],0))];
    let d2=0;
    for(let c=0;c<p;c++){const z=(v[c]-mu[c])/sd[c];d2+=(z-qz[c])*(z-qz[c]);}
    dists.push([Math.sqrt(d2),row]);
  }
  dists.sort(function(a,b){return a[0]-b[0];});
  const near=dists.slice(0,20);
  const scale=Math.max(near[near.length-1][0],1e-6);
  const pairs=near.map(function(d2){
    return [d2[1][2],Math.exp(-(d2[0]/scale)*(d2[0]/scale)*2.0)];});
  pairs.sort(function(a,b){return a[0]-b[0];});
  let tot=0; for(const pr of pairs)tot+=pr[1];
  let acc=0, mid=null;
  for(const pr of pairs){acc+=pr[1]; if(acc>=tot/2){mid=pr[0];break;}}
  const lvCount={};
  near.forEach(function(d2){const lv=d2[1][1]||"?";
    lvCount[lv]=(lvCount[lv]||0)+1;});
  let tier="?",bestC=-1;
  for(const lv in lvCount) if(lvCount[lv]>bestC){bestC=lvCount[lv];tier=lv;}
  return {ref:mid, tier:tier, near:near.slice(0,5).map(function(d2){
    return {name:d2[1][0],level:d2[1][1],diff:d2[1][2]};})};
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

/* ── P.H.M. Standard 公式 v0.1（对照 tools/phm_standard.py，逐常数一致）── */
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

/* ── analyze(fileBytes, fileName) → 报告对象数组 ── */
export async function analyzeChart(buf,fileName){
  const zip=zipParse(buf);
  const reports=[];
  const chartEntries=zip.files.filter(x=>/\.json$/i.test(x.name));
  if(!chartEntries.length) throw new Error("包里没有 .json 谱面文件");
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
  for(const en of chartEntries){
    let j;
    const raw=await en.read();
    let txt=new TextDecoder("utf-8").decode(raw);
    if(txt.charCodeAt(0)===0xFEFF) txt=txt.slice(1);
    try{ j=JSON.parse(txt); }
    catch(e){ reports.push({file:fileName,name:en.name,error:"JSON 解析失败: "+e.message}); continue; }
    if(!j.judgeLineList) continue;              // 非 RPE 谱面（如 meta json）
    const r=loadChart(j);
    const ts=r.real.map(n=>n.sec), ty=r.real.map(n=>n.type);
    const f=Object.assign({},
      strainFeatures(ts,ty), rhythmFeatures(ts),
      extractDims(r.real,r.ev,r.dur,r.bpm,r.nlines));
    f.notes_all=r.notes.length;
    const ps=psScore(f);
    const spPeak=speedPeakOfChart(j);
    const knn=knnReference(f,spPeak);
    if(meta.name) r.title=meta.name;
    if(meta.charter) r.charter=meta.charter;
    reports.push({file:fileName,name:meta.name||en.name,
      level:meta.level||knn.tier||"", charter:meta.charter||"",
      feats:f,ps:ps,knn:knn,spPeak:spPeak,bpm:r.bpm});
  }
  if(!reports.length) throw new Error("没有找到可解析的 RPE 谱面");
  return reports;
}

