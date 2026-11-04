// 每 workspace 一个面板转发端口（apps/api/src/panel-forward.ts）。
//
// 全部用注入的 fake runner：验证命令行形状、端口分配、幂等、stop 与错误路径，
// 不依赖机器上有 openshell。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PanelForwardError,
  ensurePanelForward,
  resolvePanelPort,
  stopAllPanelForwards,
  stopPanelForward,
} from '../src/panel-forward.ts'
import type { PanelForwardResult } from '../src/panel-forward.ts'

interface Call {
  args: string[]
}

function fakeRunner(
  respond: (args: string[]) => PanelForwardResult = (args) => ({
    code: 0,
    stdout: `forward ready: http://127.0.0.1:${args[2]}`,
    stderr: '',
  })
): { runner: (args: string[]) => Promise<PanelForwardResult>; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    runner: async (args: string[]) => {
      calls.push({ args })
      return respond(args)
    },
  }
}

/** 每个用例从干净状态开始：停掉残留转发并重置端口分配。 */
async function reset(): Promise<void> {
  await stopAllPanelForwards()
}

test('默认从 4100 递增，解析 stdout 的 URL；命令行是 forward start <port> <sandbox> -d', async () => {
  await reset()
  try {
    const { runner, calls } = fakeRunner()
    const first = await ensurePanelForward('ws_a', { runner, sandboxName: 'user-aaaa1111' })
    assert.deepEqual(first, { port: 4100, url: 'http://127.0.0.1:4100' })
    assert.deepEqual(calls[0]!.args, ['forward', 'start', '4100', 'user-aaaa1111', '-d'])
    assert.equal(resolvePanelPort('ws_a'), 4100)

    const second = await ensurePanelForward('ws_b', { runner, sandboxName: 'user-bbbb2222' })
    assert.deepEqual(second, { port: 4101, url: 'http://127.0.0.1:4101' })
    assert.deepEqual(calls[1]!.args, ['forward', 'start', '4101', 'user-bbbb2222', '-d'])
    assert.equal(resolvePanelPort('ws_b'), 4101)

    assert.equal(resolvePanelPort('ws_missing'), undefined)
  } finally {
    await reset()
  }
})

test('已存在直接返回：重复调用不再跑 CLI，端口不变', async () => {
  await reset()
  try {
    const { runner, calls } = fakeRunner()
    const first = await ensurePanelForward('ws_same', { runner, sandboxName: 'user-same' })

    let secondRunnerCalled = false
    const second = await ensurePanelForward('ws_same', {
      runner: async () => {
        secondRunnerCalled = true
        return { code: 0, stdout: '', stderr: '' }
      },
      sandboxName: 'user-other',
    })
    assert.deepEqual(second, first)
    assert.equal(secondRunnerCalled, false)
    assert.equal(calls.length, 1)
  } finally {
    await reset()
  }
})

test('并发 ensure 同一 workspace 只启动一次', async () => {
  await reset()
  try {
    let starts = 0
    const runner = async (args: string[]): Promise<PanelForwardResult> => {
      if (args[1] === 'start') {
        starts += 1
        // 拉长一点，确保第二次调用落在 in-flight 窗口里。
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { code: 0, stdout: `http://127.0.0.1:${args[2]}`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const [a, b] = await Promise.all([
      ensurePanelForward('ws_race', { runner, sandboxName: 'user-race' }),
      ensurePanelForward('ws_race', { runner, sandboxName: 'user-race' }),
    ])
    assert.equal(starts, 1)
    assert.deepEqual(a, b)
  } finally {
    await reset()
  }
})

test('basePort 注入：稳定端口分配，第二个 workspace 顺延', async () => {
  await reset()
  try {
    const { runner } = fakeRunner()
    assert.equal((await ensurePanelForward('ws_p1', { runner, sandboxName: 'sb-1', basePort: 4200 })).port, 4200)
    assert.equal((await ensurePanelForward('ws_p2', { runner, sandboxName: 'sb-2', basePort: 4200 })).port, 4201)
  } finally {
    await reset()
  }
})

test('stdout 没有 URL 时用分配端口兜底', async () => {
  await reset()
  try {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: 'forwarding...', stderr: '' }))
    const endpoint = await ensurePanelForward('ws_nourl', { runner, sandboxName: 'sb', basePort: 4300 })
    assert.deepEqual(endpoint, { port: 4300, url: 'http://127.0.0.1:4300' })
  } finally {
    await reset()
  }
})

test('CLI 自己报了别的端口时以 stdout 的 URL 为准', async () => {
  await reset()
  try {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: 'http://127.0.0.1:9999/', stderr: '' }))
    const endpoint = await ensurePanelForward('ws_cli', { runner, sandboxName: 'sb', basePort: 4300 })
    assert.equal(endpoint.port, 9999)
    assert.equal(resolvePanelPort('ws_cli'), 9999)
  } finally {
    await reset()
  }
})

