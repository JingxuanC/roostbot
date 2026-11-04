#!/usr/bin/env node
// 假 DSH SDK 服务：只为测试 room-agent 的协议处理（多轮 session / 事件 / 等待）。
import { createInterface } from 'node:readline'

const sessions = new Map()
const rl = createInterface({ input: process.stdin })
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)

rl.on('line', (line) => {
  if (line.trim() === '') return
  const frame = JSON.parse(line)
  const { id, method, params } = frame
  const reply = (result) => send({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') {
    reply({ serverInfo: { name: 'fake-sdk-runtime', version: '0' } })
    return
  }
  if (method === 'session/prompt') {
    const { sessionId, contentBlocks } = params
    const text = contentBlocks.map((block) => block.text ?? '').join('')
    const turns = (sessions.get(sessionId) ?? 0) + 1
    sessions.set(sessionId, turns)
    // 模拟：第二轮回答里带上"我记得"，证明同 session
    const answer = turns === 1 ? `收到了：「${text.slice(-20)}」` : `第 ${turns} 轮，我记得之前的对话：「${text.slice(-20)}」`
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } } } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
    }, 5)
    reply({ messageId: `msg-${turns}` })
    return
  }
  if (method === 'session/wait') {
    reply({})
    return
  }
  if (method === 'shutdown') {
    reply({})
    setTimeout(() => process.exit(0), 5)
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } })
})
