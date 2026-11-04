// claim 抽取：falsifier 硬门槛、置信度夹紧、每日配额、去重、JSON / 竖线行两种格式。
// 纯函数，不建 store，不碰 DB。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLAIM_DAILY_CAP,
  CLAIM_DEFAULT_CONFIDENCE,
  ClaimError,
  EMPTY_FALSIFIERS,
  extractClaims,
  isFalsifiable,
} from '../src/claims.ts'

const NOW = Date.UTC(2026, 10, 4, 1, 0, 0)
const LONG_FALSIFIER = '若流动性分组后 IC 差 < 0.01 则推翻'

function line(subject: string, predicate: string, object: string, falsifier = LONG_FALSIFIER, confidence?: string): string {
  const tail = confidence === undefined ? '' : ` | ${confidence}`
  return `${subject} | ${predicate} | ${object} | ${falsifier}${tail}`
}

test('空文本 / 只有注释：没有 claim，也没有拒绝', () => {
  assert.deepEqual(extractClaims({ text: '', now: NOW }), { claims: [], rejected: [] })
  assert.deepEqual(extractClaims({ text: '   \n  \n', now: NOW }), { claims: [], rejected: [] })
  assert.deepEqual(extractClaims({ text: '# 今天没有新结论', now: NOW }), { claims: [], rejected: [] })
})

test('竖线行解析：字段完整、at=now、sourceQuote 是原行、confidence 默认 0.5', () => {
  const result = extractClaims({
    text: `- ${line('5 日反转因子', '在流动性后 30% 的样本里更强', '全样本不显著')}`,
    now: NOW,
  })
  assert.equal(result.rejected.length, 0)
  assert.equal(result.claims.length, 1)
  const claim = result.claims[0]!
  assert.deepEqual(claim, {
    subject: '5 日反转因子',
    predicate: '在流动性后 30% 的样本里更强',
    object: '全样本不显著',
    falsifier: LONG_FALSIFIER,
    confidence: CLAIM_DEFAULT_CONFIDENCE,
    sourceQuote: line('5 日反转因子', '在流动性后 30% 的样本里更强', '全样本不显著'),
    at: NOW,
  })
})

test('falsifier 太短（去空白后 < 10）→ falsifier_missing', () => {
  const result = extractClaims({ text: line('a', 'b', 'c', '若 IC 下降则推翻'), now: NOW })
  assert.equal(result.claims.length, 0)
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['falsifier_missing'])
})

test('falsifier 空话清单逐条拒绝', () => {
  for (const empty of EMPTY_FALSIFIERS) {
    const result = extractClaims({ text: line('a', 'b', 'c', `${empty}。`), now: NOW })
    assert.equal(result.claims.length, 0, `"${empty}" 不应通过`)
    assert.equal(result.rejected[0]!.reason, 'falsifier_missing')
  }
  assert.equal(isFalsifiable('无法证伪'), false)
  assert.equal(isFalsifiable(LONG_FALSIFIER), true)
})

test('falsifier 边界：去空白后正好 10 字符通过、9 字符拒绝', () => {
  const ten = '1 2 3 4 5 6 7 8 9 0'
  const nine = '1 2 3 4 5 6 7 8 9'
  assert.equal(extractClaims({ text: line('a', 'b', 'c', ten), now: NOW }).claims.length, 1)
  assert.equal(extractClaims({ text: line('a', 'b', 'c', nine), now: NOW }).claims.length, 0)
})

test('confidence 夹在 0..1；字符串可解析；非法值回落到默认', () => {
  const result = extractClaims({
    text: [
      line('a1', 'p', 'o', LONG_FALSIFIER, '2'),
      line('a2', 'p', 'o', LONG_FALSIFIER, '-1'),
      line('a3', 'p', 'o', LONG_FALSIFIER, '0.4'),
      line('a4', 'p', 'o', LONG_FALSIFIER, 'nope'),
    ].join('\n'),
    now: NOW,
  })
  assert.deepEqual(result.claims.map((claim) => claim.confidence), [1, 0, 0.4, CLAIM_DEFAULT_CONFIDENCE])
})

test('dailyCap 之外的 claim 进 rejected(daily_cap)，配额内按输入顺序保留', () => {
  const result = extractClaims({
    text: [line('a1', 'p', 'o'), line('a2', 'p', 'o'), line('a3', 'p', 'o')].join('\n'),
    now: NOW,
    dailyCap: 2,
  })
  assert.deepEqual(result.claims.map((claim) => claim.subject), ['a1', 'a2'])
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['daily_cap'])
  assert.equal(result.rejected[0]!.line, 3)
})

