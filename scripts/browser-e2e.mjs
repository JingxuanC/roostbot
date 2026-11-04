#!/usr/bin/env node
// 浏览器端到端验收（TODO 4.5.4）：配对 → 建两个 Bot → 建群 → 两轮对话 → 截图。
//
// 零依赖：只用 Node 内置模块（child_process / http / fs / os / path / crypto / 全局 WebSocket）
// 和 Chrome DevTools Protocol。不用 puppeteer / playwright，也不往仓库里写 devtools 日志。
//
// 用法：
//   node --experimental-strip-types scripts/browser-e2e.mjs \
//     --base http://47.90.253.85:8792 --headful false
//
// 可选：
//   --code 123456            直接用一个有效配对码（5 分钟内、未使用）
//   --session-token <tok>    已有会话 token：先 /api/auth/me 取 accountId，再签发配对码
//   --out docs/assets/m5-browser-e2e.png
//   --timeout 600000         总超时（默认 10 分钟）
//   --bot-timeout 180000     单轮等待两个 Bot 回复的超时
//   --keep-profile           保留临时 Chrome profile（默认删）
//
// 退出码：0 全流程 PASS；1 任一步 FAIL（打印失败步骤、URL、body 前 500 字、DOM 摘要）。
//
// 诚实约定：任何一步没达成就是 FAIL；不会把超时或“看起来像”当成 PASS。

import { spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    base: 'http://47.90.253.85:8792',
    headful: false,
    code: '',
    sessionToken: '',
    out: 'docs/assets/m5-browser-e2e.png',
    timeout: 600_000,
    botTimeout: 180_000,
    keepProfile: false,
    account: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--base':
        out.base = String(value || '').replace(/\/+$/, '')
        i += 1
        break
      case '--headful':
        out.headful = value === 'true' || value === '1'
        i += 1
        break
      case '--code':
        out.code = String(value || '').trim()
        i += 1
        break
      case '--session-token':
        out.sessionToken = String(value || '').trim()
        i += 1
        break
      case '--account':
        out.account = String(value || '').trim()
        i += 1
        break
      case '--out':
        out.out = String(value || '')
        i += 1
        break
      case '--timeout':
        out.timeout = Number(value) || out.timeout
        i += 1
        break
      case '--bot-timeout':
        out.botTimeout = Number(value) || out.botTimeout
        i += 1
        break
      case '--keep-profile':
        out.keepProfile = true
        break
      default:
        if (key.startsWith('--')) throw new Error(`未知参数 ${key}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()

function log(line) {
  process.stdout.write(`${line}\n`)
}

function short(value, max = 300) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`URL 不合法：${url}`))
      return
    }
    const mod = parsed.protocol === 'https:' ? https : http
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = mod.request(
      parsed,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...headers,
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text === '' ? null : JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, text, json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时：${method} ${url}`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 2000 }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      })
      .on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 配对码：匿名 bootstrap（回环才允许）/ 已认证签发 / --code
// ---------------------------------------------------------------------------

function pairingFailureHint(res) {
  const code = res?.json?.error?.code || ''
  const message = res?.json?.error?.message || res?.text || ''
  const lines = [`HTTP ${res?.status} ${code} ${short(message, 200)}`]
  if (code === 'pairing_forbidden' && /loopback/i.test(message)) {
    lines.push(
      '说明：该控制面只允许「回环地址 + 无会话」的匿名 bootstrap 签发配对码；从公网 IP 直接请求会被拒。',
      '可用 --code <6位码>（云端 5 分钟内签发）或 --session-token <token>（脚本会先 /api/auth/me 再签发）。'
    )
  }
  return lines.join('\n  ')
}

