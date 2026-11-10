// 房间定时：最小表单。默认时区 Asia/Shanghai。
// 到点只把 prompt 交给隔离 run，结果写回目标房间；没话说就静默。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'

function field(label, name, value, placeholder) {
  const input = el('input', { name, value: value ?? '', placeholder: placeholder ?? '' })
  input.style.cssText = 'width:100%;margin:4px 0 12px;padding:8px;border-radius:8px;border:1px solid #333;background:#111;color:#eee'
  return el('label', { style: 'display:block;font-size:13px;color:#aaa' }, [label, input])
}

export async function mountRoutinesPage(root, ctx) {
  root.replaceChildren(el('p', { text: '正在载入房间定时…' }))
  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(el('p', { text: error instanceof Error ? error.message : '载入失败' }))
    return
  }

  const status = el('p', { text: '' })
  const list = el('div')

  async function reload() {
    list.replaceChildren()
    try {
      const data = await ctx.api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/routines`)
      const rows = Array.isArray(data?.routines) ? data.routines : []
      if (rows.length === 0) {
        list.append(el('p', { text: '还没有房间定时。' }))
        return
      }
      for (const routine of rows) {
        const row = el('p', {
          text: `${routine.name} · ${routine.cron} · ${routine.timezone} · ${routine.enabled ? '启用' : '停用'} · 下次 ${new Date(routine.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        })
        const run = el('button', { type: 'button', text: '立即运行' })
        run.addEventListener('click', async () => {
          status.textContent = ''
          try {
            const result = await ctx.api.post(`/api/routines/${encodeURIComponent(routine.id)}/run`, {})
            status.textContent = `已运行：${result?.run?.status ?? ''}`
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : '运行失败'
          }
        })
        list.append(el('div', { style: 'margin:8px 0' }, [row, run]))
      }
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      list.append(el('p', { text: error instanceof Error ? error.message : '列表失败' }))
    }
  }

  const form = el('form')
  const name = field('名称', 'name', '', '盘前检查')
  const cron = field('cron', 'cron', 'daily 09:00', 'daily 09:00 或 */5 * * * *')
  const timezone = field('时区', 'timezone', 'Asia/Shanghai', 'Asia/Shanghai')
  const botId = field('Bot id', 'botId', '', 'bot_…')
  const roomId = field('目标房间 id', 'roomId', '', 'rm_…')
  const prompt = field('prompt（不含聊天记录）', 'prompt', '', '只在有异动时用一句话报告')
  const submit = el('button', { type: 'submit', text: '创建' })
  form.append(name, cron, timezone, botId, roomId, prompt, submit)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    status.textContent = ''
    const body = Object.fromEntries(new FormData(form).entries())
    try {
      await ctx.api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/routines`, body)
      form.reset()
      timezone.querySelector('input').value = 'Asia/Shanghai'
      cron.querySelector('input').value = 'daily 09:00'
      await reload()
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '创建失败'
    }
  })

  root.replaceChildren(
    el('h1', { text: '房间定时' }),
    el('p', { text: '到点用单独的 run 跑这段 prompt，不带房间历史。有结果才发一条到目标房间，否则静默。默认时区 Asia/Shanghai。' }),
    form,
    status,
    list,
  )
  await reload()
}
