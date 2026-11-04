// workspace 成员与角色（docs/design/auth.md §5/§13）。
//
// 覆盖：列表顺序、角色查询、owner/admin 管理权限、只有 owner 能授予/撤销 owner、
// 最后一个 owner 不能降级/移除、事件恰好一次、行与事件同一 savepoint。

import assert from 'node:assert/strict'
import test from 'node:test'

import { readEvents } from '../src/events.ts'
import {
  MEMBER_ERROR_CODES,
  getWorkspaceMember,
  getWorkspaceRole,
  listWorkspaceMembers,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
  storeErrorTag,
} from '../src/index.ts'
import { createWorkspace } from '../src/workspaces.ts'
import type { Store } from '../src/types.ts'
import { assertStoreError, withStore } from './helpers.ts'

const AT = Date.UTC(2026, 10, 4, 12, 0, 0)

interface Fixture {
  workspaceId: string
}

function setup(store: Store): Fixture {
  const workspace = createWorkspace(store, {
    tenantId: 'acc_owner',
    name: '成员测试',
    profileVersion: 'dev',
    createdAt: AT,
  })
  insertMember(store, workspace.id, 'acc_owner', 'owner', null, AT)
  insertMember(store, workspace.id, 'acc_admin', 'admin', 'acc_owner', AT + 10)
  insertMember(store, workspace.id, 'acc_member', 'member', 'acc_owner', AT + 20)
  insertMember(store, workspace.id, 'acc_viewer', 'viewer', 'acc_owner', AT + 30)
  return { workspaceId: workspace.id }
}

function insertMember(
  store: Store,
  workspaceId: string,
  accountId: string,
  role: string,
  invitedBy: string | null,
  createdAt: number,
): void {
  store.db
    .prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(workspaceId, accountId, role, invitedBy, createdAt)
}

function authEvents(store: Store, kind: string) {
  return readEvents(store, { domain: 'auth' }).filter((event) => event.kind === kind)
}

test('listWorkspaceMembers 按 created_at 升序，字段完整', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    const members = listWorkspaceMembers(store, workspaceId)
    assert.deepEqual(
      members.map((member) => [member.accountId, member.role]),
      [
        ['acc_owner', 'owner'],
        ['acc_admin', 'admin'],
        ['acc_member', 'member'],
        ['acc_viewer', 'viewer'],
      ],
    )
    assert.deepEqual(members[0], {
      accountId: 'acc_owner',
      role: 'owner',
      invitedBy: null,
      createdAt: AT,
    })
    assert.equal(members[2]!.invitedBy, 'acc_owner')
  })
})

test('getWorkspaceMember / getWorkspaceRole：非成员返回 null，不默认 viewer', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_member'), 'member')
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_stranger'), null)
    assert.equal(getWorkspaceMember(store, workspaceId, 'acc_stranger'), null)
  })
})

test('owner 改角色：落库并写一次 auth.role.changed', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    const updated = setWorkspaceMemberRole(store, {
      workspaceId,
      accountId: 'acc_member',
      role: 'admin',
      by: 'acc_owner',
      at: AT + 100,
    })
    assert.equal(updated.role, 'admin')

    const events = authEvents(store, 'auth.role.changed')
    assert.equal(events.length, 1)
    const event = events[0]!
    assert.equal(event.domain, 'auth')
    assert.deepEqual(event.actor, { kind: 'user', id: 'acc_owner' })
    assert.deepEqual(event.subject, { kind: 'member', id: 'acc_member' })
    assert.deepEqual(event.payload, { workspaceId, from: 'member', to: 'admin' })
    assert.equal(event.at, new Date(AT + 100).toISOString())
  })
})

test('角色没变时不写事件（幂等）', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    setWorkspaceMemberRole(store, {
      workspaceId,
      accountId: 'acc_member',
      role: 'member',
      by: 'acc_owner',
      at: AT + 100,
    })
    assert.equal(authEvents(store, 'auth.role.changed').length, 0)
  })
})

test('admin 不能授予或撤销 owner', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)

    assertStoreError(
      () =>
        setWorkspaceMemberRole(store, {
          workspaceId,
          accountId: 'acc_member',
          role: 'owner',
          by: 'acc_admin',
          at: AT + 100,
        }),
      'FORBIDDEN',
    )
    try {
      setWorkspaceMemberRole(store, {
        workspaceId,
        accountId: 'acc_member',
        role: 'owner',
        by: 'acc_admin',
        at: AT + 100,
      })
    } catch (err) {
      assert.equal(storeErrorTag(err), MEMBER_ERROR_CODES.forbidden)
    }

    assertStoreError(
      () =>
        setWorkspaceMemberRole(store, {
          workspaceId,
          accountId: 'acc_owner',
          role: 'admin',
          by: 'acc_admin',
          at: AT + 100,
        }),
      'FORBIDDEN',
    )
    // 失败不改变角色，也不写事件。
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_member'), 'member')
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_owner'), 'owner')
    assert.equal(authEvents(store, 'auth.role.changed').length, 0)
  })
})

