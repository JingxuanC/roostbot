// Roost 网页端 —— 第一版 UI 切片。零依赖、零构建：浏览器按 ES module 直接执行。
//
// 设计来源（唯一事实源）：
//   docs/design/ui.md          §3.1 配对、§3.2 房间、§3.10 Bot 发来的消息、§6 设计系统
//   docs/design/messaging.md   §14 / §14.1 私聊默认折叠
//   docs/design/bot-identity.md §3 程序化图标
//   docs/design/events.md      §3 事件信封、§5 chat.message 载荷
//   docs/design/auth.md        §3 配对流程、§7 token 不进 Web 存储
//
// 状态说明：本文件里只有「配对」会发网络请求。房间、消息、审批全部是固定样例，
// 发送消息只追加本地气泡，不发请求（见 README「哪些是真的、哪些是假的」）。
// token 只在内存变量里（sessionToken），不写 localStorage / sessionStorage，刷新即丢。

// ---------------------------------------------------------------------------
// 一、程序化图标：packages/identity/src/glyph.ts 的等价重写
// ---------------------------------------------------------------------------
// 不改算法，只改运行环境：fnv1a → 6 族 × 8 调色板 × 4 旋转 × 4 装饰点。
// 同一个 bot id 永远得到同一个图标；改名不改形象（bot-identity.md §13.2）。
// 与 .ts 的一致性靠 apps/web 之外的对照检查保证（见 README）；这里不 import ts。

const GLYPH_FAMILIES = ['egg', 'feather', 'wing', 'eye', 'nest', 'beak']
const PALETTES = [
  { name: 'amber', dark: '#D8AB52', light: '#B8862F' },
  { name: 'teal', dark: '#5FB3B3', light: '#2E7D7D' },
  { name: 'blue', dark: '#7AA2E0', light: '#3A5EA8' },
  { name: 'violet', dark: '#A78BDB', light: '#6C4FB0' },
  { name: 'rose', dark: '#D98CA0', light: '#A8556A' },
  { name: 'moss', dark: '#8FBF7A', light: '#4F7A3F' },
  { name: 'clay', dark: '#D09A78', light: '#9A6446' },
  { name: 'slate', dark: '#9AA6B8', light: '#5A6678' },
]
const ROTATIONS = [0, 90, 180, 270]
const DOT_COUNTS = [0, 1, 2, 3]

