# Roost CLI 安装与发布

> 状态：便携安装包已落地（2026-11-09）；原生签名安装包是下一阶段。

## 1. 当前形态

CLI 是一个单文件 `roost.mjs`，只依赖 Node 标准库。

```text
dist/cli/v<version>/
  roost.mjs
  install.sh
  install.ps1
  checksums.txt
  README.txt
dist/roost-cli-v<version>.tar.gz
```

构建：

```bash
node scripts/package-cli.mjs
```

产物同时包含 npm 包：

```text
dist/roost-cli-0.1.0.tgz   # npm install -g roost-cli
```

当前发布地址：

```text
https://www.roostbots.com/downloads/cli/v0.1.0/
```

### npm（推荐）

```bash
npm install -g roost-cli
roost --version
```

如果 npm registry 还没发布，下载 tarball 后本地安装：

```bash
curl -fLO https://www.roostbots.com/downloads/cli/v0.1.0/roost-cli-0.1.0.tgz
npm install -g ./roost-cli-0.1.0.tgz
```

npm 12 直接安装远程 tarball 需要：

```bash
npm install -g --allow-remote=all <url>
```

### 不依赖 npm 的便携安装器

```bash
curl -fsSL https://www.roostbots.com/downloads/cli/v0.1.0/install.sh | sh
```

Windows：

```powershell
irm https://www.roostbots.com/downloads/cli/v0.1.0/install.ps1 | iex
```

安装器做：

```text
检查 Node >= 22.18
下载 roost.mjs + checksums.txt
校验 sha256
安装到 ~/.roost/bin/roost.mjs
在 ~/.local/bin/roost 写 wrapper
提示 roost setup
```

路径可用环境变量覆盖：

```text
ROOST_INSTALL_DIR
ROOST_BIN_DIR
ROOST_CLI_BASE_URL
ROOST_CLI_VERSION
```

## 2. 为什么先做 portable installer

- 不要求 npm 全局安装
- 不把 Node 打进二进制（第一版）
- 安装脚本短、可审计、可替换
- CLI 与 daemon 共用同一份文件
- 后续升级只需替换 `roost.mjs`

## 3. 下一阶段：单文件二进制

目标是不要求用户预装 Node。

路线 A：**Bun compile**

```bash
bun build --compile apps/cli/roost.mjs --outfile roost
```

缺点：需要验证 `child_process`、PTY、fetch、路径行为与 Node 一致。

路线 B：**Node SEA**

```text
esbuild apps/cli/roost.mjs --bundle --platform=node --format=cjs
node --experimental-sea-config sea-config.json
cp $(command -v node) roost
npx postject roost NODE_SEA_BLOB sea-prep.blob ...
```

产物按平台发布：

```text
roost-darwin-arm64
roost-darwin-x64
roost-linux-x64
roost-linux-arm64
roost-windows-x64.exe
```

## 4. 原生安装包

| 平台 | 包 | 需要 |
|---|---|---|
| macOS | `.pkg` / `.dmg` | Developer ID 签名 + notarization |
| Windows | `.msi` 或 Inno Setup `.exe` | Authenticode 证书 |
| Linux | `.deb` / `.rpm` | nfpm 或 fpm |

原生安装包应包含：

```text
roost 二进制
launchd / systemd / Windows Startup 注册
安装后提示 `roost setup`
卸载时移除自启动
```

## 5. 发布流程

```text
1. 改 package.json version 与 CHANGELOG
2. node scripts/package-cli.mjs
3. 上传 dist/cli/v<version> 到 www/downloads/cli/
4. 上传 dist/roost-cli-v<version>.tar.gz 到 GitHub Release
5. 以后可增加签名、公证、自动更新
```

## 6. 安全

- 安装器必须校验 sha256
- 不自动登录、不自动读取用户项目
- 不把 model key 写入安装包
- 原生安装包必须签名；未签名版本只作为开发预览
- 自启动只运行 `roost daemon run`，没有 shell 拼接的用户输入
