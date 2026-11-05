import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decryptModelKey,
  deriveModelKeyMaster,
  encryptModelKey,
  maskHint,
  readModelKeyMaster
} from '../src/model-key-crypto.ts'

const KEY = 'sk-test-1234567890abcd'

test('AES-256-GCM 加解密；同一明文每次密文不同', () => {
  const master = deriveModelKeyMaster('test-master')
  const a = encryptModelKey(KEY, master)
  const b = encryptModelKey(KEY, master)
  assert.equal(a.keyHint, '…abcd')
  assert.notEqual(a.keyCiphertext, b.keyCiphertext)
  assert.equal(decryptModelKey(a, master), KEY)
  assert.equal(decryptModelKey(b, master), KEY)
})

test('错误主密钥 / 篡改密文无法解密', () => {
  const master = deriveModelKeyMaster('test-master')
  const encrypted = encryptModelKey(KEY, master)
  assert.throws(() => decryptModelKey(encrypted, deriveModelKeyMaster('other')))
  assert.throws(() => decryptModelKey({ ...encrypted, keyTag: Buffer.alloc(16).toString('base64') }, master))
})

test('主密钥只接受 32 字节 base64/hex；hint 只露后 4 位', () => {
  assert.equal(readModelKeyMaster({ ROOST_MODEL_KEY_SECRET: '' }), null)
  assert.equal(readModelKeyMaster({ ROOST_MODEL_KEY_SECRET: 'too-short' }), null)
  const raw = Buffer.alloc(32, 7)
  assert.deepEqual(readModelKeyMaster({ ROOST_MODEL_KEY_SECRET: raw.toString('base64') }), raw)
  assert.deepEqual(readModelKeyMaster({ ROOST_MODEL_KEY_SECRET: raw.toString('hex') }), raw)
  assert.equal(maskHint('abcd'), '…')
  assert.equal(maskHint('sk-123456'), '…3456')
})
