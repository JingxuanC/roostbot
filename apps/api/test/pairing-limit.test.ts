import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimRetryAfterMs, recordClaimFailure } from '../src/server.ts'

test('pairing failures are counted per source and do not lock every source', () => {
  const buckets = new Map<string, number[]>()
  const now = 1_760_000_000_000
  for (let i = 0; i < 20; i += 1) recordClaimFailure(buckets, '10.0.0.8', now)
  assert.ok(claimRetryAfterMs(buckets, '10.0.0.8', now) > 0)
  assert.equal(claimRetryAfterMs(buckets, '10.0.0.9', now), 0)
})
