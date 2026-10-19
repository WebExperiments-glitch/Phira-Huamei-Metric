/* ============================================================
 * js/i18n/packs.js —— 谱面包页（/packs）的外壳文案
 * ============================================================ */
export default {
  zh: {
    'pk.title': '谱面包',
    'pk.sub':
      '把任意谱面连同曲绘、音频打成 <b>.pez</b> 包带走。' +
      '所有文件都从你的浏览器直连Phira 的服务器下载，' +
      '<b>不经我们的服务器中转</b>。',

    /* ── 搜索区 ── */
    'pk.search': '搜曲名、谱师、作曲、标签…',
    'pk.searchHint': '也可以搜玩家昵称 —— 那些常出现在简介和标签里',
    'pk.level': '难度',
    'pk.allLevels': '全部难度',
    'pk.sort': '排序',
    'pk.sortDefault': '默认',
    'pk.sortRating': '评分最高',
    'pk.sortNewest': '最新',
    'pk.sortLevel': '定数最高',
    'pk.resultCount': '{n} 张谱面',
    'pk.noResult': '没找到匹配的谱面',
    'pk.noResultHint': '换个关键词试试，或者清掉难度筛选。',
    'pk.loading': '正在取谱面…',
    'pk.loadFail': '取不到谱面数据',
    'pk.loadFailHint': '这是上游 Phira 的公开接口，可能临时不可用。稍后重试。',
    'pk.retry': '重试',
    'pk.more': '加载更多',

    /* ── 卡片 ── */
    'pk.by': '谱师',
    'pk.music': '作曲',
    'pk.illust': '曲绘',
    'pk.score': '评分',
    'pk.votes': '{n} 人评',
    'pk.noVotes': '暂无评分',
    'pk.verified': '已审核',
    'pk.stable': '稳定',
    'pk.openOnPhira': '在 Phira 打开',

    /* ── 详情抽屉 ── */
    'pk.files': '包含哪些文件',
    'pk.chartJson': '谱面本体（chart.json）',
    'pk.audio': '音频',
    'pk.illust2': '曲绘',
    'pk.preview': '预览视频',
    'pk.notHas': '这张谱面没有提供',
    'pk.saveOne': '只下载这一个文件（不打包）',
    'pk.pack': '打包下载',
    'pk.packing': '正在打包…',
    'pk.packProgress': '第 {i}/{n} 个文件…',
    'pk.packDone': '已打包：{name}',
    'pk.packPartial': '打包好了，但有 {n} 个文件没取到',
    'pk.packFailed': '{name} 失败：{err}',
    'pk.packAllFailed': '所有文件都没取到，没法打包',
    'pk.saveOk': '开始下载',
    'pk.tagline': '简介',

    /* ── 页脚说明 ── */
    'pk.noteTitle': '关于这些包',
    'pk.note1':
      '包的<b>字节</b>在你自己浏览器里生成 —— 我们只传了字符串。' +
      '所以无论包多大，都不占我们的服务器带宽。',
    'pk.note2':
      '包名带<b>日期</b>（如 chart-2026-10-18.pez），' +
      '这样同一个谱面不同时期打的包不会互相覆盖。',
    'pk.note3':
      'chart.json 是<b>原样</b>打进去的，没有重新序列化 —— ' +
      '重新 JSON.stringify 会丢字段顺序和数字精度，Phira 读出来行为可能变。',
    'pk.note4':
      '谱面、曲绘、音乐的<b>著作权属于各自的作者</b>。' +
      '这里只是帮你省去逐个下载的麻烦，请自行在合理范围内使用。',
  },

  en: {
    'pk.title': 'Chart Packs',
    'pk.sub':
      'Bundle any chart with its illustration and audio as a <b>.pez</b> pack. ' +
      'Every file is fetched by your browser straight from Phira’s servers — ' +
      '<b>never proxied through ours</b>.',

    'pk.search': 'Search title, charter, composer, tags…',
    'pk.searchHint': 'Player nicknames work too — they usually live in the description or tags',
    'pk.level': 'Difficulty',
    'pk.allLevels': 'All difficulties',
    'pk.sort': 'Sort',
    'pk.sortDefault': 'Default',
    'pk.sortRating': 'Top rated',
    'pk.sortNewest': 'Newest',
    'pk.sortLevel': 'Highest level',
    'pk.resultCount': '{n} charts',
    'pk.noResult': 'No matching charts',
    'pk.noResultHint': 'Try different keywords, or clear the difficulty filter.',
    'pk.loading': 'Loading charts…',
    'pk.loadFail': 'Could not load charts',
    'pk.loadFailHint': 'This is Phira’s public API and may be temporarily unavailable. Try again later.',
    'pk.retry': 'Retry',
    'pk.more': 'Load more',

    'pk.by': 'Charter',
    'pk.music': 'Composer',
    'pk.illust': 'Illustrator',
    'pk.score': 'Rating',
    'pk.votes': '{n} ratings',
    'pk.noVotes': 'Not rated yet',
    'pk.verified': 'Reviewed',
    'pk.stable': 'Stable',
    'pk.openOnPhira': 'Open on Phira',

    'pk.files': 'Files included',
    'pk.chartJson': 'Chart (chart.json)',
    'pk.audio': 'Audio',
    'pk.illust2': 'Illustration',
    'pk.preview': 'Preview video',
    'pk.notHas': 'not provided for this chart',
    'pk.saveOne': 'Download just this file (no pack)',
    'pk.pack': 'Build pack',
    'pk.packing': 'Building…',
    'pk.packProgress': 'File {i} of {n}…',
    'pk.packDone': 'Packed: {name}',
    'pk.packPartial': 'Packed, but {n} file(s) failed',
    'pk.packFailed': '{name} failed: {err}',
    'pk.packAllFailed': 'Nothing could be fetched — no pack to build',
    'pk.saveOk': 'Download started',
    'pk.tagline': 'Description',

    'pk.noteTitle': 'About these packs',
    'pk.note1':
      'The pack bytes are generated in <b>your browser</b> — we only pass strings. ' +
      'So however large the pack is, it costs our servers nothing.',
    'pk.note2':
      'Pack names carry a <b>date</b> (e.g. chart-2026-10-18.pez) so packs built at ' +
      'different times never overwrite each other.',
    'pk.note3':
      'chart.json is embedded <b>byte-for-byte</b>, never re-serialized — ' +
      're-running JSON.stringify loses field order and numeric precision, ' +
      'which can change how Phira reads it.',
    'pk.note4':
      'Charts, illustrations and audio <b>belong to their respective authors</b>. ' +
      'This page only saves you from downloading them one by one; ' +
      'please use them within fair bounds.',
  },
};