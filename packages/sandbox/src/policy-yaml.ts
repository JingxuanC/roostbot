// 把我们的策略模型渲染成 OpenShell 的 policy YAML。
//
// 字段名与结构以官方 schema 为准（docs/how-it-works/policies/schema.mdx，
// 2026-11 实测于 openshell 0.1.6）：
//   version / filesystem_policy{read_only,read_write} / landlock / process{run_as_user,run_as_group}
//   network_policies: 映射「规则名 -> {endpoints[], binaries[]}」
// 生成后由网关校验（未知字段会被拒绝），所以这里的字段不能凭感觉写。

import type { SandboxPolicy } from './types.ts'

/** YAML 标量：够了就裸写，含特殊字符才加引号。 */
function scalar(value: string): string {
  if (/^[A-Za-z0-9_./:@*+-]+$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function list(values: readonly string[], indent: number): string {
  const pad = ' '.repeat(indent)
  return values.map((value) => `${pad}- ${scalar(value)}`).join('\n')
}

function splitHost(host: string): { host: string; port?: number } {
  const match = /^([^:]+):(\d+)$/.exec(host)
  if (match === null) return { host }
  return { host: match[1]!, port: Number.parseInt(match[2]!, 10) }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * 渲染策略。规则按「二进制 → 目的地」展开；方法用 REST 的 allow rules 表达。
 * 凭据只写 provider 名（credential_binding），永远不写凭据值。
 */
export function renderPolicyYaml(policy: SandboxPolicy): string {
  const lines: string[] = ['version: 1', '', 'filesystem_policy:', '  read_only:']
  lines.push(policy.filesystem.read.length === 0 ? '    []' : list(policy.filesystem.read, 4))
  lines.push('  read_write:')
  lines.push(policy.filesystem.write.length === 0 ? '    []' : list(policy.filesystem.write, 4))
  lines.push('', 'process:')
  lines.push(`  run_as_user: "${policy.process.user}"`)
  lines.push(`  run_as_group: "${policy.process.user}"`)
  lines.push('', 'network_policies:')

  if (policy.network.allow.length === 0) {
    lines.push('  {}')
    return lines.join('\n') + '\n'
  }

  policy.network.allow.forEach((rule, index) => {
    const { host, port } = splitHost(rule.host)
    const methods = rule.methods.map((method) => method.toUpperCase())
    const allRead = methods.length > 0 && methods.every((method) => READ_METHODS.has(method))
    const readWrite = new Set([...READ_METHODS, 'POST', 'PUT', 'PATCH'])
    const allReadWrite = methods.length > 0 && methods.every((method) => readWrite.has(method))
    const name = `rule-${index + 1}-${rule.binary.split('/').pop() ?? 'bin'}-${host}`

    lines.push(`  ${scalar(name)}:`)
    lines.push('    endpoints:')
    lines.push(`      - host: ${scalar(host)}`)
    lines.push(`        port: ${port ?? 443}`)
    if (methods.length === 0) {
      // 不限定方法 = 不检查请求内容，只做连接级放行。
      lines.push('        protocol: tcp')
    } else {
      lines.push('        protocol: rest')
      lines.push('        enforcement: enforce')
      if (allRead) {
        lines.push('        access: read-only')
      } else if (allReadWrite) {
        lines.push('        access: read-write')
      } else {
        lines.push('        rules:')
        for (const method of methods) {
          lines.push('          - allow:')
          lines.push(`              method: ${scalar(method)}`)
        }
      }
    }
    if (rule.credentials !== undefined) {
      lines.push('        credential_binding:')
      lines.push(`          provider: ${scalar(rule.credentials)}`)
    }
    lines.push('    binaries:')
    lines.push(`      - path: ${scalar(rule.binary)}`)
  })

  return lines.join('\n') + '\n'
}
