// Profile 锁文档：构造、内容寻址、完整性校验（TODO 4.3.4）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROFILE_LOCK_KIND,
  PROFILE_LOCK_VERSION,
  buildProfileLock,
  lockIdFor,
  profileLockIntegrity,
  verifyProfileLock
} from '../src/profile-lock.ts'

const PACKAGE_JSON = '{\n  "name": "roostbot-runtime-profile"\n}\n'
const PATCH = '[]\n'

function build(generatedAt: number, overrides: { packageJson?: string; patch?: string; lockfile?: string | null } = {}) {
  return buildProfileLock({
    source: 'baseline-profile',
    packageJson: overrides.packageJson ?? PACKAGE_JSON,
    patch: overrides.patch ?? PATCH,
    lockfile: overrides.lockfile ?? null,
    generatedAt
  })
}

test('锁文档含 package.json 原文、patch 行与内容寻址的 id', () => {
  const lock = build(1_760_000_000_000)
  assert.equal(lock.kind, PROFILE_LOCK_KIND)
  assert.equal(lock.version, PROFILE_LOCK_VERSION)
  assert.equal(lock.source, 'baseline-profile')
  assert.equal(lock.packageJson, PACKAGE_JSON)
  assert.equal(lock.patch, PATCH)
  assert.equal(lock.lockfile, null)
  assert.match(lock.integrity, /^[0-9a-f]{64}$/)
  assert.equal(lock.id, lockIdFor(lock.integrity))
  assert.equal(lock.generatedAt, 1_760_000_000_000)
})

test('integrity 与 generatedAt 无关（同内容任何时候拉都是同一把锁）', () => {
  assert.equal(build(1).integrity, build(2).integrity)
  assert.equal(build(1).id, build(2).id)
})

test('packageJson / patch / lockfile 任一变化都会改变 integrity', () => {
  const base = build(1)
  assert.notEqual(build(1, { packageJson: PACKAGE_JSON + ' ' }).integrity, base.integrity)
  assert.notEqual(build(1, { patch: '- op: add\n' }).integrity, base.integrity)
  assert.notEqual(build(1, { lockfile: 'lockfileVersion: 1\n' }).integrity, base.integrity)
  assert.equal(
    build(1, { lockfile: 'lockfileVersion: 1\n' }).integrity,
    profileLockIntegrity({ packageJson: PACKAGE_JSON, patch: PATCH, lockfile: 'lockfileVersion: 1\n' })
  )
})

test('verifyProfileLock：JSON 往返后仍通过；篡改任一字段即拒绝', () => {
  const lock = build(1_760_000_000_000)
  const roundTripped: unknown = JSON.parse(JSON.stringify(lock))
  assert.equal(verifyProfileLock(roundTripped), true)

  assert.equal(verifyProfileLock({ ...lock, packageJson: '{"name":"evil"}' }), false)
  assert.equal(verifyProfileLock({ ...lock, id: 'lock-000000000000' }), false)

  const bad: unknown[] = [
    null,
    'lock',
    { ...lock, kind: 'other' },
    { ...lock, version: 2 },
    { ...lock, integrity: 'not-hex' },
    { ...lock, lockfile: 42 },
    { ...lock, generatedAt: 'now' }
  ]
  for (const doc of bad) assert.equal(verifyProfileLock(doc), false, JSON.stringify(doc))
})
