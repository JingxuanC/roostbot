// 把我们的策略模型渲染成 OpenShell 的 policy YAML。
//
// 字段名与结构以官方 schema 为准（docs/how-it-works/policies/schema.mdx，
// 2026-11 实测于 openshell 0.1.6）：
//   version / filesystem_policy{read_only,read_write} / landlock / process{run_as_user,run_as_group}
//   network_policies: 映射「规则名 -> {endpoints[], binaries[]}」
// 生成后由网关校验（未知字段会被拒绝），所以这里的字段不能凭感觉写。

import { SandboxError } from './exec.ts'
import type { SandboxPolicy } from './types.ts'

/** 所有标量都加引号，避免 `*` 被当成 YAML alias，也避免换行注入。 */
function scalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

function list(values: readonly string[], indent: number): string {
  const pad = ' '.repeat(indent)
  return values.map((value) => `${pad}- ${scalar(value)}`).join('\n')
}

function splitHost(host: string): { host: string; port?: number } {
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(host)
  if (ipv6 !== null) {
    return { host: ipv6[1]!, ...(ipv6[2] === undefined ? {} : { port: Number.parseInt(ipv6[2], 10) }) }
  }
  const match = /^([^:]+):(\d+)$/.exec(host)
  if (match === null) return { host }
  return { host: match[1]!, port: Number.parseInt(match[2]!, 10) }
}

const READ_ONLY_METHODS = ['GET', 'HEAD', 'OPTIONS']
const READ_WRITE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH']

function sameMethods(methods: readonly string[], expected: readonly string[]): boolean {
  if (methods.length !== expected.length) return false
  const have = new Set(methods)
  return expected.every((method) => have.has(method))
}

function assertRenderable(policy: SandboxPolicy): void {
  const user = policy.process.user
  if (typeof user !== 'number' || !Number.isInteger(user) || user <= 0) {
    throw new SandboxError('invalid_policy', 'process.user must be a positive integer')
  }
  if (!Array.isArray(policy.process.caps) || policy.process.caps.length > 0) {
    throw new SandboxError('invalid_policy', 'process.caps must be empty')
  }
  for (const rule of policy.network.allow) {
    if (rule.transport === 'tcp') {
      if (rule.credentials !== undefined) {
        throw new SandboxError('invalid_policy', `tcp rule for ${rule.host} cannot carry credentials`)
      }
      continue
    }
    if (rule.methods.length === 0) {
      throw new SandboxError('invalid_policy', `network rule for ${rule.host} must list at least one HTTP method`)
    }
  }
}

/**
 * 渲染策略。规则按「二进制 → 目的地」展开；方法用 REST 的 allow rules 表达。
 * 凭据只写 provider 名（credential_binding），永远不写凭据值。
 */
export function renderPolicyYaml(policy: SandboxPolicy): string {
  assertRenderable(policy)
  const lines: string[] = ['version: 1', '', 'filesystem_policy:', '  read_only:']
  lines.push(policy.filesystem.read.length === 0 ? '    []' : list(policy.filesystem.read, 4))
  lines.push('  read_write:')
  lines.push(policy.filesystem.write.length === 0 ? '    []' : list(policy.filesystem.write, 4))
  lines.push('', 'landlock:', '  compatibility: hard_requirement')
  lines.push('', 'process:')
  lines.push(`  run_as_user: "${policy.process.user}"`)
  lines.push(`  run_as_group: "${policy.process.user}"`)
  // 没有规则时整个段落省略：schema 里它是可选的，空映射虽然合法但没必要冒险。
  if (policy.network.allow.length === 0) {
    return lines.join('\n') + '\n'
  }
  lines.push('', 'network_policies:')

  policy.network.allow.forEach((rule, index) => {
    const { host, port } = splitHost(rule.host)
    const methods = rule.methods.map((method) => method.toUpperCase())
    const readOnly = sameMethods(methods, READ_ONLY_METHODS)
    const readWrite = sameMethods(methods, READ_WRITE_METHODS)
    const name = `rule-${index + 1}-${rule.binary.split('/').pop() ?? 'bin'}-${host}`

    lines.push(`  ${scalar(name)}:`)
    lines.push('    endpoints:')
    lines.push(`      - host: ${scalar(host)}`)
    lines.push(`        port: ${port ?? 443}`)
    if (rule.transport === 'tcp') {
      lines.push('        protocol: tcp')
      lines.push('    binaries:')
      lines.push(`      - path: ${scalar(rule.binary)}`)
      return
    }
    lines.push('        protocol: rest')
    lines.push('        enforcement: enforce')
    if (readOnly) {
      lines.push('        access: read-only')
    } else if (readWrite) {
      lines.push('        access: read-write')
    } else {
      lines.push('        rules:')
      for (const method of methods) {
        lines.push('          - allow:')
        lines.push(`              method: ${scalar(method)}`)
        lines.push('              path: "**"')
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
