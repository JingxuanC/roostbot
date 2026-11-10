import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveApiBase } from '../lib/api-base.js'

test('?api= only allows loopback or the page origin', () => {
  assert.equal(resolveApiBase('', 'http://127.0.0.1:8787'), '')
  assert.equal(resolveApiBase('http://127.0.0.1:8787', 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.equal(resolveApiBase('http://localhost:8787/', 'https://roost.example'), 'http://localhost:8787')
  assert.equal(resolveApiBase('https://roost.example', 'https://roost.example'), 'https://roost.example')
  assert.equal(resolveApiBase('https://evil.example', 'https://roost.example'), '')
  assert.equal(resolveApiBase('http://evil.example', 'https://roost.example'), '')
  assert.equal(resolveApiBase('javascript:alert(1)', 'https://roost.example'), '')
})
