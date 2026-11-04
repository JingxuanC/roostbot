// packages/rooms 测试的公共夹具（不是 *.test.ts，不会被 node --test 当测试跑）。

import type { Room, RoomMember } from '../../contract/src/index.ts'

export const BASE = 1_760_000_000_000

export const HOST: RoomMember = { botId: 'b_host', role: 'host', name: '主持' }
export const DATA: RoomMember = { botId: 'b_data', role: 'member', name: '数据官' }
export const DATA2: RoomMember = { botId: 'b_data2', role: 'member', name: '数据官2' }
export const OPS: RoomMember = { botId: 'b_ops', role: 'member', name: '运营' }
export const MEMBERS: RoomMember[] = [HOST, DATA, DATA2, OPS]

export function makeRoom(patch: Partial<Room> = {}): Room {
  return {
    id: 'room_1',
    workspaceId: 'ws_1',
    name: '研究组',
    replyMode: 'everyone',
    responder: { kind: 'everyone' },
    hostBotId: 'b_host',
    createdByKind: 'user',
    createdBy: 'user_1',
    createdAt: BASE,
    members: MEMBERS,
    ...patch
  }
}

export function member(botId: string, name: string, role: 'host' | 'member' = 'member'): RoomMember {
  return { botId, name, role }
}
