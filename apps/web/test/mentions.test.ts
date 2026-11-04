import assert from 'node:assert/strict'
import { test } from 'node:test'

import { insertMention, memberNameConflict, parseMentionQuery } from '../lib/mentions.js'

const members = [
  { botId: 'chief', role: 'host', name: 'Chief' },
  { botId: 'data', role: 'member', name: '数据官' },
  { botId: 'data2', role: 'member', name: '数据官2' },
  { botId: 'selector', role: 'member', name: '选股师' },
]

test('行尾的 @ 弹出全部成员', () => {
  const query = parseMentionQuery('@', members)
  assert.equal(query.active, true)
  assert.equal(query.query, '')
  assert.equal(query.start, 0)
  assert.equal(query.matches.length, 4)
})

test('前缀匹配列出候选（数据 → 数据官 / 数据官2）', () => {
  const query = parseMentionQuery('盘前 @数据', members)
  assert.equal(query.query, '数据')
  assert.equal(query.start, 3)
  assert.deepEqual(query.matches.map((m) => m.name), ['数据官', '数据官2'])
  assert.equal(query.exact, false)
})

test('中文名前缀歧义：@数据官 不匹配 @数据官2', () => {
  const query = parseMentionQuery('@数据官', members)
  assert.deepEqual(query.matches.map((m) => m.name), ['数据官'])
  assert.equal(query.exact, true)
})

test('@数据官2 只匹配它自己', () => {
  const query = parseMentionQuery('@数据官2', members)
  assert.deepEqual(query.matches.map((m) => m.name), ['数据官2'])
})

test('拉丁名按大小写不敏感匹配', () => {
  const query = parseMentionQuery('@chi', members)
  assert.deepEqual(query.matches.map((m) => m.name), ['Chief'])
  assert.equal(parseMentionQuery('@CHIEF', members).exact, true)
})

test('邮箱与提及后的空白不触发菜单', () => {
  assert.equal(parseMentionQuery('foo@bar', members), null)
  assert.equal(parseMentionQuery('@数据官 你好', members), null)
  assert.equal(parseMentionQuery('没有 at 符号', members), null)
  assert.equal(parseMentionQuery('', members), null)
})

test('空白（含换行）后的 @ 也算提及', () => {
  assert.equal(parseMentionQuery('第一行\n@选', members).query, '选')
  assert.equal(parseMentionQuery('第一行\n@选', members).matches[0].name, '选股师')
})

test('没有名字的成员不进候选', () => {
  const query = parseMentionQuery('@', [null, {}, { botId: 'x' }, { botId: 'y', name: '  ' }, { botId: 'z', name: '甲' }])
  assert.deepEqual(query.matches.map((m) => m.name), ['甲'])
})

test('insertMention 替换查询片段并补一个空格', () => {
  const text = '盘前 @数据 看看'
  const query = parseMentionQuery(text, members)
  assert.equal(query, null) // 完整提及后已不处于输入态
  const typing = '盘前 @数据'
  const mention = parseMentionQuery(typing, members)
  const result = insertMention(typing, mention, '数据官')
  assert.equal(result.text, '盘前 @数据官 ')
  assert.equal(result.caret, result.text.length)
})

test('insertMention 在已有空白时不重复加空格', () => {
  const mention = { start: 0, end: 2 }
  const result = insertMention('@数 后续', mention, '数据官')
  assert.equal(result.text, '数据官 后续'.replace(/^/, '@'))
  assert.equal(result.caret, '@数据官 '.length)
})

test('insertMention 空名字不改文本', () => {
  assert.deepEqual(insertMention('abc', { start: 0, end: 1 }, '  '), { text: 'abc', caret: 3 })
})

test('名字冲突：完全同名（去空白、忽略大小写）才算', () => {
  assert.equal(memberNameConflict(' 选股师 ', members).botId, 'selector')
  assert.equal(memberNameConflict('chief', members).botId, 'chief')
  assert.equal(memberNameConflict('数据官', members).botId, 'data')
  assert.equal(memberNameConflict('数据官2', members).botId, 'data2')
})

test('名字冲突不做前缀判定：数据官3 不冲突', () => {
  assert.equal(memberNameConflict('数据官3', members), null)
  assert.equal(memberNameConflict('数据', members), null)
  assert.equal(memberNameConflict('', members), null)
  assert.equal(memberNameConflict('   ', members), null)
})
