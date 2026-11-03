import { randomBytes } from 'node:crypto'

// ULID 形状的 id：48 位毫秒时间戳 + 80 位随机数，Crockford base32 共 26 字符。
// 注意：同一毫秒内不保证单调（sortable 只是时间前缀）；排序永远用 seq（events.md §3 规则 1），
// 所以这里不需要维护单调状态。

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ms: number): string {
  let out = ''
  let rest = ms
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = randomBytes(10)
  let bits = 0n
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
  let out = ''
  for (let i = 0; i < 16; i += 1) {
    out = CROCKFORD[Number(bits & 31n)] + out
    bits >>= 5n
  }
  return out
}

function body(at: number): string {
  return `${encodeTime(at)}${encodeRandom()}`
}

export function newEventId(at: number = Date.now()): string {
  return `ev_${body(at)}`
}

export function newWorkspaceId(at: number = Date.now()): string {
  return `ws_${body(at)}`
}

/** 通用：`<prefix>_<ulid body>`，用于房间等不是 events/workspaces 的实体。 */
export function newRoostId(prefix: string, at: number = Date.now()): string {
  return `${prefix}_${body(at)}`
}
