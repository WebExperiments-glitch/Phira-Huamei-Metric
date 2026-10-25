/* ============================================================
 * i18n 分片：/render（谱面渲染预览）
 * 前缀 rnd. —— 不要太短，免得和别的分片撞键
 * ============================================================ */

export default {
  zh: {
    'nav.render': '谱面渲染',
    'rnd.h1': '谱面渲染预览',
    'rnd.lead': '拖入一张 RPE 谱面（.json），这里会把它按时间播出来。'
      + '纯前端，文件不上传。',
    'rnd.drop': '拖入谱面，或点击选择',
    'rnd.hint': '支持 RPE 的 .json（v1 与 v160 两种结构都认）。'
      + '⚠ .pec 是另一种文本格式，暂不支持——拖进去会明确报错，不是文件坏了。',
    'rnd.play': '播放',
    'rnd.pause': '暂停',
    'rnd.reading': '读取中…',
    'rnd.needJson': '这个文件不是 JSON。.pec 是另一种文本格式，目前不支持。',
    'rnd.noNotes': '解析出 0 个音符——可能是另一种结构的谱面，把文件发我看看。',
    'rnd.notes': '音符',
    'rnd.lines': '判定线',
    'rnd.schema': '结构',
    'rnd.dur': '时长',
    'rnd.audio': '配一个音频（可选）',
    'rnd.audioHint': '选一段和谱面对得上的音频，时间轴就跟它走。',
    'rnd.limit': '这是**简化视图**，不是 Phira 的渲染器：没有特效、没有音符贴图、'
      + '缓动只做了常见几种。它的用途是"一眼看出这谱长什么样"，不是替代 phira-render。',
  },
  en: {
    'nav.render': 'Renderer',
    'rnd.h1': 'Chart render preview',
    'rnd.lead': 'Drop an RPE chart (.json) and it plays back over time. '
      + 'Runs entirely in your browser — nothing is uploaded.',
    'rnd.drop': 'Drop a chart, or click to choose',
    'rnd.hint': 'Accepts RPE .json (both v1 and v160 layouts). '
      + '⚠ .pec is a different text format and is not supported yet — it will say so, not fail silently.',
    'rnd.play': 'Play',
    'rnd.pause': 'Pause',
    'rnd.reading': 'Reading…',
    'rnd.needJson': 'This file is not JSON. .pec is a different text format and is not supported yet.',
    'rnd.noNotes': 'Parsed 0 notes — possibly a layout we do not handle yet. Send me the file.',
    'rnd.notes': 'Notes',
    'rnd.lines': 'Judge lines',
    'rnd.schema': 'Layout',
    'rnd.dur': 'Duration',
    'rnd.audio': 'Attach audio (optional)',
    'rnd.audioHint': 'Pick audio that matches the chart; the timeline follows it.',
    'rnd.limit': 'This is a **simplified view**, not Phira’s renderer: no effects, no note textures, '
      + 'only a few easing curves. It is for seeing what a chart looks like — not a phira-render replacement.',
  },
};
