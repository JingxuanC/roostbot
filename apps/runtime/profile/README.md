# profile/ — 镜像里的基线，不是租户 profile

这个目录只会被 `Dockerfile` 复制到镜像的 `/opt/roostbot/profile`，作为**空基线**：
`package.json` + 空的 `cordis.yml` / `cordis.patch.yml`。

真实的 workspace profile 由控制面生成（见 `docs/runtime-contract.md` 第 6 条与
`docs/design/plugins.md`）：

- 控制面按租户生成 `package.json`、`cordis.yml`、`cordis.patch.yml`
- 插件按 `plugins.lock.json` 非交互同步，失败时容器不得进入 running
- 生成结果放在 workspace 卷上，启动时通过 `DSH_PROFILE` 指过去，或挂载覆盖
  `/opt/roostbot/profile`

**不要把租户插件、token、`link:` 依赖打进镜像。** 这个基线只保证目录结构存在，
不保证不经过控制面就能启动一个可用的 DSH（见 `apps/runtime/README.md` 的诚实边界）。
