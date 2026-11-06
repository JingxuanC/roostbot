// Roost 网页端（M4）。零依赖、零构建：浏览器按 ES module 直接执行。
//
// 设计来源（唯一事实源）：
//   docs/build/m4-contract.md  §2 API、§5 前端范围
//   docs/design/ui.md          §3.1 配对、§3.2 房间、§3.7 Bot 设置、§3.11 群设置、
//                              §3.12 谁会回答 + @ 菜单、§3.10 Bot 发来的消息、§6 设计系统
//   docs/design/bots.md        创建轻、设置重；暂停/删除语义
//   docs/design/rooms.md       建群、members、responder、轮次与 slot 状态
//   docs/design/messaging.md   §14 / §14.1 私聊默认折叠
//   docs/design/events.md      §3 事件信封、§5 chat.message 载荷
//   docs/design/auth.md        §3 配对流程、§7 token 不进 Web 存储
//
// 状态说明：配对、Bot、建群、房间消息都走控制面 REST；预览（#room）与「需要你」仍是固定样例。
// 设备会话 token 存在 localStorage（见 lib/session-store.js），刷新/重开手机网页仍回到房间；
// 受保护页面遇到 401 会清 token 并回登录页，用 pendingRoute 记住原地址。

import { $, avatar, botAvatar, el } from './lib/dom.js'
import { renderAttachmentList, resetAttachmentUrls } from './lib/attachments.js'
import { GLYPH_FAMILIES, PALETTES, glyphSvg, hashId, specFor } from './lib/glyph.js'
import { createApiClient, isAuthError } from './lib/api-client.js'
import { isAuthRouteName, pendingRouteAfter } from './lib/auth-flow.js'
import {
  clearSessionToken,
  readLastRoom,
  readSessionToken,
  writeLastRoom,
  writeSessionToken
} from './lib/session-store.js'
import { canonicalWorkspaceRoute, routeMatch } from './lib/routing.js'
import {
  NOTIFICATION_TITLE,
  notificationPermission,
  planApprovalNotification,
  readNotificationPref,
  supportsNotifications,
} from './lib/notifications.js'
import { insertMention, parseMentionQuery } from './lib/mentions.js'
import {
  roomMembers,
  roomOriginLabel,
  roomOriginTitle,
  roundStateLabel,
  roundStatusItems,
  speakingSlot,
  whoAnswersLabel,
} from './lib/rooms.js'
import * as ui from './lib/ui.js'
import { mountApprovalsPage } from './views/approvals.js'
import { mountBotSettingsPage, mountBotsPage } from './views/bots.js'
import { mountNewRoomPage, mountRoomSettingsPage } from './views/rooms.js'
import { mountPanelsPage } from './views/panels.js'
import { mountMarketplacePage } from './views/marketplace.js'
import { mountConnectorsPage } from './views/connectors.js'
import { mountPluginsPage } from './views/plugins.js'
import { mountSchedulesPage } from './views/schedules.js'
import { mountRoutinesPage } from './views/routines.js'
import { mountSettingsPage } from './views/settings.js'
import { mountUsagePage } from './views/usage.js'
import { mountInstallsPage } from './views/installs.js'
import {
  mountLoginPage,
  mountRegisterPage,
  mountResetConfirmPage,
  mountResetPage,
  mountVerifyEmailPage,
} from './views/auth.js'

// ---------------------------------------------------------------------------
// 一、固定样例
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
      table.append(el('caption', { class: 'sr-only', text: '消息中的表格' }))
      rows.forEach((row, index) => {
        if (index === 1) return // 分隔行
        const cells = row.split('|').slice(1, -1).map((cell) => cell.trim())
        const tr = el('tr')
        for (const cell of cells) {
          tr.append(index === 0 ? el('th', { scope: 'col' }, [inlineFragment(cell)]) : el('td', {}, [inlineFragment(cell)]))
        }
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
// 二、渲染
// ---------------------------------------------------------------------------

/** 侧栏 Bot：预览用样例，连上控制面后用真实列表；点开是设置页（不是聊天）。 */
function renderSidebarBots() {
  const list = $('#bot-list')
  if (!list) return
  list.replaceChildren()
  // 未进入实时 workspace 时不展示样例 Bot；生产界面不再用假数据充数。
  const bots = LIVE.active ? STORE.bots : []
  if (bots.length === 0) {
    const row = el('li', { class: 'bot-row bot-row-empty' })
    row.append(el('span', { class: 'muted', text: LIVE.active ? '还没有 Bot' : '登录后显示 Bot' }))
    if (LIVE.active) row.append(el('a', { class: 'nav-add-link', href: '#/bots/new', text: '新建' }))
    list.append(row)
    return
  }
  for (const bot of bots) {
    const row = el('li', { class: 'bot-row' })
    const link = el('a', { class: 'bot-link', href: `#/bots/${encodeURIComponent(bot.id)}` })
    link.append(botAvatar(bot, 24))
    link.append(el('span', { class: 'bot-name', text: bot.name }))
    if (bot.role) link.append(el('span', { class: 'bot-role', text: bot.role }))
    if (bot.status === 'paused') link.append(el('span', { class: 'bot-paused', text: '暂停' }))
    if (!LIVE.active && bot.id === ROOM.working.botId) {
      link.append(el('span', { class: 'dot', 'aria-hidden': 'true' }))
      link.append(el('span', { class: 'sr-only', text: '正在工作' }))
    }
    row.append(link)
    list.append(row)
  }
}

/**
 * 房间图标（bot-identity §8）：≤4 个成员鸟头拼合，2×2 + 超出计数；
 * 拿不到成员时返回 null，由调用方决定退化显示。
 */
function roomFlock(room, size = 24) {
  const members = roomMembers(room)
  if (members.length === 0) return null
  const wrap = el('span', { class: 'room-flock', style: `--flock-size:${size}px` })
  for (const member of members.slice(0, 4)) {
    const bot = STORE.bots.find((item) => item.id === member.botId)
    const label = member.name || (bot && bot.name) || 'Bot'
    wrap.append(
      botAvatar(
        bot ?? { id: member.botId, name: label },
        Math.max(10, Math.round(size / 2)),
        member.role === 'host' ? { accessory: 'crown' } : {}
      )
    )
  }
  if (members.length > 4) wrap.append(el('span', { class: 'room-flock-more', text: `+${members.length - 4}` }))
  return wrap
}

/** 侧栏房间：预览用样例，连上控制面后用真实列表；当前房间 aria-current。 */
function renderSidebarRooms() {
  const list = $('#room-list')
  if (!list) return
  list.replaceChildren()
  if (!LIVE.active && !STORE.roomsLoaded) {
    const row = el('li', { class: 'room-row room-row-empty' })
    row.append(el('span', { class: 'muted', text: '登录后显示房间' }))
    list.append(row)
    return
  }
  if (STORE.rooms.length === 0) {
    const row = el('li', { class: 'room-row room-row-empty' })
    row.append(el('span', { class: 'muted', text: '还没有房间' }))
    list.append(row)
    return
  }
  for (const entry of conversationEntries()) {
    const current = entry.room !== null && entry.room.id === LIVE.roomId
    const row = el('li', { class: 'room-row', 'aria-current': current ? 'true' : null })
    row.append(renderChatRow(entry))
    list.append(row)
  }
}

/** Bot 名字/角色：真实列表优先，样例兜底，最后才是成员名；绝不显示内部 id。 */
function botIdentity(id) {
  const stored = STORE.bots.find((bot) => bot.id === id)
  if (stored) return { name: stored.name || 'Bot', role: stored.role || '' }
  const sample = BOTS[id]
  if (sample) return { name: sample.name, role: sample.role }
  const member = LIVE.room ? roomMembers(LIVE.room).find((item) => item.botId === id) : null
  return { name: (member && member.name) || 'Bot', role: '' }
}

function botLabel(id) {
  return botIdentity(id).name
}

/** 附件渲染上下文：只有实时房间才画附件区；预览模式没有后端。 */
function attachmentContext() {
  return { live: LIVE.active, api, requirePair }
}

/** 用户气泡：灰色胶囊，右对齐。 */
function renderUserMessage(event) {
  const payload = event.payload
  const row = el('div', { class: 'msg msg-user' })
  const body = el('div', { class: 'msg-user-body' })
  body.append(el('span', { class: 'sr-only', text: '你：' }))
  if (typeof payload.text === 'string' && payload.text.trim() !== '') {
    const bubble = el('div', { class: 'bubble bubble-user' })
    bubble.append(markdownFragment(payload.text))
    body.append(bubble)
  }
  appendRichParts(body, event, true)
  if (!hasImagePart(payload)) {
    const attachments = renderAttachmentList(payload.attachments, attachmentContext())
    if (attachments) body.append(attachments)
  }
  row.append(body)
  return row
}

/** 房间里的 Bot 消息：圆头像 + 名字，正文不套气泡。 */
function renderRoomMessage(event) {
  const bot = botIdentity(event.actor.id)
  const primary = LIVE.room && LIVE.room.hostBotId === event.actor.id
  const article = el('article', { class: primary ? 'msg msg-bot is-primary' : 'msg msg-bot' })
  const head = el('header', { class: 'msg-head' })
  head.append(botAvatar({ id: event.actor.id, name: bot.name, role: bot.role }, 28, { round: true, primary }))
  head.append(el('span', { class: 'msg-name', text: bot.name }))
  article.append(head)
  const bubble = el('div', { class: 'bubble bubble-bot' })
  const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : ''
  const parts = Array.isArray(event.payload.parts) ? event.payload.parts : []
  const titles = cardTitles(parts)
  if (text !== '' && !titles.includes(text)) bubble.append(markdownFragment(event.payload.text))
  if (bubble.childNodes.length > 0) article.append(bubble)
  appendRichParts(article, event, false)
  if (!hasImagePart(event.payload)) {
    const attachments = renderAttachmentList(event.payload.attachments, attachmentContext())
    if (attachments) article.append(attachments)
  }
  return article
}

const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/** 卡片标题已经画在卡片上。正文如果只是同一句话，就不再画一条气泡。 */
function cardTitles(parts) {
  const titles = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.title === 'string' && part.title.trim() !== '') titles.push(part.title.trim())
    if (typeof part.prompt === 'string' && part.prompt.trim() !== '') titles.push(part.prompt.trim())
  }
  return titles
}

function hasImagePart(payload) {
  return Array.isArray(payload?.parts) && payload.parts.some((part) => part && part.type === 'image')
}

function appendRichParts(parent, event, fromUser) {
  const parts = Array.isArray(event.payload.parts) ? event.payload.parts : []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'image' && !fromUser) parent.append(renderImagePart(part, event))
    if (part.type === 'image' && fromUser) parent.append(renderImagePart(part, event))
    if (part.type === 'choice' && !fromUser) parent.append(renderChoicePart(part))
    if (part.type === 'approval' && !fromUser) parent.append(renderApprovalPart(part))
    if (part.type === 'tool') {
      parent.append(el('p', { class: 'muted', text: `工具 ${part.name || ''}${part.summary ? ' · ' + part.summary : ''}` }))
    }
  }
  if (fromUser) {
    const shown = new Set(parts.filter((part) => part && part.type === 'image').map((part) => part.artifactId))
    const images = (event.payload.attachments || []).filter((item) => item && (String(item.mime || item.kind || '').includes('image') || item.kind === 'image'))
    for (const item of images) {
      if (shown.has(item.artifactId)) continue
      parent.append(renderImagePart({ artifactId: item.artifactId, name: item.name, url: item.url }, event))
    }
  }
}

