// 账号页：#/login、#/register、#/verify-email、#/reset、#/reset-confirm
// （docs/design/auth.md §4/§10、docs/build/wave1.md §A/§D）。
//
// 表单校验与 payload 形状在 lib/auth-flow.js；本文件只建 DOM、发请求、就地显示错误。
// 会话在 HttpOnly cookie 里；登录成功由 app.js 的 completeAuth 接管（回 pendingRoute）。
// OIDC：GET /api/auth/providers 404 时整块隐藏，不显示“点了没反应”的按钮。

import { isAuthError, isMissingRoute } from '../lib/api-client.js'
import {
  authFailureMessage,
  authProviders,
  authSuccessMessage,
  isSafeAuthorizeUrl,
  loginPayload,
  registerPayload,
  resetPayload,
  resetRequestPayload,
  verifyEmailPayload,
} from '../lib/auth-flow.js'
import { el } from '../lib/dom.js'
import * as ui from '../lib/ui.js'

function authCard(title, subtitle, children, footer) {
  const card = el('section', { class: 'page-card auth-card' })
  card.append(el('h1', { class: 'auth-title', text: title }))
  if (subtitle) card.append(el('p', { class: 'auth-subtitle muted', text: subtitle }))
  for (const child of children) if (child) card.append(child)
  if (footer) card.append(el('div', { class: 'auth-foot' }, footer))
  return card
}

function authShell(card) {
  const root = el('div', { class: 'auth-shell' })
  root.append(el('a', { class: 'wordmark auth-wordmark', href: '#/', text: 'Roost' }), card)
  return root
}

function authNoticeNode(ctx) {
  const message = typeof ctx.consumeAuthNotice === 'function' ? ctx.consumeAuthNotice() : ''
  if (message === '') return el('p', { class: 'auth-notice', hidden: true })
  return el('p', { class: 'auth-notice', role: 'status', text: message })
}

function fieldError(result, controls, errorNode) {
  const control = controls[result.field] || controls[Object.keys(controls)[0]] || null
  ui.setError(errorNode, result.message)
  if (control) {
    ui.setFieldInvalid(control, true, errorNode)
    control.focus()
  }
}

function isProviderRouteMissing(error) {
  return isMissingRoute(error) || error.status === 405 || error.status === 501 || error.status === 404
}

async function providerSection(ctx, errorNode) {
  const host = el('div', { class: 'auth-providers', hidden: true })
  let data
  try {
    data = await ctx.api.get('/api/auth/providers')
  } catch (error) {
    if (isAuthError(error)) {
      // 未登录访问 providers 不应 401；真 401 时仍然隐藏，不让按钮成为假入口。
      host.hidden = true
      return host
    }
    // 404/405/501：OIDC 未配置，整块隐藏（wave1 §D）。
    if (isProviderRouteMissing(error)) {
      host.hidden = true
      return host
    }
    host.hidden = false
    host.append(
      el('p', { class: 'field-hint', text: `第三方登录暂不可用：${error instanceof Error ? error.message : String(error)}` })
    )
    return host
  }

  const providers = authProviders(data)
  if (providers.length === 0) {
    host.hidden = true
    return host
  }
  host.hidden = false
  host.append(el('p', { class: 'auth-divider', text: '或使用第三方账号' }))
  const row = el('div', { class: 'auth-provider-row' })
  for (const provider of providers) {
    const button = ui.button(provider.label, {
      variant: 'outline',
      block: true,
      onClick: () => void startOidc(provider, button, errorNode),
    })
    row.append(button)
  }
  host.append(row)
  host.append(el('p', { class: 'field-hint', text: '首次使用会在提供方完成注册，然后自动创建 Roost 账号。' }))
  return host

  async function startOidc(provider, button, error) {
    ui.setError(error, '')
    ui.setBusy(button, true, `正在打开 ${provider.label}…`)
    try {
      const result = await ctx.api.post('/api/auth/oidc/start', { provider: provider.id })
      const url = result && typeof result.authorizeUrl === 'string' ? result.authorizeUrl : ''
      if (!isSafeAuthorizeUrl(url)) {
        ui.setError(error, '第三方登录返回的地址不合法；这次没有跳转，也没有登录。')
        return
      }
      if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
        window.location.assign(url)
        return
      }
      ui.setError(error, `这个环境不能跳转；请手动打开 authorizeUrl。`)
    } catch (cause) {
      if (isProviderRouteMissing(cause)) {
        host.hidden = true
        ui.setError(error, '第三方登录未配置（HTTP 404）；已隐藏按钮。')
        return
      }
      ui.setError(error, authFailureMessage(cause, 'login'))
    } finally {
      if (button.isConnected) ui.setBusy(button, false)
    }
  }
}

