import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyPlugin, tierLabel } from '../src/index.ts'

const ctx = { platform: 'cloud' as const, availableBinaries: ['node'], availableDataMounts: ['news'] }

test('纯 host 插件 = A 级', () => {
  const result = classifyPlugin({ tools: 3, skills: 5 }, ctx)
  assert.equal(result.tier, 'A')
  assert.deepEqual(result.reasons, [])
})

test('需要网络/凭据/磁盘 = B 级，且列出缺口', () => {
  const result = classifyPlugin(
    { tools: 12, network: ['api.tushare.pro'], credentials: ['tushare'], diskBytes: 320_000_000, binaries: ['python3'], dataMounts: ['bars'] },
    ctx
  )
  assert.equal(result.tier, 'B')
  assert.deepEqual(result.requires.network, ['api.tushare.pro'])
  assert.deepEqual(result.requires.binaries, ['python3'])
  assert.deepEqual(result.requires.dataMounts, ['bars'])
  assert.ok(result.reasons.length >= 4)
})

test('已有二进制/数据面不算缺口', () => {
  const result = classifyPlugin({ binaries: ['node'], dataMounts: ['news'] }, ctx)
  assert.equal(result.tier, 'A')
})

test('client 半：云端 C 级，桌面 B 级', () => {
  assert.equal(classifyPlugin({ panels: 2, clientHalf: true }, ctx).tier, 'C')
  assert.equal(classifyPlugin({ panels: 2, clientHalf: true }, { platform: 'desktop' }).tier, 'B')
})

test('桌面专有 = D 级', () => {
  const result = classifyPlugin({ desktopOnly: true, panels: 1 }, ctx)
  assert.equal(result.tier, 'D')
  assert.equal(tierLabel(result.tier), '仅桌面')
})