test('owner 可以授予 owner；有两个 owner 后原 owner 可以降级', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    setWorkspaceMemberRole(store, {
      workspaceId,
      accountId: 'acc_admin',
      role: 'owner',
      by: 'acc_owner',
      at: AT + 100,
    })
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_admin'), 'owner')

    const demoted = setWorkspaceMemberRole(store, {
      workspaceId,
      accountId: 'acc_owner',
      role: 'admin',
      by: 'acc_owner',
      at: AT + 200,
    })
    assert.equal(demoted.role, 'admin')
    assert.equal(authEvents(store, 'auth.role.changed').length, 2)
  })
})

test('最后一个 owner 不能降级：抛 WORKSPACE_LAST_OWNER tag，角色不变', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    assertStoreError(
      () =>
        setWorkspaceMemberRole(store, {
          workspaceId,
          accountId: 'acc_owner',
          role: 'member',
          by: 'acc_owner',
          at: AT + 100,
        }),
      'FORBIDDEN',
    )
    try {
      setWorkspaceMemberRole(store, {
        workspaceId,
        accountId: 'acc_owner',
        role: 'member',
        by: 'acc_owner',
        at: AT + 100,
      })
    } catch (err) {
      assert.equal(storeErrorTag(err), MEMBER_ERROR_CODES.lastOwner)
    }
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_owner'), 'owner')
    assert.equal(authEvents(store, 'auth.role.changed').length, 0)
  })
})

test('移除成员：删行并写一次 auth.member.removed', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    removeWorkspaceMember(store, {
      workspaceId,
      accountId: 'acc_member',
      by: 'acc_admin',
      at: AT + 100,
    })
    assert.equal(getWorkspaceMember(store, workspaceId, 'acc_member'), null)

    const events = authEvents(store, 'auth.member.removed')
    assert.equal(events.length, 1)
    const event = events[0]!
    assert.deepEqual(event.actor, { kind: 'user', id: 'acc_admin' })
    assert.deepEqual(event.subject, { kind: 'member', id: 'acc_member' })
    assert.deepEqual(event.payload, { workspaceId, role: 'member' })
  })
})

test('最后一个 owner 不能移除；admin 不能移除 owner', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)

    try {
      removeWorkspaceMember(store, { workspaceId, accountId: 'acc_owner', by: 'acc_owner', at: AT + 100 })
      assert.fail('expected last owner removal to fail')
    } catch (err) {
      assert.equal(storeErrorTag(err), MEMBER_ERROR_CODES.lastOwner)
    }

    try {
      removeWorkspaceMember(store, { workspaceId, accountId: 'acc_owner', by: 'acc_admin', at: AT + 100 })
      assert.fail('expected admin removing owner to fail')
    } catch (err) {
      assert.equal(storeErrorTag(err), MEMBER_ERROR_CODES.forbidden)
    }

    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_owner'), 'owner')
    assert.equal(authEvents(store, 'auth.member.removed').length, 0)
  })
})

test('非 owner/admin 不能管理成员；不存在的成员报 notFound tag', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    assertStoreError(
      () =>
        setWorkspaceMemberRole(store, {
          workspaceId,
          accountId: 'acc_viewer',
          role: 'member',
          by: 'acc_member',
          at: AT + 100,
        }),
      'FORBIDDEN',
    )

    try {
      setWorkspaceMemberRole(store, {
        workspaceId,
        accountId: 'acc_missing',
        role: 'member',
        by: 'acc_owner',
        at: AT + 100,
      })
      assert.fail('expected missing member to fail')
    } catch (err) {
      assert.equal(storeErrorTag(err), MEMBER_ERROR_CODES.notFound)
    }
  })
})

test('非法角色值抛 INVALID_INPUT', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    assertStoreError(
      () =>
        setWorkspaceMemberRole(store, {
          workspaceId,
          accountId: 'acc_member',
          role: 'superuser' as never,
          by: 'acc_owner',
          at: AT + 100,
        }),
      'INVALID_INPUT',
    )
  })
})

test('事件写失败时角色变更回滚（行与事件同一 savepoint）', async () => {
  await withStore((store) => {
    const { workspaceId } = setup(store)
    store.db.exec(
      "CREATE TRIGGER fail_auth_role_event BEFORE INSERT ON events WHEN NEW.kind = 'auth.role.changed' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    try {
      assertStoreError(
        () =>
          setWorkspaceMemberRole(store, {
            workspaceId,
            accountId: 'acc_member',
            role: 'admin',
            by: 'acc_owner',
            at: AT + 100,
          }),
        'EVENT_WRITE_FAILED',
      )
    } finally {
      store.db.exec('DROP TRIGGER fail_auth_role_event')
    }
    // UPDATE 必须被 savepoint 回滚。
    assert.equal(getWorkspaceRole(store, workspaceId, 'acc_member'), 'member')
    assert.equal(authEvents(store, 'auth.role.changed').length, 0)
  })
})
