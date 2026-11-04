// 面板清单 + 容器冒烟（surface.ts 的 wave1 §C 新增部分）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { panelSmoke, panelsFromManifest } from '../src/surface.ts'

test('panelsFromManifest：只保留 {id,title,slot} 完整形状，去掉多余字段', () => {
  const panels = panelsFromManifest({
    name: 'demo',
    panels: [
      { id: 'board', title: '行情板', slot: 'sidebar', extra: 1 },
      { id: 'main', title: '主面板', slot: 'main' },
      { id: 'no-slot', title: '缺 slot' },
      { id: 'no-title', slot: 'sidebar' },
      { slot: 'sidebar', title: '缺 id' },
      { id: '', title: '空 id', slot: 'sidebar' },
      { id: 'blank', title: '   ', slot: 'sidebar' },
      { id: 7, title: '类型不对', slot: 'sidebar' },
      'not-an-object',
      null,
      ['array']
    ]
  })
  assert.deepEqual(panels, [
    { id: 'board', title: '行情板', slot: 'sidebar' },
    { id: 'main', title: '主面板', slot: 'main' }
  ])
  // 返回的是新对象：manifest 的额外字段不应被带出来
  assert.equal('extra' in panels[0]!, false)
})

test('panelsFromManifest：字段两侧空白被 trim', () => {
  assert.deepEqual(
    panelsFromManifest({ panels: [{ id: ' p1 ', title: ' 标题 ', slot: ' main ' }] }),
    [{ id: 'p1', title: '标题', slot: 'main' }]
  )
})

test('panelsFromManifest：panels 不是数组（含旧的数量声明）/ manifest 缺失 → []', () => {
  assert.deepEqual(panelsFromManifest({ panels: 7 }), [])
  assert.deepEqual(panelsFromManifest({ panels: null }), [])
  assert.deepEqual(panelsFromManifest({}), [])
  assert.deepEqual(panelsFromManifest(undefined), [])
  assert.deepEqual(panelsFromManifest(null), [])
  assert.deepEqual(panelsFromManifest('manifest'), [])
  assert.deepEqual(panelsFromManifest([]), [])
  assert.deepEqual(panelsFromManifest({ panels: [] }), [])
})

test('panelSmoke：200 + <!doctype html（大小写不敏感）→ ok', async () => {
  const seen: string[] = []
  const result = await panelSmoke({
    port: 4099,
    fetchImpl: (async (input: string | URL | Request) => {
      seen.push(String(input))
      return {
        status: 200,
        text: async () => '<!DOCTYPE HTML><html><body>panel</body></html>'
      }
    }) as typeof fetch
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(seen, ['http://127.0.0.1:4099/'])
})

test('panelSmoke：200 但不是 HTML 壳 → not_html', async () => {
  const result = await panelSmoke({
    port: 4100,
    fetchImpl: (async () => ({
      status: 200,
      text: async () => '<html><body>not dsh</body></html>'
    })) as unknown as typeof fetch
  })
  assert.deepEqual(result, { ok: false, reason: 'not_html' })
})

test('panelSmoke：非 200 → bad_status（带状态码）', async () => {
  const result = await panelSmoke({
    port: 4100,
    fetchImpl: (async () => ({
      status: 503,
      text: async () => 'nope'
    })) as unknown as typeof fetch
  })
  assert.deepEqual(result, { ok: false, reason: 'bad_status', status: 503 })
})

test('panelSmoke：fetch 抛错/超时 → unreachable', async () => {
  const result = await panelSmoke({
    port: 4100,
    fetchImpl: (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }) as typeof fetch
  })
  assert.deepEqual(result, { ok: false, reason: 'unreachable' })

  const bodyError = await panelSmoke({
    port: 4100,
    fetchImpl: (async () => ({
      status: 200,
      text: async () => {
        throw new Error('connection reset')
      }
    })) as unknown as typeof fetch
  })
  assert.deepEqual(bodyError, { ok: false, reason: 'unreachable' })
})

test('panelSmoke：端口非法 → bad_port，不发请求', async () => {
  let called = false
  const fetchImpl = (async () => {
    called = true
    return { status: 200, text: async () => '<!doctype html>' }
  }) as unknown as typeof fetch

  for (const port of [0, -1, 70_000, 1.5, undefined]) {
    const result = await panelSmoke({ port, fetchImpl })
    assert.deepEqual(result, { ok: false, reason: 'bad_port' })
  }
  assert.equal(called, false)
})

test('panelSmoke：兼容 wave1 的 webPort 写法', async () => {
  const seen: string[] = []
  const result = await panelSmoke({
    webPort: 4201,
    fetchImpl: (async (input: string | URL | Request) => {
      seen.push(String(input))
      return { status: 200, text: async () => '<!doctype html>' }
    }) as typeof fetch
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(seen, ['http://127.0.0.1:4201/'])
})
