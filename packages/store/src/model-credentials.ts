// 每个 workspace 的 BYO 模型凭据（密文由 API 层加密，store 只存不透明字段）。
//
// 设计：Key 永不返回、永不进沙箱；这里不 import crypto，方便测试和内存实现。

import { asInteger, asNonEmptyString, asOptionalString, asRecord, assertOpen } from './internal.ts'
import { newRoostId } from './ids.ts'
import { StoreError } from './errors.ts'
import type { Store } from './types.ts'

export interface WorkspaceModelCredential {
  workspaceId: string
  provider: string
  baseUrl: string
  model: string
  keyCiphertext: string
  keyIv: string
  keyTag: string
  keyHint: string
  updatedBy: string | null
  createdAt: number
  updatedAt: number
}

export interface SaveModelCredentialInput {
  workspaceId: string
  provider: string
  baseUrl: string
  model: string
  keyCiphertext: string
  keyIv: string
  keyTag: string
  keyHint: string
  updatedBy?: string | null
  at?: number
}

export function getWorkspaceModelCredential(store: Store, workspaceId: string): WorkspaceModelCredential | null {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'model.workspaceId')
  const row = store.db
    .prepare('SELECT * FROM workspace_model_credentials WHERE workspace_id = ?')
    .get(id) as Record<string, unknown> | undefined
  return row === undefined || row === null ? null : rowToCredential(row)
}

export function saveWorkspaceModelCredential(store: Store, input: SaveModelCredentialInput): WorkspaceModelCredential {
  assertOpen(store)
  const req = asRecord(input, 'modelCredential')
  const workspaceId = asNonEmptyString(req.workspaceId, 'modelCredential.workspaceId')
  const provider = asNonEmptyString(req.provider, 'modelCredential.provider')
  const baseUrl = asNonEmptyString(req.baseUrl, 'modelCredential.baseUrl')
  const model = asNonEmptyString(req.model, 'modelCredential.model')
  const keyCiphertext = asNonEmptyString(req.keyCiphertext, 'modelCredential.keyCiphertext')
  const keyIv = asNonEmptyString(req.keyIv, 'modelCredential.keyIv')
  const keyTag = asNonEmptyString(req.keyTag, 'modelCredential.keyTag')
  const keyHint = asNonEmptyString(req.keyHint, 'modelCredential.keyHint')
  const updatedBy = asOptionalString(req.updatedBy, 'modelCredential.updatedBy')
  const at = asInteger(req.at ?? Date.now(), 'modelCredential.at', 0)

  store.db
    .prepare(
      `INSERT INTO workspace_model_credentials
         (workspace_id, provider, base_url, model, key_ciphertext, key_iv, key_tag, key_hint,
          updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         provider = excluded.provider,
         base_url = excluded.base_url,
         model = excluded.model,
         key_ciphertext = excluded.key_ciphertext,
         key_iv = excluded.key_iv,
         key_tag = excluded.key_tag,
         key_hint = excluded.key_hint,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(workspaceId, provider, baseUrl, model, keyCiphertext, keyIv, keyTag, keyHint, updatedBy, at, at)

  const saved = getWorkspaceModelCredential(store, workspaceId)
  if (saved === null) throw new StoreError('MODEL_CREDENTIAL_WRITE_FAILED', 'model credential was not persisted')
  return saved
}

export function deleteWorkspaceModelCredential(store: Store, workspaceId: string): boolean {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'model.workspaceId')
  const result = store.db.prepare('DELETE FROM workspace_model_credentials WHERE workspace_id = ?').run(id)
  return Number(result.changes) > 0
}

function rowToCredential(row: Record<string, unknown>): WorkspaceModelCredential {
  return {
    workspaceId: String(row['workspace_id']),
    provider: String(row['provider']),
    baseUrl: String(row['base_url']),
    model: String(row['model']),
    keyCiphertext: String(row['key_ciphertext']),
    keyIv: String(row['key_iv']),
    keyTag: String(row['key_tag']),
    keyHint: String(row['key_hint']),
    updatedBy: row['updated_by'] === null || row['updated_by'] === undefined ? null : String(row['updated_by']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  }
}
