-- 0021_runtime_tokens.sql — 每 workspace 短期 runtime token（ADR 0005 的 provider 方案）。
--
-- 事实源：docs/build/wave3.md §B、docs/decisions/0005-runtime-token.md「provider 方案」。
--
-- 与 sessions / auth_tokens 同一原则：明文只在签发响应里出现一次，库里只存 sha256(token)。
-- 与 0001/0019 一样不加外键：控制面是权威，约束留给控制面。
--
-- 生命周期：start 时签发（TTL 跟沙箱走）→ 沙箱注入 ROOST_RUNTIME_TOKEN → 内部接口按
-- x-runtime-token 校验 → stop 时按 workspace 吊销。revoked_at 非空即作废，
-- expires_at 之后也一律作废；两者都保留，审计才能分清「过期」和「主动吊销」。

CREATE TABLE runtime_tokens (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);

-- 按 workspace 批量吊销 / 列出某 workspace 的有效 token（stop、重启、配额清理）。
CREATE INDEX idx_runtime_tokens_workspace ON runtime_tokens(workspace_id, revoked_at);
