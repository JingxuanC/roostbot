import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AVATAR_ACCEPT,
  AVATAR_MAX_BYTES,
  avatarLabel,
  isAvatarDataUrl,
  readAvatarFile,
} from '../lib/avatar.js'

function fakeFile(bytes, type = 'image/png') {
  return {
    type,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
}

function base64Of(size) {
  return Buffer.from(new Uint8Array(size)).toString('base64')
}

test('readAvatarFile 把 PNG 读成可识别的 dataURL', async () => {
  const result = await readAvatarFile(fakeFile(new Uint8Array([1, 2, 3]), 'image/png'))
  assert.equal(result.ok, true)
  assert.equal(result.type, 'image/png')
  assert.equal(result.bytes, 3)
  assert.equal(result.dataUrl, 'data:image/png;base64,AQID')
  assert.equal(isAvatarDataUrl(result.dataUrl), true)
})

test('readAvatarFile 能读真正的 File（浏览器同款接口）', async () => {
  if (typeof File !== 'function') return
  const file = new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' })
  const result = await readAvatarFile(file)
  assert.equal(result.ok, true)
  assert.equal(result.dataUrl, 'data:image/png;base64,AQID')
})

test('readAvatarFile 接受 JPEG / WebP / GIF（accept 与类型白名单一致）', async () => {
  for (const type of ['image/jpeg', 'image/webp', 'image/gif']) {
    const result = await readAvatarFile(fakeFile(new Uint8Array([9]), type))
    assert.equal(result.ok, true, type)
    assert.equal(result.dataUrl.startsWith(`data:${type};base64,`), true)
  }
  assert.equal(AVATAR_ACCEPT, 'image/png,image/jpeg,image/webp,image/gif')
})

test('readAvatarFile 拒绝 SVG / 文本 / 未知类型', async () => {
  const svg = await readAvatarFile(fakeFile(new Uint8Array([1]), 'image/svg+xml'))
  assert.equal(svg.ok, false)
  assert.equal(svg.code, 'avatar.type')
  assert.match(svg.error, /PNG/)

  const text = await readAvatarFile(fakeFile(new Uint8Array([1]), 'text/plain'))
  assert.equal(text.ok, false)
  assert.equal(text.code, 'avatar.type')

  const none = await readAvatarFile(null)
  assert.equal(none.ok, false)
  assert.equal(none.code, 'avatar.missing')
})

test('readAvatarFile 超过 256KB 直接拒绝，不读文件内容', async () => {
  let read = false
  const file = {
    type: 'image/png',
    size: AVATAR_MAX_BYTES + 1,
    async arrayBuffer() {
      read = true
      return new ArrayBuffer(0)
    },
  }
  const result = await readAvatarFile(file)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'avatar.size')
  assert.match(result.error, /256KB/)
  assert.equal(read, false, '超限时不该真的去读')
})

test('readAvatarFile 拒绝空文件与读不出来的文件', async () => {
  const empty = await readAvatarFile(fakeFile(new Uint8Array(0)))
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'avatar.empty')

  const broken = {
    type: 'image/png',
    size: 10,
    async arrayBuffer() {
      throw new Error('boom')
    },
  }
  const unreadable = await readAvatarFile(broken)
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.code, 'avatar.unreadable')
})

test('readAvatarFile 以真实读到的字节数再卡一次上限', async () => {
  const file = {
    type: 'image/png',
    size: 10,
    async arrayBuffer() {
      return new Uint8Array(AVATAR_MAX_BYTES + 1).buffer
    },
  }
  const result = await readAvatarFile(file)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'avatar.size')
})

test('isAvatarDataUrl 只认白名单类型、合法 base64 与 ≤256KB', () => {
  assert.equal(isAvatarDataUrl('data:image/png;base64,AQID'), true)
  assert.equal(isAvatarDataUrl('data:image/jpeg;base64,AQID'), true)
  assert.equal(isAvatarDataUrl('data:image/svg+xml;base64,AQID'), false)
  assert.equal(isAvatarDataUrl('data:text/plain;base64,AQID'), false)
  assert.equal(isAvatarDataUrl('data:image/png;base64,'), false)
  assert.equal(isAvatarDataUrl('data:image/png;base64,***'), false)
  assert.equal(isAvatarDataUrl('image/png;base64,AQID'), false)
  assert.equal(isAvatarDataUrl(''), false)
  assert.equal(isAvatarDataUrl(null), false)
  assert.equal(isAvatarDataUrl(42), false)
})

test('isAvatarDataUrl 的上限边界正好是 256KB', () => {
  const ok = `data:image/png;base64,${base64Of(AVATAR_MAX_BYTES)}`
  assert.equal(isAvatarDataUrl(ok), true)
  const tooBig = `data:image/png;base64,${base64Of(AVATAR_MAX_BYTES + 1)}`
  assert.equal(isAvatarDataUrl(tooBig), false)
})

test('avatarLabel：合法图片是「自定义图片」，其余是「程序化图标」', () => {
  assert.equal(avatarLabel({ avatar: { image: 'data:image/png;base64,AQID' } }), '自定义图片')
  assert.equal(avatarLabel({ avatar: { shape: 'egg', color: 'amber' } }), '程序化图标')
  assert.equal(avatarLabel({ avatar: { image: 'data:image/svg+xml;base64,AQID' } }), '程序化图标')
  assert.equal(avatarLabel({}), '程序化图标')
  assert.equal(avatarLabel(null), '程序化图标')
})
