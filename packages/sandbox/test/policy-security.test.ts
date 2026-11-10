// M6 / M7 / N1 / N2 / N3 / N5: policy rendering must not be wider than the model,
// and credentialed or metadata changes must require proof.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SandboxError, isEgressAllowed, renderPolicyYaml, requiresProof, type SandboxPolicy } from '../src/index.ts'

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    version: 1,
    filesystem: { read: ['/usr'], write: [] },
    process: { user: 1000, caps: [] },
    network: { default: 'deny', allow: [] },
    ...overrides,
  }
}

test('empty methods are rejected instead of becoming protocol tcp', () => {
  const input = policy({
    network: { default: 'deny', allow: [{ binary: '/usr/bin/wget', host: 'example.com', methods: [] }] },
  })
  assert.throws(
    () => renderPolicyYaml(input),
    (error: unknown) => error instanceof SandboxError && error.code === 'invalid_policy',
  )
  assert.equal(isEgressAllowed(input, { binary: '/usr/bin/wget', host: 'example.com', method: 'GET' }), false)
})

test('GET+POST is not rendered as the read-write preset', () => {
  const yaml = renderPolicyYaml(
    policy({
      network: {
        default: 'deny',
        allow: [{ binary: '/usr/bin/curl', host: 'api.example.com', methods: ['GET', 'POST'] }],
      },
    }),
  )
  assert.doesNotMatch(yaml, /access: read-write/)
  assert.doesNotMatch(yaml, /protocol: tcp/)
  assert.match(yaml, /method: "GET"/)
  assert.match(yaml, /method: "POST"/)
  assert.match(yaml, /path: "\*\*"/)
  assert.equal(
    isEgressAllowed(policy({
      network: {
        default: 'deny',
        allow: [{ binary: '/usr/bin/curl', host: 'api.example.com', methods: ['GET', 'POST'] }],
      },
    }), { binary: '/usr/bin/curl', host: 'api.example.com', method: 'PUT' }),
    false,
  )
})

test('rendered policy quotes wildcard hosts and requires landlock', () => {
  const yaml = renderPolicyYaml(
    policy({
      network: {
        default: 'deny',
        allow: [{ binary: '/usr/bin/git', host: '*.github.com', methods: ['GET'] }],
      },
    }),
  )
  assert.match(yaml, /host: "\*\.github\.com"/)
  assert.match(yaml, /landlock:/)
  assert.match(yaml, /compatibility: hard_requirement/)
  assert.doesNotMatch(yaml, /host: \*\.github\.com/)
})

test('user 0 and non-empty caps are rejected before render', () => {
  assert.throws(
    () => renderPolicyYaml(policy({ process: { user: 0, caps: [] } })),
    (error: unknown) => error instanceof SandboxError && error.code === 'invalid_policy',
  )
  assert.throws(
    () => renderPolicyYaml(policy({ process: { user: 1000, caps: ['CAP_SYS_ADMIN'] } })),
    (error: unknown) => error instanceof SandboxError && error.code === 'invalid_policy',
  )
})

test('IPv6 host:port is split and not given a default 443 on the bracket', () => {
  const yaml = renderPolicyYaml(
    policy({
      network: {
        default: 'deny',
        allow: [{ binary: '/usr/bin/curl', host: '[2001:db8::1]:8443', methods: ['GET'] }],
      },
    }),
  )
  assert.match(yaml, /host: "2001:db8::1"/)
  assert.match(yaml, /port: 8443/)
})

test('changing the host or binary of a credentialed rule requires proof', () => {
  const before = { binary: '/usr/bin/curl', host: 'api.github.com', methods: ['GET'], credentials: 'gh' }
  assert.deepEqual(
    requiresProof(before, { ...before, host: 'evil.example' }),
    ['credentialed target changed'],
  )
  assert.deepEqual(
    requiresProof(before, { ...before, binary: '/tmp/curl' }),
    ['credentialed target changed'],
  )
})

test('metadata endpoints are denied, including the Alibaba address and host variants', () => {
  const hosts = ['169.254.169.254', '169.254.169.254:80', '169.254.169.254.', '100.100.100.200', 'FD00:EC2::254', 'metadata.google.internal.']
  for (const host of hosts) {
    assert.ok(requiresProof(undefined, { binary: '/usr/bin/curl', host, methods: ['GET'] }).includes('cloud metadata endpoint'), host)
    assert.equal(
      isEgressAllowed(
        policy({
          network: { default: 'deny', allow: [{ binary: '/usr/bin/curl', host, methods: ['GET'] }] },
        }),
        { binary: '/usr/bin/curl', host, method: 'GET' },
      ),
      false,
      host,
    )
  }
})

test('egress host compare ignores a trailing dot and an explicit port', () => {
  const input = policy({
    network: { default: 'deny', allow: [{ binary: '/usr/bin/curl', host: 'example.com:443', methods: ['GET'] }] },
  })
  assert.equal(isEgressAllowed(input, { binary: '/usr/bin/curl', host: 'example.com.', method: 'GET' }), true)
  assert.equal(isEgressAllowed(input, { binary: '/usr/bin/curl', host: 'example.com:443', method: 'GET' }), true)
})