/** fnv1a：小而稳，不依赖平台随机数。 */
function hashId(id) {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function specFor(id) {
  const hash = hashId(id)
  return {
    family: GLYPH_FAMILIES[hash % 6],
    palette: PALETTES[Math.floor(hash / 6) % 8],
    rotate: ROTATIONS[Math.floor(hash / 48) % 4],
    dots: DOT_COUNTS[Math.floor(hash / 192) % 4],
    seed: hash,
  }
}

/** 各族的几何：都画在 96×96 画布里，描线 5，中心附近。 */
function familyPath(family) {
  switch (family) {
    case 'egg':
      return 'M48 20 C62 20 72 34 72 50 C72 66 61 76 48 76 C35 76 24 66 24 50 C24 34 34 20 48 20 Z'
    case 'feather':
      return 'M30 72 C34 46 46 28 68 22 C66 44 54 62 30 72 Z M38 62 L60 30'
    case 'wing':
      return 'M22 58 C36 40 52 30 74 26 C70 46 56 62 34 70 Z'
    case 'eye':
      return 'M22 48 C34 34 62 34 74 48 C62 62 34 62 22 48 Z'
    case 'nest':
      return 'M24 56 C34 68 62 68 72 56 M28 62 C38 72 58 72 68 62 M34 44 C40 38 56 38 62 44'
    case 'beak':
      return 'M28 40 C44 32 64 34 74 44 C64 52 46 58 32 54 Z'
    default:
      return ''
  }
}

function dotsMarks(count, color) {
  const spots = [
    [70, 26],
    [26, 70],
    [72, 70],
  ]
  return spots
    .slice(0, count)
    .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${color}"/>`)
    .join('')
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 产出可直接内联的 SVG。
 * @param {string} id Bot 的稳定 id（不是名字——改名不改形象）
 * @param {{theme?: 'dark'|'light', size?: number, label?: string}} [options]
 *   不给 label 时输出装饰性图标（名字就在旁边，别让读屏念两遍）。
 */
function glyphSvg(id, options = {}) {
  const theme = options.theme || 'dark'
  const size = options.size || 24
  const label = options.label || ''
  const spec = specFor(id)
  const ink = theme === 'dark' ? spec.palette.dark : spec.palette.light
  const base = theme === 'dark' ? '#141619' : '#FFFFFF'
  const line = theme === 'dark' ? '#2A2E35' : '#E6E3DC'
  const a11y = label
    ? ` role="img" aria-label="${escapeAttr(label)}"`
    : ' role="presentation" aria-hidden="true"'
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96"${a11y}>`,
    `<rect width="96" height="96" rx="24" fill="${base}" stroke="${line}" stroke-width="1.5"/>`,
    `<g transform="rotate(${spec.rotate} 48 48)" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">`,
    `<path d="${familyPath(spec.family)}"/>`,
    '</g>',
    dotsMarks(spec.dots, ink),
    '</svg>',
  ].join('')
}

// ---------------------------------------------------------------------------
// 二、固定样例
// ---------------------------------------------------------------------------

/** 四个 Bot。id 是稳定的；名字只是显示名（bot-identity.md §2）。 */
const BOTS = {
  chief: { id: 'chief', name: 'Chief', role: '协调' },
  'data-officer': { id: 'data-officer', name: '数据官', role: '数据' },
  selector: { id: 'selector', name: '选股师', role: '选股' },
  'risk-officer': { id: 'risk-officer', name: '风控官', role: '风控' },
}

/** 消息里标签行动词的来源：packages/messaging/src/provenance.ts 的 VERBS。 */
const PEER_VERBS = {
  message: '发来消息',
  reply: '回复',
  delegate: '委派工作',
  consult: '提问',
  proactive: '主动',
}

/** 折叠时标签行摘要的截断长度（provenance.ts 的 PEER_SUMMARY_CHARS）。 */
const PEER_SUMMARY_CHARS = 40

/**
 * 房间样例。每条消息的形状贴着 docs/design/events.md §3 的信封：
 *   domain / kind / actor / audience / payload
 * 私聊额外带 peer 字段，对应 provenance.ts 的 PeerLabel（名字、动作、完成条件）。
 */
/** 控制面地址：`?api=` 可指定；默认同源（控制面自己伺服本页）。 */
const API_BASE = (() => {
  try {
    return (new URLSearchParams(location.search).get('api') || '').trim().replace(/\/+$/, '')
  } catch {
    return ''
  }
})()

/** 调试/测试时用 ?stream=0 关掉 SSE（静态截图、受限环境）；默认开。 */
const STREAM_ENABLED = (() => {
  try {
    return new URLSearchParams(location.search).get('stream') !== '0'
  } catch {
    return true
  }
})()

const ROOM = {
  id: 'r_quant',
  name: '量化研究组',
  working: { botId: 'selector', text: '选股师 正在工作' },
  events: [
    {
      seq: 4210,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'user', id: 'you' },
      audience: 'room:r_quant',
      payload: { role: 'user', text: '盘前看一下有什么异动', framing: 'room' },
    },
    {
      seq: 4211,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'selector' },
      audience: 'room:r_quant',
      payload: { role: 'bot', text: '我先拉一遍涨跌幅和成交额异常。', framing: 'room' },
    },
    {
      seq: 4212,
      domain: 'tool',
      kind: 'tool.call',
      actor: { kind: 'bot', id: 'selector' },
      audience: 'room:r_quant',
      payload: {
        name: 'get_a_realtime',
        args: { symbol: '600519' },
        ms: 1200,
        result: '样例数据：贵州茅台 1428.00 · +1.20%',
      },
    },
    {
      seq: 4213,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'selector' },
      audience: 'member:risk-officer',
      payload: {
        role: 'bot',
        text: '盘前这 3 只看一下流动性，每只给结论与反例',
        framing: 'team-message',
      },
      peer: { from: '选股师', delivery: 'delegate', doneWhen: '每只给出结论与反例', source: 'Chief 的回合' },
    },
    {
      seq: 4214,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'data-officer' },
      audience: 'member:selector',
      payload: {
        role: 'bot',
        text: '600519 的成交额口径按 5 日均值给，先别用 TTM。',
        framing: 'team-message',
      },
      peer: { from: '数据官', delivery: 'message' },
    },
    {
      seq: 4215,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'risk-officer' },
      audience: 'room:r_quant',
      payload: { role: 'bot', text: '等选股师的候选，先看数据完整性。', framing: 'room' },
    },
    {
      seq: 4216,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'risk-officer' },
      audience: 'room:r_quant',
      payload: { role: 'bot', text: '风控官 已停止（停止指令）', framing: 'notice' },
      peer: { from: '风控官', delivery: 'notice' },
    },
    {
      seq: 4217,
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'selector' },
      audience: 'room:r_quant',
      payload: { role: 'bot', text: '结论：3 只异动，2 只流动性不足。', framing: 'room' },
    },
  ],
  needs: [
    {
      id: 'ap_1',
      kind: 'approval',
      botId: 'selector',
      title: '请求发送邮件',
      impact: '会向外部地址发出邮件，发出后无法撤回。',
      fields: [
        ['收件人', 'research@example.com'],
        ['主题', '今日异动摘要'],
      ],
      actions: ['拒绝', '允许这一次'],
    },
    {
      id: 'q_1',
      kind: 'question',
      botId: 'risk-officer',
      title: '在等一个回答',
      question: '口径用 TTM 还是最近一期？',
      impact: '这个选择决定回测与结论口径，选错了整条链都要重跑。',
      actions: ['TTM', '最近一期', '自己输入'],
    },
  ],
}


