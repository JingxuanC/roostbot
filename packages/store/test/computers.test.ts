import assert from 'node:assert/strict'
import test from 'node:test'

import { openStore } from '../src/index.ts'
import {
  claimComputerJob,
  createComputerJob,
  expireComputerJobs,
  getComputerJob,
  renewComputerJobLease,
} from '../src/computers.ts'

test('computer job leases renew and expired claims return to the queue', () => {
  const store = openStore(':memory:')
  try {
    const job = createComputerJob(store, {
      bindingId: 'cb_test',
      computerId: 'cmp_test',
      workspaceId: 'ws_test',
      roomId: 'rm_test',
      roundId: 'rnd_test',
      slotIndex: 0,
      botId: 'bot_test',
      idem: 'job-test',
      payload: { prompt: 'hi' },
      now: 1000,
    })
    const claimed = claimComputerJob(store, { jobId: job.id, computerId: 'cmp_test', leaseMs: 60_000, now: 1000 })
    assert.equal(claimed?.state, 'claimed')
    const renewed = renewComputerJobLease(store, { jobId: job.id, computerId: 'cmp_test', leaseMs: 60_000, now: 1000 })
    assert.equal(renewed?.state, 'running')
    assert.equal(expireComputerJobs(store, 61_001), 1)
    assert.equal(getComputerJob(store, job.id)?.state, 'queued')
    const reclaimed = claimComputerJob(store, { jobId: job.id, computerId: 'cmp_test', leaseMs: 60_000, now: 62_000 })
    assert.equal(reclaimed?.state, 'claimed')
  } finally {
    store.close()
  }
})
