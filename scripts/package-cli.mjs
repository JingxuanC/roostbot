#!/usr/bin/env node
// Build the portable Roost CLI release assets:
//   dist/cli/v<version>/{roost.mjs,install.sh,install.ps1,checksums.txt,README.txt}
//   dist/roost-cli-v<version>.tar.gz
//
// No npm required. The installer checks for Node >= 22.18; standalone binaries
// are a later packaging step (Node SEA/Bun) and do not change these entrypoints.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version)
const out = join(root, 'dist', 'cli', `v${version}`)
const cli = join(root, 'apps', 'cli', 'roost.mjs')
const installSh = join(root, 'scripts', 'install.sh')
const installPs1 = join(root, 'scripts', 'install.ps1')
const release = join(root, 'dist', `roost-cli-v${version}.tar.gz`)

rmSync(join(root, 'dist', 'cli'), { recursive: true, force: true })
mkdirSync(out, { recursive: true })
copyFileSync(cli, join(out, 'roost.mjs'))
writeFileSync(join(out, 'install.sh'), readFileSync(installSh, 'utf8').replaceAll('__VERSION__', version), { mode: 0o755 })
writeFileSync(join(out, 'install.ps1'), readFileSync(installPs1, 'utf8').replaceAll('__VERSION__', version))
const files = ['roost.mjs', 'install.sh', 'install.ps1']
const sums = files.map((name) => {
  const digest = createHash('sha256').update(readFileSync(join(out, name))).digest('hex')
  return `${digest}  ${name}`
})
writeFileSync(join(out, 'checksums.txt'), `${sums.join('\n')}\n`)
writeFileSync(join(out, 'README.txt'), `Roost CLI v${version}\n\nQuick install:\n  curl -fsSL https://www.roostbots.com/downloads/cli/v${version}/install.sh | sh\n\nWindows:\n  irm https://www.roostbots.com/downloads/cli/v${version}/install.ps1 | iex\n\nRequirements: Node >= 22.18. Your local project paths remain in ~/.roost.\n`)
const tar = spawnSync('tar', ['-czf', release, '-C', join(root, 'dist', 'cli'), `v${version}`], { encoding: 'utf8' })
if (tar.status !== 0) {
  console.error(`package-cli: tar failed: ${tar.stderr || tar.stdout}`)
  process.exit(1)
}
console.log(`package-cli: ${out}`)
console.log(`package-cli: ${release}`)
for (const line of sums) console.log(`  ${line}`)