function attachmentUrl(event, artifactId, part) {
  if (part && typeof part.url === 'string' && part.url !== '') return part.url
  const list = Array.isArray(event.payload.attachments) ? event.payload.attachments : []
  const found = list.find((item) => item && item.artifactId === artifactId)
  if (found && typeof found.url === 'string' && found.url !== '') return found.url
  if (event.seq) return `/api/messages/${encodeURIComponent(String(event.seq))}/files/${encodeURIComponent(artifactId)}`
  return ''
}

function renderImagePart(part, event) {
  const src = attachmentUrl(event, part.artifactId, part)
  const card = el('button', { class: 'img-card', type: 'button' })
  const img = el('img', { alt: part.name || '图片' })
  card.append(img)
  const caption = typeof part.caption === 'string' ? part.caption.trim() : ''
  if (caption !== '') card.append(el('span', { class: 'cap', text: caption }))
  const title = part.name || '图片'
  const open = () => openImageViewer({ src: img.src || src, title, detail: part.artifactId || '' })
  card.addEventListener('click', open)
  const signed = typeof src === 'string' && src.includes('token=')
  if (src && LIVE.token && src.startsWith('/api/') && !signed) {
    fetch(src, { headers: { authorization: `Bearer ${LIVE.token}` } })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('image'))))
      .then((blob) => {
        img.src = URL.createObjectURL(blob)
      })
      .catch(() => {
        img.alt = '图片加载失败'
      })
  } else if (src) {
    img.src = src
  }
  return card
}

function renderChoicePart(part) {
  const card = el('div', { class: 'card choice-card' })
  const head = el('div', { class: 'card-head' })
  head.append(el('div', { class: 'card-title', text: part.prompt || '' }))
  const close = el('button', { type: 'button', class: 'card-x', 'aria-label': '关闭', text: '✕' })
  close.addEventListener('click', () => { card.hidden = true })
  head.append(close)
  card.append(head)
  const options = Array.isArray(part.options) ? part.options : []
  const answered = Boolean(part.selectedOptionId)
  options.forEach((option, index) => {
    const selected = answered && part.selectedOptionId === option.id
    const button = el('button', { type: 'button', class: selected ? 'opt selected' : 'opt' })
    const letter = CHOICE_LETTERS[index] || String(index + 1)
    button.append(el('span', { class: 'opt-letter', text: letter }))
    button.append(el('span', { text: option.label || option.id }))
    if (answered) button.disabled = true
    button.addEventListener('click', () => {
      void answerChoice(part.cardId, option.id, button)
    })
    card.append(button)
  })
  if (answered) {
    const index = options.findIndex((option) => option.id === part.selectedOptionId)
    const chosen = options[index]
    const letter = CHOICE_LETTERS[index] || ''
    card.append(el('p', { class: 'choice-status', text: `已选 ${letter}${chosen ? ' · ' + (chosen.label || chosen.id) : ''}` }))
  }
  return card
}

function renderApprovalPart(part) {
  const resolved = part.status === 'approved' || part.status === 'rejected'
  const card = el('div', { class: resolved ? 'card approval-card is-resolved' : 'card approval-card' })
  const head = el('div', { class: 'card-head' })
  head.append(el('div', { class: 'card-title', text: part.title || part.action || '需要你确认' }))
  const close = el('button', { type: 'button', class: 'card-x', 'aria-label': '关闭', text: '✕' })
  if (resolved) close.disabled = true
  else close.addEventListener('click', () => { card.hidden = true })
  head.append(close)
  card.append(head)
  if (part.consequence) card.append(el('p', { class: 'approval-meta', text: part.consequence }))
  if (part.target) {
    const fields = el('div', { class: 'approval-fields' })
    const row = el('div', { class: 'row' })
    row.append(el('span', { class: 'k', text: '对象' }))
    row.append(el('span', { class: 'v', text: part.target }))
    fields.append(row)
    card.append(fields)
  }
  if (resolved) {
    const line = el('p', {
      class: part.status === 'approved' ? 'resolved' : 'resolved denied',
      text: part.status === 'approved' ? '✓ 已允许' : '✕ 已拒绝',
    })
    card.append(line)
    return card
  }
  const actions = el('div', { class: 'approval-actions' })
  const deny = el('button', { type: 'button', class: 'btn-deny', text: '拒绝' })
  const allow = el('button', { type: 'button', class: 'btn-approve', text: '允许这一次' })
  deny.addEventListener('click', () => { void decideApprovalCard(part.approvalId, 'rejected') })
  allow.addEventListener('click', () => { void decideApprovalCard(part.approvalId, 'approved') })
  actions.append(deny, allow)
  card.append(actions)
  return card
}

async function answerChoice(cardId, optionId, button) {
  if (!LIVE.active || !LIVE.roomId || !cardId) return
  button.disabled = true
  try {
    await api.post(`/api/rooms/${encodeURIComponent(LIVE.roomId)}/cards/${encodeURIComponent(cardId)}/answer`, { optionId })
    await refreshMessages()
  } catch (error) {
    button.disabled = false
    showComposerError(error instanceof Error ? error.message : '没能提交选项')
  }
}

async function decideApprovalCard(approvalId, decision) {
  if (!approvalId) return
  try {
    await api.post(`/api/approvals/${encodeURIComponent(approvalId)}`, { decision })
    await refreshMessages()
  } catch (error) {
    showComposerError(error instanceof Error ? error.message : '没能提交决定')
  }
}

function openImageViewer(info) {
  const viewer = $('#image-viewer')
  const img = $('#image-viewer-img')
  const title = $('#image-viewer-title')
  const detail = $('#image-detail-text')
  if (!viewer || !img) return
  img.src = info.src
  img.alt = info.title || '图片'
  if (title) title.textContent = info.title || '图片'
  if (detail) {
    detail.hidden = true
    detail.textContent = info.detail || ''
  }
  viewer.hidden = false
  viewer.dataset.src = info.src
  viewer.dataset.title = info.title || '图片'
}

function closeImageViewer() {
  const viewer = $('#image-viewer')
  if (viewer) viewer.hidden = true
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
  const bot = botIdentity(event.actor.id)
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
  toggle.append(botAvatar({ id: event.actor.id, name: bot.name, role: bot.role }, 16))
  toggle.append(el('span', { class: 'peer-name', text: event.peer.from || bot.name }))
  if (verb) toggle.append(el('span', { class: 'peer-verb', text: ` · ${verb}` }))
  toggle.append(el('span', { class: 'peer-summary', text: ` · ${summary}` }))
  toggle.append(el('span', { class: 'peer-count', text: `${text.length} 字` }))

  const body = el('div', { class: 'peer-body', id: bodyId, hidden: true })
  const peerText = el('div', { class: 'peer-text' })
  peerText.append(markdownFragment(text))
  body.append(peerText)
  const attachments = renderAttachmentList(event.payload.attachments, attachmentContext())
  if (attachments) body.append(attachments)
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
  if (event.payload.role === 'user') return renderUserMessage(event)

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
  // 整表重建 = 旧附件节点全部丢弃：先释放它们的 blob URL，避免内存泄漏。
  resetAttachmentUrls()
  const list = $('#messages')
  list.replaceChildren()
  if (LIVE.logHasMore && LIVE.logBefore !== null) {
    list.append(renderLoadOlder())
  }
  if (ROOM.events.length === 0) {
    list.append(el('p', { class: 'messages-empty muted', text: '还没有消息。说一句，开启一轮。' }))
  } else {
    for (const event of ROOM.events) {
      const node = renderEvent(event)
      // data-seq 供乱序到达时定位插入点（appendLiveEvent → insertEvent）。
      const seq = Number(event && event.seq)
      if (Number.isFinite(seq)) node.dataset.seq = String(seq)
      list.append(node)
    }
  }
  // 初始渲染完再开 live region，避免读屏一次念完整个房间。
  list.setAttribute('aria-live', 'polite')
}

/** 日志裁剪投影的"向前翻页"入口（rooms.md §3：最多翻到最近 60 条）。 */
function renderLoadOlder() {
  const wrap = el('div', { class: 'messages-older' })
  const button = ui.button('加载更早的消息', { variant: 'ghost', size: 'sm' })
  button.addEventListener('click', () => {
    void loadOlderMessages(button)
  })
  wrap.append(button)
  return wrap
}

