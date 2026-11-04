// Bot 小鸟头像：确定性、物种/配色覆盖、SVG 结构、状态与无障碍标签。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BIRD_PALETTES, BIRD_SPECIES, BIRD_STATES, birdSpecFor, birdSvg } from '../lib/bird.js'

test('同一个 id 永远得到同一只鸟（改名不影响形象的前提）', () => {
  const a = birdSpecFor('bot_01M6KMHFHMNJ4S8286D7VS8MEQ')
  const b = birdSpecFor('bot_01M6KMHFHMNJ4S8286D7VS8MEQ')
  assert.deepEqual(a, b)
  assert.equal(birdSvg('bot_1'), birdSvg('bot_1'))
})

test('200 个 id 能覆盖全部 6 个物种与 8 个调色板', () => {
  const species = new Set<string>()
  const palettes = new Set<string>()
  for (let i = 0; i < 200; i += 1) {
    const spec = birdSpecFor(`bot_${i}`)
    species.add(spec.species)
    palettes.add(spec.palette.name)
  }
  assert.deepEqual([...species].sort(), [...BIRD_SPECIES].sort())
  assert.deepEqual([...palettes].sort(), BIRD_PALETTES.map((palette) => palette.name).sort())
})

test('SVG：96 viewBox、尺寸、role/label、鸟的关键部件', () => {
  const svg = birdSvg('bot_owl', { size: 40, label: '夜班猫头鹰' })
  assert.match(svg, /viewBox="0 0 96 96"/)
  assert.match(svg, /width="40"/)
  assert.match(svg, /height="40"/)
  assert.match(svg, /role="img"/)
  assert.match(svg, /aria-label="夜班猫头鹰"/)
  assert.match(svg, /<circle[^>]*fill="#FFFDF7"/) // 眼白
  assert.match(svg, /stroke-linecap="round"/) // 爪
  assert.doesNotMatch(svg, /undefined|NaN/)
})

test('状态：working 有呼吸环、paused 去饱和、alert 眼神上扬', () => {
  const working = birdSvg('bot_1', { state: 'working' })
  assert.match(working, /class="bird-ring"/)
  const paused = birdSvg('bot_1', { state: 'paused' })
  assert.match(paused, /opacity="0.55"/)
  assert.doesNotMatch(paused, /class="bird-ring"/)
  const alert = birdSvg('bot_1', { state: 'alert' })
  const idle = birdSvg('bot_1', { state: 'idle' })
  assert.notEqual(alert, idle)
  assert.match(alert, /c4-4 10-4 14-1/) // alert 专属的「眉眼上扬」路径
})

test('非法 state/size 回退到 idle/24，不抛错', () => {
  const svg = birdSvg('bot_1', { state: 'dancing' as never, size: -3 })
  assert.match(svg, /width="24"/)
  assert.doesNotMatch(svg, /class="bird-ring"/)
})

test('名字里的 HTML 会被转义（不拼 innerHTML）', () => {
  const svg = birdSvg('bot_1', { label: '<img src=x onerror=alert(1)>' })
  assert.doesNotMatch(svg, /<img/)
  assert.match(svg, /&lt;img/)
})

test('所有状态都产出合法 SVG 闭合标签', () => {
  for (const state of BIRD_STATES) {
    const svg = birdSvg('bot_2', { state })
    assert.equal((svg.match(/<svg/g) ?? []).length, 1)
    assert.equal((svg.match(/<\/svg>/g) ?? []).length, 1)
  }
})