async function resolveAccountId(base, token) {
  if (token === '') return ''
  const me = await requestJson(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  if (me.status !== 200) throw new Error(`/api/auth/me 失败：HTTP ${me.status} ${short(me.text, 200)}`)
  const accountId = me.json?.accountId || me.json?.account?.id || ''
  if (!accountId) throw new Error(`/api/auth/me 没有返回 accountId：${short(me.text, 200)}`)
  return accountId
}

async function obtainPairingCode(options) {
  if (options.code !== '') {
    if (!/^\d{6}$/.test(options.code)) throw new Error(`--code 必须是 6 位数字：${options.code}`)
    return { code: options.code, source: '--code' }
  }
  if (options.sessionToken !== '') {
    const accountId = options.account || (await resolveAccountId(options.base, options.sessionToken))
    const res = await requestJson(`${options.base}/api/pairing/code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.sessionToken}` },
      body: { accountId },
    })
    if (res.status !== 200 || !res.json?.code) {
      throw new Error(`已认证签发配对码失败：\n  ${pairingFailureHint(res)}`)
    }
    return { code: String(res.json.code), source: `session-token（${accountId}）` }
  }
  const accountId = options.account || `acc_browser_${Date.now()}_${randomBytes(4).toString('hex')}`
  const res = await requestJson(`${options.base}/api/pairing/code`, {
    method: 'POST',
    body: { accountId },
  })
  if (res.status !== 200 || !res.json?.code) {
    throw new Error(`匿名签发配对码失败（accountId=${accountId}）：\n  ${pairingFailureHint(res)}`)
  }
  return { code: String(res.json.code), source: `匿名 bootstrap（${accountId}）` }
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
  }

  async connect(timeoutMs = 10_000) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node 没有全局 WebSocket；需要 Node >= 22（本脚本零依赖）')
    }
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`CDP WebSocket 错误：${event?.message || 'unknown'}`))
      })
    })
    ws.addEventListener('message', (event) => this._onMessage(event.data))
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, entry] of this.pending) {
        entry.reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    })
  }

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`))
      else entry.resolve(msg.result)
      return
    }
    // 事件：只留调试钩子，不落盘。
    if (msg.method === 'Runtime.exceptionThrown') {
      this.lastException = msg.params?.exceptionDetails?.text || ''
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // 关不掉也不影响结果
    }
  }
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.deadline = Date.now() + 600_000
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId)
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: false,
    })
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails
      const message = detail.exception?.description || detail.text || 'evaluate 抛错'
      throw new Error(`页面脚本抛错：${short(message, 300)}`)
    }
    return result?.result?.value
  }

  async waitFor(expression, { timeout = 20_000, label = expression, interval = 200 } = {}) {
    const started = Date.now()
    const limit = Math.min(timeout, Math.max(0, this.deadline - Date.now()))
    let lastError = ''
    while (Date.now() - started <= limit) {
      try {
        const value = await this.evaluate(expression)
        if (value) return value
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await sleep(interval)
    }
    const suffix = lastError === '' ? '' : `（最后一次页面错误：${short(lastError, 160)}）`
    throw new Error(`等待超时（${limit}ms）：${label}${suffix}`)
  }

  async navigate(url) {
    await this.send('Page.navigate', { url })
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    })
  }

  async click(selectorOrText) {
    const arg = JSON.stringify(selectorOrText)
    const result = await this.evaluate(`(() => {
      const target = ${arg};
      const isSelector = /^[#.\\[a-zA-Z]/.test(target) && !/[\\u4e00-\\u9fa5]/.test(target);
      let el = null;
      if (isSelector) {
        try { el = document.querySelector(target); } catch { el = null; }
      }
      if (!el) {
        const all = [...document.querySelectorAll('button, a, label, [role="button"], input[type="submit"]')];
        const matches = all.filter((node) => {
          if (!node || node.offsetParent === null) return false;
          const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
          const aria = node.getAttribute && (node.getAttribute('aria-label') || '');
          return text.includes(target) || aria.includes(target);
        });
        matches.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        el = matches[0] || null;
      }
      if (!el) {
        // 允许“文本 → 同 label 里的控件”这一层：例如勾选行标签。
        const labels = [...document.querySelectorAll('label')].filter((node) => (node.innerText || '').includes(target));
        if (labels.length > 0) {
          const control = labels[0].querySelector('input, button, select, textarea');
          if (control) el = control;
          else el = labels[0];
        }
      }
      if (!el) return { ok: false };
      if (el.disabled) return { ok: false, disabled: true, text: (el.innerText || '').trim().slice(0, 80) };
      el.scrollIntoView({ block: 'center' });
      el.focus?.();
      el.click();
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      };
    })()`)
    if (!result?.ok) {
      throw new Error(
        result?.disabled
          ? `控件被禁用，无法点击：${selectorOrText}`
          : `找不到可点击的控件：${selectorOrText}`
      )
    }
    return result
  }

  async type(selector, value) {
    const arg = JSON.stringify(selector)
    const val = JSON.stringify(String(value))
    const result = await this.evaluate(`(() => {
      const el = document.querySelector(${arg});
      if (!el) return { ok: false, reason: 'not-found' };
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${val});
      else el.value = ${val};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    })()`)
    if (!result?.ok) throw new Error(`找不到输入框：${selector}`)
    return result
  }

  async pressDigit(digit) {
    // 用 CDP 真实插入文本，触发 #code-N 的 input 事件（配对码 6 个格子各 1 位）。
    await this.send('Input.insertText', { text: String(digit) })
  }

  async text(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? (el.innerText || el.textContent || '').trim() : '';
    })()`)
  }

  async screenshot(filePath) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const buffer = Buffer.from(data, 'base64')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buffer)
    return { filePath, bytes: buffer.length }
  }

  async dump() {
    try {
      return await this.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        };
        const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"]')]
          .filter(visible)
          .slice(0, 40)
          .map((el) => {
            const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
            return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (label ? ' "' + label + '"' : '');
          });
        return {
          url: location.href,
          hash: location.hash,
          title: document.title,
          bodyText: (document.body.innerText || '').slice(0, 500),
          controls,
        };
      })()`)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), url: '(页面不可读)' }
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome 启动
// ---------------------------------------------------------------------------

function pickPort() {
  return randomInt(9300, 9899)
}

async function launchChrome(options) {
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`)
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-browser-e2e-'))
  const port = pickPort()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ]
  if (!options.headful) args.unshift('--headless=new')
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderrChunks = []
  proc.stderr.on('data', (chunk) => {
    const text = String(chunk)
    stderrChunks.push(text)
    if (stderrChunks.length > 200) stderrChunks.shift()
  })
  let exited = null
  proc.on('exit', (code, signal) => {
    exited = { code, signal }
  })

  const endpoint = `http://127.0.0.1:${port}`
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    if (exited) {
      throw new Error(
        `Chrome 提前退出（code=${exited.code} signal=${exited.signal}）：\n${short(stderrChunks.join(''), 800)}`
      )
    }
    try {
      const version = await httpGetJson(`${endpoint}/json/version`)
      if (version?.webSocketDebuggerUrl) {
        return { proc, port, endpoint, profileDir, wsUrl: version.webSocketDebuggerUrl, version }
      }
    } catch {
      // 还没起来
    }
    await sleep(150)
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    // ignore
  }
  throw new Error(`等不到 Chrome DevTools 端口 ${port}：\n${short(stderrChunks.join(''), 800)}`)
}

