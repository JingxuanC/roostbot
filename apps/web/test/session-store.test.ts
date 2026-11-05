import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clearSessionToken,
  readLastRoom,
  readSessionToken,
  writeLastRoom,
  writeSessionToken
} from '../lib/session-store.js'

function fakeStorage() {
  const map = new Map()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key) : null),
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key)
  }
}

function withStorage(storage: unknown, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
}

test('配对 token 可写入、读回、清除', () => {
  const store = fakeStorage()
  withStorage(store, () => {
    assert.equal(readSessionToken(), null)
    assert.equal(writeSessionToken('tok_abc'), true)
    assert.equal(readSessionToken(), 'tok_abc')
    clearSessionToken()
    assert.equal(readSessionToken(), null)
  })
})

test('最近房间只接受房间 hash，停止时一起清掉', () => {
  const store = fakeStorage()
  withStorage(store, () => {
    assert.equal(writeLastRoom('#/rooms/rm_1'), true)
    assert.equal(readLastRoom(), '#/rooms/rm_1')
    assert.equal(writeLastRoom('#/settings'), false)
    assert.equal(readLastRoom(), '#/rooms/rm_1')
    clearSessionToken()
    assert.equal(readLastRoom(), null)
  })
})

test('存储不可用时不抛错，退化为无会话', () => {
  withStorage(
    {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
      removeItem() {
        throw new Error('denied')
      }
    },
    () => {
      assert.equal(readSessionToken(), null)
      assert.equal(writeSessionToken('tok'), false)
      assert.equal(writeLastRoom('#/rooms/x'), false)
      clearSessionToken()
    }
  )
})
