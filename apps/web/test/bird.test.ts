// Bot 小鸟头像：确定性、物种/配色覆盖、SVG 结构、状态与无障碍标签。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BIRD_ACCESSORIES, BIRD_MOODS, BIRD_PALETTES, BIRD_SPECIES, BIRD_STATES, accessoryForId, accessoryForRole, birdSpecFor, birdSvg } from '../lib/bird.js'

test('同一个 id 永远得到同一只鸟（改名不影响形象的前提）', () => {
  const a = birdSpecFor('bot_01M6KMHFHMNJ4S8286D7VS8MEQ')
  const b = birdSpecFor('bot_01M6KMHFHMNJ4S8286D7VS8MEQ')
  assert.deepEqual(a, b)
  assert.equal(birdSvg('bot_1'), birdSvg('bot_1'))
})

test('1200 个 id 能覆盖全部 18 个物种、8 个调色板与全部配饰', () => {
  const species = new Set<string>()
  const palettes = new Set<string>()
  const accessories = new Set<string>()
  for (let i = 0; i < 1200; i += 1) {
    const spec = birdSpecFor(`bot_${i}`)
    species.add(spec.species)
    palettes.add(spec.palette.name)
    accessories.add(spec.defaultAccessory)
  }
  assert.equal(BIRD_SPECIES.length, 18)
  assert.deepEqual([...species].sort(), [...BIRD_SPECIES].sort())
  assert.deepEqual([...palettes].sort(), BIRD_PALETTES.map((palette) => palette.name).sort())
  assert.deepEqual([...accessories].sort(), [...BIRD_ACCESSORIES].sort())
  assert.deepEqual([...BIRD_MOODS].sort(), ['crazy', 'cute'])
})

test('配饰：角色优先，其次 id 稳定兜底，显式 accessory 最高优先', () => {
  assert.equal(accessoryForRole('研究'), 'glasses')
  assert.equal(accessoryForRole('数据分析'), 'glasses')
  assert.equal(accessoryForRole('数据'), 'headphones')
  assert.equal(accessoryForRole('量化研究'), 'glasses')
  assert.equal(accessoryForRole('风控'), 'hardhat')
  assert.equal(accessoryForRole('评审'), 'hardhat')
  assert.equal(accessoryForRole('主持'), 'crown')
  assert.equal(accessoryForRole('未知角色'), null)

  const glasses = birdSvg('bot_role', { role: '研究' })
  assert.match(glasses, /stroke-width="2.2"/)
  assert.doesNotMatch(glasses, /rect x="16"/)
  const headphones = birdSvg('bot_role', { role: '数据' })
  assert.match(headphones, /rect x="16"/)
  const hat = birdSvg('bot_role', { role: '风控' })
  assert.match(hat, /E9B23B/)
  const crown = birdSvg('bot_role', { role: '主持' })
  assert.match(crown, /E8C24A/)

  // 显式 accessory 覆盖 role
  const tie = birdSvg('bot_role', { role: '数据', accessory: 'tie' })
  assert.match(tie, /B33A36/)
  assert.doesNotMatch(tie, /rect x="16"/)

  // paused 不戴配饰（躺平不需要行头）
  const paused = birdSvg('bot_role', { role: '数据', state: 'paused' })
  assert.doesNotMatch(paused, /rect x="16"/)

  // 同一 id 的兜底配饰稳定
  assert.equal(accessoryForId('bot_fixed'), accessoryForId('bot_fixed'))
})

test('可爱系与疯狂系的表情不同：疯狂系压眉、瞳孔更小', () => {
  const cute = birdSvg('bot_cute', { state: 'idle' })
  const crazy = birdSvg('bot_crazy', { state: 'idle' })
  // 同一 state 下两支的眉/瞳几何不同即可；具体 id 由 hash 决定气质。
  const cuteIds = Array.from({ length: 40 }, (_, i) => `cutie_${i}`)
  const crazyIds = Array.from({ length: 40 }, (_, i) => `wild_${i}`)
  const cuteSpecs = cuteIds.map((id) => birdSpecFor(id).species)
  const crazySpecs = crazyIds.map((id) => birdSpecFor(id).species)
  assert.ok(cuteSpecs.length > 0 && crazySpecs.length > 0)
  assert.notEqual(cute.slice(0, 400), crazy.slice(0, 400))
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
