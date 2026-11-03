// 设计见 docs/design/storage.md。这里只有接口与纯函数；默认实现在 apps/runtime。

export interface StoredObjectMeta {
  id: string
  sha256: string
  size: number
  mime: string
  owner: string
  audience: string
  createdAt: number
}

export interface StoredObject {
  id: string
  sha256: string
  size: number
  mime: string
}

export interface PutOptions {
  mime: string
  owner: string
  audience?: string
}

/** 内容存储。默认本地卷实现，v2 可换对象存储，调用方不变。 */
export interface ContentStore {
  put(bytes: Uint8Array, options: PutOptions): Promise<StoredObject>
  get(id: string): Promise<{ bytes: Uint8Array; meta: StoredObjectMeta } | null>
  head(id: string): Promise<StoredObjectMeta | null>
  delete(id: string): Promise<boolean>
  /** 短时读取 URL；本地实现返回控制面代理 URL，绝不返回真实路径。 */
  signRead(id: string, ttlSeconds: number): Promise<string>
}

/** 默认上限：单文件 50MB；头像 10MB（见 design §6）。 */
export const MAX_OBJECT_BYTES = 50 * 1024 * 1024
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_EVENT = 10

/** 内容寻址 id：sha256 的前 32 个十六进制字符，两级目录避免单目录膨胀。 */
export function objectId(sha256: string): string {
  return sha256.slice(0, 32)
}

/** `ab/cd/<id>` —— 本地卷的落盘相对路径。 */
export function objectPath(id: string): string {
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`
}

/** 同内容只存一份：重复 put 直接返回已存在的对象。 */
export function isDuplicate(existing: StoredObjectMeta | null, sha256: string): boolean {
  return existing !== null && existing.sha256 === sha256
}

/** 引用计数为 0 且超过保留期才可回收。 */
export function isCollectable(refCount: number, createdAt: number, now: number, retentionMs: number): boolean {
  return refCount === 0 && now - createdAt > retentionMs
}