// ---------------------------------------------------------------------------
// Markdown（最小子集，全部用 DOM 构建，绝不 innerHTML）
// ---------------------------------------------------------------------------
// 模型回复天然带 markdown：加粗、列表、表格、代码块。渲染成纯文本会让长回答
// 变成一坨（用户实测第一眼就是这个问题）。这里只做安全子集：
// 标题/列表/表格/引用/代码块/加粗/斜体/行内代码/链接，其余按文本。

const MD_INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\((?:https?:\/\/)[^)]+\))/g

function inlineFragment(text) {
  const frag = document.createDocumentFragment()
  let last = 0
  for (const match of text.matchAll(MD_INLINE)) {
    if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('**')) {
      frag.append(el('strong', { text: token.slice(2, -2) }))
    } else if (token.startsWith('`')) {
      frag.append(el('code', { class: 'md-code', text: token.slice(1, -1) }))
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      const href = link ? link[2] : ''
      if (/^https?:\/\//.test(href)) {
        frag.append(el('a', { href, rel: 'noopener noreferrer', target: '_blank', text: link[1] }))
      } else {
        frag.append(document.createTextNode(token))
      }
    } else {
      frag.append(el('em', { text: token.slice(1, -1) }))
    }
    last = match.index + token.length
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)))
  return frag
}

