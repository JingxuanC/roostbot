import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isCloudInstallable } from '../src/types.ts'

test('cloud installs accept only a registry name at a semver', () => {
  assert.equal(isCloudInstallable('left-pad@1.2.3'), true)
  assert.equal(isCloudInstallable('@scope/pkg@1.2.3'), true)
  for (const spec of ['link:../x', 'file:./pkg', '../x', '/abs', '~/x', 'git+ssh://git@github.com/a/b.git', 'https://example.com/pkg.tgz', 'github:org/repo']) {
    assert.equal(isCloudInstallable(spec), false, spec)
  }
})