function loginLinks() {
  return [
    el('a', { href: '#/register', text: '注册账号' }),
    el('span', { class: 'muted', text: ' · ' }),
    el('a', { href: '#/reset', text: '忘记密码' }),
    el('span', { class: 'muted', text: ' · ' }),
    el('a', { href: '#/', text: '用配对码登录' }),
  ]
}

export async function mountLoginPage(root, ctx) {
  const state = typeof ctx.authState === 'function' ? ctx.authState() : null
  if (state && state.status === 'authenticated') {
    root.replaceChildren(
      authShell(
        authCard('已登录', state.account?.email ? `当前账号：${state.account.email}` : '当前设备已经有账号会话。', [
          el('p', { class: 'field-hint', text: '会话在 HttpOnly cookie 里；进入工作区不需要再输一次密码。' }),
          el('div', { class: 'auth-actions' }, [
            ui.button('进入工作区', {
              variant: 'primary',
              onClick: () => void ctx.completeAuth(null),
            }),
          ]),
        ], loginLinks())
      )
    )
    return
  }

  const email = ui.input({
    id: 'auth-login-email',
    type: 'email',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    required: true,
  })
  const password = ui.input({
    id: 'auth-login-password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
  })
  const error = ui.inlineError()
  const status = ui.statusLine('')
  const submit = ui.button('登录', { variant: 'primary', type: 'submit', block: true })
  const form = el('form', { class: 'form auth-form', novalidate: true })
  form.append(
    authNoticeNode(ctx),
    ui.field('邮箱', email, { id: 'auth-login-email', required: true }),
    ui.field('密码', password, { id: 'auth-login-password', required: true }),
    error,
    status,
    submit
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(status, '')
    const result = loginPayload({ email: email.value, password: password.value })
    if (!result.ok) {
      fieldError(result, { email, password }, error)
      return
    }
    ui.setBusy(submit, true, '登录中…')
    try {
      const body = await ctx.api.post('/api/auth/login', result.payload)
      if (body && typeof body.csrfToken === 'string' && typeof ctx.api.setCsrfToken === 'function') {
        ctx.api.setCsrfToken(body.csrfToken)
      }
      ui.setStatus(status, authSuccessMessage('login'))
      await ctx.completeAuth(body)
    } catch (cause) {
      if (isAuthError(cause)) {
        ui.setError(error, authFailureMessage(cause, 'login'))
        password.focus()
        password.select?.()
        return
      }
      ui.setError(error, authFailureMessage(cause, 'login'))
    } finally {
      if (submit.isConnected) ui.setBusy(submit, false)
    }
  })

  const card = authCard('登录', '账号会话保存在 HttpOnly cookie 里；登录后回到刚才的页面。', [
    form,
    el('div', { class: 'auth-providers-host' }),
  ], loginLinks())
  const host = card.querySelector('.auth-providers-host')
  host.append(await providerSection(ctx, error))
  root.replaceChildren(authShell(card))
}