function markdownFragment(text) {
  const frag = document.createDocumentFragment()
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  let i = 0
  const paragraph = (buffer) => {
    const p = el('p', { class: 'md-p' })
    buffer.forEach((line, index) => {
      if (index > 0) p.append(el('br'))
      p.append(inlineFragment(line))
    })
    frag.append(p)
  }
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const code = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i += 1 }
      i += 1
      const pre = el('pre', { class: 'md-pre' })
      pre.append(el('code', { text: code.join('\n') }))
      frag.append(pre)
      continue
    }
    if (/^\s*$/.test(line)) { i += 1; continue }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      frag.append(el(`h${heading[1].length + 2}`, { class: 'md-h' }, [inlineFragment(heading[2])]))
      i += 1
      continue
    }
    if (line.startsWith('|') && lines[i + 1] !== undefined && /^\|[\s:-]+\|/.test(lines[i + 1])) {
      const rows = []
      while (lines[i] !== undefined && lines[i].startsWith('|')) { rows.push(lines[i]); i += 1 }
      const table = el('table', { class: 'md-table' })
      rows.forEach((row, index) => {
        if (index === 1) return // 分隔行
        const cells = row.split('|').slice(1, -1).map((cell) => cell.trim())
        const tr = el('tr')
        for (const cell of cells) tr.append(index === 0 ? el('th', {}, [inlineFragment(cell)]) : el('td', {}, [inlineFragment(cell)]))
        table.append(tr)
      })
      frag.append(table)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const list = el('ul', { class: 'md-list' })
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        list.append(el('li', {}, [inlineFragment(lines[i].replace(/^\s*[-*+]\s+/, ''))]))
        i += 1
      }
      frag.append(list)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const list = el('ol', { class: 'md-list' })
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        list.append(el('li', {}, [inlineFragment(lines[i].replace(/^\s*\d+[.)]\s+/, ''))]))
        i += 1
      }
      frag.append(list)
      continue
    }
    if (line.startsWith('>')) {
      const quote = el('blockquote', { class: 'md-quote' })
      const buffer = []
      while (i < lines.length && lines[i].startsWith('>')) { buffer.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      quote.append(markdownFragment(buffer.join('\n')))
      frag.append(quote)
      continue
    }
    const buffer = [line]
    i += 1
    while (i < lines.length && lines[i] !== '' && !/^\s*(```|#{1,3}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(lines[i])) {
      buffer.push(lines[i]); i += 1
    }
    paragraph(buffer)
  }
  return frag
}

// ---------------------------------------------------------------------------
// 三、DOM 小工具
// ---------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector)

/** 建元素：props 里的 class/text 走属性语义，其余当 attribute（含 aria-*）。 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'hidden') node.hidden = Boolean(value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function svgNode(markup) {
  const template = document.createElement('template')
  template.innerHTML = markup.trim()
  return template.content.firstElementChild
}

function avatar(botId, size) {
  const wrap = el('span', { class: `avatar avatar-${size}` })
  wrap.append(svgNode(glyphSvg(botId, { size })))
  return wrap
}

// ---------------------------------------------------------------------------
// 四、渲染
// ---------------------------------------------------------------------------

function renderSidebarBots() {
  const list = $('#bot-list')
  list.replaceChildren()
  for (const bot of Object.values(BOTS)) {
    const row = el('li', { class: 'bot-row' })
    row.append(avatar(bot.id, 24))
    row.append(el('span', { class: 'bot-name', text: bot.name }))
    row.append(el('span', { class: 'bot-role', text: bot.role }))
    if (bot.id === ROOM.working.botId) {
      row.append(el('span', { class: 'dot', 'aria-hidden': 'true' }))
      row.append(el('span', { class: 'sr-only', text: '正在工作' }))
    }
    list.append(row)
  }
}

/** 用户气泡：主色、右对齐，绝不和 Bot 消息混淆（messaging.md §14）。 */
function renderUserMessage(text) {
  const row = el('div', { class: 'msg msg-user' })
  row.append(el('span', { class: 'sr-only', text: '你：' }))
  const bubble = el('div', { class: 'bubble bubble-user' })
  bubble.append(markdownFragment(text))
  row.append(bubble)
  return row
}

/** 房间里的 Bot 消息：中性底，气泡上方「头像 名字 · 角色」，没有标签行。 */
function renderRoomMessage(event) {
  const bot = BOTS[event.actor.id]
  const article = el('article', { class: 'msg msg-bot' })
  const head = el('header', { class: 'msg-head' })
  head.append(avatar(event.actor.id, 24))
  head.append(el('span', { class: 'msg-name', text: bot.name }))
  head.append(el('span', { class: 'msg-role', text: bot.role }))
  article.append(head)
  const bubble = el('div', { class: 'bubble bubble-bot' })
  bubble.append(markdownFragment(event.payload.text))
  article.append(bubble)
  return article
}

/**
 * 折叠开关要不要折叠这一条：等价于 provenance.ts 的 collapsedByDefault()。
 * 房间与通知不折叠；其余（message/reply/delegate/consult/proactive）默认折叠。
 */
function collapsedByDefault(delivery) {
  return delivery !== 'room' && delivery !== 'notice'
}

/** Bot 私聊：默认只显示一行标签，点击就地展开（不跳转、不弹窗）。 */
function renderPeerMessage(event, delivery) {
  const bot = BOTS[event.actor.id]
  const text = event.payload.text
  const summary = text.length > PEER_SUMMARY_CHARS ? `${text.slice(0, PEER_SUMMARY_CHARS)}…` : text
  const bodyId = `peer-${event.seq}`
  const verb = PEER_VERBS[delivery] || ''

  const toggle = el('button', {
    class: 'peer-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': bodyId,
  })
  const chev = el('span', { class: 'chev', 'aria-hidden': 'true', text: '▸' })
  toggle.append(chev)
  toggle.append(avatar(event.actor.id, 16))
  toggle.append(el('span', { class: 'peer-name', text: event.peer.from || bot.name }))
  if (verb) toggle.append(el('span', { class: 'peer-verb', text: ` · ${verb}` }))
  toggle.append(el('span', { class: 'peer-summary', text: ` · ${summary}` }))
  toggle.append(el('span', { class: 'peer-count', text: `${text.length} 字` }))

  const body = el('div', { class: 'peer-body', id: bodyId, hidden: true })
  const peerText = el('div', { class: 'peer-text' })
  peerText.append(markdownFragment(text))
  body.append(peerText)
  const meta = []
  if (event.peer.source) meta.push(`来源：${event.peer.source}`)
  if (event.peer.doneWhen) meta.push(`完成条件：${event.peer.doneWhen}`)
  if (event.peer.reason) meta.push(`为什么现在说话：${event.peer.reason}`)
  if (meta.length) body.append(el('p', { class: 'peer-meta', text: meta.join(' · ') }))

  const article = el('article', { class: 'msg msg-peer' })
  article.append(toggle, body)

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(open))
    chev.textContent = open ? '▾' : '▸'
    body.hidden = !open
    article.classList.toggle('is-open', open)
  })

  return article
}

/** 通知类：居中事件行，不进正文流，也不折叠。 */
function renderNotice(event) {
  const row = el('p', { class: 'msg-event' })
  row.append(el('span', { class: 'event-dot', 'aria-hidden': 'true', text: '·' }))
  row.append(document.createTextNode(` ${event.payload.text} `))
  row.append(el('span', { class: 'event-dot', 'aria-hidden': 'true', text: '·' }))
  return row
}

/** 工具调用：默认一行（工具名 + 耗时），点击展开参数与结果。 */
function renderToolCall(event) {
  const payload = event.payload
  const bodyId = `tool-${event.seq}`
  const seconds = typeof payload.ms === 'number' ? ` · ${(payload.ms / 1000).toFixed(1)}s` : ''

  const toggle = el('button', {
    class: 'tool-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': bodyId,
  })
  const chev = el('span', { class: 'chev', 'aria-hidden': 'true', text: '▸' })
  toggle.append(chev)
  toggle.append(el('span', { class: 'tool-tree', 'aria-hidden': 'true', text: '├' }))
  toggle.append(el('span', { class: 'tool-name', text: `工具 ${payload.name}` }))
  if (seconds) toggle.append(el('span', { class: 'tool-dur', text: seconds }))

  const body = el('div', { class: 'tool-body', id: bodyId, hidden: true })
  const argsLine = el('p', { class: 'tool-line' })
  argsLine.append(el('span', { class: 'tool-key', text: '参数' }))
  argsLine.append(el('code', { text: JSON.stringify(payload.args) }))
  body.append(argsLine)
  if (payload.result) {
    const resultLine = el('p', { class: 'tool-line' })
    resultLine.append(el('span', { class: 'tool-key', text: '结果' }))
    resultLine.append(el('span', { text: payload.result }))
    body.append(resultLine)
  }

  const article = el('article', { class: 'msg-tool' })
  article.append(toggle, body)
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(open))
    chev.textContent = open ? '▾' : '▸'
    body.hidden = !open
  })
  return article
}

/** 一条事件按来源分类，选渲染方式（对应 events.md 的 domain / kind）。 */
function renderEvent(event) {
  if (event.domain === 'tool') return renderToolCall(event)
  if (event.payload.role === 'user') return renderUserMessage(event.payload.text)

  const delivery =
    event.peer && event.peer.delivery
      ? event.peer.delivery
      : event.payload.framing === 'room'
        ? 'room'
        : 'message'

  if (delivery === 'notice') return renderNotice(event)
  return collapsedByDefault(delivery)
    ? renderPeerMessage(event, delivery)
    : renderRoomMessage(event)
}

function renderMessages() {
  const list = $('#messages')
  list.replaceChildren()
  for (const event of ROOM.events) list.append(renderEvent(event))
  // 初始渲染完再开 live region，避免读屏一次念完整个房间。
  list.setAttribute('aria-live', 'polite')
}

function renderNeeds() {
  const body = $('#needs-body')
  body.replaceChildren()
  for (const item of ROOM.needs) {
    const card = el('article', { class: 'need-card' })
    const head = el('p', { class: 'need-head' })
    head.append(
      el('span', {
        class: `need-icon ${item.kind === 'approval' ? 'is-warn' : 'is-question'}`,
        'aria-hidden': 'true',
        text: item.kind === 'approval' ? '⚠' : '?',
      }),
      avatar(item.botId, 20),
      el('span', { class: 'need-who', text: BOTS[item.botId].name }),
    )
    card.append(head)
    card.append(el('h3', { class: 'need-title', text: item.title }))

    if (item.question) card.append(el('p', { class: 'need-question', text: item.question }))

    if (item.fields) {
      const dl = el('dl', { class: 'need-meta' })
      for (const [key, value] of item.fields) {
        const row = el('div')
        row.append(el('dt', { text: key }), el('dd', { text: value }))
        dl.append(row)
      }
      card.append(dl)
    }

    card.append(el('p', { class: 'need-impact', text: `影响：${item.impact}` }))

    const note = el('p', { class: 'need-note', role: 'status', hidden: true })
    note.textContent = '审批接口尚未实现（v1）；这里不会发出任何请求。'

    const actions = el('div', { class: 'need-actions' })
    for (const [index, label] of item.actions.entries()) {
      const button = el('button', {
        class: `btn btn-sm ${index === item.actions.length - 1 ? 'btn-outline' : 'btn-ghost'}`,
        type: 'button',
        text: label,
      })
      button.addEventListener('click', () => {
        // 诚实：审批接口还没有，点了就说明没有发出任何请求。
        note.hidden = false
      })
      actions.append(button)
    }
    card.append(actions, note)

    body.append(card)
  }

  const count = ROOM.needs.length
  $('#needs-count').textContent = `(${count})`
  $('#needs-btn-sm').textContent = `需要你 (${count})`
  $('#needs-title').textContent = `需要你 · ${count}`
}

// ---------------------------------------------------------------------------
// 五、配对（唯一会发请求的地方）
// ---------------------------------------------------------------------------

let sessionToken = null // 只在内存：不写 localStorage、不写 URL、不渲染（auth.md §7）

async function serverMessage(response) {
  const type = response.headers.get('content-type') || ''
  try {
    if (type.includes('application/json')) {
      const body = await response.json()
      const message =
        body && (body.message || body.error_description || body.detail || body.error?.message || body.error)
      if (typeof message === 'string' && message.trim()) return message.trim()
    } else {
      const text = (await response.text()).trim()
      if (text) return text.slice(0, 200)
    }
  } catch {
    // 落到状态码兜底
  }
  return `配对失败（HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}）`
}

function setupPairing() {
  const form = $('#pair-form')
  const boxes = Array.from(document.querySelectorAll('.code-digit'))
  const error = $('#pair-error')
  const submit = $('#pair-submit')
  const note = $('#api-note')

  note.textContent = API_BASE ? `API：${API_BASE}` : 'API：同源（?api=http://127.0.0.1:8787 可指定）'

  const code = () => boxes.map((box) => box.value).join('')
  const focusBox = (index) => {
    const target = boxes[Math.max(0, Math.min(boxes.length - 1, index))]
    if (target) target.focus()
  }
  const clearError = () => {
    error.hidden = true
    error.textContent = ''
  }
  const showError = (message) => {
    error.textContent = message
    error.hidden = false
  }
  const setBusy = (busy) => {
    submit.disabled = busy
    submit.textContent = busy ? '配对中…' : '配对'
    form.setAttribute('aria-busy', String(busy))
  }

  boxes.forEach((box, index) => {
    box.addEventListener('focus', () => box.select())
    box.addEventListener('input', () => {
      clearError()
      const digits = box.value.replace(/\D/g, '')
      box.value = ''
      if (!digits) return
      let cursor = index
      for (const digit of digits) {
        if (cursor >= boxes.length) break
        boxes[cursor].value = digit
        cursor += 1
      }
      focusBox(cursor)
    })
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace') {
        event.preventDefault()
        clearError()
        if (box.value) {
          box.value = ''
        } else if (index > 0) {
          boxes[index - 1].value = ''
          focusBox(index - 1)
        }
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        focusBox(index - 1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        focusBox(index + 1)
      }
    })
    box.addEventListener('paste', (event) => {
      const pasted = (event.clipboardData && event.clipboardData.getData('text')) || ''
      const digits = pasted.replace(/\D/g, '').slice(0, boxes.length)
      if (!digits) return
      event.preventDefault()
      clearError()
      for (const target of boxes) target.value = ''
      digits.split('').forEach((digit, offset) => {
        boxes[offset].value = digit
      })
      focusBox(digits.length)
    })
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const value = code()
    if (value.length !== boxes.length) {
      showError(`请输入 ${boxes.length} 位数字`)
      focusBox(boxes.findIndex((box) => !box.value))
      return
    }

    clearError()
    setBusy(true)
    try {
      const response = await fetch(API_BASE ? `${API_BASE}/api/pairing/claim` : '/api/pairing/claim', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value }),
      })

      if (!response.ok) {
        // 服务端的 message 原样显示（auth.md §8 的失败话术由服务端给）。
        showError(await serverMessage(response))
        return
      }

      let body = null
      try {
        body = await response.json()
      } catch {
        // 204 或空 body 也算成功
      }
      // 会话正常情况下在 HttpOnly cookie 里，前端看不到；真返回了 token 也只在内存。
      const token = body && (body.token || body.sessionToken || (body.session && body.session.token))
      if (typeof token === 'string' && token) sessionToken = token

      try {
        await enterLiveRoom(token)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        enterRoom('paired')
        showError(`配对成功，但房间没载入（${reason}）。可以稍后刷新重试。`)
      }
    } catch (cause) {
      // fetch 本身失败（没服务、file://、CORS）——把原因摊开说，不假装成功。
      const reason = cause instanceof Error ? cause.message : String(cause)
      showError(`连不上 API（${reason}）。检查控制面是否在跑，或用 ?api= 指定地址；也可以先「预览房间」。`)
    } finally {
      setBusy(false)
    }
  })

  const preview = $('#preview-btn')
  preview.addEventListener('click', () => enterRoom('preview'))
}


// ---------------------------------------------------------------------------
// 六之二、真实房间（控制面 API + SSE）
// ---------------------------------------------------------------------------
// 配对成功后才走这里：房间、消息都来自控制面；预览模式仍然用固定样例。
// 消息形状保持与 events.md 一致（chat.message 事件），只是由服务端消息投影出来。

const LIVE = {
  active: false,
  token: '',
  roomId: '',
  rooms: [],
  lastSeq: 0,
  seen: new Set(),
  stream: null,
}

function toEvent(message, roomId) {
  const isUser = message.actor && message.actor.kind === 'user'
  return {
    seq: message.seq,
    domain: 'chat',
    kind: 'chat.message',
    actor: message.actor,
    audience: `room:${roomId}`,
    payload: {
      role: isUser ? 'user' : 'bot',
      text: message.text,
      framing: isUser ? 'user' : 'room',
    },
  }
}

async function apiFetch(path, options = {}, token = LIVE.token) {
  const base = API_BASE ? `${API_BASE}${path}` : path
  const response = await fetch(base, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  return response
}

async function ensureRoom() {
  let rooms = []
  const roomsRes = await apiFetch('/api/rooms')
  if (roomsRes.ok) rooms = (await roomsRes.json()).rooms || []

  if (rooms.length === 0) {
    // 新账号还没有 workspace：先建一个，再建房间（失败就把原因说出来）。
    let wsRes = await apiFetch('/api/workspaces')
    let workspaces = wsRes.ok ? (await wsRes.json()).workspaces || [] : []
    if (workspaces.length === 0) {
      const created = await apiFetch('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: '我的工作区' }),
      })
      if (!created.ok) throw new Error(await serverMessage(created))
      workspaces = [(await created.json()).workspace]
    }
    const roomRes = await apiFetch('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaces[0].id, name: '量化研究组' }),
    })
    if (!roomRes.ok) throw new Error(await serverMessage(roomRes))
    rooms = [(await roomRes.json()).room]
  }
  return rooms
}

function appendLiveEvent(message) {
  if (LIVE.seen.has(message.seq)) return
  LIVE.seen.add(message.seq)
  LIVE.lastSeq = Math.max(LIVE.lastSeq, message.seq)
  const list = $('#messages')
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  list.append(renderEvent(toEvent(message, LIVE.roomId)))
  if (nearBottom) list.scrollTop = list.scrollHeight
}

function openStream() {
  if (!STREAM_ENABLED) return
  if (LIVE.stream !== null) LIVE.stream.close()
  const url = `/api/rooms/${encodeURIComponent(LIVE.roomId)}/stream?access_token=${encodeURIComponent(LIVE.token)}&after=${LIVE.lastSeq}`
  const stream = new EventSource(API_BASE ? `${API_BASE}${url}` : url)
  stream.addEventListener('message', (event) => {
    try {
      appendLiveEvent(JSON.parse(event.data))
    } catch {
      // 坏帧不该打断整条流；服务端会重连补拉。
    }
  })
  stream.addEventListener('error', () => {
    // EventSource 自己会重连；这里只把状态说出来。
    $('#working-text').textContent = '连接断开，正在重连…'
  })
  LIVE.stream = stream
}

/** 配对成功后进入真实房间；失败就退回样例并说明原因。 */
async function enterLiveRoom(token) {
  LIVE.token = token
  const rooms = await ensureRoom()
  const room = rooms[0]
  LIVE.rooms = rooms
  LIVE.roomId = room.id
  ROOM.name = room.name
  ROOM.events = []

  const messagesRes = await apiFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`)
  if (!messagesRes.ok) throw new Error(await serverMessage(messagesRes))
  const { messages } = await messagesRes.json()
  ROOM.events = messages.map((message) => toEvent(message, room.id))
  for (const message of messages) {
    LIVE.seen.add(message.seq)
    LIVE.lastSeq = Math.max(LIVE.lastSeq, message.seq)
  }

  LIVE.active = true
  renderMessages()
  $('#room-name').textContent = ROOM.name
  document.title = `${ROOM.name} · Roost`
  openStream()

  enterRoom('live')
}

