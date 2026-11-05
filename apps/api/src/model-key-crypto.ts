// BYO 模型 Key 的静态加密：AES-256-GCM。
//
// - 主密钥来自 ROOST_MODEL_KEY_SECRET（32 字节 base64 或 hex）；未配置时 BYO 保存/读取返回 null，
//   平台免费额度仍可工作（不需要用户 Key）。
// - 只存密文/iv/tag/hint；明文只在本进程内存里出现一次，不写日志、不返前端。
// - 与 runtime token / session token 无关，别混用。

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export interface EncryptedModelKey {
  keyCiphertext: string
  keyIv: string
  keyTag: string
  keyHint: string
}

export interface StoredModelKey {
  keyCiphertext: string
  keyIv: string
  keyTag: string
}

const ALGORITHM = 'aes-256-gcm'

/** 32 字节主密钥；支持 base64 / hex 两种写法。长度不对返回 null。 */
export function readModelKeyMaster(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = (env['ROOST_MODEL_KEY_SECRET'] ?? '').trim()
  if (raw === '') return null
  const fromBase64 = Buffer.from(raw, 'base64')
  if (fromBase64.length === 32) return fromBase64
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  // 也接受 32 个可打印字符以下？不：密钥必须明确 32 字节，避免误把弱口令当密钥。
  return null
}

/** 从任意口令派生 32 字节密钥（只用于测试/本地演示，不用于生产）。 */
export function deriveModelKeyMaster(passphrase: string): Buffer {
  return createHash('sha256').update(`roost-model-key:${passphrase}`).digest()
}

export function encryptModelKey(plain: string, master: Buffer): EncryptedModelKey {
  if (typeof plain !== 'string' || plain.trim() === '') throw new Error('model key is empty')
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('model key master must be 32 bytes')
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, master, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    keyCiphertext: ciphertext.toString('base64'),
    keyIv: iv.toString('base64'),
    keyTag: tag.toString('base64'),
    keyHint: maskHint(plain)
  }
}

export function decryptModelKey(stored: StoredModelKey, master: Buffer): string {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('model key master must be 32 bytes')
  const iv = Buffer.from(stored.keyIv, 'base64')
  const tag = Buffer.from(stored.keyTag, 'base64')
  const ciphertext = Buffer.from(stored.keyCiphertext, 'base64')
  const decipher = createDecipheriv(ALGORITHM, master, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 只显示最后 4 位；短 key 全部打码。 */
export function maskHint(plain: string): string {
  const text = String(plain)
  if (text.length <= 4) return '…'
  return `…${text.slice(-4)}`
}