export async function mountRegisterPage(root, ctx) {
  const email = ui.input({
    id: 'auth-register-email',
    type: 'email',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    required: true,
  })
  const password = ui.input({
    id: 'auth-register-password',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  })
  const confirm = ui.input({
    id: 'auth-register-confirm',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  })
  const error = ui.inlineError()
  const status = ui.statusLine('')
  const submit = ui.button('创建账号', { variant: 'primary', type: 'submit', block: true })
  let completed = false
  const form = el('form', { class: 'form auth-form', novalidate: true })
  form.append(
    authNoticeNode(ctx),
    ui.field('邮箱', email, { id: 'auth-register-email', required: true }),
    ui.field('密码', password, {
      id: 'auth-register-password',
      required: true,
      hint: '至少 12 位；密码只保存 scrypt 哈希，服务端不会回显。',
    }),
    ui.field('确认密码', confirm, { id: 'auth-register-confirm', required: true }),
    error,
    status,
    submit
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(status, '')
    const result = registerPayload({ email: email.value, password: password.value, confirm: confirm.value })
    if (!result.ok) {
      fieldError(result, { email, password, confirm }, error)
      return
    }
    ui.setBusy(submit, true, '创建中…')
    try {
      await ctx.api.post('/api/auth/register', result.payload)
      ui.setStatus(status, authSuccessMessage('register'))
      status.append(el('a', { href: '#/verify-email', text: '去验证邮箱' }))
      completed = true
      ui.setBusy(submit, false)
      submit.disabled = true
    } catch (cause) {
      ui.setError(error, authFailureMessage(cause, 'register'))
    } finally {
      if (!completed && submit.isConnected) ui.setBusy(submit, false)
    }
  })

  root.replaceChildren(
    authShell(
      authCard(
        '注册',
        '邮箱 + 密码创建账号；验证邮箱后再登录。',
        [form],
        [el('a', { href: '#/login', text: '已经有账号？登录' }), el('span', { class: 'muted', text: ' · ' }), el('a', { href: '#/', text: '用配对码登录' })]
      )
    )
  )
}

export async function mountVerifyEmailPage(root, ctx, params = {}) {
  const token = ui.input({
    id: 'auth-verify-token',
    value: typeof params.token === 'string' ? params.token : '',
    autocomplete: 'one-time-code',
    placeholder: '邮件里的验证 token',
    required: true,
  })
  const error = ui.inlineError()
  const status = ui.statusLine('')
  const submit = ui.button('验证邮箱', { variant: 'primary', type: 'submit' })
  let completed = false
  const form = el('form', { class: 'form auth-form', novalidate: true })
  form.append(
    authNoticeNode(ctx),
    ui.field('验证 token', token, {
      id: 'auth-verify-token',
      required: true,
      hint: '从验证邮件链接里带过来；也可以用 resend 重新发一封。',
    }),
    error,
    status,
    submit
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(status, '')
    const result = verifyEmailPayload({ token: token.value })
    if (!result.ok) {
      fieldError(result, { token }, error)
      return
    }
    ui.setBusy(submit, true, '验证中…')
    try {
      await ctx.api.post('/api/auth/verify-email', result.payload)
      ui.setStatus(status, authSuccessMessage('verify'))
      status.append(el('a', { href: '#/login', text: '去登录' }))
      completed = true
      ui.setBusy(submit, false)
      submit.disabled = true
    } catch (cause) {
      ui.setError(error, authFailureMessage(cause, 'verify'))
    } finally {
      if (!completed && submit.isConnected) ui.setBusy(submit, false)
    }
  })

  const resendEmail = ui.input({
    id: 'auth-verify-resend-email',
    type: 'email',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    required: true,
  })
  const resendError = ui.inlineError()
  const resendStatus = ui.statusLine('')
  const resend = ui.button('重新发送验证邮件', { variant: 'ghost', type: 'submit' })
  const resendForm = el('form', { class: 'form auth-form', novalidate: true })
  resendForm.append(
    ui.field('重新发送到', resendEmail, { id: 'auth-verify-resend-email', required: true }),
    resendError,
    resendStatus,
    resend
  )
  resendForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(resendError, '')
    ui.clearFieldInvalid(resendError)
    ui.setStatus(resendStatus, '')
    const result = resetRequestPayload({ email: resendEmail.value })
    if (!result.ok) {
      fieldError(result, { email: resendEmail }, resendError)
      return
    }
    ui.setBusy(resend, true, '发送中…')
    try {
      await ctx.api.post('/api/auth/verify-email/resend', result.payload)
      ui.setStatus(resendStatus, '如果这个邮箱有待验证账号，验证邮件已重新发送。')
    } catch (cause) {
      ui.setError(resendError, authFailureMessage(cause, 'verify'))
    } finally {
      if (resend.isConnected) ui.setBusy(resend, false)
    }
  })

  root.replaceChildren(
    authShell(
      authCard(
        '验证邮箱',
        '验证 token 单次有效；过期或已用就重新发送。',
        [form, el('hr', { class: 'auth-rule' }), resendForm],
        [el('a', { href: '#/login', text: '回登录' }), el('span', { class: 'muted', text: ' · ' }), el('a', { href: '#/', text: '用配对码登录' })]
      )
    )
  )
}

