# @roost/storage

内容存储接口：**内容寻址 + 不可变 + 引用计数**。默认本地卷，v2 可换对象存储，调用方不变。

设计见 [`docs/design/storage.md`](../../docs/design/storage.md)。

## 接口

```ts
ContentStore = { put, get, head, delete, signRead }
id = sha256(bytes).slice(0, 32)      // 同内容只存一份
path = ab/cd/<id>                    // 本地卷两级目录
```

## 四条规则

1. **内容寻址**：同样内容只存一份，重复 put 幂等
2. **不可变**：不覆盖；要改就是新对象
3. **不暴露路径**：浏览器只经 `/api/attachments/:id`，永远拿不到真实文件路径
4. **引用计数回收**：`ref_count=0` 且超过保留期才删，删前写审计事件

## 默认实现

`LocalVolumeStore`：`<workspace 卷>/attachments/`，写临时文件 → fsync → rename（同卷原子），目录 0700、文件 0600。

## 待办

- [ ] LocalVolumeStore 实现（含 GC）
- [ ] 预签名 URL 与 Range 读取
- [ ] 缩略图缓存（头像/图片）
