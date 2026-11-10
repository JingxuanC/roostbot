import assert from 'node:assert/strict'
import { test } from 'node:test'

import { botHarnessKind, harnessAvatarSvg } from '../lib/dom.js'

test('known harnesses get a stable avatar mark', () => {
  for (const kind of ['dsh', 'claude-code', 'codex', 'grok-build', 'hermes', 'native']) {
    assert.equal(botHarnessKind({ runtimeKind: kind }), kind)
    const svg = harnessAvatarSvg(kind, 32, 'Bot', true)
    assert.match(svg, /^<svg /)
    assert.match(svg, /viewBox="0 0 96 96"/)
    assert.match(svg, /<circle/)
  }
})

test('unknown runtimes fall back to the bird avatar', () => {
  assert.equal(botHarnessKind({ runtimeKind: '' }), '')
  assert.equal(botHarnessKind({ runtimeKind: 'mystery' }), '')
  assert.equal(harnessAvatarSvg('mystery', 32), '')
})