test('没有 sandboxName → sandbox_required，不跑 CLI', async () => {
  await reset()
  try {
    const { runner, calls } = fakeRunner()
    await assert.rejects(
      ensurePanelForward('ws_no_sandbox', { runner }),
      (error: unknown) =>
        error instanceof PanelForwardError &&
        error.code === 'sandbox_required' &&
        /sandbox name/i.test(error.message)
    )
    assert.equal(calls.length, 0)
    assert.equal(resolvePanelPort('ws_no_sandbox'), undefined)
  } finally {
    await reset()
  }
})

test('CLI 非零退出 → forward_failed，端口释放，映射不存在', async () => {
  await reset()
  try {
    const failing = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'sandbox not ready' }))
    await assert.rejects(
      ensurePanelForward('ws_fail', { runner: failing.runner, sandboxName: 'sb', basePort: 4400 }),
      (error: unknown) =>
        error instanceof PanelForwardError &&
        error.code === 'forward_failed' &&
        /sandbox not ready/.test(error.message)
    )
    assert.equal(resolvePanelPort('ws_fail'), undefined)

    // 端口已释放：下一次还能拿到 4400
    const ok = fakeRunner()
    assert.equal((await ensurePanelForward('ws_retry', { runner: ok.runner, sandboxName: 'sb', basePort: 4400 })).port, 4400)
  } finally {
    await reset()
  }
})

test('runner 抛错 → forward_failed（ENOENT 也走这条），不抛原始错误类型', async () => {
  await reset()
  try {
    await assert.rejects(
      ensurePanelForward('ws_throw', {
        sandboxName: 'sb',
        basePort: 4500,
        runner: async () => {
          throw new Error('openshell not found on PATH')
        },
      }),
      (error: unknown) => error instanceof PanelForwardError && error.code === 'forward_failed'
    )
  } finally {
    await reset()
  }
})

test('basePort 非法 → bad_port', async () => {
  await reset()
  try {
    await assert.rejects(
      ensurePanelForward('ws_badport', { sandboxName: 'sb', basePort: 0, runner: fakeRunner().runner }),
      (error: unknown) => error instanceof PanelForwardError && error.code === 'bad_port'
    )
  } finally {
    await reset()
  }
})

test('stop：命令行是 forward stop <port> <sandbox>，映射立刻消失，重复 stop 返回 false', async () => {
  await reset()
  try {
    const { runner, calls } = fakeRunner()
    await ensurePanelForward('ws_stop', { runner, sandboxName: 'user-stop', basePort: 4600 })
    assert.equal(await stopPanelForward('ws_stop'), true)
    assert.deepEqual(calls.at(-1)!.args, ['forward', 'stop', '4600', 'user-stop'])
    assert.equal(resolvePanelPort('ws_stop'), undefined)
    assert.equal(await stopPanelForward('ws_stop'), false)
    assert.equal(calls.filter((call) => call.args[1] === 'stop').length, 1)
  } finally {
    await reset()
  }
})

test('stop 时 CLI 失败只记日志，映射照样删除且不抛', async () => {
  await reset()
  try {
    const logs: string[] = []
    const { runner } = fakeRunner()
    await ensurePanelForward('ws_stop_fail', { runner, sandboxName: 'sb', basePort: 4700 })

    const result = await stopPanelForward('ws_stop_fail', {
      log: (line: string) => logs.push(line),
      runner: async () => {
        throw new Error('boom')
      },
    })
    assert.equal(result, true)
    assert.equal(resolvePanelPort('ws_stop_fail'), undefined)
    assert.ok(logs.some((line) => line.includes('panel forward stop ws_stop_fail failed')))
  } finally {
    await reset()
  }
})

test('stopAllPanelForwards：停掉全部并重置端口分配', async () => {
  await reset()
  try {
    const { runner, calls } = fakeRunner()
    await ensurePanelForward('ws_all1', { runner, sandboxName: 'sb-1', basePort: 4800 })
    await ensurePanelForward('ws_all2', { runner, sandboxName: 'sb-2', basePort: 4800 })

    await stopAllPanelForwards()
    assert.equal(resolvePanelPort('ws_all1'), undefined)
    assert.equal(resolvePanelPort('ws_all2'), undefined)
    assert.deepEqual(
      calls.filter((call) => call.args[1] === 'stop').map((call) => call.args[2]),
      ['4800', '4801']
    )

    // 重置后默认分配回到 4100
    assert.equal((await ensurePanelForward('ws_after', { runner, sandboxName: 'sb-3' })).port, 4100)
  } finally {
    await reset()
  }
})
