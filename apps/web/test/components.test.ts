// apps/web/lib/components.js：结构、类名、禁用态与「不拼 innerHTML」。
// 零依赖，所以在测试里手写一个最小 DOM（只实现 el 用到的那几个方法）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { button, card, field } from '../lib/components.js'

class FakeNode {
  nodeType = 1
  tagName: string
  className = ''
  id = ''
  textContent = ''
  value = ''
  checked = false
  selected = false
  disabled = false
  hidden = false
  children: FakeNode[] = []
  attrs = new Map<string, string>()
  listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  append(...nodes: Array<FakeNode | string>) {
    for (const node of nodes) {
      this.children.push(typeof node === 'string' ? new FakeText(node) : node)
    }
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value)
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  fire(type: string, event: unknown = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super('#text')
    this.nodeType = 3
    this.textContent = text
  }
}

;(globalThis as any).Node = FakeNode
;(globalThis as any).document = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => new FakeText(String(text)),
}

function make(tag: string): FakeNode {
  return (globalThis as any).document.createElement(tag)
}

function find(node: FakeNode, className: string): FakeNode | null {
  if (node.className.split(/\s+/).includes(className)) return node
  for (const child of node.children) {
    const hit = find(child, className)
    if (hit) return hit
  }
  return null
}

test('button 默认：<button type=button class="btn">，文字进 textContent', () => {
  const node = button({ label: '保存' })
  assert.equal(node.tagName, 'BUTTON')
  assert.equal(node.className, 'btn')
  assert.equal(node.getAttribute('type'), 'button')
  assert.equal(node.textContent, '保存')
  assert.equal(node.disabled, false)
  assert.equal(node.children.length, 0)
})

test('button：variant/block/sm 组合成与 ui.js 相同的类名', () => {
  assert.equal(button({ label: 'x', variant: 'primary' }).className, 'btn btn-primary')
  assert.equal(button({ label: 'x', variant: 'ghost' }).className, 'btn btn-ghost')
  assert.equal(button({ label: 'x', variant: 'outline', block: true }).className, 'btn btn-outline btn-block')
  assert.equal(button({ label: 'x', size: 'sm' }).className, 'btn btn-sm')
  assert.equal(
    button({ label: 'x', variant: 'quiet', block: true, size: 'sm' }).className,
    'btn btn-quiet btn-block btn-sm'
  )
  assert.equal(button({ label: 'x', variant: 'unknown' }).className, 'btn')
})

test('button：禁用态、title、aria-label、submit 类型', () => {
  const node = button({
    label: '创建',
    type: 'submit',
    disabled: true,
    title: '提交表单',
    ariaLabel: '创建一个 Bot',
  })
  assert.equal(node.getAttribute('type'), 'submit')
  assert.equal(node.disabled, true)
  assert.equal(node.attrs.get('title'), '提交表单')
  assert.equal(node.attrs.get('aria-label'), '创建一个 Bot')
})

test('button：onClick 注册 click，触发时拿到事件；没传就不注册', () => {
  const calls = []
  const node = button({ label: '发送', onClick: (event: unknown) => calls.push(event) })
  node.fire('click', { type: 'click' })
  assert.equal(calls.length, 1)
  assert.equal((calls[0] as { type: string }).type, 'click')
  assert.equal(button({ label: '空' }).listeners.has('click'), false)
})

test('card 默认：div.page-card，无标题时不生成 section-head', () => {
  const node = card({ children: ['第一行', make('span')] })
  assert.equal(node.tagName, 'DIV')
  assert.equal(node.className, 'page-card')
  assert.equal(find(node, 'section-head'), null)
  assert.equal(node.children.length, 2)
  assert.equal(node.children[0].textContent, '第一行')
})

test('card：标题 + actions 生成 section-head，children 按顺序跟在后面', () => {
  const action = button({ label: '编辑', variant: 'ghost' })
  const body = make('p')
  const node = card({ title: '身份', actions: action, children: [body] })
  const head = find(node, 'section-head')
  assert.ok(head)
  const title = find(node, 'section-title')
  assert.equal(title?.tagName, 'H2')
  assert.equal(title?.textContent, '身份')
  const actions = find(node, 'section-actions')
  assert.ok(actions)
  assert.deepEqual(actions?.children, [action])
  assert.deepEqual(node.children, [head, body])
})

test('card：className 追加在 page-card 之后，不覆盖基础类', () => {
  assert.equal(card({ className: 'plugin-hero' }).className, 'page-card plugin-hero')
  assert.equal(card({}).className, 'page-card')
})

test('field：label/for/control/hint 的顺序与类名', () => {
  const control = make('input')
  control.id = 'bot-name'
  const node = field({
    label: '名字',
    control,
    required: true,
    hint: '≤40 字',
  })
  assert.equal(node.className, 'field')
  assert.equal(node.children.length, 3)
  const label = node.children[0]
  assert.equal(label.tagName, 'LABEL')
  assert.equal(label.className, 'field-label')
  assert.equal(label.getAttribute('for'), 'bot-name')
  assert.equal(label.textContent, '名字（必填）')
  assert.equal(node.children[1], control)
  const hint = node.children[2]
  assert.equal(hint.className, 'field-hint')
  assert.equal(hint.textContent, '≤40 字')
})

test('field：显式 id 优先于 control.id；无 hint 时只有 label+control', () => {
  const control = make('input')
  control.id = 'control-id'
  const node = field({ label: '模型', control, id: 'override-id', className: 'field-grid-cell' })
  assert.equal(node.className, 'field field-grid-cell')
  assert.equal(node.children[0].getAttribute('for'), 'override-id')
  assert.equal(node.children.length, 2)
})

test('field：没有 control 直接抛错，不生成半个字段', () => {
  assert.throws(() => field({ label: '名字' }), TypeError)
  assert.throws(() => field({ label: '名字', control: null }), TypeError)
})

test('用户输入只进 textContent：标签/标题里的 HTML 不会变成节点或属性', () => {
  const payload = '<img src=x onerror="alert(1)">'
  const node = button({ label: payload })
  assert.equal(node.textContent, payload)
  assert.equal(node.children.length, 0)
  assert.equal(node.attrs.has('onerror'), false)

  const titled = card({ title: payload, children: [] })
  const title = find(titled, 'section-title')
  assert.equal(title?.textContent, payload)
  assert.equal(title?.children.length, 0)
  assert.equal(titled.attrs.has('onerror'), false)
})