export async function mountResetPage(root, ctx) {
  const email = ui.input({
    id: 'auth-reset-email',
    type: 'email',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    required: true,
  })
  const error = ui.inlineError()
  const status = ui.statusLine('')
  const submit = ui.button('发送重置邮件', { variant: 'primary', type: 'submit' })
  const form = el('form', { class: 'form auth-form', novalidate: true })
  form.append(
    authNoticeNode(ctx),
    ui.field('邮箱', email, { id: 'auth-reset-email', required: true }),
    el('p', {
      class: 'field-hint',
      text: '无论邮箱是否存在都会返回同样的结果，避免暴露账号是否存在。',
    }),
    error,
    status,
    submit
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(status, '')
    const result = resetRequestPayload({ email: email.value })
    if (!result.ok) {
      fieldError(result, { email }, error)
      return
    }
    ui.setBusy(submit, true, '发送中…')
    try {
      await ctx.api.post('/api/auth/password/reset-request', result.payload)
      ui.setStatus(status, '如果这个邮箱有账号，重置邮件已发送。到邮件里打开带 token 的链接。')
    } catch (cause) {
      ui.setError(error, authFailureMessage(cause, 'reset'))
    } finally {
      if (submit.isConnected) ui.setBusy(submit, false)
    }
  })

  root.replaceChildren(
    authShell(
      authCard(
        '重置密码',
        '输入账号邮箱；重置链接里的 token 只能使用一次。',
        [form],
        [el('a', { href: '#/reset-confirm', text: '已有 token？直接重置' }), el('span', { class: 'muted', text: ' · ' }), el('a', { href: '#/login', text: '回登录' })]
      )
    )
  )
}

export async function mountResetConfirmPage(root, ctx, params = {}) {
  const token = ui.input({
    id: 'auth-reset-token',
    value: typeof params.token === 'string' ? params.token : '',
    autocomplete: 'one-time-code',
    placeholder: '邮件里的重置 token',
    required: true,
  })
  const password = ui.input({
    id: 'auth-reset-password',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  })
  const confirm = ui.input({
    id: 'auth-reset-confirm',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  })
  const error = ui.inlineError()
  const status = ui.statusLine('')
  const submit = ui.button('设置新密码', { variant: 'primary', type: 'submit' })
  let completed = false
  const form = el('form', { class: 'form auth-form', novalidate: true })
  form.append(
    authNoticeNode(ctx),
    ui.field('重置 token', token, { id: 'auth-reset-token', required: true }),
    ui.field('新密码', password, {
      id: 'auth-reset-password',
      required: true,
      hint: '至少 12 位。',
    }),
    ui.field('确认新密码', confirm, { id: 'auth-reset-confirm', required: true }),
    error,
    status,
    submit
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(status, '')
    const result = resetPayload({ token: token.value, password: password.value, confirm: confirm.value })
    if (!result.ok) {
      fieldError(result, { token, password, confirm }, error)
      return
    }
    ui.setBusy(submit, true, '重置中…')
    try {
      await ctx.api.post('/api/auth/password/reset', result.payload)
      ui.setStatus(status, authSuccessMessage('reset'))
      status.append(el('a', { href: '#/login', text: '去登录' }))
      completed = true
      ui.setBusy(submit, false)
      submit.disabled = true
    } catch (cause) {
      ui.setError(error, authFailureMessage(cause, 'reset'))
    } finally {
      if (!completed && submit.isConnected) ui.setBusy(submit, false)
    }
  })

  root.replaceChildren(
    authShell(
      authCard(
        '设置新密码',
        'token 单次有效；设置成功后旧密码立即失效。',
        [form],
        [el('a', { href: '#/reset', text: '重新申请重置' }), el('span', { class: 'muted', text: ' · ' }), el('a', { href: '#/login', text: '回登录' })]
      )
    )
  )
}
