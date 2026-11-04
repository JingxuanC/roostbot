// @ 提及相关的纯逻辑（docs/design/ui.md §3.12、rooms.md §4）。
// 中文名按前缀匹配时必须做消歧：输入了完整的「数据官」就只匹配「数据官」，
// 不再把「数据官2」列进来（后者是另一个成员）。

function normalizeMembers(members) {
  if (!Array.isArray(members)) return []
  const seen = new Set()
  const list = []
  for (const member of members) {
    if (!member || typeof member !== 'object') continue
    const name = typeof member.name === 'string' ? member.name.trim() : ''
    if (name === '') continue
    const botId = typeof member.botId === 'string' ? member.botId : typeof member.id === 'string' ? member.id : ''
    const key = botId !== '' ? botId : name
    if (seen.has(key)) continue
    seen.add(key)
    list.push({
      botId,
      name,
      role: typeof member.role === 'string' ? member.role : '',
    })
  }
  return list
}

/**
 * 解析输入框末尾正在输入的 @ 查询。
 * 只有「行首或空白后的 @」才算提及（`foo@bar` 是邮箱，不弹菜单），
 * 且 @ 之后到文本结尾不能有空白（有空白说明这个提及已经写完了）。
 *
 * @param {string} text 输入框全文
 * @param {Array<{botId?: string, id?: string, name?: string, role?: string}>} members
 * @returns {null | {active: true, query: string, start: number, end: number, matches: Array, exact: boolean}}
 */
export function parseMentionQuery(text, members) {
  const source = String(text ?? '')
  const tail = /(^|[\s\u3000])@([^\s@]*)$/.exec(source)
  if (tail === null) return null
  const query = tail[2] ?? ''
  const start = source.length - query.length - 1
  const list = normalizeMembers(members)
  const lower = query.toLowerCase()
  let matches = lower === '' ? list : list.filter((member) => member.name.toLowerCase().startsWith(lower))
  const exactMatches = lower === '' ? [] : list.filter((member) => member.name.toLowerCase() === lower)
  // 完整名字优先：@数据官 不再匹配 @数据官2。
  const exact = exactMatches.length > 0
  if (exact) matches = exactMatches
  return { active: true, query, start, end: source.length, matches, exact }
}

/**
 * 把选中的成员插入输入框，替换正在输入的 @ 片段。
 * @returns {{text: string, caret: number}}
 */
export function insertMention(text, mention, name) {
  const source = String(text ?? '')
  const cleanName = String(name ?? '').trim()
  if (cleanName === '') return { text: source, caret: source.length }
  const start = Math.min(Math.max(Number.isInteger(mention?.start) ? mention.start : source.length, 0), source.length)
  const end = Math.min(Math.max(Number.isInteger(mention?.end) ? mention.end : source.length, start), source.length)
  const before = source.slice(0, start)
  const rest = source.slice(end)
  const gap = /^[ \t]*/.exec(rest)?.[0] ?? ''
  const inserted = `@${cleanName}${gap === '' && !/^\s/.test(rest) ? ' ' : ''}`
  const next = `${before}${inserted}${rest}`
  const caret = Math.min(before.length + inserted.length + gap.length, next.length)
  return { text: next, caret }
}

/**
 * 名字冲突：忽略首尾空白与大小写后完全相同才算冲突。
 * 刻意不做前缀判断 —— 「数据官」和「数据官2」是两个合法的不同名字。
 * @returns {null | object} 冲突的成员；没有冲突返回 null
 */
export function memberNameConflict(name, members) {
  const wanted = String(name ?? '').trim().toLowerCase()
  if (wanted === '') return null
  for (const member of normalizeMembers(members)) {
    if (member.name.toLowerCase() === wanted) return member
  }
  return null
}