async function loadOlderMessages(button) {
  if (!LIVE.active || !LIVE.roomId || LIVE.logBefore === null) return
  ui.setBusy(button, true, '加载中…')
  const roomId = LIVE.roomId
  const before = LIVE.logBefore
  try {
    const data = await api.get(
      `/api/rooms/${encodeURIComponent(roomId)}/messages?before=${encodeURIComponent(String(before))}`
    )
    if (LIVE.roomId !== roomId) return
    // 统一登记进 LIVE.seen：翻页拿到的旧消息和 SSE / after 补拉走同一套去重。
    const older = (Array.isArray(data?.messages) ? data.messages : [])
      .map((message) => toEvent(message, roomId))
      .filter((event) => {
        const seq = Number(event.seq)
        if (!Number.isFinite(seq)) return true
        if (LIVE.seen.has(seq)) return false
        LIVE.seen.add(seq)
        return true
      })
      .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    LIVE.logHasMore = Boolean(data?.page?.hasMore)
    LIVE.logBefore = Number.isSafeInteger(data?.page?.before) ? data.page.before : null

    if (older.length === 0) {
      renderMessages()
      return
    }

    // 把旧消息前插，重新渲染后保持视口停在原来的消息上。
    const list = $('#messages')
    const prevHeight = list ? list.scrollHeight : 0
    const prevTop = list ? list.scrollTop : 0
    ROOM.events = [...older, ...ROOM.events]
    renderMessages()
    if (list) list.scrollTop = prevTop + (list.scrollHeight - prevHeight)
  } catch (error) {
    if (isAuthError(error)) {
      requirePair()
      return
    }
    console.error('load older messages failed', error)
    ui.setBusy(button, false)
  }
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
// 三、配对
// ---------------------------------------------------------------------------

// 配对 token 持久化到 localStorage，刷新/重开页面仍回到上次的房间；不写 URL、不渲染。
let sessionToken = readSessionToken()

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
    ui.setFieldInvalid(boxes, false, error)
  }
  const showError = (message) => {
    error.textContent = message
    error.hidden = false
    // 错误作用于整组配对码：六个输入都标红，读屏读到一致的原因。
    ui.setFieldInvalid(boxes, true, error)
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
      if (typeof token === 'string' && token) {
        sessionToken = token
        writeSessionToken(token)
      }

      try {
        await enterLiveRoom(token)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        showError(`配对成功，但房间没载入（${reason}）。可以点「预览房间」，或稍后刷新重试。`)
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
  preview.addEventListener('click', () => {
    if (location.hash === '#room') renderRoute()
    else navigate('#room')
  })
}


// ---------------------------------------------------------------------------
// 四、状态、API 客户端与会话
// ---------------------------------------------------------------------------
// 会话 token 仍只在内存（auth.md §7）：刷新即丢。受保护页面在 401 时回到配对页，
// 配对成功后回到刚才的地址（pendingRoute）。不写 localStorage / sessionStorage。

const LIVE = {
  active: false,
  token: '',
  roomId: '',
  room: null,
  lastSeq: 0,
  seen: new Set(),
  stream: null,
  // 显式重连状态机（TODO 5.5.3 / E10）：idle → connecting → open → reconnecting。
  // 不依赖 EventSource 自带重连，因为它会复用打开时 URL 里的旧 after。
  streamState: 'idle',
  // 已发出消息、还在等 Bot 回复；用于立刻显示思考动画。
  pendingReply: false,
  pendingReplyBotId: '',
  reconnectAttempt: 0,
  reconnectTimer: null,
  // 房间日志裁剪投影（rooms.md §3）：首看 12 条，before 向前翻到 60 条。
  logHasMore: false,
  logBefore: null,
}

const STORE = {
  workspaceId: '',
  bots: [],
  botsLoaded: false,
  botsLoading: null,
  rooms: [],
  roomsLoaded: false,
  roomsLoading: null,
}

/** 固定样例：预览模式（未配对）只读，发送不会请求服务端。 */
const SAMPLE_EVENTS = ROOM.events.slice()

const PREVIEW_ROOM = {
  id: 'r_quant',
  name: '量化研究组',
  replyMode: 'everyone',
  hostBotId: 'chief',
  responder: { kind: 'member', botId: 'selector' },
  members: [
    { botId: 'chief', role: 'host', name: 'Chief' },
    { botId: 'data-officer', role: 'member', name: '数据官' },
    { botId: 'selector', role: 'member', name: '选股师' },
    { botId: 'risk-officer', role: 'member', name: '风控官' },
  ],
}

const api = createApiClient({
  base: API_BASE,
  getToken: () => sessionToken || '',
})

let pendingRoute = ''
let pageFlash = ''
let routeSeq = 0
let authNotice = ''
// 会话探测：cookie 模式下浏览器看不到 HttpOnly token，只能问 GET /api/auth/me。
// status=unknown 表示还没问；anonymous/authenticated 是确定结果；unavailable 表示账号接口未上线。
const authState = { status: 'unknown', account: null, available: false }
let authProbe = null

function hasToken() {
  return (typeof sessionToken === 'string' && sessionToken !== '') || authState.status === 'authenticated'
}

async function probeSession() {
  try {
    const me = await api.get('/api/auth/me')
    authState.status = 'authenticated'
    authState.account = me && typeof me === 'object' ? me : { accountId: null, email: '' }
    authState.available = true
    return true
  } catch (error) {
    if (isAuthError(error)) {
      authState.status = 'anonymous'
      authState.account = null
      authState.available = true
      return false
    }
    // 404/405/501/503：账号接口还没上线，退回旧的配对流程；其它错误也不阻断页面。
    authState.status = 'unavailable'
    authState.account = null
    authState.available = false
    return false
  }
}

async function ensureAuthProbe() {
  if (authState.status !== 'unknown') return hasToken()
  if (authProbe === null) authProbe = probeSession()
  try {
    return await authProbe
  } finally {
    authProbe = null
  }
}

function setTitle(title) {
  document.title = title ? `${title} · Roost` : 'Roost'
}

function navigate(hash) {
  if (location.hash === hash) {
    void renderRoute()
    return
  }
  location.hash = hash
}

/** 受保护页面发现 401：记住原地址并去 #/login；登录成功后回原路由。 */
function requirePair(message = '') {
  // 401/失效：清掉持久化的设备会话，避免刷新后继续拿旧 token 撞墙。
  clearSessionToken()
  sessionToken = null
  LIVE.token = ''
  const target = pendingRouteAfter(location.hash)
  if (target !== '') pendingRoute = target
  // 401 说明 cookie/token 都不再有效；登录页应显示表单，而不是“已登录”。
  authState.status = 'anonymous'
  authState.account = null
  stopNeedsPolling()
  resetApprovalNotifyState()
  authNotice =
    message ||
    '会话已失效或还没登录。登录成功后会回到刚才的页面；也可以用配对码登录。'
  navigate('#/login')
  setTitle('登录')
}

/** 登录/注册成功后接手：更新会话状态，并把用户送回 pendingRoute。 */
async function completeAuth(account) {
  // 账号登录（cookie 会话）优先：清掉之前配对留下的 Bearer token，避免两套会话打架。
  clearSessionToken()
  sessionToken = null
  LIVE.token = ''
  authState.status = 'authenticated'
  authState.available = true
  if (account && typeof account === 'object') authState.account = { ...authState.account, ...account }
  authNotice = ''
  const csrf = account && typeof account.csrfToken === 'string' ? account.csrfToken : ''
  if (csrf !== '' && typeof api.setCsrfToken === 'function') api.setCsrfToken(csrf)
  await enterLiveRoom('')
}

function flash(message) {
  pageFlash = message
}

function showPageFlash() {
  const note = $('#page-note')
  if (!note) return
  note.textContent = pageFlash
  note.hidden = pageFlash === ''
  pageFlash = ''
}

async function ensureWorkspaceId() {
  if (STORE.workspaceId) return STORE.workspaceId
  const data = await api.get('/api/workspaces')
  let workspaces = Array.isArray(data?.workspaces) ? data.workspaces : []
  if (workspaces.length === 0) {
    const created = await api.post('/api/workspaces', { name: '我的工作区' })
    workspaces = created && created.workspace ? [created.workspace] : []
  }
  if (workspaces.length === 0) throw new Error('没有可用的 workspace')
  STORE.workspaceId = workspaces[0].id
  return STORE.workspaceId
}

async function loadBots(options = {}) {
  if (STORE.botsLoaded && !options.force) return STORE.bots
  if (STORE.botsLoading && !options.force) return STORE.botsLoading
  const task = (async () => {
    const workspaceId = await ensureWorkspaceId()
    const data = await api.get(`/api/bots?workspaceId=${encodeURIComponent(workspaceId)}`)
    const list = Array.isArray(data?.bots) ? data.bots : Array.isArray(data) ? data : []
    STORE.bots = list
    STORE.botsLoaded = true
    renderSidebarBots()
    return STORE.bots
  })()
  STORE.botsLoading = task
  try {
    return await task
  } finally {
    if (STORE.botsLoading === task) STORE.botsLoading = null
  }
}

function normalizeRoom(payload) {
  const room = payload && typeof payload === 'object' && payload.room ? payload.room : payload
  if (!room || typeof room !== 'object') return null
  const round = room.round || (payload && typeof payload === 'object' ? payload.round || payload.currentRound : null) || null
  return {
    ...room,
    members: Array.isArray(room.members) ? room.members : [],
    round,
  }
}

async function loadRooms(options = {}) {
  if (STORE.roomsLoaded && !options.force) return STORE.rooms
  if (STORE.roomsLoading && !options.force) return STORE.roomsLoading
  const task = (async () => {
    const query = STORE.workspaceId ? `?workspaceId=${encodeURIComponent(STORE.workspaceId)}` : ''
    const data = await api.get(`/api/rooms${query}`)
    const list = Array.isArray(data?.rooms) ? data.rooms : []
    STORE.rooms = list.map(normalizeRoom).filter(Boolean)
    STORE.roomsLoaded = true
    if (!STORE.workspaceId && STORE.rooms[0]?.workspaceId) STORE.workspaceId = STORE.rooms[0].workspaceId
    renderSidebarRooms()
    updatePageBackLink()
    return STORE.rooms
  })()
  STORE.roomsLoading = task
  try {
    return await task
  } finally {
    if (STORE.roomsLoading === task) STORE.roomsLoading = null
  }
}

async function loadRoom(id, options = {}) {
  if (!id) return null
  try {
    return normalizeRoom(await api.get(`/api/rooms/${encodeURIComponent(id)}`))
  } catch (error) {
    // 契约还没实现单房间路由时，用列表里的同一间兜底（没有 members/round）。
    if (!(error && error.status === 404)) throw error
    const rooms = options.force ? await loadRooms({ force: true }) : await loadRooms()
    const fallback = rooms.find((room) => room.id === id)
    if (fallback) return normalizeRoom(fallback)
    throw error
  }
}

/** 配对后没有房间时不强行建：M4 的房间至少 2 个 Bot，先让用户去建 Bot 再建群。 */
async function ensureRoom() {
  return loadRooms({ force: true })
}

function pageContext() {
  return {
    api,
    store: STORE,
    navigate,
    ensureWorkspaceId,
    loadBots,
    loadRooms,
    loadRoom,
    requirePair,
    hasToken,
    authState: () => authState,
    completeAuth,
    consumeAuthNotice: () => {
      const message = authNotice
      authNotice = ''
      return message
    },
    refreshNeedsCount,
    refreshSidebar() {
      renderSidebarRooms()
      renderSidebarBots()
    },
  }
}

// ---------------------------------------------------------------------------
// 「需要你」角标：连上控制面后按 workspace 拉真实 pending 数（简单 fetch，不新增 SSE）
// ---------------------------------------------------------------------------

let needsCountSeq = 0

// 通知（TODO 5.5.6）：按 approval id 去重，同一批只提醒一次。首轮只建基线。
const NEEDS_POLL_MS = 60_000
const approvalNotifyState = {
  knownIds: new Set(),
  notifiedIds: new Set(),
  ready: false,
}
let needsPollTimer = null

function resetApprovalNotifyState() {
  approvalNotifyState.knownIds = new Set()
  approvalNotifyState.notifiedIds = new Set()
  approvalNotifyState.ready = false
}

function stopNeedsPolling() {
  if (needsPollTimer) {
    clearInterval(needsPollTimer)
    needsPollTimer = null
  }
}

/** 连上控制面后按 60s 刷新待审批；页面可见与否都跑，隐藏时才有系统通知。 */
function startNeedsPolling() {
  if (needsPollTimer) return
  needsPollTimer = setInterval(() => {
    void refreshNeedsCount()
  }, NEEDS_POLL_MS)
}

/** 系统通知只在这一刻创建：权限必须在用户手势时已经拿到；失败就只保留角标。 */
function showApprovalSystemNotification(body) {
  if (!supportsNotifications() || notificationPermission() !== 'granted') return false
  try {
    const notification = new Notification(NOTIFICATION_TITLE, {
      body,
      tag: 'roost-approvals',
      renotify: false,
    })
    notification.onclick = () => {
      try {
        window.focus()
      } catch {
        // 部分浏览器不允许脚本抢焦点；下面照样切路由。
      }
      navigate('#/approvals')
      notification.close()
    }
    return true
  } catch {
    return false
  }
}

/** 把一轮审批快照交给纯逻辑：去重 + 判断是否弹通知。 */
function applyApprovalSnapshot(list) {
  const plan = planApprovalNotification({
    knownIds: approvalNotifyState.knownIds,
    notifiedIds: approvalNotifyState.notifiedIds,
    ready: approvalNotifyState.ready,
    approvals: list,
    enabled: readNotificationPref(),
    permission: notificationPermission(),
    hidden: typeof document !== 'undefined' && document.hidden === true,
  })
  approvalNotifyState.knownIds = plan.knownIds
  approvalNotifyState.notifiedIds = plan.notifiedIds
  approvalNotifyState.ready = plan.ready
  if (plan.notify) showApprovalSystemNotification(plan.body)
}

/** 把真实 pending 数写到侧栏/房间头/抽屉标题；0 时隐藏角标，不显示样例 2。 */
function setNeedsCount(count) {
  const value = Number.isInteger(count) && count > 0 ? count : 0
  const countNode = $('#needs-count')
  if (countNode) {
    countNode.textContent = value > 0 ? `(${value})` : ''
    countNode.hidden = value === 0
  }
  const small = $('#needs-btn-sm')
  if (small) small.textContent = value > 0 ? `需要你 (${value})` : '需要你'
  const title = $('#needs-title')
  if (title) title.textContent = `需要你 · ${value}`
}

/**
 * 刷新真实 pending 数。预览模式（未配对/未连上）直接跳过：保留原有样例行为。
 * 失败保持原样，不把角标清零、也不打断当前页面。
 */
async function refreshNeedsCount() {
  if (!LIVE.active && !hasToken()) return
  const seq = ++needsCountSeq
  try {
    const workspaceId = await ensureWorkspaceId()
    const params = new URLSearchParams({ workspaceId, status: 'pending' })
    const data = await api.get(`/api/approvals?${params.toString()}`)
    if (seq !== needsCountSeq) return
    const list = Array.isArray(data?.approvals) ? data.approvals : []
    const pending = list.filter((item) => item && item.status === 'pending').length
    setNeedsCount(pending)
    // 通知只在页面隐藏且出现新的 approval id 时弹；页面可见只更新角标。
    applyApprovalSnapshot(list)
  } catch {
    // 角标只是提示：401/未就绪/网络失败都不改样例数字，也不弹错。
  }
}

// ---------------------------------------------------------------------------
// 五、路由与页面切换
// ---------------------------------------------------------------------------

/** 管理页左上角的「← 房间」：回到最近一个房间，不把用户丢回配对页。 */
function roomBackHash() {
  const id = LIVE.roomId || (STORE.rooms.length > 0 ? STORE.rooms[STORE.rooms.length - 1].id : '')
  if (id) return `#/rooms/${encodeURIComponent(id)}`
  // 页面状态被重置（例如从设置页刷新）时，仍能靠持久化的最近房间回去。
  return readLastRoom() || '#/bots'
}

function updatePageBackLink() {
  const link = $('#page-back')
  if (link) link.href = roomBackHash()
}

function showView(name) {
  const pair = $('#pair-view')
  const auth = $('#auth-view')
  const room = $('#room-view')
  const page = $('#page-view')
  if (pair) pair.hidden = name !== 'pair'
  if (auth) auth.hidden = name !== 'auth'
  if (room) room.hidden = name !== 'room'
  if (page) page.hidden = name !== 'page'
  if (name === 'page') updatePageBackLink()
  document.body.dataset.view = name
}

function focusPairCode() {
  const pair = $('#pair-view')
  if (!pair) return
  if (pair.contains(document.activeElement)) return
  const firstEmpty = Array.from(document.querySelectorAll('.code-digit')).find((box) => box.value === '') || $('.code-digit')
  if (firstEmpty) firstEmpty.focus()
}

function renderNotFound(main) {
  const hash = location.hash || '#/'
  main.replaceChildren(
    ui.pageHeader('找不到这个页面'),
    ui.emptyState({
      title: '地址不对',
      body: `没有匹配 ${hash} 的路由。可用的有 #/bots、#/installs、#/plugins、#/panels、#/schedules、#/connectors、#/login、#/register、#/rooms/new、#/rooms/:id/settings。`,
      action: ui.linkButton('回首页', '#/', { variant: 'primary' }),
      secondary: ui.linkButton('Bot 列表', '#/bots', { variant: 'ghost' }),
    })
  )
}

function renderWorkspaceMismatch(main, workspaceId) {
  main.replaceChildren(
    ui.pageHeader('这个工作区不在当前账号下'),
    ui.emptyState({
      title: '工作区不匹配',
      body: `链接里的工作区 ${workspaceId || '（空）'} 不属于当前账号。为免把内容误跳到别的工作区，这里不自动打开。`,
      action: ui.linkButton('回到当前工作区', '#/bots', { variant: 'primary' }),
      secondary: ui.linkButton('去配对', '#/', { variant: 'ghost' }),
    })
  )
}

/**
 * 多端深链（ui.md §4）：先解析当前 workspace，再规范化成内部路由。
 * 一致时 replaceState 改写地址栏（不产生历史噪音）；不一致时显示空态，不静默跳错。
 */
async function openWorkspaceDeepLink(route, seq) {
  if (!hasToken()) {
    requirePair()
    return
  }
  let workspaceId = ''
  try {
    workspaceId = await ensureWorkspaceId()
  } catch (error) {
    if (seq !== routeSeq) return
    if (isAuthError(error)) {
      requirePair()
      return
    }
    showView('page')
    setTitle('打不开这个链接')
    const main = $('#page-main')
    if (main) {
      main.replaceChildren(
        ui.pageHeader('打不开这个链接'),
        ui.errorState({
          error,
          message: `工作区载入失败：${error instanceof Error ? error.message : String(error)}`,
          onRetry: () => void renderRoute(),
          onPair: true,
        })
      )
    }
    return
  }
  if (seq !== routeSeq) return

  const canonical = canonicalWorkspaceRoute(route, workspaceId)
  if (!canonical || canonical.status === 'invalid') {
    showView('page')
    setTitle('找不到页面')
    const main = $('#page-main')
    if (main) renderNotFound(main)
    return
  }
  if (canonical.status === 'mismatch') {
    showView('page')
    setTitle('工作区不匹配')
    const main = $('#page-main')
    if (main) renderWorkspaceMismatch(main, canonical.workspaceId)
    window.scrollTo(0, 0)
    return
  }

  // replaceState 不触发 hashchange，所以改写后手动按内部路由重渲染。
  try {
    history.replaceState(history.state, '', canonical.hash)
  } catch {
    // file:// 等受限环境：退化为普通跳转，仍不留在 /w/ 深链地址上。
    location.hash = canonical.hash
    return
  }
  await renderRoute()
}

async function renderRoute() {
  const seq = ++routeSeq
  closeMentionMenu()
  const route = routeMatch(location.hash)
  // 离开房间页就断开 SSE 并清掉重连定时器，别在后台一直收消息/重连。
  if (route.name !== 'room') stopStream()
  const roomView = $('#room-view')
  if (roomView) roomView.classList.toggle('is-home', route.name === 'home')

  if (isAuthRouteName(route.name)) {
    await ensureAuthProbe()
    const authMain = $('#auth-main')
    if (!authMain) return
    showView('auth')
    const ctx = pageContext()
    switch (route.name) {
      case 'login':
        setTitle('登录')
        await mountLoginPage(authMain, ctx)
        break
      case 'register':
        setTitle('注册')
        await mountRegisterPage(authMain, ctx)
        break
      case 'verifyEmail':
        setTitle('验证邮箱')
        await mountVerifyEmailPage(authMain, ctx, route.params)
        break
      case 'reset':
        setTitle('重置密码')
        await mountResetPage(authMain, ctx)
        break
      case 'resetConfirm':
        setTitle('设置新密码')
        await mountResetConfirmPage(authMain, ctx, route.params)
        break
      default:
        break
    }
    window.scrollTo(0, 0)
    return
  }

  if (route.name === 'pair') {
    showView('pair')
    setTitle('配对')
    focusPairCode()
    return
  }

  // cookie 模式下先问一次 /api/auth/me；账号接口未上线（unavailable）时不拦截，保留旧配对流程。
  await ensureAuthProbe()
  const previewRoom = route.name === 'room' && route.params.id === null
  if (!previewRoom && !hasToken() && authState.available) {
    requirePair()
    return
  }

  if (
    route.name === 'workspaceRoom' ||
    route.name === 'workspaceBot' ||
    route.name === 'workspaceApprovals'
  ) {
    await openWorkspaceDeepLink(route, seq)
    return
  }
  if (route.name === 'home') {
    showView('room')
    setTitle('Roost')
    await openHome(seq)
    return
  }
  if (route.name === 'room') {
    showView('room')
    setTitle('房间')
    await openRoomRoute(route.params.id, seq)
    return
  }

  showView('page')
  const main = $('#page-main')
  if (!main) return
  const ctx = pageContext()

  switch (route.name) {
    case 'bots':
      setTitle('Bot')
      await mountBotsPage(main, ctx)
      void refreshNeedsCount()
      break
    case 'botNew':
      setTitle('新建 Bot')
      await mountBotsPage(main, ctx, { create: true })
      void refreshNeedsCount()
      break
    case 'bot':
      setTitle('Bot 设置')
      await mountBotSettingsPage(main, ctx, route.params.id)
      void refreshNeedsCount()
      break
    case 'approvals':
      setTitle('需要你')
      await mountApprovalsPage(main, ctx)
      break
    case 'plugins':
      setTitle('插件')
      await mountPluginsPage(main, ctx)
      break
    case 'plugin':
      setTitle('插件详情')
      await mountMarketplacePage(main, ctx, route.params.slug)
      break
    case 'installs':
      setTitle('已安装插件')
      await mountInstallsPage(main, ctx)
      break
    case 'panels':
      setTitle('插件面板')
      await mountPanelsPage(main, ctx)
      break
    case 'settings':
      setTitle('设置')
      await mountSettingsPage(main, ctx)
      break
    case 'usage':
      setTitle('用量')
      await mountUsagePage(main, ctx)
      break
    case 'schedules':
      setTitle('定时任务')
      await mountSchedulesPage(main, ctx)
      break
    case 'routines':
      setTitle('房间定时')
      await mountRoutinesPage(main, ctx)
      break
    case 'connectors':
      setTitle('连接器')
      await mountConnectorsPage(main, ctx)
      break
    case 'roomNew':
      setTitle('新建房间')
      await mountNewRoomPage(main, ctx)
      break
    case 'roomSettings':
      setTitle('房间设置')
      await mountRoomSettingsPage(main, ctx, route.params.id)
      break
    default:
      setTitle('找不到页面')
      renderNotFound(main)
  }

  if (seq !== routeSeq) return
  showPageFlash()
  window.scrollTo(0, 0)
}

// ---------------------------------------------------------------------------
// 六、房间页：加载、成员、轮次状态、SSE
// ---------------------------------------------------------------------------

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
      // 无附件时后端也会给 []；历史/翻页/补拉都走这里，形状保持一致。
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      ...(Array.isArray(message.parts) ? { parts: message.parts } : {}),
    },
  }
}

