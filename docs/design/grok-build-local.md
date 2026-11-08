# Grok Build 本地 + DeepSeek

> 验证日期：2026-11-08。Grok Build 不是只能接 xAI；它支持
> `[model.<name>]` 自定义 OpenAI-compatible endpoint。本机已用 DeepSeek 跑通。

## 配置

```toml
# ~/.grok/config.toml
[models]
default = "deepseek-chat"

[model.deepseek-chat]
model = "deepseek-chat"
name = "DeepSeek Chat"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
api_backend = "chat_completions"
context_window = 65536
max_completion_tokens = 4096
temperature = 0.3
```

`env_key` 让 key 留在环境变量里，不写进配置文件。脚本：

```bash
DEEPSEEK_API_KEY=... sh scripts/configure-grok-deepseek.sh
```

## 启动

```bash
source ~/roost-local-agents/env.sh
export PATH="$HOME/.grok/bin:$PATH"
grok -p '只回复 GROK_DEEPSEEK_OK' --model deepseek-chat
```

本机实测：

```text
grok 1.0.45 (2bdd1d6a6369)
GROK_DEEPSEEK_OK
```

ACP 实测：

```text
grok agent --always-approve stdio
ACP_DEEPSEEK_OK
```

## 从源码构建（本机 macOS arm64）

x.ai 安装器在部分网络不可达；源码构建：

```bash
git clone --depth 1 https://github.com/xai-org/grok-build.git
cd grok-build
export PROTOC=/path/to/protoc
export GROK_SHELL_BUNDLE_RG_PATH=/path/to/rg
cargo build -p xai-grok-pager-bin --release
cp target/release/xai-grok-pager ~/.grok/bin/grok
```

本机用 Rust stable 构建成功；官方要求 Rust 1.94，源码树 1.94 工具链下载不
可用时 stable 1.99 也可构建。

## 验证

```text
headless: grok -p ... --model deepseek-chat
ACP:      createAcpAdapter('grok-build', {...}).probe()
          -> {"ok":true,"binary":"/Users/paopao/.grok/bin/grok","auth":"unknown"}
```

`auth: unknown` 是 probe 不主动发模型请求，不代表调用失败；实际 headless 和 ACP
turn 都已返回 DeepSeek 文本。
