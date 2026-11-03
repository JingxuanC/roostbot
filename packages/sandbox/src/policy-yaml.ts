// 把我们的策略模型渲染成 OpenShell 的 policy YAML。
//
// 注意（诚实）：字段名按 OpenShell 文档里出现的段落（version / filesystem_policy /
// process / network_policies）生成，但**没有对着 openshell 的 schema 校验过**——
// 这台机器没有 Docker，跑不起真 sandbox。第一件事应该是拿 `openshell sandbox create
// --policy` 验一次，不一致就改这里，不改上游模型。

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

/**
 * 渲染策略。规则按「二进制 → 目的地 → 方法」展开，和 packages/sandbox 的模型一一对应。
 * 凭据只写引用名（provider 名），永远不写凭据值。
 */
export function renderPolicyYaml(policy: SandboxPolicy): string {
  const lines: string[] = ['version: 1', '', 'filesystem_policy:', '  read:']
  lines.push(list(policy.filesystem.read, 4))
  lines.push('  write:')
  lines.push(list(policy.filesystem.write, 4))
  lines.push('', 'process:')
  lines.push(`  user: ${policy.process.user}`)
  lines.push('  capabilities: []' + (policy.process.caps.length === 0 ? '' : '  # 违反 isProcessPolicySafe：实现应拒绝'))
  lines.push('', 'network_policies:')
  lines.push('  default: deny')
  if (policy.network.allow.length === 0) {
    lines.push('  rules: []')
    return lines.join('\n') + '\n'
  }
  lines.push('  rules:')
  policy.network.allow.forEach((rule, index) => {
    lines.push(`    - name: ${scalar(`rule-${index + 1}-${rule.binary.split('/').pop() ?? 'bin'}`)}`)
    lines.push(`      binary: ${scalar(rule.binary)}`)
    lines.push(`      host: ${scalar(rule.host)}`)
    lines.push('      methods:')
    lines.push(list(rule.methods.map((method) => method.toUpperCase()), 8))
    if (rule.credentials !== undefined) {
      lines.push(`      credentials: ${scalar(rule.credentials)}`)
    }
  })
  return lines.join('\n') + '\n'
}
