// 定时任务页「新建任务」表单：Bot 下拉、routineId、表达式示例、时区、追赶窗口、重叠策略。
//
// POST /api/workspaces/:id/schedules → 201 { schedule }
// 400 schedule.invalid 显示服务端原因；409 提示 routineId 重复；403 提示角色不足；503 说明未就绪。
// 所有用户可见文本只进 textContent / value。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  CATCH_UP_DEFAULT_HOURS,
  OVERLAP_OPTIONS,
  browserTimeZone,
  expressionExamples,
  scheduleErrorText,
  validateScheduleForm,
} from '../lib/schedules.js'
import * as ui from '../lib/ui.js'

const SECTION_DESC =
  '同一工作区里 routineId 唯一。表达式支持 5 段 cron、daily HH:MM、weekly 星期 HH:MM、every 秒数；时区用 IANA 名称。'

function schedulesPath(workspaceId) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/schedules`
}

function botOptions(bots) {
  return (Array.isArray(bots) ? bots : [])
    .filter((bot) => bot && typeof bot === 'object' && typeof bot.id === 'string' && bot.id !== '')
    .map((bot) => {
      const name = typeof bot.name === 'string' && bot.name.trim() !== '' ? bot.name.trim() : bot.id
      return { value: bot.id, label: `${name}（${bot.id}）` }
    })
}

/**
 * @param {object} ctx 页面上下文
 * @param {object} state { workspaceId, bots }
 * @param {(schedule: object) => void} onCreated 创建成功后插入列表
 */
export function scheduleFormSection(ctx, state, onCreated) {
  const options = botOptions(state.bots)
  const bot = ui.select({
    id: 'schedule-bot',
    options,
    value: options.length > 0 ? options[0].value : undefined,
  })
  const routineId = ui.input({
    id: 'schedule-routine',
    placeholder: '例如 daily-premarket',
    maxlength: 200,
    required: true,
  })
  const expression = ui.input({
    id: 'schedule-expression',
    placeholder: 'daily 09:00',
    maxlength: 200,
    required: true,
  })
  const timezone = ui.input({
    id: 'schedule-timezone',
    value: browserTimeZone(),
    placeholder: 'Asia/Shanghai',
    maxlength: 100,
    required: true,
  })
  const catchUp = ui.input({
    id: 'schedule-catchup',
    type: 'number',
    value: String(CATCH_UP_DEFAULT_HOURS),
    inputmode: 'decimal',
    placeholder: String(CATCH_UP_DEFAULT_HOURS),
  })
  const overlap = ui.select({
    id: 'schedule-overlap',
    options: OVERLAP_OPTIONS.map((item) => ({
      value: item.value,
      label: `${item.label}（${item.description}）`,
    })),
    value: 'queue',
  })

  const error = ui.inlineError()
  const statusLine = ui.statusLine('')
  const submit = ui.button('创建定时任务', { variant: 'primary', type: 'submit' })
  const form = el('form', { class: 'form schedule-form', novalidate: true })
  const grid = el('div', { class: 'schedule-form-grid' })

  const examples = el('div', { class: 'schedule-examples', role: 'group', 'aria-label': '表达式示例' })
  for (const item of expressionExamples()) {
    examples.append(
      ui.button(item.label, {
        variant: 'ghost',
        size: 'sm',
        title: `填入 ${item.value}`,
        onClick: () => {
          expression.value = item.value
          expression.focus()
        },
      })
    )
  }

  const fields = {
    botId: bot,
    routineId,
    expression,
    timezone,
    catchUpHours: catchUp,
    overlap,
  }

  grid.append(
    ui.field('Bot', bot, { id: 'schedule-bot', required: true, hint: '从当前工作区的 Bot 里选择' }),
    ui.field('routineId', routineId, {
      id: 'schedule-routine',
      required: true,
      hint: 'Bot 侧的 routine 标识；同一工作区唯一（≤200 字）',
    })
  )
  const expressionField = ui.field('表达式', expression, {
    id: 'schedule-expression',
    required: true,
    hint: '5 段 cron（分 时 日 月 周），或 daily / weekly / every 简化形态',
  })
  expressionField.append(examples)
  grid.append(expressionField)
  grid.append(
    ui.field('时区', timezone, {
      id: 'schedule-timezone',
      required: true,
      hint: 'IANA 时区，例如 Asia/Shanghai；默认取浏览器时区',
    }),
    ui.field('追赶窗口（小时）', catchUp, {
      id: 'schedule-catchup',
      hint: `默认 ${CATCH_UP_DEFAULT_HOURS} 小时；超过窗口的错过触发会记 missed`,
    }),
    ui.field('重叠策略', overlap, {
      id: 'schedule-overlap',
      hint: 'queue 等上一轮结束；skip 重叠时丢弃并留一条 skipped 记录',
    })
  )
  grid.append(error, statusLine, el('div', { class: 'form-foot schedule-form-foot' }, [submit]))
  form.append(grid)

  if (options.length === 0) {
    form.prepend(
      el('p', { class: 'field-hint' }, [
        el('a', { href: '#/bots/new', text: '先新建一个 Bot' }),
        document.createTextNode('，然后再回来创建定时任务。'),
      ])
    )
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(statusLine, '')
    const validation = validateScheduleForm({
      botId: bot.value,
      routineId: routineId.value,
      expression: expression.value,
      timezone: timezone.value,
      catchUpHours: catchUp.value,
      overlap: overlap.value,
    })
    if (!validation.ok) {
      ui.setError(error, validation.message)
      const field = fields[validation.field]
      if (field) ui.setFieldInvalid(field, true, error)
      if (field && typeof field.focus === 'function') field.focus()
      return
    }

    ui.setBusy(submit, true, '创建中…')
    try {
      const data = await ctx.api.post(schedulesPath(state.workspaceId), validation.payload)
      const created =
        data && typeof data === 'object' && data.schedule && typeof data.schedule === 'object'
          ? data.schedule
          : null
      if (created !== null) {
        onCreated(created)
        ui.setStatus(statusLine, `已创建「${created.routineId || validation.payload.routineId}」。`)
      } else {
        ui.setStatus(statusLine, '创建成功，但响应里没有 schedule；请点列表上方的「重试」刷新。')
      }
      routineId.value = ''
      expression.value = ''
      routineId.focus()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setError(error, scheduleErrorText(cause))
    } finally {
      ui.setBusy(submit, false)
    }
  })

  return ui.section('新建定时任务', [form], { description: SECTION_DESC })
}
