#!/usr/bin/env node
// 假 DSH SDK 服务：只为测试 room-agent 的协议处理（多轮 session / 事件 / 等待）。
//
// 可选环境变量（测试用）：
//   FAKE_DSH_LOG     把 resume/prompt 事件追加成 JSONL，测试可读
//   FAKE_DSH_ANSWER  固定回答（如 `[PASS]`），默认按轮数生成
//   FAKE_DSH_MODE    working | approval | error | silent（模拟 SlotResult 的分支）
//   FAKE_DSH_DELAY_MS 正常回答延迟多少毫秒（默认 5；测 stop 中断用大值）
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sessions = new Map()
const logPath = process.env.FAKE_DSH_LOG ?? ''
const fixedAnswer = process.env.FAKE_DSH_ANSWER
const mode = process.env.FAKE_DSH_MODE ?? ''
const delayMs = Number(process.env.FAKE_DSH_DELAY_MS ?? '5')
const rl = createInterface({ input: process.stdin })
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)

function record(event) {
  if (logPath === '') return
  try {
    appendFileSync(logPath, `${JSON.stringify(event)}\n`)
  } catch {
    // 记录失败不影响协议行为
  }
}

rl.on('line', (line) => {
  if (line.trim() === '') return
  const frame = JSON.parse(line)
  const { id, method, params } = frame
  const reply = (result) => send({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') {
    reply({ serverInfo: { name: 'fake-sdk-runtime', version: '0' } })
    return
  }
  if (method === 'session/resume') {
    record({ kind: 'resume', sessionId: params.sessionId })
    reply({})
    return
  }
  if (method === 'session/prompt') {
    const { sessionId, contentBlocks } = params
    const text = contentBlocks.map((block) => block.text ?? '').join('')
    record({ kind: 'prompt', sessionId, text })
    const turns = (sessions.get(sessionId) ?? 0) + 1
    sessions.set(sessionId, turns)
    if (mode === 'error') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'session crashed' } })
      return
    }
    if (mode === 'working' || mode === 'approval' || mode === 'silent') {
      if (mode !== 'silent') {
        const status = mode === 'working' ? 'working' : 'waiting-approval'
        setTimeout(() => send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status } }), 1)
      }
      reply({ messageId: `msg-${turns}` })
      return
    }
    // 模拟：第二轮回答里带上"我记得"，证明同 session
    const generated =
      turns === 1
        ? `收到了：「${text.slice(-20)}」`
        : `第 ${turns} 轮，我记得之前的对话：「${text.slice(-20)}」`
    const answer = fixedAnswer === undefined ? generated : fixedAnswer
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } } } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
    }, delayMs)
    reply({ messageId: `msg-${turns}` })
    return
  }
  if (method === 'session/wait') {
    // 工作/审批/静默模式不主动结束：agent 要按超时与状态各自归类
    if (mode === 'working' || mode === 'approval' || mode === 'silent') return
    setTimeout(() => reply({}), delayMs)
    return
  }
  if (method === 'shutdown') {
    reply({})
    setTimeout(() => process.exit(0), 5)
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } })
})
