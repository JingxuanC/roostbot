// 信任判定：sha512 integrity / 白名单 / 发布时长 / 签名状态。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkReleaseAge,
  isAllowlisted,
  parseAllowlist,
  sha512Integrity,
  signatureState,
  verifyIntegrity,
} from '../src/trust.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

// ---- integrity ---------------------------------------------------------------

test('verifyIntegrity：两份 integrity 逐字节比较；内容也能算', () => {
  const integrity = sha512Integrity('market-center@1.2.0.tgz bytes')
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(verifyIntegrity(integrity, integrity), true)
  // actual 是内容：自己算 sha512
  assert.equal(verifyIntegrity(integrity, 'market-center@1.2.0.tgz bytes'), true)
  assert.equal(verifyIntegrity(integrity, 'tampered bytes'), false)
  // 两份不同的合法 integrity：比较为 false
  const other = sha512Integrity('something else')
  assert.equal(verifyIntegrity(integrity, other), false)
})

test('verifyIntegrity：缺值 / 非 sha512 / 截断一律 false', () => {
  const integrity = sha512Integrity('payload')
  assert.equal(verifyIntegrity(null, integrity), false)
  assert.equal(verifyIntegrity(undefined, integrity), false)
  assert.equal(verifyIntegrity(integrity, null), false)
  assert.equal(verifyIntegrity('', ''), false)
  assert.equal(verifyIntegrity('sha1-abc', integrity), false)
  assert.equal(verifyIntegrity(integrity, 'sha512-'), false)
  // 同一内容不同长度（截断 base64）不通过
  assert.equal(verifyIntegrity(integrity, integrity.slice(0, 40)), false)
  // 空白归一
  assert.equal(verifyIntegrity(`  ${integrity}  `, integrity), true)
})

// ---- 白名单 ------------------------------------------------------------------

test('parseAllowlist：逗号分隔、去空白、小写、保序去重', () => {
  assert.deepEqual(parseAllowlist(' A, b ,, a ,*'), ['a', 'b', '*'])
  assert.deepEqual(parseAllowlist(['market-center', 'market-center', ' pub ']), ['market-center', 'pub'])
  assert.deepEqual(parseAllowlist(''), [])
  assert.deepEqual(parseAllowlist(null), [])
  assert.deepEqual(parseAllowlist(undefined), [])
})

test('isAllowlisted：空白名单 = 拒绝（默认拒绝）', () => {
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: '' }), false)
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: [] }), false)
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: null }), false)
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: undefined }), false)
})

test('isAllowlisted：slug / publisherId / * 三种放行', () => {
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: 'market-center' }), true)
  assert.equal(isAllowlisted({ slug: 'MARKET-CENTER', allowlist: 'market-center' }), true)
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: 'other, market-center' }), true)
  assert.equal(isAllowlisted({ slug: 'market-center', allowlist: 'other' }), false)
  // 发布者维度
  assert.equal(isAllowlisted({ slug: 'whatever', publisherId: 'pub_roost', allowlist: 'pub_roost' }), true)
  assert.equal(isAllowlisted({ slug: 'whatever', publisherId: 'pub_other', allowlist: 'pub_roost' }), false)
  // 显式 *
  assert.equal(isAllowlisted({ slug: 'anything', allowlist: '*' }), true)
  // 空 slug 不匹配任何具体条目（只有 * 能放行）
  assert.equal(isAllowlisted({ slug: '', allowlist: 'market-center' }), false)
  assert.equal(isAllowlisted({ slug: '', allowlist: '*' }), true)
})

// ---- 发布时长 ----------------------------------------------------------------

test('checkReleaseAge：门槛内拒绝、够久放行、<=0 不设门槛', () => {
  const fresh = checkReleaseAge(NOW - 60 * 60 * 1000, DAY, NOW)
  assert.equal(fresh.ok, false)
  assert.ok(fresh.reason !== null)
  assert.match(fresh.reason!, /minimum release age/)
  assert.equal(fresh.ageMs, 60 * 60 * 1000)

  const old = checkReleaseAge(NOW - 2 * DAY, DAY, NOW)
  assert.equal(old.ok, true)
  assert.equal(old.reason, null)

  const noGate = checkReleaseAge(NOW, 0, NOW)
  assert.equal(noGate.ok, true)
  assert.equal(noGate.ageMs, 0)

  // 发布时间缺失：有门槛就不装
  const missing = checkReleaseAge(null, DAY, NOW)
  assert.equal(missing.ok, false)
  assert.equal(missing.ageMs, null)
  assert.match(missing.reason!, /publishedAt is missing/)

  // 没有门槛时缺发布时间不阻断
  assert.equal(checkReleaseAge(undefined, 0, NOW).ok, true)

  // 未来时间（时钟偏差）：age 为负 → 不到门槛
  assert.equal(checkReleaseAge(NOW + DAY, DAY, NOW).ok, false)
})

// ---- 签名 --------------------------------------------------------------------

test('signatureState：sigstore / npm-provenance / none', () => {
  assert.equal(signatureState({ sigstore: true }), 'sigstore')
  assert.equal(signatureState({ sigstore: 'roost' }), 'sigstore')
  assert.equal(signatureState({ sigstoreBundle: { mediaType: 'x' } }), 'sigstore')

  assert.equal(signatureState({ provenance: { predicateType: 'x' } }), 'npm-provenance')
  assert.equal(signatureState({ attestations: [{ url: 'x' }] }), 'npm-provenance')
  assert.equal(signatureState({ dist: { attestations: [{ url: 'x' }] } }), 'npm-provenance')
  assert.equal(signatureState({ signatures: [{ keyid: 'k', sig: 's' }] }), 'npm-provenance')
  assert.equal(signatureState({ dist: { signatures: [{ keyid: 'k', sig: 's' }] } }), 'npm-provenance')

  assert.equal(signatureState({}), 'none')
  assert.equal(signatureState({ dist: {} }), 'none')
  assert.equal(signatureState({ attestations: [] }), 'none')
  assert.equal(signatureState({ sigstore: false }), 'none')
  assert.equal(signatureState(null), 'none')
  assert.equal(signatureState('sigstore'), 'none')
  assert.equal(signatureState(undefined), 'none')
})
