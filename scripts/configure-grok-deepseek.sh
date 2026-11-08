#!/bin/sh
# Configure Grok Build to use DeepSeek's OpenAI-compatible Chat Completions API.
#
#   DEEPSEEK_API_KEY=sk-... sh scripts/configure-grok-deepseek.sh
#
# The key is referenced by env name (env_key), not written into config.toml.
set -eu
GROK_HOME=${GROK_HOME:-$HOME/.grok}
CONFIG="$GROK_HOME/config.toml"
DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}
mkdir -p "$GROK_HOME"
cat > "$CONFIG" <<CFG
[models]
default = "deepseek-chat"

[model.deepseek-chat]
model = "deepseek-chat"
name = "DeepSeek Chat"
base_url = "$DEEPSEEK_BASE_URL"
env_key = "DEEPSEEK_API_KEY"
api_backend = "chat_completions"
context_window = 65536
max_completion_tokens = 4096
temperature = 0.3
CFG
chmod 600 "$CONFIG"
echo "wrote $CONFIG"
echo "run: source ~/roost-local-agents/env.sh && grok -p '只回复 OK' --model deepseek-chat"