test('alreadyToday 计数挤占配额；已达上限时全部拒绝', () => {
  const text = [line('a1', 'p', 'o'), line('a2', 'p', 'o')].join('\n')
  const half = extractClaims({ text, now: NOW, dailyCap: 2, alreadyToday: 1 })
  assert.deepEqual(half.claims.map((claim) => claim.subject), ['a1'])
  assert.deepEqual(half.rejected.map((entry) => entry.reason), ['daily_cap'])

  const full = extractClaims({ text, now: NOW, dailyCap: 2, alreadyToday: 2 })
  assert.equal(full.claims.length, 0)
  assert.deepEqual(full.rejected.map((entry) => entry.reason), ['daily_cap', 'daily_cap'])
})

test('同文本去重：重复进 rejected(duplicate)，且不占用配额', () => {
  const text = [line('a', 'p', 'o'), line('a', 'p', 'o'), line('b', 'p', 'o')].join('\n')
  const result = extractClaims({ text, now: NOW, dailyCap: 2 })
  assert.deepEqual(result.claims.map((claim) => claim.subject), ['a', 'b'])
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['duplicate'])
})

test('alreadyToday 传文本数组：既计数又去重', () => {
  const result = extractClaims({
    text: [line('a', 'p', 'o'), line('b', 'p', 'o')].join('\n'),
    now: NOW,
    dailyCap: 3,
    alreadyToday: ['a p o'],
  })
  assert.deepEqual(result.claims.map((claim) => claim.subject), ['b'])
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['duplicate'])
})

test('JSON 数组输入与 sourceQuote 覆写', () => {
  const result = extractClaims({
    text: JSON.stringify([
      {
        subject: '盘前槽位',
        predicate: '不能用',
        object: '当天收盘 K 线',
        falsifier: '若 09:15 前能拿到当日收盘价则推翻',
        confidence: 0.95,
        sourceQuote: '盘前槽位不能用当天收盘 K 线（约束）',
      },
    ]),
    now: NOW,
  })
  assert.equal(result.claims.length, 1)
  assert.equal(result.claims[0]!.confidence, 0.95)
  assert.equal(result.claims[0]!.sourceQuote, '盘前槽位不能用当天收盘 K 线（约束）')
  assert.equal(result.rejected.length, 0)
})

test('```json 围栏与 {"claims":[...]} 形状都能解析', () => {
  const entry = {
    subject: 'a',
    predicate: 'p',
    object: 'o',
    falsifier: LONG_FALSIFIER,
    confidence: 0.5,
  }
  const fenced = extractClaims({
    text: '```json\n' + JSON.stringify([entry]) + '\n```',
    now: NOW,
  })
  assert.equal(fenced.claims.length, 1)

  const wrapped = extractClaims({ text: JSON.stringify({ claims: [entry] }), now: NOW })
  assert.equal(wrapped.claims.length, 1)
  assert.equal(wrapped.rejected.length, 0)
})

test('坏 JSON / 缺字段 / 字段不够的行都进 malformed', () => {
  assert.deepEqual(
    extractClaims({ text: '[{"subject":', now: NOW }).rejected.map((entry) => entry.reason),
    ['malformed'],
  )
  assert.deepEqual(
    extractClaims({ text: JSON.stringify({ notClaims: [] }), now: NOW }).rejected.map((entry) => entry.reason),
    ['malformed'],
  )
  const missingObject = extractClaims({
    text: JSON.stringify([{ subject: 'a', predicate: 'p' }]),
    now: NOW,
  })
  assert.equal(missingObject.claims.length, 0)
  assert.deepEqual(missingObject.rejected.map((entry) => entry.reason), ['malformed'])

  const badLines = extractClaims({
    text: ['a | b | c', 'a | b | c | f | 0.5 | extra', ' | b | c | ' + LONG_FALSIFIER].join('\n'),
    now: NOW,
  })
  assert.equal(badLines.claims.length, 0)
  assert.deepEqual(badLines.rejected.map((entry) => entry.reason), ['malformed', 'malformed', 'malformed'])
})

test('一行坏、一行好：好 claim 照常保留，坏行进 rejected', () => {
  const result = extractClaims({
    text: [line('a', 'p', 'o'), 'prose that is not a claim'].join('\n'),
    now: NOW,
  })
  assert.equal(result.claims.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]!.line, 2)
})

test('输入形状非法抛 ClaimError', () => {
  assert.throws(() => extractClaims({ text: 42 as never, now: NOW }), ClaimError)
  assert.throws(() => extractClaims({ text: 'x', now: -1 }), ClaimError)
  assert.throws(() => extractClaims({ text: 'x', now: NOW, dailyCap: -1 }), ClaimError)
  assert.throws(() => extractClaims({ text: 'x', now: NOW, alreadyToday: 'a b' as never }), ClaimError)
  assert.throws(() => extractClaims(null as never), ClaimError)
})

test('默认 dailyCap 是 50（与 store 的 MEMORY_DAILY_LIMIT 对齐）', () => {
  assert.equal(CLAIM_DAILY_CAP, 50)
  const lines = Array.from({ length: 51 }, (_, index) => line(`s${index}`, 'p', 'o'))
  const result = extractClaims({ text: lines.join('\n'), now: NOW })
  assert.equal(result.claims.length, 50)
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['daily_cap'])
})
