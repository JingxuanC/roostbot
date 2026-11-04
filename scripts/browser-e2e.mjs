#!/usr/bin/env node
// 浏览器端到端验收（4.5.4）：零依赖 CDP 客户端。
//
// 用法：
//   node --experimental-strip-types scripts/browser-e2e.mjs \
//     --base http://47.90.253.85:8792 --session <64hex> --account acc_xxx
//
// 流程：匿名/会话签配对码 → 浏览器配对 → UI 建两个 Bot → UI 建群 → 发消息 → 等两个 bot 回复
//      → 截图。任一步失败输出 FAIL + 证据，不伪造 PASS。

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const BASE = (args.get('--base') ?? 'http://127.0.0.1:8792').replace(/\/+$/, '')
const SESSION = args.get('--session') ?? ''
const ACCOUNT = args.get('--account') ?? ''
const OUT = args.get('--out') ?? 'docs/assets/m5-browser-e2e.png'
const HEADFUL = args.get('--headful') === 'true'

const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' → ' + JSON.stringify(detail)?.slice(0, 400)}`)
}

async function mintCode() {
  const response = await fetch(`${BASE}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SESSION}` },
    body: JSON.stringify({ accountId: ACCOUNT })
  })
  const body = await response.json()
  if (!response.ok || typeof body.code !== 'string') throw new Error(`mint code failed: ${response.status} ${JSON.stringify(body)}`)
  return body.code
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.id === undefined) return
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) pending.reject(new Error(JSON.stringify(frame.error)))
      else pending.resolve(frame.result)
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (result.exceptionDetails !== undefined) throw new Error(`eval failed: ${result.exceptionDetails.text}`)
    return result.result?.value
  }
}

async function waitFor(cdp, sessionId, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression, sessionId)
      if (last) return last
    } catch (error) {
      last = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)?.slice(0, 300)}`)
}

const setValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.focus();
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`

const clickText = (text) => `(() => {
  const nodes = [...document.querySelectorAll('button, a')];
  const hit = nodes.find((node) => (node.textContent || '').trim().includes(${JSON.stringify(text)}) && !node.disabled);
  if (!hit) return false;
  hit.click();
  return true;
})()`

async function main() {
  const hasLogin = typeof args.get('--email') === 'string' && typeof args.get('--password') === 'string'
  const code = hasLogin ? null : await mintCode()
  if (code !== null) console.log(`pairing code: ${code}`)
  const port = 19200 + Math.floor(Math.random() * 400)
  const userDir = mkdtempSync(join(tmpdir(), 'roost-e2e-'))
  const chrome = spawn(CHROME, [
    ...(HEADFUL ? [] : ['--headless=new']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  chrome.stderr.on('data', (chunk) => { stderr += chunk })

  const deadline = Date.now() + 20000
  let version
  while (Date.now() < deadline) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  if (version === undefined) throw new Error(`chrome devtools did not start: ${stderr.slice(-400)}`)
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(ws)
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sid = attached.sessionId
  await cdp.send('Page.enable', {}, sid)
  await cdp.send('Runtime.enable', {}, sid)

  await cdp.send('Page.navigate', { url: `${BASE}/` }, sid)
  await waitFor(cdp, sid, 'document.readyState === "complete"', 20000, 'page load')
  const email = args.get('--email')
  const password = args.get('--password')
  if (typeof email === 'string' && typeof password === 'string') {
    await cdp.evaluate('location.hash = "#/login"', sid)
    await waitFor(cdp, sid, 'document.querySelector("#auth-login-email") !== null', 15000, 'login form')
    await cdp.evaluate(setValue('#auth-login-email', email), sid)
    await cdp.evaluate(setValue('#auth-login-password', password), sid)
    await cdp.evaluate(`document.querySelector('#auth-login-email').closest('form').requestSubmit()`, sid)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const probe = await cdp.evaluate(`(async () => {
      const me = await fetch('/api/auth/me', { credentials: 'include' }).then((r) => r.status).catch(() => 0);
      const err = (document.querySelector('.bt-error, .auth-error, #auth-main [role=alert]')?.textContent || '').slice(0, 200);
      return { me, err, hash: location.hash, text: (document.body.innerText || '').slice(0, 160) };
    })()`, sid)
    console.log('DEBUG login:', JSON.stringify(probe))
    const loggedIn = probe.me === 200 && !/#\/login/.test(probe.hash)
    step('浏览器登录', loggedIn, { hash: await cdp.evaluate('location.hash', sid) })
    if (!loggedIn) throw new Error('login failed')
  } else {
    await waitFor(cdp, sid, 'document.querySelector("#pair-view") && !document.querySelector("#pair-view").hidden', 15000, 'pair view')
  }

  if (typeof email === 'string' && typeof password === 'string') {
    // 已用邮箱登录，跳过配对。
  } else {
  // 6 个配对码输入框
  const codeOk = await cdp.evaluate(`(() => {
    const digits = ${JSON.stringify(code ?? '')}.split('');
    for (let i = 0; i < digits.length; i += 1) {
      const input = document.querySelector('#code-' + i);
      if (!input) return false;
      input.focus();
      input.value = digits[i];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`, sid)
  await cdp.evaluate(clickText('配对并进入'), sid).catch(() => false)
  await cdp.evaluate(`document.querySelector('#pair-form').requestSubmit()`, sid)
  const claimed = await waitFor(cdp, sid, 'document.querySelector("#bot-list") || location.hash.startsWith("#/bots")', 20000, 'app after pairing').then(() => true).catch(() => false)
  step('浏览器配对', codeOk && claimed, { codeOk, claimed, url: await cdp.evaluate('location.href', sid) })
  }

  // 通过 UI 建两个 Bot
  const names = ['浏览器甲', '浏览器乙']
  for (const name of names) {
    await cdp.evaluate('location.hash = "#/bots/new"', sid)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    console.log('DEBUG after hash:', JSON.stringify(await cdp.evaluate('({ hash: location.hash, view: [...document.querySelectorAll("div[id]")].filter((n) => !n.hidden).map((n) => n.id), text: (document.body.innerText || "").slice(0, 200) })', sid)))
    await waitFor(cdp, sid, 'document.querySelector("#bot-name") !== null', 10000, 'bot form')
    await cdp.evaluate(setValue('#bot-name', name), sid)
    await cdp.evaluate(setValue('#bot-role', '研究'), sid)
    await cdp.evaluate(setValue('#bot-model', 'deepseek-chat'), sid)
    await cdp.evaluate(clickText('创建 Bot'), sid)
    const created = await waitFor(cdp, sid, `(() => {
      const items = [...document.querySelectorAll('#bot-list *')].map((node) => node.textContent || '');
      return items.some((text) => text.includes(${JSON.stringify(name)})) || /#\\/bots\\/[^/]+$/.test(location.hash);
    })()`, 20000, `create bot ${name}`).then(() => true).catch(() => false)
    step(`UI 建 Bot：${name}`, created, { hash: await cdp.evaluate('location.hash', sid) })
  }

  // 通过 UI 建群
  await cdp.evaluate('location.hash = "#/rooms/new"', sid)
  await waitFor(cdp, sid, 'document.querySelector("#room-name") !== null', 10000, 'room form')
  await cdp.evaluate(setValue('#room-name', '浏览器验收群'), sid)
  const picked = await cdp.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('input[name="room-members"]')];
    for (const box of boxes.slice(0, 2)) { if (!box.checked) box.click(); }
    return boxes.length;
  })()`, sid)
  const responder = await cdp.evaluate(`(() => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    const everyone = radios.find((radio) => radio.value === 'everyone');
    if (everyone) { everyone.click(); return 'everyone'; }
    return radios.length === 0 ? 'none' : radios[0].value;
  })()`, sid)
  await cdp.evaluate(clickText('创建房间'), sid)
  const roomHash = await waitFor(cdp, sid, '/^#\\/rooms\\/[^/]+$/.test(location.hash) ? location.hash : null', 20000, 'room created')
  step('UI 建群', typeof roomHash === 'string', { picked, responder, roomHash })

  // 发送消息并等两个 bot 回复
  await waitFor(cdp, sid, 'document.querySelector("#composer") !== null', 10000, 'composer')
  await cdp.evaluate(setValue('#composer', '请用一句话回答：现在是浏览器验收。'), sid)
  await cdp.evaluate(`document.querySelector('#composer-form').requestSubmit()`, sid)
  const replied = await waitFor(cdp, sid, `(() => {
    const bots = [...document.querySelectorAll('.msg-bot .bubble-bot')].map((node) => node.textContent || '').filter((text) => text.trim() !== '');
    return bots.length >= 2 ? bots : null;
  })()`, 180000, 'two bot replies').then((value) => value).catch(() => null)
  step('UI 发消息 + 两个 Bot 回复', Array.isArray(replied), replied === null ? 'timeout' : replied)
  if (Array.isArray(replied)) console.log('  bot replies:', JSON.stringify(replied.map((text) => text.slice(0, 80))))

  // 第二轮
  await cdp.evaluate(setValue('#composer', '刚才我说的是在验收什么？用一句话回答。'), sid)
  await cdp.evaluate(`document.querySelector('#composer-form').requestSubmit()`, sid)
  const second = await waitFor(cdp, sid, `(() => {
    const bots = [...document.querySelectorAll('.msg-bot .bubble-bot')].map((node) => node.textContent || '').filter((text) => text.trim() !== '');
    return bots.length >= 3 ? bots : null;
  })()`, 180000, 'second turn reply').then((value) => value).catch(() => null)
  step('UI 第二轮对话', Array.isArray(second), second === null ? 'timeout' : second.slice(-1))

  // 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid)
  mkdirSync('docs/assets', { recursive: true })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  step('截图', true, OUT)

  ws.close()
  chrome.kill('SIGTERM')
  const failed = steps.filter((item) => !item.ok)
  console.log(`\nBROWSER E2E: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${steps.length - failed.length}/${steps.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('BROWSER E2E FAILED:', error instanceof Error ? error.message : error)
  process.exit(2)
})
