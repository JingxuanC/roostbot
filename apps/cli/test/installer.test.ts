import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

test('package-cli creates a checksummed installer and the wrapper runs', () => {
  const packaged = spawnSync(process.execPath, [join(ROOT, 'scripts', 'package-cli.mjs')], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const assets = join(ROOT, 'dist', 'cli', `v${pkg.version}`)
  const sums = readFileSync(join(assets, 'checksums.txt'), 'utf8')
  assert.match(sums, /  roost\.mjs\n/)
  assert.match(sums, /  install\.sh\n/)

  const dir = mkdtempSync(join(tmpdir(), 'roost-installer-'))
  try {
    const install = spawnSync('sh', [join(assets, 'install.sh')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        ROOST_CLI_BASE_URL: `file://${assets}`,
        ROOST_INSTALL_DIR: join(dir, 'lib'),
        ROOST_BIN_DIR: join(dir, 'bin'),
      },
    })
    assert.equal(install.status, 0, install.stderr || install.stdout)
    const version = spawnSync(join(dir, 'bin', 'roost'), ['--version'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(version.status, 0, version.stderr)
    assert.match(version.stdout, /^roost /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