// ---------------------------------------------------------------------------
// 六、房间交互
// ---------------------------------------------------------------------------

function enterRoom(mode) {
  $('#pair-view').hidden = true
  const room = $('#room-view')
  room.hidden = false
  $('#room-name').textContent = ROOM.name
  $('#working-text').textContent = ROOM.working.text
  const stripText = $('#demo-strip-text')
  if (mode === 'live') {
    if (stripText) stripText.hidden = true
    const foot = document.querySelector('.side-foot')
    if (foot) foot.textContent = '已连接控制面 · 实时'
  } else if (stripText) {
    stripText.hidden = false
    stripText.textContent =
      mode === 'paired'
        ? '已配对，但房间仍是固定样例（房间接口未接上）；发送不会请求服务端。'
        : '假数据预览：未配对，房间内容为固定样例；发送不会请求服务端。'
  }
  document.title = `${ROOM.name} · Roost`
  $('#composer').focus()
}

function setupNeedsPanel() {
  const panel = $('#needs')
  const buttons = [$('#needs-btn'), $('#needs-btn-sm')]
  let lastFocus = null

  const setOpen = (open, opener) => {
    if (open) {
      lastFocus = opener || document.activeElement
      panel.hidden = false
      for (const button of buttons) button.setAttribute('aria-expanded', 'true')
      panel.focus()
      return
    }
    // 先把焦点交回去再隐藏：面板里还有焦点时隐藏它，浏览器会把焦点甩到 body。
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
    panel.hidden = true
    for (const button of buttons) button.setAttribute('aria-expanded', 'false')
  }

  for (const button of buttons) {
    // 记住是哪个入口打开的，关闭时焦点回到它（Esc 也一样）。
    button.addEventListener('click', () => setOpen(panel.hidden, button))
  }
  $('#needs-close').addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault()
      setOpen(false)
    }
  })
}

