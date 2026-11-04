import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LocalVolumeStore, objectPath } from '../src/index.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'roost-storage-'))
}

function objectDirs(root: string): string[] {
  const out: string[] = []
  for (const a of listDir(root)) {
    for (const b of listDir(join(root, a))) out.push(join(root, a, b))
  }
  return out
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

test('内容寻址：同内容只存一份，重复 put 幂等', async () => {
  const root = tempRoot()
  try {
    const store = new LocalVolumeStore({ root })
    const bytes = new Uint8Array(Buffer.from('hello roost'))
    const first = await store.put(bytes, { mime: 'text/plain', owner: 'acc_1' })
    const second = await store.put(bytes, { mime: 'text/plain', owner: 'someone-else' })

    assert.equal(first.id.length, 32)
    assert.match(first.id, /^[0-9a-f]{32}$/)
    assert.equal(second.id, first.id)
    assert.equal(second.size, bytes.byteLength)

    const blob = readFileSync(join(root, objectPath(first.id), 'blob'))
    assert.deepEqual([...blob], [...bytes])
    // 第二次 put 不覆盖 owner。
    const meta = JSON.parse(readFileSync(join(root, objectPath(first.id), 'meta.json'), 'utf8')) as {
      owner: string
      mime: string
    }
    assert.equal(meta.owner, 'acc_1')
    assert.equal(meta.mime, 'text/plain')
    assert.equal(objectDirs(root).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('原子写权限：目录 0700、文件 0600', async () => {
  const root = tempRoot()
  try {
    const store = new LocalVolumeStore({ root })
    const stored = await store.put(new Uint8Array([1, 2, 3, 4]), { mime: 'application/octet-stream', owner: 'acc' })
    const dir = join(root, objectPath(stored.id))
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'blob')).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'meta.json')).mode & 0o777, 0o600)
    assert.equal(statSync(root).mode & 0o777, 0o700)
    // 没有残留的 tmp 文件。
    assert.deepEqual(readdirSync(dir).sort(), ['blob', 'meta.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('get/head/delete 与路径穿越防护', async () => {
  const root = tempRoot()
  try {
    const store = new LocalVolumeStore({ root })
    const stored = await store.put(new Uint8Array([9, 8, 7]), { mime: 'image/png', owner: 'acc', audience: 'team' })

    const got = await store.get(stored.id)
    assert.deepEqual([...(got?.bytes ?? [])], [9, 8, 7])
    assert.equal(got?.meta.owner, 'acc')
    assert.equal(got?.meta.audience, 'team')
    assert.equal((await store.head(stored.id))?.size, 3)

    // 非法 id 一律 null/false，不碰文件系统。
    assert.equal(await store.get('../../etc/passwd'), null)
    assert.equal(await store.head('../../etc/passwd'), null)
    assert.equal(await store.delete('not-an-id'), false)

    assert.equal(await store.delete(stored.id), true)
    assert.equal(await store.get(stored.id), null)
    assert.equal(await store.delete(stored.id), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('签名读取：HMAC 校验与过期', async () => {
  const root = tempRoot()
  let now = 1_000_000
  try {
    const store = new LocalVolumeStore({ root, signingSecret: 'test-secret', now: () => now })
    const stored = await store.put(new Uint8Array([1]), { mime: 'image/png', owner: 'acc' })
    const url = await store.signRead(stored.id, 60)

    assert.match(url, new RegExp(`^/api/attachments/${stored.id}\\?token=\\d+\\.[0-9a-f]{64}$`))
    const token = new URL(url, 'http://local').searchParams.get('token')!
    assert.equal(store.verifyReadToken(stored.id, token), true)

    // 换 id / 改 token 都不行。
    assert.equal(store.verifyReadToken(stored.id.replace(/^./, 'f'), token), false)
    assert.equal(store.verifyReadToken(stored.id, `${token}0`), false)
    assert.equal(store.verifyReadToken(stored.id, ''), false)

    // 过期后拒绝（ttl 60s）。
    now += 60_001
    assert.equal(store.verifyReadToken(stored.id, token), false)

    // 另一个实例用不同 secret 也验不过。
    const other = new LocalVolumeStore({ root, signingSecret: 'other-secret', now: () => now })
    now -= 60_001
    assert.equal(other.verifyReadToken(stored.id, token), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
