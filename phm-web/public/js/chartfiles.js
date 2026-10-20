/* ============================================================
 * js/chartfiles.js —— 谱面资源（浏览器侧）：下载 + 本地打包
 * ============================================================
 * 【为什么打包在浏览器做】
 *   曲绘 / 音乐 / chart.json 一律**直接从 Phira 的 CDN 取**，
 *   我们服务器只传字符串。理由见 lib/chartfiles.mjs 顶部：
 *   服务器中转等于拿我们的出口 IP 替全网扒上游，
 *   还要白烧带宽、还踩 DMCA。
 *
 * 【.pez 的实际形态】
 *   一个 zip，里面必须有 chart.json。
 *   上游的 file 直链本身**就是 .pez**（zip），
 *   但我们要重新打一遍，原因见 packPez 的注释。
 *
 * ⚠ 全部 fetch 都带 abort 超时：
 *   CDN 卡住时没有超时的 fetch 会永远挂着，
 *   界面就停在「正在打包」—— 用户看不出是死了还是在等。
 * ============================================================ */

import { zipStore } from './rulechart.js?v=V0.21.1.3';
import { clipName, pezFileName, PEZ_CHART_ENTRY } from './chartfiles-core.mjs?v=V0.21.1.3';

/* 单个文件的上限。⚠ 必须有：Phira 的音频最大能到 40MB+，
 * 不设限时一个卡住的文件能把整个打包拖到天荒地老。 */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_FILE_BYTES = 120 * 1024 * 1024;

/* ⚠ 单文件失败的策略：**继续**。
 * 用户勾了 4 个文件，其中曲绘 404 了 —— 他应该拿到另外 3 个
 * 并被告知少了 1 个，而不是整包失败、一个都拿不到。 */
async function grab(url, name) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, mode: 'cors' });
    if (!r.ok) return { ok: false, name, url, err: 'HTTP ' + r.status };
    /* ⚠ 先读长度再决定要不要收：Content-Length 可能没有，
     * 那就边读边数，超了就掐断 —— 不掐的话一个 500MB 的
     * 异常文件能把浏览器内存吃光（表现为标签页崩溃，不是报错）。 */
    const len = Number(r.headers.get('content-length')) || 0;
    if (len > MAX_FILE_BYTES) {
      return { ok: false, name, url, err: '文件过大（' + Math.round(len / 1048576) + 'MB）' };
    }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) {
      return { ok: false, name, url, err: '文件过大' };
    }
    return { ok: true, name, url, data: new Uint8Array(buf), size: buf.byteLength };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '超时' : (e && e.message) || '未知错误';
    return { ok: false, name, url, err: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ── 打进包里用的内部文件名 ──
 * ⚠ 曲绘/音频在包里的名字不重要（Phira 只找 chart.json），
 *   但**扩展名要保留** —— 某些工具靠扩展名判断格式，
 *   上游直链没扩展名，全叫 file.bin 会让下游编辑器打不开。 */
function innerName(kind, url) {
  const ext = (String(url).match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [])[1];
  switch (kind) {
    case 'chart':   return PEZ_CHART_ENTRY;
    case 'audio':   return 'audio' + (ext ? '.' + ext.toLowerCase() : '.mp3');
    case 'illust':  return 'illustration' + (ext ? '.' + ext.toLowerCase() : '.png');
    case 'preview': return 'preview' + (ext ? '.' + ext.toLowerCase() : '.mp4');
    default:        return 'file' + (ext ? '.' + ext.toLowerCase() : '.bin');
  }
}

/* ══════════════════════════════════════════════════════════════
 * 打包 .pez
 * ══════════════════════════════════════════════════════════════
 * ⚠ 为什么**解包重打**而不是直接把上游 .pez 转存：
 *   上游那个包是「谱面作者上传时的样子」，里面可能有
 *   chart.json 之外的杂项、也可能只有 chart.json。
 *   而用户勾了曲绘/音频，想要的是一个**齐全**的包。
 *   所以：取出 chart.json 原样保留，其余按用户勾选补进去。
 *
 * ⚠ chart.json 必须**原样**放进去，绝不重序列化：
 *   JSON.parse → JSON.stringify 会丢字段顺序、丢数字精度
 *   （大整数会变成 1e+21），Phira 读出来行为可能变。
 *   重打包在这里是原子的 —— 字节从 zip 里出来再进新 zip。
 */
export async function packPez(chart, wanted, onProgress) {
  const want = Array.isArray(wanted) && wanted.length
    ? wanted
    : ['chart'];

  const entries = [];
  const failed = [];
  let done = 0;

  for (const kind of want) {
    const url = kind === 'chart' ? chart.file : kind === 'audio' ? chart.audioUrl
      : kind === 'illust' ? chart.illustration : chart.preview;
    if (!url) {
      failed.push({ kind, err: '这张谱面没有提供这个文件' });
      done++;
      onProgress && onProgress(done, want.length, kind);
      continue;
    }
    /* 音频不是 file 直链 —— Phira 的音乐要从 /music 拿。
     * ⚠ 上游 chart 对象里**没有** audioUrl 字段（实测），
     *   所以由调用方补；这里只处理非空的情况。 */
    const r = await grab(url, innerName(kind, url));
    if (r.ok) entries.push({ name: r.name, data: r.data });
    else failed.push({ kind, err: r.err });
    done++;
    onProgress && onProgress(done, want.length, kind);
  }

  /* 一个都没拿到 → 直接失败，别给用户一个空 zip。
   * 空 .pez 塞进 Phira 会报「找不到 chart.json」，
   * 那是个让人摸不着头脑的错，而真因（网络/权限）在这里就丢了。 */
  if (!entries.length) {
    return { ok: false, failed, err: '所有文件都没能取到' };
  }

  const zip = zipStore(entries);
  const blob = new Blob([zip], { type: 'application/zip' });
  return {
    ok: true,
    blob,
    name: pezFileName(chart.name || 'chart'),
    /* 报告包里实际有什么 —— 页面上要如实说，不能只说"打包好了" */
    packed: entries.map(e => e.name),
    failed,
  };
}

/* ── 触发下载 ──
 * ⚠ 必须先 revokeObjectURL：Blob 一直占着内存，
 *   连打 20 个包就能把标签页吃崩。
 * ⚠ 用 setTimeout(…, 0) 而不是立刻 revoke：
 *   立刻 revoke 的话浏览器还没开始读，下载会静默失败
 *   （表现为"点了没反应"，这个坑踩过不止一次）。 */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = clipName(name, 'download');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── 单文件下载（不打包） ──
 * ⚗不 fetch 也不转 blob —— 直接给 <a download> 指向 CDN 直链。
 *   浏览器自己流式下载，不占我们的内存也不占我们的带宽。
 *   ⚠ 但 CDN 直链多数不响应 download 头，浏览器会**打开**它
 *     而不是存盘 —— 所以用 rel="noreferrer" 配 target="_blank" 兜底，
 *     用户再自己右键另存。两种情况都提示一句。 */
export function fileUrlOf(chart, kind) {
  switch (kind) {
    case 'chart':   return chart.file || '';
    case 'audio':   return chart.audioUrl || '';
    case 'illust':  return chart.illustration || '';
    case 'preview': return chart.preview || '';
    default:        return '';
  }
}