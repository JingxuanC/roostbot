// 零依赖 SMTP 发信：注册验证、重置密码。
//
// 只支持常见 SMTP：25 / 465（隐式 TLS）/ 587（STARTTLS）+ AUTH LOGIN。
// 环境变量见 deploy/env.example；未配置 ROOST_SMTP_HOST 时返回 null，
// 控制面保持原有的“token 写日志”模式，不影响注册本身。

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

import type { Mailer, VerificationMail, PasswordResetMail } from './auth-login-routes.ts'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
  baseUrl: string
  timeoutMs?: number
}

export function createSmtpMailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer | null {
  const host = (env['ROOST_SMTP_HOST'] ?? '').trim()
  const from = (env['ROOST_SMTP_FROM'] ?? '').trim()
  if (host === '' || from === '') return null
  const port = Number(env['ROOST_SMTP_PORT'] ?? (env['ROOST_SMTP_SECURE'] === '1' ? '465' : '587'))
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null
  const user = (env['ROOST_SMTP_USER'] ?? '').trim()
  const pass = env['ROOST_SMTP_PASS'] ?? ''
  return createSmtpMailer({
    host,
    port,
    secure: env['ROOST_SMTP_SECURE'] === '1' || port === 465,
    ...(user === '' ? {} : { user }),
    ...(user === '' ? {} : { pass }),
    from,
    baseUrl: (env['ROOST_PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:8787').trim() || 'http://127.0.0.1:8787'
  })
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  return {
    async sendVerificationEmail(mail: VerificationMail): Promise<void> {
      const link = appLink(config.baseUrl, `api/auth/verify-email/link?token=${encodeURIComponent(mail.token)}`)
      await sendOne(config, mail.to, '验证你的 Roost 邮箱', [
        '欢迎使用 Roost。',
        '',
        '请打开下面的链接验证邮箱（24 小时内有效）：',
        link,
        '',
        '如果不是你注册的，请忽略这封邮件。'
      ])
    },
    async sendPasswordResetEmail(mail: PasswordResetMail): Promise<void> {
      const link = appLink(config.baseUrl, `#/reset-confirm?token=${encodeURIComponent(mail.token)}`)
      await sendOne(config, mail.to, '重置你的 Roost 密码', [
        '我们收到了重置密码的请求。',
        '',
        '请打开下面的链接设置新密码（30 分钟内有效）：',
        link,
        '',
        '如果不是你发起的，请忽略这封邮件。'
      ])
    }
  }
}

function helloName(): string {
  return 'roostbots.com'
}

function appLink(baseUrl: string, hash: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${hash}`
}

async function sendOne(config: SmtpConfig, to: string, subject: string, lines: string[]): Promise<void> {
  const fromAddress = envelopeAddress(config.from)
  const message = buildMessage({
    from: config.from,
    to,
    subject,
    body: lines.join('\r\n')
  })
  const session = await SmtpSession.open(config)
  try {
    await session.command(`MAIL FROM:<${fromAddress}>`, [250])
    await session.command(`RCPT TO:<${to}>`, [250, 251])
    await session.command('DATA', [354])
    await session.writeData(message)
    await session.command('QUIT', [221], { optional: true })
  } finally {
    session.close()
  }
}

function buildMessage(input: { from: string; to: string; subject: string; body: string }): string {
  const headers = [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`
  ]
  const body = input.body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, ' ')
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function envelopeAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from)
  return (match?.[1] ?? from).trim()
}

class SmtpSession {
  private socket: Socket
  private buffer = ''
  private lines: string[] = []
  private waiters: Array<(line: string) => void> = []
  private closed = false
  private readonly config: SmtpConfig

  private constructor(socket: Socket, config: SmtpConfig) {
    this.socket = socket
    this.config = config
    this.attach()
  }

