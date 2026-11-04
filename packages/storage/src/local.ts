// LocalVolumeStore：默认内容存储实现（docs/design/storage.md §4）。
//
// 落盘结构（两级目录，避免单目录过多文件）：
//   <root>/ab/cd/<id>/blob
//   <root>/ab/cd/<id>/meta.json
//
// 三条约束：
//   1. 内容寻址：id = sha256(bytes).slice(0, 32)，同内容只存一份；
//   2. 写不可变：重复 put 直接返回已存在对象，绝不覆盖；
//   3. 不暴露真实路径：签名 URL 只带 id + HMAC token，由控制面代理读取。
//
// 原子写：临时文件 → fsync → rename（同卷 rename 原子）。目录 0700、文件 0600。

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { objectId, objectPath } from './types.ts'
import type { ContentStore, PutOptions, StoredObject, StoredObjectMeta } from './types.ts'

/** 默认根目录：ROOST_ATTACHMENTS_DIR，否则 <cwd>/data/attachments。 */
export function defaultAttachmentsRoot(): string {
  const fromEnv = process.env.ROOST_ATTACHMENTS_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return resolve(process.cwd(), 'data', 'attachments')
}

export interface LocalVolumeStoreOptions {
  /** 存储根目录；默认 see defaultAttachmentsRoot()。 */
  root?: string
  /** HMAC 签名密钥；默认 ROOST_SIGNING_SECRET，未配置时进程内随机。 */
  signingSecret?: string | Buffer
  /** 注入时钟（测试用）。默认 Date.now。 */
  now?: () => number
}

interface MetaFile {
  id: string
  sha256: string
  size: number
  mime: string
  owner: string
  audience: string
  createdAt: number
}

const ID_PATTERN = /^[0-9a-f]{32}$/

/** 只接受内容寻址 id（32 位小写 hex），杜绝 ../ 之类的路径穿越。 */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

export class LocalVolumeStore implements ContentStore {
  readonly root: string
  private readonly secret: Buffer
  private readonly now: () => number

  constructor(options: LocalVolumeStoreOptions = {}) {
    this.root = resolve(options.root ?? defaultAttachmentsRoot())
    this.now = options.now ?? (() => Date.now())
    this.secret = resolveSecret(options.signingSecret)
    ensureDir(this.root)
  }

  /** 内容寻址 id（sha256 前 32 hex）。 */
  idOf(bytes: Uint8Array): string {
    return objectId(sha256Hex(bytes))
  }

  /** 本地卷上的对象目录；调用方不要把它交给浏览器。 */
  objectDir(id: string): string {
    if (!isObjectId(id)) throw new Error(`invalid object id: ${String(id)}`)
    return join(this.root, objectPath(id))
  }

  async put(bytes: Uint8Array, options: PutOptions): Promise<StoredObject> {
    if (!(bytes instanceof Uint8Array)) throw new Error('put(bytes) expects a Uint8Array')
    const sha256 = sha256Hex(bytes)
    const id = objectId(sha256)
    const dir = this.objectDir(id)
    const blobPath = join(dir, 'blob')
    const metaPath = join(dir, 'meta.json')

    // 去重：已经存在就只补缺失的 blob（崩溃恢复），绝不覆盖已有内容。
    const existing = this.readMeta(id)
    if (existing !== null) {
      if (existing.sha256 !== sha256) {
        // 纯理论：同一 id 前缀但完整 sha 不同（2^128 分之一）。
        throw new Error(`object id collision for ${id}`)
      }
      ensureDir(dir)
      if (!exists(blobPath)) writeFileAtomic(blobPath, bytes)
      return { id, sha256, size: existing.size, mime: existing.mime }
    }

    ensureDir(dir)
    const blobExists = exists(blobPath)
    if (!blobExists) writeFileAtomic(blobPath, bytes)

    const meta: MetaFile = {
      id,
      sha256,
      size: bytes.byteLength,
      mime: options.mime,
      owner: options.owner,
      audience: options.audience ?? 'team',
      createdAt: this.now(),
    }
    writeFileAtomic(metaPath, Buffer.from(JSON.stringify(meta), 'utf8'))
    return { id, sha256, size: meta.size, mime: meta.mime }
  }