async function createPage(cdp, base) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = new Page(cdp, sessionId)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.setViewport(VIEWPORT.width, VIEWPORT.height)
  await page.send('Page.navigate', { url: base })
  return { page, targetId }
}

// ---------------------------------------------------------------------------
// 流程
// ---------------------------------------------------------------------------

async function run() {
  const options = parseArgs(process.argv.slice(2))
  const startedAll = Date.now()
  const deadline = startedAll + options.timeout
  const steps = []
  let chrome = null
  let cdp = null
  let page = null
  let screenshot = null
  let codeInfo = null

  const elapsed = () => Date.now() - startedAll

  async function step(name, detail, fn) {
    const started = Date.now()
    log(`\n▶ ${name}`)
    try {
      const result = await fn()
      const ms = Date.now() - started
      steps.push({ name, status: 'PASS', ms, detail, result: result ?? null })
      log(`  PASS ${ms}ms${detail ? ` · ${detail}` : ''}`)
      return result
    } catch (error) {
      const ms = Date.now() - started
      const dump = page ? await page.dump() : null
      steps.push({ name, status: 'FAIL', ms, detail, error: error instanceof Error ? error.message : String(error), dump })
      log(`  FAIL ${ms}ms`)
      log(`  原因：${error instanceof Error ? error.message : String(error)}`)
      if (dump) {
        log(`  当前 URL：${dump.url || dump.hash || '(未知)'}`)
        log(`  页面标题：${dump.title || '(空)'}`)
        log(`  body.innerText（前 500 字）：`)
        log(`  ${String(dump.bodyText || dump.error || '').replace(/\n/g, '\n  ')}`)
        if (Array.isArray(dump.controls) && dump.controls.length > 0) {
          log(`  可见控件（前 40 个）：`)
          for (const line of dump.controls) log(`    - ${line}`)
        }
      }
      throw error
    }
  }

  function assertOverallTime(label) {
    if (Date.now() > deadline) {
      throw new Error(`总超时（${options.timeout}ms）已到，停在：${label}`)
    }
  }

  try {
    // ---- a) 配对码 -------------------------------------------------------
    log(`== Roost 浏览器 E2E ==`)
    log(`base=${options.base} headful=${options.headful} out=${options.out} timeout=${options.timeout}ms`)
    codeInfo = await step('a. 取得配对码', 'HTTP POST /api/pairing/code', async () => {
      const info = await obtainPairingCode(options)
      log(`  code=${info.code} 来源=${info.source}`)
      return info
    })

    // ---- 启动 Chrome -----------------------------------------------------
    const chromeInfo = await step('a0. 启动 Chrome + CDP', 'headless / CDP', async () => {
      let lastError = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const launched = await launchChrome(options)
          log(`  Chrome ${launched.version.Browser || ''} · DevTools ${launched.endpoint}`)
          return launched
        } catch (error) {
          lastError = error
          log(`  启动失败（第 ${attempt + 1} 次）：${short(error instanceof Error ? error.message : String(error), 200)}`)
          await sleep(300)
        }
      }
      throw lastError || new Error('Chrome 启动失败')
    })
    chrome = chromeInfo
    cdp = new CDP(chromeInfo.wsUrl)
    await cdp.connect()
    cdp.deadline = deadline
    const created = await createPage(cdp, options.base)
    page = created.page
    page.deadline = deadline
    await page.waitFor('document.readyState === "complete"', { timeout: 15_000, label: '首页加载完成' })

    // ---- b) 配对 ---------------------------------------------------------
    const pairInfo = await step('b. 首页填配对码并配对', '#code-0 … #pair-submit', async () => {
      await page.waitFor(
        'window.__roostBooted === true && document.querySelector("#pair-form") && !document.querySelector("#pair-view").hidden',
        { timeout: 15_000, label: '配对页可见且脚本已启动' }
      )
      const digits = String(codeInfo.code).split('')
      for (let i = 0; i < digits.length; i += 1) {
        const focused = await page.evaluate(`(() => {
          const el = document.querySelector('#code-${i}');
          if (!el) return false;
          el.focus();
          return document.activeElement === el;
        })()`)
        if (!focused) throw new Error(`第 ${i + 1} 个配对码格子聚焦失败`)
        await page.pressDigit(digits[i])
      }
      const filled = await page.evaluate(
        '[...document.querySelectorAll(".code-digit")].map((el) => el.value).join("")'
      )
      if (filled !== codeInfo.code) {
        throw new Error(`配对码没有填满：期望 ${codeInfo.code}，实际 ${JSON.stringify(filled)}`)
      }
      await page.click('#pair-submit')

      // 成功会离开配对页（去房间或 Bot 页）；失败会显示 #pair-error。
      const outcome = await page.waitFor(
        `(() => {
          const err = document.querySelector('#pair-error');
          if (err && !err.hidden && (err.textContent || '').trim() !== '') {
            return { kind: 'error', text: err.textContent.trim() };
          }
          const pageView = document.querySelector('#page-view');
          const roomView = document.querySelector('#room-view');
          const entered = (pageView && !pageView.hidden) || (roomView && !roomView.hidden);
          if (entered) return { kind: 'entered', hash: location.hash };
          return null;
        })()`,
        { timeout: 30_000, label: '配对成功并进入应用（或出现 #pair-error）' }
      )
      if (outcome?.kind === 'error') throw new Error(`配对被拒绝：${outcome.text}`)
      log(`  进入 ${outcome.hash}`)
      return outcome
    })

    // ---- c) 两个 Bot -----------------------------------------------------
    const botNames = ['浏览器甲', '浏览器乙']
    const createdBots = []
    for (let index = 0; index < botNames.length; index += 1) {
      const name = botNames[index]
      const bot = await step(`c${index + 1}. 新建 Bot「${name}」`, '#bot-name / #bot-model / 创建 Bot', async () => {
        assertOverallTime(`新建 Bot ${name}`)
        await page.evaluate(`location.hash = '#/bots/new'`)
        await page.waitFor(
          'document.querySelector("#bot-name") && document.querySelector("#bot-model")',
          { timeout: 15_000, label: '新建 Bot 表单出现' }
        )
        await page.type('#bot-name', name)
        await page.type('#bot-role', '验收')
        await page.type('#bot-model', 'deepseek-chat')
        const model = await page.evaluate('document.querySelector("#bot-model").value')
        if (model !== 'deepseek-chat') throw new Error(`模型输入框值不对：${model}`)
        await page.click('创建 Bot')
        const outcome = await page.waitFor(
          `(() => {
            const err = document.querySelector('#page-main .inline-error, #page-main [role="alert"]');
            if (err && (err.textContent || '').trim() !== '') return { kind: 'error', text: err.textContent.trim() };
            if (location.hash.startsWith('#/bots/') && !location.hash.endsWith('/new')) {
              return { kind: 'ok', hash: location.hash, title: document.title };
            }
            return null;
          })()`,
          { timeout: 30_000, label: 'Bot 创建成功并进入设置页' }
        )
        if (outcome?.kind === 'error') throw new Error(`创建 Bot 失败：${outcome.text}`)
        log(`  ${outcome.hash}`)
        return { name, hash: outcome.hash }
      })
      createdBots.push(bot)
    }

    // ---- d) 建群 ---------------------------------------------------------
    const room = await step('d. 通过 UI 建群（成员两个 Bot / host 第一个 / everyone）', '#/rooms/new', async () => {
      assertOverallTime('建群')
      await page.evaluate(`location.hash = '#/rooms/new'`)
      await page.waitFor(
        'document.querySelector("#page-main #room-name") && document.querySelector("input[name=\\"room-members\\"]")',
        { timeout: 15_000, label: '建群表单出现' }
      )
      await page.type('#page-main #room-name', '浏览器验收组')
      for (const name of botNames) {
        const clicked = await page.evaluate(`(() => {
          const inputs = [...document.querySelectorAll('input[name="room-members"]')];
          const input = inputs.find((node) => (node.closest('label')?.textContent || '').includes(${JSON.stringify(name)}));
          if (!input) return { ok: false, reason: 'no-input' };
          // 不用 input.click()（headless 下曾抛 Illegal invocation）；直接落 checked + change，
          // 效果与用户勾选一致：checkboxList 的 onChange 会收到事件并同步 host/responder。
          if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { ok: true, checked: input.checked, value: input.value };
        })()`)
        if (!clicked?.ok || !clicked.checked) {
          throw new Error(`勾选成员「${name}」失败：${JSON.stringify(clicked)}`)
        }
      }
      // 发言模式默认 everyone；若不是，按 UI 语义选中它。
      await page.evaluate(`(() => {
        const radio = [...document.querySelectorAll('input[type="radio"]')].find((input) => input.value === 'everyone');
        if (radio && !radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return Boolean(radio);
      })()`)
      const formState = await page.evaluate(`(() => {
        const checks = [...document.querySelectorAll('input[name="room-members"]')];
        const checked = checks.filter((input) => input.checked).map((input) => input.value);
        const host = document.querySelector('#room-host');
        const responder = [...document.querySelectorAll('input[type="radio"]')].find((input) => input.checked);
        return {
          checkedCount: checked.length,
          checked,
          host: host ? { value: host.value, text: host.options[host.selectedIndex]?.textContent || '' } : null,
          responder: responder ? responder.value : '',
          submitDisabled: [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('创建房间'))?.disabled,
        };
      })()`)
      log(`  成员=${formState.checkedCount} host=${formState.host?.text || '(空)'} responder=${formState.responder}`)
      if (formState.checkedCount !== 2) throw new Error(`应勾选 2 个成员，实际 ${formState.checkedCount}`)
      if (formState.responder !== 'everyone') throw new Error(`responder 不是 everyone：${formState.responder}`)
      if (!String(formState.host?.text || '').includes(botNames[0])) {
        throw new Error(`host 默认不是第一个勾选的成员：${JSON.stringify(formState.host)}`)
      }
      if (formState.submitDisabled) throw new Error('创建房间按钮仍被禁用')
      await page.click('创建房间')
      const outcome = await page.waitFor(
        `(() => {
          const err = document.querySelector('#page-main .inline-error, #page-main [role="alert"]');
          if (err && (err.textContent || '').trim() !== '') return { kind: 'error', text: err.textContent.trim() };
          if (/^#\\/rooms\\/[^/]+$/.test(location.hash)) return { kind: 'ok', hash: location.hash };
          return null;
        })()`,
        { timeout: 30_000, label: '建群成功并进入房间' }
      )
      if (outcome?.kind === 'error') throw new Error(`建群失败：${outcome.text}`)
      await page.waitFor(
        'document.querySelector("#composer") && document.querySelector("#composer").disabled === false',
        { timeout: 20_000, label: '房间输入框可用' }
      )
      // #room-name 在房间页是 h1；applyLiveRoomChrome 异步写入，等它变成我们建的名字再读。
      await page.waitFor(
        'document.querySelector("#room-name") && document.querySelector("#room-name").innerText.trim() === "浏览器验收组"',
        { timeout: 10_000, label: '房间标题更新为「浏览器验收组」' }
      )
      const roomName = await page.text('#room-name')
      log(`  ${outcome.hash} 房间名=${roomName}`)
      const who = await page.text('#who-answers')
      log(`  谁会回答：${who}`)
      return { hash: outcome.hash, name: roomName, members: formState.checkedCount, host: formState.host?.text, responder: formState.responder }
    })

    // ---- e) 第一轮 -------------------------------------------------------
    // 建群可能触发 kickoff：先等 Bot 消息数稳定，避免把 kickoff 的回复算成本轮。
    async function waitQuiet(stableMs = 6000, maxMs = 120_000) {
      const started = Date.now()
      let last = -1
      let since = Date.now()
      while (Date.now() - started < maxMs) {
        const count = await page.evaluate('document.querySelectorAll(".msg.msg-bot").length')
        if (count !== last) {
          last = count
          since = Date.now()
        } else if (Date.now() - since >= stableMs) {
          if (count > 0) log(`  房间已有 ${count} 条 Bot 消息（kickoff），已静默 ${stableMs}ms`)
          return count
        }
        await sleep(300)
      }
      return last
    }

    async function sendAndWait(text, expectedNew, timeoutMs) {
      await waitQuiet()
      const base = await page.evaluate(`(() => ({
        bots: document.querySelectorAll('.msg.msg-bot').length,
        users: document.querySelectorAll('.msg.msg-user').length,
      }))()`)
      await page.type('#composer', text)
      const enabled = await page.evaluate('!document.querySelector("#send").disabled')
      if (!enabled) throw new Error('发送按钮仍被禁用（输入框内容没有生效）')
      await page.click('#send')
      log(`  已发送：${text}`)
      try {
        await page.waitFor(
          `document.querySelectorAll('.msg.msg-user').length >= ${base.users + 1}`,
          { timeout: 15_000, label: '自己的消息出现在房间里' }
        )
        // 只数“最后一条用户消息之后”的 Bot 消息，避免把之前的 kickoff 回复算进来。
        await page.waitFor(
          `(() => {
            const list = document.querySelector('#messages');
            if (!list) return false;
            const rows = [...list.children];
            const userIndex = rows.map((row) => row.classList.contains('msg-user')).lastIndexOf(true);
            if (userIndex < 0) return false;
            return rows.slice(userIndex + 1).filter((row) => row.classList.contains('msg-bot')).length >= ${expectedNew};
          })()`,
          { timeout: timeoutMs, label: `${expectedNew} 条新的 Bot 消息（在最后一条用户消息之后）` }
        )
      } catch (error) {
        const composerError = await page.evaluate(
          '(() => { const el = document.querySelector("#composer-error"); return el && !el.hidden ? el.textContent.trim() : ""; })()'
        )
        if (composerError) throw new Error(`发送失败：${composerError}`)
        throw error
      }
      const messages = await page.evaluate(`(() => {
        const list = document.querySelector('#messages');
        if (!list) return [];
        const rows = [...list.children];
        const userIndex = rows.map((row) => row.classList.contains('msg-user')).lastIndexOf(true);
        return rows
          .slice(userIndex + 1)
          .filter((row) => row.classList.contains('msg-bot'))
          .map((node) => ({
            name: (node.querySelector('.msg-name')?.innerText || '').trim(),
            text: (node.querySelector('.bubble-bot')?.innerText || '').replace(/\\s+/g, ' ').trim(),
          }));
      })()`)
      return { before: base.bots, after: base.bots + expectedNew, messages }
    }

    const round1 = await step('e. 第一轮：发送并等两个 Bot 回复', '#composer → #send', async () => {
      assertOverallTime('第一轮对话')
      const result = await sendAndWait('请用一句话回答：现在是浏览器验收。', 2, options.botTimeout)
      for (const message of result.messages) log(`  ${message.name}：${short(message.text, 180)}`)
      const names = result.messages.map((message) => message.name)
      if (names.length < 2) throw new Error(`只收到 ${names.length} 条 Bot 消息`)
      if (result.messages.some((message) => message.text === '')) throw new Error('有 Bot 消息正文为空')
      return result
    })

    // ---- f) 第二轮 -------------------------------------------------------
    const round2 = await step('f. 第二轮追问并等两个 Bot 回复', '#composer → #send', async () => {
      assertOverallTime('第二轮对话')
      const result = await sendAndWait('追问：请用一句话说明你刚才回答了什么。', 2, options.botTimeout)
      for (const message of result.messages) log(`  ${message.name}：${short(message.text, 180)}`)
      if (result.messages.length < 2) throw new Error(`只收到 ${result.messages.length} 条 Bot 消息`)
      if (result.messages.some((message) => message.text === '')) throw new Error('有 Bot 消息正文为空')
      return result
    })

    // ---- g) 截图 ---------------------------------------------------------
    const shot = await step('g. 截图 1440x900', options.out, async () => {
      await page.setViewport(VIEWPORT.width, VIEWPORT.height)
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
      await sleep(300)
      const outPath = path.isAbsolute(options.out) ? options.out : path.join(REPO_ROOT, options.out)
      return page.screenshot(outPath)
    })
    screenshot = shot

    // ---- 汇总 ------------------------------------------------------------
    const totalMs = elapsed()
    const summary = {
      ok: true,
      base: options.base,
      at: stamp(),
      totalMs,
      codeSource: codeInfo?.source || '',
      room,
      rounds: [round1, round2],
      screenshot: shot,
      steps,
    }
    log(`\n== PASS == 总耗时 ${(totalMs / 1000).toFixed(1)}s`)
    log(`截图：${shot.filePath}（${shot.bytes} bytes）`)
    log(`配对：${pairInfo.hash} · Bot：${createdBots.map((bot) => bot.name).join('、')}`)
    log(`房间：${room.name}（${room.hash}）`)
    log(`第一轮 Bot 回复：${round1.messages.map((m) => m.name).join('、')}`)
    log(`第二轮 Bot 回复：${round2.messages.map((m) => m.name).join('、')}`)
    log('RESULT_JSON ' + JSON.stringify(summary))
    return summary
  } catch (error) {
    const totalMs = elapsed()
    let failureShot = null
    if (page) {
      try {
        failureShot = await page.screenshot(path.join(os.tmpdir(), 'roost-browser-e2e-fail.png'))
      } catch {
        failureShot = null
      }
    }
    const failed = steps.find((entry) => entry.status === 'FAIL')
    const summary = {
      ok: false,
      base: options.base,
      at: stamp(),
      totalMs,
      failedStep: failed?.name || 'unknown',
      error: error instanceof Error ? error.message : String(error),
      screenshot: failureShot,
      steps,
    }
    log(`\n== FAIL == 总耗时 ${(totalMs / 1000).toFixed(1)}s`)
    log(`失败步骤：${summary.failedStep}`)
    log(`原因：${summary.error}`)
    if (failureShot) log(`失败时截图（临时）：${failureShot.filePath}`)
    log('RESULT_JSON ' + JSON.stringify(summary))
    return summary
  } finally {
    cdp?.close()
    if (chrome?.proc) {
      try {
        chrome.proc.kill('SIGTERM')
      } catch {
        // ignore
      }
      await sleep(400)
      try {
        chrome.proc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    if (chrome?.profileDir && !options.keepProfile) {
      try {
        fs.rmSync(chrome.profileDir, { recursive: true, force: true })
      } catch {
        // profile 删不掉不改变验收结论
      }
    }
  }
}

run()
  .then((summary) => {
    process.exitCode = summary.ok ? 0 : 1
  })
  .catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exitCode = 1
  })
