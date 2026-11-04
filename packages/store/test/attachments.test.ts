import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTACHMENT_RETENTION_MS,
  addAttachmentRef,
  deleteAttachmentRows,
  getAttachment,
  linkArtifact,
  listArtifactsByMessage,
  listCollectableAttachments,
  listMessageAttachments,
  openStore,
  putArtifact,
  putAttachment,
  recordAttachmentGc,
  unlinkArtifact,
} from '../src/index.ts'

const DAY = 24 * 60 * 60 * 1000
const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)
const ID_C = 'c'.repeat(32)
const ID_D = 'd'.repeat(32)

function meta(id: string, createdAt: number) {
  return {
    id,
    workspaceId: 'ws_test',
    sha256: id.repeat(2),
    size: 123,
    mime: 'image/png',
    owner: 'acc_1',
    createdAt,
  }
}

test('putAttachment 幂等；引用计数与 attachment_refs 同事务', () => {
  const store = openStore(':memory:')
  try {
    const first = putAttachment(store, meta(ID_A, 1000))
    const again = putAttachment(store, meta(ID_A, 2000))
    assert.equal(first.refCount, 0)
    assert.equal(again.createdAt, 1000, '已有行不被覆盖')

    const ref1 = addAttachmentRef(store, ID_A, 'ev_1')
    assert.deepEqual(ref1, { added: true, refCount: 1 })
    const ref2 = addAttachmentRef(store, ID_A, 'ev_1')
    assert.deepEqual(ref2, { added: false, refCount: 1 }, '重复引用幂等')
    const ref3 = addAttachmentRef(store, ID_A, 'ev_2')
    assert.deepEqual(ref3, { added: true, refCount: 2 })
    assert.equal(getAttachment(store, ID_A)?.refCount, 2)

    assert.throws(() => addAttachmentRef(store, ID_B, 'ev_1'), /unknown attachment/)
  } finally {
    store.close()
  }
})

test('linkArtifact：消息引用 + 列表 + 幂等 + 解除引用', () => {
  const store = openStore(':memory:')
  try {
    putAttachment(store, meta(ID_A, 1000))
    putArtifact(store, {
      id: ID_A,
      workspaceId: 'ws_test',
      kind: 'image',
      mime: 'image/png',
      name: 'chart.png',
      size: 123,
      width: 640,
      height: 480,
      producedBy: 'bot_1',
      createdAt: 1000,
    })

    linkArtifact(store, 42, ID_A, 0)
    linkArtifact(store, 42, ID_A, 0) // 幂等
    assert.equal(getAttachment(store, ID_A)?.refCount, 1)

    const artifacts = listArtifactsByMessage(store, 42)
    assert.deepEqual(artifacts.map((item) => [item.id, item.width, item.height]), [[ID_A, 640, 480]])

    const listed = listMessageAttachments(store, [41, 42])
    assert.deepEqual(listed.map((item) => [item.messageSeq, item.artifactId, item.url]), [
      [42, ID_A, `/api/messages/42/files/${ID_A}`],
    ])
    assert.deepEqual(listMessageAttachments(store, []), [])

    assert.equal(unlinkArtifact(store, 42, ID_A), true)
    assert.equal(unlinkArtifact(store, 42, ID_A), false)
    assert.equal(getAttachment(store, ID_A)?.refCount, 0)
    assert.deepEqual(listArtifactsByMessage(store, 42), [])

    assert.throws(() => linkArtifact(store, 42, ID_B, 0), /unknown artifact/)
  } finally {
    store.close()
  }
})

test('GC：ref_count=0 且超过 7 天才可回收；有引用永不删', () => {
  const store = openStore(':memory:')
  try {
    const now = 30 * DAY
    putAttachment(store, meta(ID_A, now - ATTACHMENT_RETENTION_MS - 1)) // 老且无引用 → 可回收
    putAttachment(store, meta(ID_B, now - ATTACHMENT_RETENTION_MS - 1))
    addAttachmentRef(store, ID_B, 'ev_keep')
    putAttachment(store, meta(ID_C, now - ATTACHMENT_RETENTION_MS + 1_000)) // 老但未满 7 天
    putAttachment(store, meta(ID_D, now - 10 * DAY))
    addAttachmentRef(store, ID_D, 'ev_keep')

    const collectable = listCollectableAttachments(store, { now })
    assert.deepEqual(collectable.map((item) => item.id), [ID_A])

    const deleted = deleteAttachmentRows(store, [ID_A, ID_C, ID_B])
    assert.deepEqual(deleted.map((item) => item.id).sort(), [ID_A, ID_C].sort())
    assert.equal(getAttachment(store, ID_A), null)
    assert.equal(getAttachment(store, ID_B)?.refCount, 1)
    assert.equal(getAttachment(store, ID_C), null)

    // 引用行随附件一起删；有引用的对象仍然活着。
    const refs = store.db
      .prepare('SELECT attachment_id FROM attachment_refs ORDER BY attachment_id')
      .all()
      .map((row) => (row as { attachment_id: string }).attachment_id)
    assert.deepEqual(refs, [ID_B, ID_D])
  } finally {
    store.close()
  }
})

test('recordAttachmentGc 写 attachment.gc 审计事件', () => {
  const store = openStore(':memory:')
  try {
    putAttachment(store, meta(ID_A, 1000))
    const attachment = getAttachment(store, ID_A)!
    recordAttachmentGc(store, { attachment, at: 5000 })

    const row = store.db
      .prepare("SELECT domain, kind, payload_json FROM events WHERE kind = 'attachment.gc'")
      .get() as { domain: string; kind: string; payload_json: string }
    assert.equal(row.domain, 'attachment')
    const payload = JSON.parse(row.payload_json) as { attachment: string; size: number }
    assert.equal(payload.attachment, ID_A)
    assert.equal(payload.size, 123)
  } finally {
    store.close()
  }
})