  async get(id: string): Promise<{ bytes: Uint8Array; meta: StoredObjectMeta } | null> {
    if (!isObjectId(id)) return null
    const meta = this.readMeta(id)
    if (meta === null) return null
    try {
      const bytes = readFileSync(join(this.objectDir(id), 'blob'))
      if (sha256Hex(bytes) !== meta.sha256) return null
      return { bytes: new Uint8Array(bytes), meta: toStoredMeta(meta) }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async head(id: string): Promise<StoredObjectMeta | null> {
    if (!isObjectId(id)) return null
    const meta = this.readMeta(id)
    return meta === null ? null : toStoredMeta(meta)
  }

  async delete(id: string): Promise<boolean> {
    if (!isObjectId(id)) return false
    const dir = this.objectDir(id)
    let removed = false
    for (const name of ['blob', 'meta.json']) {
      try {
        rmSync(join(dir, name), { force: false })
        removed = true
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
    }
    try {
      rmSync(dir, { recursive: true, force: false })
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    return removed
  }

  /** 控制面代理地址：/api/attachments/:id?token=<expires>.<hmac>。 */
  async signRead(id: string, ttlSeconds: number): Promise<string> {
    if (!isObjectId(id)) throw new Error(`invalid object id: ${String(id)}`)
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('ttlSeconds must be positive')
    const expires = this.now() + Math.floor(ttlSeconds * 1000)
    const token = this.tokenFor(id, expires)
    return `/api/attachments/${id}?token=${token}`
  }

  /** 校验签名与过期时间（storage.md §9：过期 → 403）。 */
  verifyReadToken(id: string, token: string, now: number = this.now()): boolean {
    if (!isObjectId(id) || typeof token !== 'string' || token === '') return false
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) return false
    const expiresText = token.slice(0, dot)
    const macText = token.slice(dot + 1)
    if (!/^\d+$/.test(expiresText) || !/^[0-9a-f]{64}$/.test(macText)) return false
    const expires = Number(expiresText)
    if (!Number.isSafeInteger(expires) || expires <= now) return false
    const expected = Buffer.from(this.tokenFor(id, expires), 'utf8')
    const actual = Buffer.from(token, 'utf8')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  }

  private tokenFor(id: string, expires: number): string {
    const mac = createHmac('sha256', this.secret).update(`${id}\n${expires}`).digest('hex')
    return `${expires}.${mac}`
  }

  private readMeta(id: string): MetaFile | null {
    try {
      const raw = readFileSync(join(this.objectDir(id), 'meta.json'), 'utf8')
      const parsed = JSON.parse(raw) as MetaFile
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.id !== id ||
        typeof parsed.sha256 !== 'string' ||
        typeof parsed.size !== 'number' ||
        typeof parsed.mime !== 'string' ||
        typeof parsed.owner !== 'string' ||
        typeof parsed.audience !== 'string' ||
        typeof parsed.createdAt !== 'number'
      ) {
        return null
      }
      return parsed
    } catch (err) {
      if (isNotFound(err) || err instanceof SyntaxError) return null
      throw err
    }
  }
}

function resolveSecret(value: string | Buffer | undefined): Buffer {
  if (Buffer.isBuffer(value) && value.byteLength > 0) return value
  if (typeof value === 'string' && value !== '') return Buffer.from(value, 'utf8')
  const fromEnv = process.env.ROOST_SIGNING_SECRET
  if (typeof fromEnv === 'string' && fromEnv !== '') return Buffer.from(fromEnv, 'utf8')
  // 未配置：进程内随机（重启后旧签名 URL 失效，这是可接受的行为）。
  return randomBytes(32)
}

function toStoredMeta(meta: MetaFile): StoredObjectMeta {
  return {
    id: meta.id,
    sha256: meta.sha256,
    size: meta.size,
    mime: meta.mime,
    owner: meta.owner,
    audience: meta.audience,
    createdAt: meta.createdAt,
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // 某些文件系统（如只读挂载）不支持 chmod；目录已经建出来就算成功。
  }
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

/** 临时文件 → fsync → rename；文件权限 0600。 */
function writeFileAtomic(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不覆盖原始错误。
    }
    throw err
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // 见 ensureDir。
  }
}
