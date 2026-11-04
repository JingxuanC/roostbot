// 日志脱敏与保留计划（M6-6.6）。覆盖 token/key/secret/cookie/password/
// authorization/bearer 七类值，以及按年龄、按总量两种清理路径。

import assert from 'node:assert/strict'
import test from 'node:test'

import { REDACTED, redactLine, retentionPlan, type RetentionFile } from '../src/logs.ts'

const AT = Date.UTC(2026, 10, 4, 12, 0, 0)

test('query 里的 token / access_token 被抹掉，其他参数保留', () => {
  const line = redactLine('GET /api/config?access_token=sekret-access&token=sekret-token&keep=1')
  assert.ok(!line.includes('sekret-access'))
  assert.ok(!line.includes('sekret-token'))
  assert.ok(line.includes('access_token=[REDACTED]'))
  assert.ok(line.includes('token=[REDACTED]'))
  assert.ok(line.includes('keep=1'))
})

test('JSON 的 api_key / 引号值保留 JSON 形态', () => {
  const line = redactLine('{"api_key":"sk-live-123","keep":1}')
  assert.equal(line, '{"api_key":"[REDACTED]","keep":1}')
})

test('Authorization: Bearer 头整体脱敏', () => {
  const line = redactLine('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')
  assert.ok(!line.includes('eyJhbGciOiJIUzI1NiJ9'))
  assert.equal(line, 'Authorization: [REDACTED]')

  const lower = redactLine('authorization: bearer abc123')
  assert.equal(lower, 'authorization: [REDACTED]')

  const json = redactLine('{"authorization":"Bearer abc.def"}')
  assert.equal(json, '{"authorization":"[REDACTED]"}')
})

test('cookie / set-cookie 多段值整体脱敏', () => {
  assert.equal(redactLine('cookie: session=abc; theme=dark'), 'cookie: [REDACTED]')
  assert.equal(redactLine('set-cookie: sid=1; HttpOnly'), 'set-cookie: [REDACTED]')
  assert.equal(redactLine('{"cookie":"a=b; c=d"}'), '{"cookie":"[REDACTED]"}')
})

test('password / secret / client_secret / private_key', () => {
  assert.equal(redactLine('password=hunter2&user=bob'), 'password=[REDACTED]&user=bob')
  assert.equal(redactLine('client_secret: "s3cr3t value"'), 'client_secret: "[REDACTED]"')
  assert.equal(redactLine('private_key=-----BEGIN'), 'private_key=[REDACTED]')
})

test('裸 Bearer 凭据与重复脱敏的幂等性', () => {
  const bare = redactLine('curl -H "Bearer abcdef123456"')
  assert.equal(bare, 'curl -H "Bearer [REDACTED]"')
  assert.ok(!bare.includes('abcdef123456'))

  const once = redactLine('token=abc&password=def')
  assert.equal(redactLine(once), once)
})

test('普通单词 monkey / hockey 不误伤', () => {
  assert.equal(redactLine('monkey=banana'), 'monkey=banana')
  assert.equal(redactLine('hockey=stick'), 'hockey=stick')
  assert.equal(redactLine('path=/api/config?keep=1'), 'path=/api/config?keep=1')
})

test('保留计划：先删过期文件，保留未过期文件', () => {
  const files: RetentionFile[] = [
    { path: '/log/a.log', size: 100, mtime: AT - 10_000 },
    { path: '/log/b.log', size: 100, mtime: AT - 1_000 },
    { path: '/log/c.log', size: 100, mtime: AT - 5_000 }
  ]
  const plan = retentionPlan({ files, now: AT, maxAgeMs: 4_000, maxBytes: 1_000 })
  assert.deepEqual(plan.delete, ['/log/a.log', '/log/c.log'])
  assert.deepEqual(plan.keep, ['/log/b.log'])
})

test('保留计划：总量超限时从最旧开始删，删到 <= maxBytes', () => {
  const files: RetentionFile[] = [
    { path: '/log/x.log', size: 100, mtime: AT - 3_000 },
    { path: '/log/y.log', size: 100, mtime: AT - 2_000 },
    { path: '/log/z.log', size: 50, mtime: AT - 1_000 }
  ]
  const plan = retentionPlan({ files, now: AT, maxAgeMs: 1_000_000, maxBytes: 150 })
  assert.deepEqual(plan.delete, ['/log/x.log'])
  assert.deepEqual(plan.keep, ['/log/y.log', '/log/z.log'])

  const plan2 = retentionPlan({ files, now: AT, maxAgeMs: 1_000_000, maxBytes: 0 })
  assert.deepEqual(plan2.delete, ['/log/x.log', '/log/y.log', '/log/z.log'])
  assert.deepEqual(plan2.keep, [])
})

test('保留计划：过期与超量叠加，过期在前、最旧优先', () => {
  const files: RetentionFile[] = [
    { path: '/expired.log', size: 10, mtime: AT - 100_000 },
    { path: '/old.log', size: 100, mtime: AT - 3_000 },
    { path: '/new.log', size: 100, mtime: AT - 1_000 }
  ]
  const plan = retentionPlan({ files, now: AT, maxAgeMs: 10_000, maxBytes: 150 })
  assert.deepEqual(plan.delete, ['/expired.log', '/old.log'])
  assert.deepEqual(plan.keep, ['/new.log'])
})

test('保留计划边界：恰好等于 maxAge / maxBytes 时保留', () => {
  const files: RetentionFile[] = [
    { path: '/edge.log', size: 100, mtime: AT - 5_000 }
  ]
  const plan = retentionPlan({ files, now: AT, maxAgeMs: 5_000, maxBytes: 100 })
  assert.deepEqual(plan.keep, ['/edge.log'])
  assert.deepEqual(plan.delete, [])
})

test('保留计划：非法 size 按 0，Date 形式的 now 可用', () => {
  const files: RetentionFile[] = [
    { path: '/a.log', size: Number.NaN, mtime: AT - 1_000 },
    { path: '/b.log', size: 10, mtime: AT - 1_000 }
  ]
  const plan = retentionPlan({ files, now: new Date(AT), maxAgeMs: 60_000, maxBytes: 0 })
  assert.deepEqual(plan.delete, ['/b.log'])
  assert.deepEqual(plan.keep, ['/a.log'])
  assert.equal(REDACTED, '[REDACTED]')
})