/**
 * 「需要你」入口：预览时点开是固定样例抽屉；连上控制面后按钮显示真实 pending 角标，
 * 点击直接去 #/approvals（抽屉里没有真实数据可渲染，不再拿样例凑数）。
 */
function setNeedsMode(live) {
  const btn = $('#needs-btn')
  const btnSm = $('#needs-btn-sm')
  const panel = $('#needs')
  // 两种模式都要保留入口：预览看样例，实时看真实角标并跳审批页。
  if (btn) btn.hidden = false
  if (btnSm) btnSm.hidden = false
  if (panel && live) {
    panel.hidden = true
    for (const button of [btn, btnSm]) if (button) button.setAttribute('aria-expanded', 'false')
  }
}

function resetRoomChrome() {
  // 切房间：旧房间的附件 blob URL 与灯箱/iframe 一起清掉。
  resetAttachmentUrls()
  LIVE.active = false
  LIVE.room = null
  LIVE.roomId = ''
  LIVE.lastSeq = 0
  LIVE.seen = new Set()
  LIVE.logHasMore = false
  LIVE.logBefore = null
  // 关流 + 清掉待执行的重连定时器，避免旧房间继续补拉/重连。
  stopStream()
  const settings = $('#room-settings-link')
  if (settings) {
    settings.hidden = true
    settings.removeAttribute('href')
  }
  const working = $('#working')
  if (working) {
    working.hidden = true
    working.classList.remove('is-offline')
  }
  const round = $('#round-status')
  if (round) {
    round.hidden = true
    round.replaceChildren()
  }
  const strip = $('#demo-strip-text')
  if (strip) strip.hidden = true
  const origin = $('#room-origin')
  if (origin) {
    origin.hidden = true
    origin.textContent = ''
    origin.removeAttribute('title')
  }
  const foot = $('#sidebar-foot')
  if (foot) foot.textContent = '未连接控制面'
  // 加载/错误/实时房间都不显示样例「需要你」；只有预览模式会在后面重新打开。
  setNeedsMode(true)
  clearComposerError()
}