  static async open(config: SmtpConfig): Promise<SmtpSession> {
    const timeout = config.timeoutMs ?? 15_000
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port })
    const session = new SmtpSession(socket, config)
    socket.setTimeout(timeout, () => session.destroy(new Error('SMTP timeout')))
    await session.waitFor([220])
    await session.command(`EHLO ${helloName()}`, [250])
    if (!config.secure) {
      const starttls = await session.command('STARTTLS', [220], { optional: true })
      if (starttls) {
        await session.upgradeTls()
        await session.command(`EHLO ${helloName()}`, [250])
      }
    }
    if (config.user !== undefined && config.user !== '') {
      await session.authenticate(config.user, config.pass ?? '')
    }
    return session
  }

  async command(line: string, expected: number[], options: { optional?: boolean } = {}): Promise<boolean> {
    if (this.closed) throw new Error('SMTP connection is closed')
    this.socket.write(`${line}\r\n`)
    const response = await this.readResponse()
    if (!expected.includes(response.code)) {
      if (options.optional === true) return false
      throw new Error(`SMTP command failed: ${line.slice(0, 20)} -> ${response.code} ${response.lines.join(' ')}`)
    }
    return true
  }

  async writeData(message: string): Promise<void> {
    this.socket.write(`${message}\r\n.\r\n`)
    const response = await this.readResponse()
    if (response.code !== 250) throw new Error(`SMTP DATA failed: ${response.code}`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.end()
    } catch {
      // ignore
    }
  }

  private attach(): void {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')))
    this.socket.on('error', (error) => this.destroy(error))
    this.socket.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter('')
    })
  }

  private onData(text: string): void {
    this.buffer += text
    let index = this.buffer.indexOf('\r\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      const waiter = this.waiters.shift()
      if (waiter !== undefined) waiter(line)
      else this.lines.push(line)
      index = this.buffer.indexOf('\r\n')
    }
  }

  private readLine(): Promise<string> {
    const buffered = this.lines.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private async readResponse(): Promise<{ code: number; lines: string[] }> {
    const first = await this.readLine()
    const match = /^(\d{3})([ -])(.*)$/.exec(first)
    if (match === null) throw new Error(`SMTP protocol error: ${first.slice(0, 120)}`)
    const code = Number(match[1])
    const lines = [match[3] ?? '']
    if (match[2] === '-') {
      for (;;) {
        const line = await this.readLine()
        const next = /^(\d{3})([ -])(.*)$/.exec(line)
        if (next === null) throw new Error('SMTP multiline response malformed')
        lines.push(next[3] ?? '')
        if (next[2] === ' ') break
      }
    }
    return { code, lines }
  }

  private async waitFor(expected: number[]): Promise<void> {
    const response = await this.readResponse()
    if (!expected.includes(response.code)) throw new Error(`SMTP greeting failed: ${response.code}`)
  }

  private async authenticate(user: string, pass: string): Promise<void> {
    const start = await this.readResponseAfter('AUTH LOGIN', [334])
    if (!start) throw new Error('SMTP AUTH LOGIN not supported')
    const userResponse = await this.readResponseAfter(Buffer.from(user).toString('base64'), [334])
    if (!userResponse) throw new Error('SMTP AUTH username rejected')
    const passResponse = await this.readResponseAfter(Buffer.from(pass).toString('base64'), [235])
    if (!passResponse) throw new Error('SMTP AUTH password rejected')
  }

  private async readResponseAfter(line: string, expected: number[]): Promise<boolean> {
    this.socket.write(`${line}\r\n`)
    const response = await this.readResponse()
    return expected.includes(response.code)
  }

  private async upgradeTls(): Promise<void> {
    const upgraded = tlsConnect({ socket: this.socket, servername: this.config.host })
    await new Promise<void>((resolve, reject) => {
      upgraded.once('secureConnect', () => resolve())
      upgraded.once('error', reject)
    })
    this.socket = upgraded
    this.buffer = ''
    this.lines = []
    this.attach()
  }

  private destroy(error: Error): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.destroy()
    } catch {
      // ignore
    }
    for (const waiter of this.waiters.splice(0)) waiter('')
    void error
  }
}