function setupComposer() {
  const form = $('#composer-form')
  const input = $('#composer')
  const send = $('#send')

  const sync = () => {
    send.disabled = input.value.trim().length === 0
  }
  const grow = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }

  input.addEventListener('input', () => {
    sync()
    grow()
  })
  input.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    sync()
    grow()
    input.focus()

    if (LIVE.active) {
      // 真实房间：写服务端，消息由 SSE 推回来（自己先不画，避免重复）。
      apiFetch(`/api/rooms/${encodeURIComponent(LIVE.roomId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, idem: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
      })
        .then(async (response) => {
          if (response.ok) return
          const reason = await serverMessage(response)
          showError(`发送失败：${reason}`)
        })
        .catch((cause) => showError(`发送失败：${cause instanceof Error ? cause.message : String(cause)}`))
      return
    }

    appendUserMessage(text)
  })

  sync()
}

function appendUserMessage(text) {
  const list = $('#messages')
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  list.append(renderUserMessage(text))
  if (nearBottom) list.scrollTop = list.scrollHeight
}

// ---------------------------------------------------------------------------
// 七、启动
// ---------------------------------------------------------------------------

function boot() {
  if (window.__roostBooted) return
  window.__roostBooted = true
  const warning = $('#boot-warning')
  if (warning) warning.hidden = true

  renderSidebarBots()
  renderMessages()
  renderNeeds()
  setupPairing()
  setupNeedsPanel()
  setupComposer()

  if (location.hash === '#room') {
    enterRoom('preview')
  } else {
    const first = $('.code-digit')
    if (first) first.focus()
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
}

// 供离线自检用（浏览器里不会被调用；不 import 任何 .ts）。
export { hashId, specFor, glyphSvg, GLYPH_FAMILIES, PALETTES }