function applyLiveRoomChrome(room) {
  if (typeof room.id === 'string' && room.id !== '') writeLastRoom(`#/rooms/${encodeURIComponent(room.id)}`)
  const name = room.name || '房间'
  ROOM.name = name
  const heading = $('#room-name')
  const host = room.hostBotId ? (STORE.bots.find((bot) => bot.id === room.hostBotId) || null) : null
  if (heading) heading.textContent = host && host.name ? host.name : name
  paintRoomPill(room)
  const flockHolder = $('#room-flock')
  if (flockHolder) {
    const flock = roomFlock(room, 40)
    flockHolder.replaceChildren(...(flock ? [flock] : []))
    flockHolder.hidden = flock === null
  }
  setTitle(name)
  const strip = $('#demo-strip-text')
  if (strip) strip.hidden = true
  const origin = $('#room-origin')
  if (origin) {
    const label = roomOriginLabel(room)
    origin.hidden = label === ''
    origin.textContent = label
    if (label === '') origin.removeAttribute('title')
    else origin.title = roomOriginTitle(room)
  }
  const foot = $('#sidebar-foot')
  if (foot) foot.textContent = '已连接控制面 · 实时'
  const settings = $('#room-settings-link')
  if (settings) {
    settings.href = `#/rooms/${encodeURIComponent(room.id)}/settings`
    settings.hidden = false
  }
  renderSidebarRooms()
  renderSidebarBots()
  setNeedsMode(true)
  void refreshNeedsCount()
  updateWhoAnswers()
  renderRoundStatus()
  renderWorking()
}

function enterPreviewRoom() {
  resetRoomChrome()
  // 从实时房间切回预览时，把样例抽屉与样例角标（2）恢复回来。
  renderNeeds()
  LIVE.room = PREVIEW_ROOM
  LIVE.roomId = ROOM.id
  ROOM.name = PREVIEW_ROOM.name
  ROOM.events = SAMPLE_EVENTS.slice()
  const heading = $('#room-name')
  if (heading) heading.textContent = ROOM.name
  setTitle(ROOM.name)
  const strip = $('#demo-strip-text')
  if (strip) {
    strip.hidden = false
    strip.textContent = '假数据预览：未配对，房间内容为固定样例；发送不会请求服务端。'
  }
  const foot = $('#sidebar-foot')
  if (foot) foot.textContent = '未配对 · 假数据'
  const workingText = $('#working-text')
  if (workingText) workingText.textContent = ROOM.working.text
  renderSidebarRooms()
  renderSidebarBots()
  renderMessages()
  setNeedsMode(false)
  updateWhoAnswers()
  renderRoundStatus()
  renderWorking()
  setComposerEnabled(true)
  const composer = $('#composer')
  if (composer) composer.focus()
}

const roomPreviews = new Map()

function conversationEntries() {
  const used = new Set()
  const entries = []
  for (const bot of STORE.bots) {
    const hosted = STORE.rooms.filter((item) => item.hostBotId === bot.id)
    const joined = STORE.rooms.filter((item) => (item.members || []).some((member) => member.botId === bot.id))
    const room = (hosted.length > 0 ? hosted : joined)[0] || null
    if (room) used.add(room.id)
    const members = room && Array.isArray(room.members) ? room.members : []
    entries.push({
      bot,
      room,
      title: bot.name || 'Bot',
      primary: room !== null && room.hostBotId === bot.id && members.length >= 2,
    })
  }
  for (const room of STORE.rooms) {
    if (used.has(room.id)) continue
    const memberIds = (room.members || []).map((member) => member.botId).filter(Boolean)
    if (memberIds.length > 0 && memberIds.every((id) => entries.some((entry) => entry.bot && entry.bot.id === id))) continue
    const hostId = room.hostBotId || (room.members && room.members[0] && room.members[0].botId) || room.id
    entries.push({ bot: { id: hostId, name: room.name || '房间' }, room, title: room.name || '房间', primary: true })
  }
  return entries
}

function messagePreviewText(message) {
  if (!message) return '还没有消息'
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (text !== '') return text
  const parts = Array.isArray(message.parts) ? message.parts : []
  if (parts.some((part) => part && part.type === 'image')) return '图片'
  if (parts.some((part) => part && part.type === 'choice')) return '请选择'
  if (parts.some((part) => part && part.type === 'approval')) return '需要你确认'
  return '还没有消息'
}

