# 存储：接口化，默认本地卷

> 状态：方案（2026-11-03）。配套：`workspace.md`（卷与迁移）、`events.md`（事件引用附件）、`budget.md`（存储计量）。

## 1. 一句话

**内容存储是一个接口（`ContentStore`），默认实现是本地卷；以后要上对象存储只换实现，不改调用方。**

这样 v0 不引入任何云依赖（卷就是状态），v1 再按租户/区域切到 S3/OSS。

## 2. 为什么接口化

| 需求 | 本地卷 | 对象存储 |
|---|---|---|
| 单机零依赖 | ✅ | ❌ 需要凭据/网络 |
| 迁移简单（快照即带走） | ✅ | 需要同步 |
| 多端直传（手机上传大图） | ❌ 要经服务器 | ✅ 预签名 URL |
| 跨区域/多副本 | ❌ | ✅ |
| 成本 | 卷贵 | 对象存储便宜 |

**结论**：v0/v1 本地卷，v2 按客户切对象存储，**调用方代码不变**。

## 3. 接口

```ts
interface ContentStore {
  put(bytes: Uint8Array, meta: { mime: string; owner: string; audience?: string }): Promise<StoredObject>
  get(id: string): Promise<{ bytes: Uint8Array; meta: StoredObjectMeta } | null>
  head(id: string): Promise<StoredObjectMeta | null>
  delete(id: string): Promise<boolean>
  /** 预签名读取 URL；本地卷实现返回控制面代理 URL。 */
  signRead(id: string, ttlSeconds: number): Promise<string>
}

interface StoredObject {
  id: string          // 内容寻址：sha256 的前 32 hex
  sha256: string
  size: number
  mime: string
}
```

**三条约束**：

1. **内容寻址**：`id = sha256(bytes).slice(0,32)`，同样内容只存一份
2. **写不可变**：同样 id 重复 put 直接返回已存在，不覆盖
3. **删除走引用计数**：事件不再引用时才真删（GC）

## 4. 默认实现：LocalVolumeStore

```
<workspace 卷>/attachments/
  └─ ab/cd/abcdef12…            ← 两级目录，避免单目录过多文件
       ├─ blob                 ← 内容（0600）
       └─ meta.json            ← {mime, size, owner, audience, createdAt}
```

实现要点：

| 项 | 做法 |
|---|---|
| 原子写 | 写 `blob.tmp` → fsync → rename；rename 同卷原子 |
| 权限 | 目录 0700、文件 0600 |
| 去重 | 先算 sha256，存在即直接返回 |
| 读取 | 服务器进程读，再流式返回；**绝不把真实路径给浏览器** |
| 预签名 | 本地实现返回 `/api/attachments/:id?token=<短时>`，由控制面校验 |
| 校验 | 读时可重算 sha256（可选，默认只在 GC 时校验） |

## 5. 元数据与引用

```sql
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,        -- 内容寻址
  workspace_id TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mime         TEXT NOT NULL,
  owner        TEXT NOT NULL,           -- account id
  audience     TEXT NOT NULL DEFAULT 'team',
  ref_count    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE attachment_refs (
  attachment_id TEXT NOT NULL,
  event_id      TEXT NOT NULL,          -- 哪个事件引用了它
  PRIMARY KEY (attachment_id, event_id)
);
```

**引用来源**：`chat.message` 的附件、`tool.result` 的外置大输出、Bot 头像、报告成品。

**GC**：

1. 事件表里扫出所有 `attachment_id` 引用（事件是事实源，最可靠）
2. `ref_count = 0` 且超过保留期（默认 7 天）→ 删除 blob 与元数据
3. 删除前写一条 `attachment.gc` 事件，留审计

## 6. 配额与计量

| 层 | 限制 | 行为 |
|---|---|---|
| 单文件 | 默认 **50 MB**（头像 10 MB） | 拒绝并提示 |
| workspace | 默认 1–100 GB（按套餐） | 超限拒绝新上传（507） |
| 单事件引用数 | 每消息 ≤ 10 个附件 | 拒绝 |

计量：`billing.usage` 记 `storage_bytes`（日采样），与 `budget.md` 对齐。

## 7. 加密

| 层 | v0 | v1+ |
|---|---|---|
| 传输 | TLS | 同 |
| 静态（卷） | 依赖卷/磁盘加密 + 文件权限 0600 | 可选每文件 envelope 加密（DEK + KMS） |
| 对象存储 | — | 服务端加密（SSE）+ 可选 KMS |

**v0 不自己做应用层加密**：卷已经加密时再加一层只会拖慢且增加密钥管理风险。等真要跨租户共享存储时再上 envelope。

## 8. 迁移（换后端）

```
① 目标 store 就绪
② 按 sha256 全量复制（内容寻址，天然可校验）
③ 校验：逐条比对 sha256 + size
④ 切换：控制面把 workspace 的 storage_backend 指向新实现
⑤ 双读窗口（默认 24h）：读失败回退旧 store
⑥ 旧 store 只删过期未引用对象
```

`workspace.md` 的迁移（换机器）只搬卷，不改 backend；**换 backend 是另一件事**，单独走上面流程。

## 9. 失败语义

| 场景 | 行为 |
|---|---|
| 磁盘满 | put 返回 507，回合内工具拿到明确错误 |
| 内容损坏 | 读时 sha256 不匹配 → 视为不存在 + 告警 |
| 并发写同一内容 | 幂等（同 sha256 覆盖无害） |
| 预签名过期 | 403，客户端重新申请 |
| GC 误删 | 只删 `ref_count=0` 且超保留期；有事件引用就永不删 |

## 10. 与其它文档的接口

| 文档 | 关系 |
|---|---|
| `events.md` | 事件只存附件 id；大 payload 外置（> 8KB） |
| `loop-and-context.md` | 工具结果超阈值 → 存 store，上下文只留摘要 + id |
| `workspace.md` | 卷包含 `attachments/`；迁移随卷 |
| `budget.md` | `storage_bytes` 是计量项之一 |
| `sandboxing.md` | 沙箱写文件在 `/workspace`，回合结束由 runtime 决定哪些进 store |

## 11. 分期

### v0
- 只实现 LocalVolumeStore；附件 = 聊天图片 + 工具大输出
- **验收**：同一张图发两次只存一份；浏览器只能通过 `/api/attachments/:id` 取，拿不到路径

### v1
- 引用计数 + GC + 配额
- **验收**：删掉引用后 7 天，blob 真的消失；超配额上传被拒

### v2
- S3/OSS 实现；迁移流程
- **验收**：换 backend 后老附件仍可读（双读窗口）

## 12. 待决问题

1. **头像是否单独存**（尺寸小、访问频繁）？倾向：同 store，但加内存缓存。
2. **报告成品（HTML）存哪**：store 还是卷内文件？倾向：卷内（可被 git 式审计），store 只放大附件。
3. **保留期按套餐差异化**：免费 30 天、付费 365 天？
4. **图片压缩**：上传时就转 WebP，还是按需生成缩略图？倾向：保留原图 + 按需缩略图缓存。
