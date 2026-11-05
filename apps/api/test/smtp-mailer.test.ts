import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { test } from 'node:test'

import { createSmtpMailer, createSmtpMailerFromEnv } from '../src/smtp-mailer.ts'

function startFakeSmtp(): Promise<{ port: number; mail: () => string; close: () => Promise<void> }> {
  let captured = ''
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    socket.write('220 fake-smtp\r\n')
    let buffer = ''
    let inData = false
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          captured += buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 queued\r\n')
          continue
        }
        const index = buffer.indexOf('\r\n')
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (line.startsWith('EHLO ')) socket.write('250-fake\r\n250 AUTH LOGIN\r\n')
        else if (line === 'STARTTLS') socket.write('500 no starttls\r\n')
        else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n')
        else if (line === Buffer.from('user').toString('base64')) socket.write('334 UGFzc3dvcmQ6\r\n')
        else if (line === Buffer.from('pass').toString('base64')) socket.write('235 authenticated\r\n')
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 ok\r\n')
        else if (line === 'DATA') {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else socket.write('250 ok\r\n')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        mail: () => captured,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

test('SMTP mailer 发送验证邮件并带正确链接', async () => {
  const fake = await startFakeSmtp()
  try {
    const mailer = createSmtpMailer({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      user: 'user',
      pass: 'pass',
      from: 'Roost <no-reply@roostbots.com>',
      baseUrl: 'https://roostbots.com'
    })
    await mailer.sendVerificationEmail?.({ to: 'a@example.com', token: 'abc123', expiresAt: Date.now() + 1000 })
    const text = fake.mail()
    assert.match(text, /To: a@example\.com/)
    assert.match(text, /https:\/\/roostbots\.com\/#\/verify-email\?token=abc123/)
    assert.match(text, /验证你的 Roost 邮箱|verify-email/)
  } finally {
    await fake.close()
  }
})

test('未配置 SMTP_HOST 时返回 null，保持日志模式', () => {
  assert.equal(createSmtpMailerFromEnv({}), null)
  assert.equal(createSmtpMailerFromEnv({ ROOST_SMTP_HOST: 'smtp.example.com' }), null)
})