function formatShanghai(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const delta = Date.now() - date.getTime()
  if (delta >= 0 && delta < 60_000) return '刚刚'
  if (delta >= 0 && delta < 60 * 60_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
  const today = day.format(new Date())
  const that = day.format(date)
  if (that === today) return `今天 ${clock.format(date)}`
  const yesterday = day.format(new Date(Date.now() - 24 * 60 * 60 * 1000))
  if (that === yesterday) return '昨天'
  return `${Number(that.slice(5, 7))}月${Number(that.slice(8, 10))}日`
}

function previewLine(message, entry) {
  const body = messagePreviewText(message)
  const actor = message && message.actor
  if (!actor) return body
  if (actor.kind === 'user') return `你：${body}`
  if (actor.kind === 'bot' && entry && entry.bot && actor.id !== entry.bot.id) {
    return `${botIdentity(actor.id).name}：${body}`
  }
  return body
}

async function loadRoomPreview(roomId) {
  if (roomPreviews.has(roomId)) return roomPreviews.get(roomId)
  const data = await api.get(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=1`)
  const messages = Array.isArray(data?.messages) ? data.messages : []
  const last = messages[messages.length - 1]
  const preview = { message: last || null, at: last && last.at ? formatShanghai(last.at) : '' }
  roomPreviews.set(roomId, preview)
  return preview
}

function roomsForBot(bot) {
  if (!bot) return []
  const hosted = STORE.rooms.filter((item) => item.hostBotId === bot.id)
  if (hosted.length > 0) return hosted
  return STORE.rooms.filter((item) => (item.members || []).some((member) => member.botId === bot.id))
}

function renderChatRow(entry) {
  const href = entry.room ? `#/rooms/${encodeURIComponent(entry.room.id)}` : `#/bots/${encodeURIComponent(entry.bot.id)}`
  const row = el('a', { class: 'home-row', href })
  row.append(botAvatar(entry.bot, 48, { round: true, primary: entry.primary === true }))
  const text = el('div', { class: 'home-copy' })
  text.append(el('strong', { text: entry.title }))
  const preview = el('span', { class: 'home-preview', text: '…' })
  text.append(preview)
  row.append(text)
  const time = el('time', { class: 'home-time', text: '' })
  row.append(time)
  const candidates = roomsForBot(entry.bot)
  if (candidates.length === 0) {
    preview.textContent = '点开看看'
    return row
  }
  void (async () => {
    let best = null
    for (const room of candidates) {
      const item = await loadRoomPreview(room.id)
      const at = item.message && item.message.at ? Date.parse(item.message.at) : 0
      if (!best || at >= best.at) best = { room, item, at }
    }
    if (!preview.isConnected || !best) return
    row.href = `#/rooms/${encodeURIComponent(best.room.id)}`
    preview.textContent = best.item.message ? previewLine(best.item.message, entry) : '还没有消息'
    time.textContent = best.item.at
  })().catch(() => {
    if (preview.isConnected) preview.textContent = '点开看看'
  })
  return row
}

function paintRoomPill(room) {
  const slot = $('#room-pill-avatar')
  if (!slot) return
  const hostId = room && (room.hostBotId || (room.members && room.members[0] && room.members[0].botId))
  if (!hostId) {
    slot.replaceChildren()
    return
  }
  const stored = STORE.bots.find((bot) => bot.id === hostId)
  const bot = stored || { id: hostId, name: room.name || 'Bot' }
  slot.replaceChildren(botAvatar(bot, 28, { round: true, primary: room.hostBotId === hostId }))
  const subtitle = $('#room-subtitle')
  if (subtitle) subtitle.textContent = room.name ? `房间：${room.name}` : ''
}

function setupRoomMenu() {
  const button = $('#room-more')
  const menu = $('#room-menu')
  if (!button || !menu) return
  button.addEventListener('click', () => {
    const open = menu.hidden
    menu.hidden = !open
    button.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  const grid = $('#home-grid')
  if (grid) {
    grid.addEventListener('click', () => {
      const open = menu.hidden
      menu.hidden = !open
      grid.setAttribute('aria-expanded', open ? 'true' : 'false')
      button.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
  }
  const filterRows = (query) => {
    const needle = query.trim().toLowerCase()
    document.querySelectorAll('#room-view .home-row').forEach((row) => {
      const text = (row.textContent || '').toLowerCase()
      row.hidden = needle !== '' && !text.includes(needle)
    })
  }
  const homeSearch = $('#home-search')
  const sideSearch = $('#side-search')
  if (homeSearch) homeSearch.addEventListener('input', () => filterRows(homeSearch.value))
  if (sideSearch) sideSearch.addEventListener('input', () => filterRows(sideSearch.value))
  document.addEventListener('click', (event) => {
    if (menu.hidden) return
    const target = event.target
    if (button.contains(target) || menu.contains(target) || (grid && grid.contains(target))) return
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    if (grid) grid.setAttribute('aria-expanded', 'false')
  })
}

async function openHome(seq) {
  resetRoomChrome()
  stopStream()
  const list = $('#messages')
  if (!list) return
  list.replaceChildren(el('p', { class: 'muted', text: '正在载入…' }))
  try {
    if (!STORE.botsLoaded) {
      const data = await api.get('/api/bots')
      STORE.bots = Array.isArray(data?.bots) ? data.bots : []
      STORE.botsLoaded = true
    }
    if (!STORE.roomsLoaded) {
      STORE.rooms = await ensureRoom()
      STORE.roomsLoaded = true
    }
  } catch (error) {
    if (isAuthError(error)) {
      requirePair()
      return
    }
  }
  if (seq !== routeSeq) return
  list.replaceChildren()
  const heroHost = STORE.bots.find((bot) => STORE.rooms.some((room) => room.hostBotId === bot.id && (room.members || []).length >= 2)) || STORE.bots[0]
  if (heroHost) {
    const hero = el('div', { class: 'home-hero' })
    hero.append(botAvatar(heroHost, 96, { round: true, primary: true }))
    hero.append(el('div', { class: 'hero-name', text: `${heroHost.name || 'Roost'} · 主 Bot` }))
    list.append(hero)
  }
  const entries = conversationEntries()
  if (entries.length === 0) {
    list.append(el('p', { class: 'muted', text: '还没有 Bot。' }))
    renderSidebarRooms()
    return
  }
  for (const entry of entries) list.append(renderChatRow(entry))
  renderSidebarRooms()
}

async function openRoomRoute(id, seq) {
  resetRoomChrome()
  if (!id) {
    enterPreviewRoom()
    return
  }
  const messages = $('#messages')
  if (messages) messages.replaceChildren(ui.loading('正在载入房间…'))
  setComposerEnabled(false, '正在载入房间…')
  const who = $('#who-answers')
  if (who) who.textContent = '正在载入成员…'

  try {
    const room = await loadRoom(id)
    if (seq !== routeSeq) return
    if (!room) throw new Error('找不到这个房间')
    const data = await api.get(`/api/rooms/${encodeURIComponent(room.id)}/messages`)
    if (seq !== routeSeq) return
    const list = Array.isArray(data?.messages) ? data.messages : []

    LIVE.active = true
    LIVE.token = sessionToken || ''
    LIVE.roomId = room.id
    LIVE.room = room
    LIVE.lastSeq = 0
    LIVE.seen = new Set()
    // 首看只给最近 12 条；page.before 是"加载更早"的游标。
    LIVE.logHasMore = Boolean(data?.page?.hasMore)
    LIVE.logBefore = Number.isSafeInteger(data?.page?.before) ? data.page.before : null
    // 初始加载也走 LIVE.seen 去重，并按 seq 排序，后续乱序插入才有稳定基线。
    const events = []
    for (const message of list) {
      const seq = Number(message && message.seq)
      if (Number.isFinite(seq)) {
        if (LIVE.seen.has(seq)) continue
        LIVE.seen.add(seq)
        LIVE.lastSeq = Math.max(LIVE.lastSeq, seq)
      }
      events.push(toEvent(message, room.id))
    }
    events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    ROOM.events = events

    if (!STORE.roomsLoaded) {
      try {
        STORE.rooms = await ensureRoom()
        STORE.roomsLoaded = true
      } catch {
        // 侧栏没有房间列表时，对话本身仍然打开。
      }
    }
    if (!STORE.botsLoaded) {
      try {
        await loadBots()
      } catch {
        // 名字解析失败时侧栏用房间名。
      }
    }
    if (seq !== routeSeq) return
    applyLiveRoomChrome(room)
    renderMessages()
    const hostName = room.hostBotId ? (STORE.bots.find((bot) => bot.id === room.hostBotId)?.name || '') : ''
    setComposerEnabled(true, hostName ? `向${hostName}提问` : '发一条消息')
    openStream()
    const composer = $('#composer')
    if (composer) composer.focus()
  } catch (error) {
    if (seq !== routeSeq) return
    if (isAuthError(error)) {
      requirePair()
      return
    }
    renderRoomLoadError(error)
  }
}

function renderRoomLoadError(error) {
  const messages = $('#messages')
  if (messages) {
    messages.replaceChildren(
      ui.errorState({
        error,
        message: `房间没能打开：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => {
          void renderRoute()
        },
        onPair: hasToken() ? undefined : true,
      })
    )
  }
  setComposerEnabled(false, '房间没能载入')
  const who = $('#who-answers')
  if (who) who.textContent = ''
  const working = $('#working')
  if (working) working.hidden = true
  const round = $('#round-status')
  if (round) round.hidden = true
}

function updateWhoAnswers() {
  const who = $('#who-answers')
  if (!who) return
  const label = whoAnswersLabel(LIVE.active ? LIVE.room : PREVIEW_ROOM)
  who.textContent = label || '还没有成员会回答'
}

function renderRoundStatus() {
  const bar = $('#round-status')
  if (!bar) return
  const round = LIVE.active && LIVE.room ? LIVE.room.round : null
  const items = roundStatusItems(round, (botId) => botLabel(botId))
  if (items.length === 0) {
    bar.hidden = true
    bar.replaceChildren()
    return
  }
  bar.replaceChildren()
  const stateLabel = roundStateLabel(round.state)
  if (stateLabel) bar.append(el('span', { class: 'round-state', text: stateLabel }))
  for (const item of items) {
    const chip = el('span', { class: `round-chip round-${item.kind}` })
    chip.append(el('span', { class: 'round-name', text: item.name }))
    chip.append(el('span', { class: 'round-label', text: item.label }))
    if (item.note) chip.append(el('span', { class: 'round-note', text: `· ${item.note}` }))
    const title = [item.label]
    if (item.note) title.push(item.note)
    if (item.by) title.push(`由 ${botLabel(item.by)} 叫到`)
    chip.title = title.join(' · ')
    bar.append(chip)
  }
  bar.hidden = false
}

/** 给正在思考/说话的 Bot 头像加一圈动画；其余头像保持安静。 */
function markThinkingAvatar(botId) {
  for (const node of document.querySelectorAll('.avatar[data-bot-id]')) {
    node.classList.toggle('is-thinking', botId !== '' && node.getAttribute('data-bot-id') === botId)
  }
}

function renderWorking() {
  const working = $('#working')
  const text = $('#working-text')
  if (!working || !text) return
  working.classList.remove('is-thinking')
  markThinkingAvatar('')
  if (!LIVE.active) {
    working.hidden = false
    working.classList.remove('is-offline')
    text.textContent = ROOM.working.text
    return
  }
  // 离线或流断开时，状态区优先说明连接问题；恢复 open 后回到轮次状态。
  if (LIVE.streamState === 'reconnecting') {
    working.hidden = false
    working.classList.add('is-offline')
    text.textContent = '离线，正在重连…'
    return
  }
  working.classList.remove('is-offline')
  if (LIVE.pendingReply) {
    working.hidden = false
    working.classList.add('is-thinking')
    text.textContent = '正在思考…'
    markThinkingAvatar(LIVE.pendingReplyBotId)
    return
  }
  const round = LIVE.room && LIVE.room.round
  if (!round) {
    working.hidden = true
    working.classList.remove('is-thinking')
    markThinkingAvatar('')
    return
  }
  const liveSpeaking = LIVE.room && typeof LIVE.room.speaking === 'string' ? LIVE.room.speaking : ''
  const slot = speakingSlot(round)
  const activeBot = slot ? slot.botId : liveSpeaking
  markThinkingAvatar(activeBot)
  working.classList.toggle('is-thinking', activeBot !== '' || round.state === 'running')
  if (slot) {
    working.hidden = false
    text.textContent = `${botLabel(slot.botId)} 正在说`
    return
  }
  if (liveSpeaking !== '') {
    working.hidden = false
    text.textContent = `${botLabel(liveSpeaking)} 正在说`
    return
  }
  if (round.state === 'running') {
    const waiting = roundStatusItems(round, (botId) => botLabel(botId)).find((item) => item.status === 'waiting')
    working.hidden = false
    text.textContent = waiting ? `轮到 ${waiting.name}…` : '本轮进行中'
    return
  }
  working.hidden = true
}

function appendLiveEvent(message) {
  const seq = Number(message && message.seq)
  if (!message || (Number.isFinite(seq) && LIVE.seen.has(seq))) return false
  if (Number.isFinite(seq)) {
    LIVE.seen.add(seq)
    LIVE.lastSeq = Math.max(LIVE.lastSeq, seq)
  }
  clearStreaming()
  insertEvent(toEvent(message, LIVE.roomId))
  return true
}

/** 按 seq 把事件插到正确位置：乱序到达不会跑到末尾。 */
function insertEvent(event) {
  const seq = Number(event && event.seq)
  let index = ROOM.events.length
  if (Number.isFinite(seq)) {
    for (let i = 0; i < ROOM.events.length; i += 1) {
      const existing = Number(ROOM.events[i].seq)
      if (Number.isFinite(existing) && existing > seq) {
        index = i
        break
      }
    }
  }
  const isAppend = index >= ROOM.events.length
  ROOM.events.splice(index, 0, event)

  const list = $('#messages')
  if (!list) return
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const placeholder = list.querySelector('.messages-empty')
  if (placeholder) placeholder.remove()
  if (event && event.payload && event.payload.role === 'bot') {
    LIVE.pendingReply = false
    renderWorking()
  }
  const node = renderEvent(event)
  if (Number.isFinite(seq)) node.dataset.seq = String(seq)
  if (isAppend) {
    list.append(node)
    if (nearBottom) list.scrollTop = list.scrollHeight
    return
  }

  // DOM 里已有的第 index 个事件就是第一条 seq 更大的消息，插在它前面。
  const ref = list.querySelectorAll('[data-seq]')[index] || null
  const refAbove = ref ? ref.getBoundingClientRect().top < list.getBoundingClientRect().top : false
  if (ref) list.insertBefore(node, ref)
  else list.append(node)
  if (nearBottom) list.scrollTop = list.scrollHeight
  else if (refAbove) list.scrollTop += node.offsetHeight
}

/**
 * 用 after=LIVE.lastSeq 补拉断线期间的消息。
 * 返回是否成功；重连状态机据此决定继续退避还是重新开流。
 */
async function refreshMessages() {
  if (!LIVE.active || !LIVE.roomId) return false
  const roomId = LIVE.roomId
  try {
    const query = LIVE.lastSeq > 0 ? `?after=${encodeURIComponent(String(LIVE.lastSeq))}` : ''
    const data = await api.get(`/api/rooms/${encodeURIComponent(roomId)}/messages${query}`)
    if (!LIVE.active || LIVE.roomId !== roomId) return false
    const list = Array.isArray(data?.messages) ? data.messages : []
    for (const message of list) appendLiveEvent(message)
    return true
  } catch (error) {
    if (isAuthError(error)) requirePair()
    return false
  }
}

/** 发消息后短轮询房间轮次；让「正在思考」和头像动画跟真实 turn 同步。 */
function watchRound(roomId) {
  stopRoundWatch()
  const startedAt = Date.now()
  const tick = async () => {
    roundWatchTimer = null
    if (!LIVE.active || LIVE.roomId !== roomId) return
    await refreshRoomState()
    if (!LIVE.active || LIVE.roomId !== roomId) return
    const round = LIVE.room && LIVE.room.round
    const state = round && typeof round.state === 'string' ? round.state : ''
    const running = state === 'running' || state === 'pending' || state === 'waiting'
    const elapsed = Date.now() - startedAt
    if (elapsed > 120_000) {
      LIVE.pendingReply = false
      renderWorking()
      return
    }
    // 轮次还没落库时也给 8 秒窗口，避免刚发完就停止动画。
    if (!running && (round || elapsed > 8_000)) {
      LIVE.pendingReply = false
      renderWorking()
      return
    }
    roundWatchTimer = setTimeout(tick, 800)
  }
  roundWatchTimer = setTimeout(tick, 250)
}

async function refreshRoomState() {
  if (!LIVE.active || !LIVE.roomId) return
  try {
    const room = await loadRoom(LIVE.roomId, { force: true })
    if (!room || room.id !== LIVE.roomId) return
    LIVE.room = room
    updateWhoAnswers()
    renderRoundStatus()
    renderWorking()
    renderSidebarRooms()
  } catch (error) {
    if (isAuthError(error)) requirePair()
  }
}

function handleRoundEvent(event) {
  try {
    const payload = JSON.parse(event.data)
    const round = payload && (payload.round || payload)
    if (!round || !LIVE.room) return
    LIVE.room.round = round
    renderRoundStatus()
    renderWorking()
  } catch {
    // 坏帧不打断整条流。
  }
}

let streamingText = ''

function clearStreaming() {
  streamingText = ''
  document.getElementById('streaming-line')?.remove()
}

function handleDeltaEvent(event) {
  let payload
  try {
    payload = JSON.parse(event.data)
  } catch {
    return
  }
  const delta = payload && typeof payload.delta === 'string' ? payload.delta : ''
  if (delta === '') return
  streamingText += delta
  const list = $('#messages')
  if (!list) return
  let node = document.getElementById('streaming-line')
  if (!node) {
    node = el('article', { class: 'msg msg-bot streaming-line', id: 'streaming-line' })
    list.append(node)
  }
  node.replaceChildren(el('p', { class: 'streaming-text', text: streamingText }))
  const dots = el('span', { class: 'thinking-dots typing-indicator', 'aria-hidden': 'true' })
  dots.append(el('i'), el('i'), el('i'))
  node.append(dots)
  list.scrollTop = list.scrollHeight
  LIVE.pendingReply = true
  renderWorking()
}

function handleSpeakingEvent(event) {
  try {
    const payload = JSON.parse(event.data)
    const botId = payload && (payload.speaking || payload.botId)
    if (!LIVE.room) return
    if (typeof botId === 'string' && botId !== '') LIVE.room.speaking = botId
    else delete LIVE.room.speaking
    renderWorking()
  } catch {
    // 同上。
  }
}

function setStreamState(state) {
  LIVE.streamState = state
  if (LIVE.active) renderWorking()
}

function clearReconnectTimer() {
  if (LIVE.reconnectTimer) {
    clearTimeout(LIVE.reconnectTimer)
    LIVE.reconnectTimer = null
  }
}

function closeStream() {
  if (LIVE.stream) {
    LIVE.stream.close()
    LIVE.stream = null
  }
}

/** 关流并清掉定时器：切房间、页面卸载、离开房间页时调用，避免旧房间还在重连。 */
let roundWatchTimer = null
function stopRoundWatch() {
  if (roundWatchTimer) {
    clearTimeout(roundWatchTimer)
    roundWatchTimer = null
  }
  LIVE.pendingReply = false
  LIVE.pendingReplyBotId = ''
}

function stopStream() {
  stopRoundWatch()
  clearReconnectTimer()
  closeStream()
  LIVE.streamState = 'idle'
  LIVE.reconnectAttempt = 0
}

function openStream() {
  if (!STREAM_ENABLED || !LIVE.active || !LIVE.roomId) return
  clearReconnectTimer()
  if (LIVE.stream) {
    LIVE.stream.close()
    LIVE.stream = null
  }
  // 首次打开是 connecting；重连期间保持 reconnecting，直到 open 才隐藏离线提示。
  if (LIVE.streamState === 'idle') LIVE.streamState = 'connecting'
  const streamQuery = new URLSearchParams({ after: String(LIVE.lastSeq) })
  if (LIVE.token !== '') streamQuery.set('access_token', LIVE.token)
  const path = `/api/rooms/${encodeURIComponent(LIVE.roomId)}/stream?${streamQuery.toString()}`
  let stream
  try {
    stream = new EventSource(API_BASE ? `${API_BASE}${path}` : path)
  } catch {
    scheduleReconnect()
    return
  }
  LIVE.stream = stream
  stream.addEventListener('open', () => {
    if (stream !== LIVE.stream) return
    LIVE.reconnectAttempt = 0
    setStreamState('open')
  })
  stream.addEventListener('message', (event) => {
    try {
      appendLiveEvent(JSON.parse(event.data))
    } catch {
      // 坏帧不该打断整条流；重连补拉会兜住。
    }
  })
  stream.addEventListener('round', handleRoundEvent)
  stream.addEventListener('round.started', handleRoundEvent)
  stream.addEventListener('round.ended', handleRoundEvent)
  stream.addEventListener('status', handleRoundEvent)
  stream.addEventListener('speaking', handleSpeakingEvent)
  stream.addEventListener('message.delta', handleDeltaEvent)
  stream.addEventListener('card.answered', () => { void refreshMessages() })
  stream.addEventListener('approval.decided', () => { void refreshMessages() })
  stream.addEventListener('error', () => {
    if (stream !== LIVE.stream) return
    // 关掉浏览器自动重连：它会带着旧的 after 重放，可能漏掉断线期间的消息。
    // 这里只关流、不重置 reconnectAttempt，才能让退避逐次翻倍。
    closeStream()
    scheduleReconnect()
  })
}

/** 指数退避：1s、2s、4s、8s… 上限 30s，下一次先补拉再开流。 */
function scheduleReconnect() {
  if (!STREAM_ENABLED || !LIVE.active || !LIVE.roomId) return
  setStreamState('reconnecting')
  if (LIVE.reconnectTimer) return
  const attempt = LIVE.reconnectAttempt
  LIVE.reconnectAttempt += 1
  const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000)
  LIVE.reconnectTimer = setTimeout(() => {
    LIVE.reconnectTimer = null
    void reconnectStream()
  }, delay)
}

async function reconnectStream() {
  if (!STREAM_ENABLED || !LIVE.active || !LIVE.roomId) return
  const roomId = LIVE.roomId
  const ok = await refreshMessages()
  if (!LIVE.active || LIVE.roomId !== roomId) return
  if (!ok) {
    scheduleReconnect()
    return
  }
  openStream()
}

function handleOnline() {
  if (!LIVE.active) return
  clearReconnectTimer()
  LIVE.reconnectAttempt = 0
  if (LIVE.stream && LIVE.stream.readyState !== 2) void refreshMessages()
  else void reconnectStream()
}

function handleOffline() {
  if (!LIVE.active) return
  closeStream()
  scheduleReconnect()
}

function handleVisibilityChange() {
  if (document.visibilityState !== 'visible' || !LIVE.active) return
  // 回到可见立即补拉一次：后台标签页的 SSE 可能被节流，断线提示也可能还没触发。
  if (LIVE.reconnectTimer) {
    clearReconnectTimer()
    LIVE.reconnectAttempt = 0
    void reconnectStream()
    return
  }
  if (!LIVE.stream || LIVE.stream.readyState === 2) {
    void reconnectStream()
    return
  }
  void refreshMessages()
}

/** 配对成功后进入：有房间去房间，没房间先去建 Bot。 */
async function enterLiveRoom(token) {
  if (typeof token === 'string' && token !== '') {
    sessionToken = token
    writeSessionToken(token)
  }
  LIVE.token = sessionToken || ''
  let rooms = await ensureRoom()
  STORE.rooms = rooms
  STORE.roomsLoaded = true
  LIVE.active = true
  startNeedsPolling()
  renderSidebarRooms()
  let bots = []
  try {
    bots = await loadBots()
  } catch {
    // 侧栏空着也比假装有 Bot 好。
  }
  // 首次进入空 workspace：自动创建一个主 Bot，Bot API 会同时建好它的私聊 DM。
  // 这样用户进来是可直接说话的主 Bot，而不是空列表 / 新建表单。
  if (bots.length === 0) {
    try {
      const workspaceId = await ensureWorkspaceId()
      await api.post('/api/bots', {
        workspaceId,
        name: '主 Bot',
        role: '主理人',
        model: 'deepseek-flash',
      })
      bots = await loadBots({ force: true })
    } catch {
      // 创建失败仍走普通空列表兜底，不把用户卡在空白页。
    }
  }
  rooms = await ensureRoom()
  STORE.rooms = rooms
  renderSidebarRooms()
  // 启动沙箱可能耗时；不要让它阻塞进入房间，消息会落在控制面等 room-agent 起来。
  void ensureRuntimeStarted()
  const note = $('#pair-note')
  if (note) note.hidden = true
  const lastRoom = readLastRoom()
  const mainDm = rooms.find((room) => room.dm === true && (room.members || []).some((member) => member.botId === bots[0]?.id))
  const target =
    pendingRoute || lastRoom || (mainDm ? `#/rooms/${encodeURIComponent(mainDm.id)}` : rooms.length > 0 ? `#/rooms/${encodeURIComponent(rooms[0].id)}` : '#/bots')
  pendingRoute = ''
  if (rooms.length === 0) flash('还没有房间：先建一个 Bot，再开始对话。')
  navigate(target)
}

// ---------------------------------------------------------------------------
// 七、输入区：谁会回答、@ 菜单、发送
// ---------------------------------------------------------------------------

function syncSend() {
  const input = $('#composer')
  const send = $('#send')
  const files = $('#composer-files')
  if (!input || !send) return
  const hasFile = Boolean(files && !files.hidden && files.childElementCount > 0)
  send.disabled = input.disabled || (input.value.trim() === '' && !hasFile)
}

function growComposer() {
  const input = $('#composer')
  if (!input) return
  // 原来固定在 160px，长消息只能在小框里滚动；放宽到 40vh（桌面最多 320px）。
  const viewportCap = typeof window === 'undefined' ? 320 : Math.round(window.innerHeight * 0.4)
  const maxHeight = Math.max(160, Math.min(320, viewportCap))
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`
}

function setComposerEnabled(enabled, placeholder) {
  const input = $('#composer')
  const send = $('#send')
  if (!input || !send) return
  input.disabled = !enabled
  input.placeholder = placeholder || '发一条消息'
  if (!enabled) {
    send.disabled = true
    send.title = '房间还没载入'
  } else {
    send.title = '⌘↵ / Ctrl+↵ 发送'
    syncSend()
  }
}

function showComposerError(message) {
  const node = $('#composer-error')
  if (!node) return
  node.textContent = message
  node.hidden = false
  ui.setFieldInvalid($('#composer'), true, node)
}

function clearComposerError() {
  const node = $('#composer-error')
  if (!node) return
  node.textContent = ''
  node.hidden = true
  ui.setFieldInvalid($('#composer'), false, node)
}

const mentionState = {
  open: false,
  index: 0,
  items: [],
  mention: null,
  signature: '',
}

function closeMentionMenu() {
  const menu = $('#mention-menu')
  const input = $('#composer')
  mentionState.open = false
  mentionState.index = 0
  mentionState.items = []
  mentionState.mention = null
  mentionState.signature = ''
  if (menu) {
    menu.hidden = true
    menu.replaceChildren()
  }
  if (input) {
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }
}

function mentionMembers() {
  const room = LIVE.active ? LIVE.room : PREVIEW_ROOM
  return roomMembers(room).map((member) => ({
    botId: member.botId,
    name: member.name || botLabel(member.botId),
    role: botIdentity(member.botId).role,
  }))
}

function setupMentionMenu() {
  const input = $('#composer')
  const menu = $('#mention-menu')
  if (!input || !menu) return

  const pick = (item) => {
    const result = insertMention(input.value, mentionState.mention, item.name)
    input.value = result.text
    input.setSelectionRange(result.caret, result.caret)
    closeMentionMenu()
    syncSend()
    growComposer()
    input.focus()
  }

  const render = (mention) => {
    const items = mention.matches.slice(0, 8).map((member) => ({
      ...member,
      role: botIdentity(member.botId).role,
    }))
    if (items.length === 0) {
      closeMentionMenu()
      return
    }
    mentionState.open = true
    mentionState.items = items
    mentionState.mention = mention
    if (mentionState.index >= items.length) mentionState.index = 0
    menu.replaceChildren()
    items.forEach((item, index) => {
      const button = el('button', {
        class: `mention-item${index === mentionState.index ? ' is-active' : ''}`,
        type: 'button',
        role: 'option',
        id: `mention-option-${index}`,
        'aria-selected': String(index === mentionState.index),
      })
      button.append(avatar(item.botId, 20))
      const text = el('span', { class: 'mention-text' })
      text.append(el('span', { class: 'mention-name', text: item.name }))
      if (item.role) text.append(el('span', { class: 'mention-role', text: item.role }))
      button.append(text)
      button.addEventListener('click', () => pick(item))
      menu.append(button)
    })
    menu.hidden = false
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', 'mention-menu')
    input.setAttribute('aria-activedescendant', `mention-option-${mentionState.index}`)
  }

  const update = () => {
    if (input.disabled) {
      closeMentionMenu()
      return
    }
    const mention = parseMentionQuery(input.value, mentionMembers())
    if (!mention || mention.matches.length === 0) {
      closeMentionMenu()
      return
    }
    const signature = `${mention.query}|${mention.matches.map((member) => member.botId || member.name).join(',')}`
    if (mentionState.open && mentionState.signature === signature) return
    mentionState.signature = signature
    mentionState.index = 0
    render(mention)
  }

  input.addEventListener('input', update)
  input.addEventListener('click', update)
  input.addEventListener('keydown', (event) => {
    if (!mentionState.open) return
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const total = mentionState.items.length
      if (total === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      mentionState.index = (mentionState.index + delta + total) % total
      render(mentionState.mention)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = mentionState.items[mentionState.index]
      if (item) pick(item)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMentionMenu()
      return
    }
    if (event.key === 'Tab') closeMentionMenu()
  })
  // 点菜单项时不要先让输入框失焦。
  menu.addEventListener('mousedown', (event) => event.preventDefault())
  document.addEventListener('click', (event) => {
    if (!mentionState.open) return
    if (menu.contains(event.target) || event.target === input) return
    closeMentionMenu()
  })
}

/** 「需要你」抽屉：焦点移入/归位、Esc 关闭（沿用 v0 的实现）。 */
function setupNeedsPanel() {
  const panel = $('#needs')
  const buttons = [$('#needs-btn'), $('#needs-btn-sm')]
  if (!panel) return
  let lastFocus = null

  const setOpen = (open, opener) => {
    if (open) {
      lastFocus = opener || document.activeElement
      panel.hidden = false
      for (const button of buttons) if (button) button.setAttribute('aria-expanded', 'true')
      // 打开后把焦点放进抽屉（关闭按钮；没有就落在对话框容器上）。
      const closeButton = $('#needs-close')
      ;(closeButton || panel).focus()
      return
    }
    panel.hidden = true
    for (const button of buttons) if (button) button.setAttribute('aria-expanded', 'false')
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
  }

  for (const button of buttons) {
    if (!button) continue
    button.addEventListener('click', () => {
      // 连上控制面后抽屉不再展示样例，直接去真实审批页。
      if (LIVE.active) {
        navigate('#/approvals')
        return
      }
      setOpen(panel.hidden, button)
    })
  }
  const close = $('#needs-close')
  if (close) close.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (event) => {
    if (panel.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    ui.trapTabKey(event, panel)
  })
}

/** 窄屏侧栏抽屉（≤720px，纯 CSS 控制显隐）：顶栏按钮开合、遮罩点击关闭、Esc 关闭。 */
function setupSidebarDrawer() {
  const room = $('#room-view')
  const toggle = $('#sidebar-toggle')
  const scrim = $('#sidebar-scrim')
  const sidebar = $('#sidebar')
  if (!room || !toggle) return
  let lastFocus = null
  const isOpen = () => room.classList.contains('sidebar-open')
  // 抽屉关着时不可聚焦，否则键盘会 Tab 进看不见的导航。
  if (sidebar) sidebar.inert = true

  const setOpen = (open, opener) => {
    room.classList.toggle('sidebar-open', open)
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    toggle.setAttribute('aria-label', open ? '收起导航' : '展开导航')
    if (sidebar) sidebar.inert = !open
    if (scrim) scrim.hidden = !open
    if (open) {
      lastFocus = opener || document.activeElement
      const first = ui.focusableElements(sidebar)[0]
      if (first) first.focus()
      else if (sidebar) sidebar.focus()
      return
    }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
  }

  toggle.addEventListener('click', () => setOpen(!isOpen(), toggle))
  if (scrim) scrim.addEventListener('click', () => setOpen(false))
  if (sidebar) {
    // 点侧栏里的链接就关掉抽屉，别挡着刚打开的房间/设置页。
    sidebar.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) setOpen(false)
    })
  }
  document.addEventListener('keydown', (event) => {
    if (!isOpen()) return
    // 「需要你」抽屉叠在侧栏上时，焦点陷阱由它接管。
    const needs = $('#needs')
    if (needs && !needs.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    ui.trapTabKey(event, sidebar)
  })
  window.addEventListener('resize', () => {
    if (window.innerWidth > 720 && isOpen()) setOpen(false)
  })
}

/** 跳过导航直接到主内容；不能走 hash，否则会触发路由把页面切走。 */
function setupSkipLinks() {
  for (const link of document.querySelectorAll('.skip-link')) {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      const id = (link.getAttribute('href') || '').replace(/^#/, '')
      const target = id === '' ? null : document.getElementById(id)
      if (!target) return
      target.focus()
      target.scrollIntoView({ block: 'start' })
    })
  }
}

function setupImageViewer() {
  const close = $('#image-viewer-close')
  const share = $('#image-share')
  const save = $('#image-save')
  const detail = $('#image-detail')
  if (close) close.addEventListener('click', closeImageViewer)
  if (share) {
    share.addEventListener('click', async () => {
      const viewer = $('#image-viewer')
      const url = viewer?.dataset.src || location.href
      const title = viewer?.dataset.title || '图片'
      if (navigator.share) {
        try {
          await navigator.share({ title, url })
          return
        } catch {
          // 用户取消或浏览器拒绝时退回复制链接。
        }
      }
      try {
        await navigator.clipboard.writeText(url)
        share.textContent = '已复制'
      } catch {
        share.textContent = '无法分享'
      }
    })
  }
  if (save) {
    save.addEventListener('click', () => {
      const url = $('#image-viewer')?.dataset.src
      if (!url) return
      const link = document.createElement('a')
      link.href = url
      link.download = $('#image-viewer')?.dataset.title || 'image'
      link.click()
    })
  }
  if (detail) {
    detail.addEventListener('click', () => {
      const node = $('#image-detail-text')
      if (node) node.hidden = !node.hidden
    })
  }
}

function setupComposer() {
  const form = $('#composer-form')
  const input = $('#composer')
  const send = $('#send')
  if (!form || !input || !send) return

  input.addEventListener('input', () => {
    clearComposerError()
    syncSend()
    growComposer()
  })
  input.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  const plus = $('#composer-plus')
  const file = $('#composer-file')
  const mic = $('#composer-mic')
  const pendingFiles = []
  if (plus && file) {
    plus.addEventListener('click', () => file.click())
    file.addEventListener('change', async () => {
      const chosen = file.files && file.files[0]
      file.value = ''
      if (!chosen || !LIVE.active || !LIVE.roomId) return
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(LIVE.roomId)}/artifacts`, {
          method: 'POST',
          headers: {
            authorization: LIVE.token ? `Bearer ${LIVE.token}` : '',
            'content-type': chosen.type || 'application/octet-stream',
            'x-artifact-name': chosen.name || 'image',
          },
          body: chosen,
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload?.error?.message || '上传失败')
        pendingFiles.push(payload.artifactId)
        const chips = $('#composer-files')
        if (chips) {
          chips.hidden = false
          chips.append(el('span', { text: chosen.name || '图片' }))
        }
        syncSend()
      } catch (error) {
        showComposerError(error instanceof Error ? error.message : '上传失败')
      }
    })
  }
  if (mic) {
    mic.addEventListener('click', () => {
      const Speech = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!Speech) {
        showComposerError('这台浏览器没有语音输入')
        return
      }
      const recognition = new Speech()
      recognition.lang = 'zh-CN'
      recognition.onresult = (event) => {
        const said = event.results?.[0]?.[0]?.transcript
        if (typeof said === 'string' && said !== '') input.value = `${input.value} ${said}`.trim()
      }
      recognition.start()
    })
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if ((!text && pendingFiles.length === 0) || input.disabled) return
    clearComposerError()

    if (LIVE.active && LIVE.roomId) {
      input.value = ''
      syncSend()
      growComposer()
      input.focus()
      try {
        const posted = await api.post(`/api/rooms/${encodeURIComponent(LIVE.roomId)}/messages`, {
          text,
          ...(pendingFiles.length > 0 ? { artifactIds: pendingFiles.splice(0, pendingFiles.length) } : {}),
          idem: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })
        const chips = $('#composer-files')
        if (chips) {
          chips.replaceChildren()
          chips.hidden = true
        }
        if (posted && posted.message) appendLiveEvent(posted.message)
        else await refreshMessages()
        LIVE.pendingReply = true
        LIVE.pendingReplyBotId = LIVE.room?.responder?.botId || LIVE.room?.hostBotId || ''
        renderWorking()
        watchRound(LIVE.roomId)
      } catch (error) {
        if (isAuthError(error)) {
          requirePair()
          return
        }
        showComposerError(`发送失败：${error instanceof Error ? error.message : String(error)}`)
        // 没发出去就把文字还给用户，别让它凭空消失。
        if (input.value === '') input.value = text
        syncSend()
        growComposer()
      }
      return
    }

    input.value = ''
    syncSend()
    growComposer()
    input.focus()
    appendUserMessage(text)
  })

  syncSend()
}

function appendUserMessage(text) {
  const list = $('#messages')
  if (!list) return
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const placeholder = list.querySelector('.messages-empty')
  if (placeholder) placeholder.remove()
  list.append(renderUserMessage(text))
  if (nearBottom) list.scrollTop = list.scrollHeight
}

// ---------------------------------------------------------------------------
// 八、启动
// ---------------------------------------------------------------------------

function boot() {
  if (window.__roostBooted) return
  window.__roostBooted = true
  const warning = $('#boot-warning')
  if (warning) warning.hidden = true

  renderSidebarBots()
  renderSidebarRooms()
  renderNeeds()
  setupPairing()
  const pageBack = $('#page-back')
  if (pageBack) {
    // href 在渲染时可能还没拿到房间；点击时按当前状态再决定一次，保证「← 房间」不会回到配对页。
    pageBack.addEventListener('click', (event) => {
      event.preventDefault()
      location.hash = roomBackHash()
    })
  }
  setupNeedsPanel()
  setupSidebarDrawer()
  setupSkipLinks()
  setupComposer()
  setupImageViewer()
  setupRoomMenu()
  setupMentionMenu()
  window.addEventListener('hashchange', () => {
    void renderRoute().then(() => {
      updatePageBackLink()
    })
  })
  // 离线/回到前台时显式补拉；页面卸载时清掉定时器与 EventSource。
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', () => {
    stopStream()
    stopNeedsPolling()
    resetAttachmentUrls()
  })
  // 从往返缓存恢复时 pagehide 已经关过流，这里补一次重连与待审批轮询。
  window.addEventListener('pageshow', () => {
    if (!LIVE.active) return
    startNeedsPolling()
    if (LIVE.stream || LIVE.reconnectTimer) return
    LIVE.reconnectAttempt = 0
    void reconnectStream()
  })
  const hash = location.hash
  const authHash = hash === '' || hash === '#/' || hash === '#/login'
  if (sessionToken && authHash) {
    // 重新打开/刷新手机网页：直接回到上次的房间，不先闪一下登录页。
    enterLiveRoom().catch(() => {
      void renderRoute()
    })
    return
  }
  void renderRoute()
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
}

// 供离线自检用；lib/glyph.js 是唯一实现，这里保持旧导出名不变。
export { hashId, specFor, glyphSvg, GLYPH_FAMILIES, PALETTES }
export { birdSvg, birdSpecFor, BIRD_SPECIES, BIRD_PALETTES, BIRD_STATES } from './lib/bird.js'
