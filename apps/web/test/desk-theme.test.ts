// The desk theme is intentionally loaded last and owns the product's visual
// system. These assertions catch the common regressions: stylesheet order,
// missing paper/ink tokens, and the old blue theme leaking back in.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../styles-desk.css', import.meta.url), 'utf8')

test('desk theme loads after the legacy themes', () => {
  const base = html.indexOf('styles.css')
  const white = html.indexOf('styles-white.css')
  const desk = html.indexOf('styles-desk.css')
  assert.ok(base >= 0 && white > base, 'white theme must load after base')
  assert.ok(desk > white, 'desk theme must be the final stylesheet')
})

test('desk theme owns the paper/ink palette and type pairing', () => {
  for (const token of ['#f3efe6', '#25221c', '#2f5b4c', '#25221c']) {
    assert.ok(css.toLowerCase().includes(token), `missing desk token ${token}`)
  }
  assert.match(css, /font-family:\s*var\(--roost-font-display\)/)
  assert.match(css, /font-family:\s*var\(--roost-font-body\)/)
  assert.match(css, /font-variant-numeric:\s*tabular-nums/)
})

test('desk shell keeps a desktop rail and a mobile drawer', () => {
  assert.match(css, /grid-template-columns:\s*276px minmax\(0,\s*1fr\)/)
  assert.match(css, /transform:\s*translateX\(-102%\)/)
  assert.match(css, /#room-view \.sidebar-toggle/)
})
