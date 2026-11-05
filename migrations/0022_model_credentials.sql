-- 0022_model_credentials.sql — BYO 模型凭据与账号注册赠送 token 额度。
--
-- 设计：API Key 只在控制面加密存储，DSH 永远拿不到；免费额度按账号一次性发放，
-- 默认 90 天过期，只在使用平台 Key 且模型为免费模型时扣减。

CREATE TABLE workspace_model_credentials (
  workspace_id   TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  model          TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,           -- AES-256-GCM 密文（base64）
  key_iv         TEXT NOT NULL,
  key_tag        TEXT NOT NULL,
  key_hint       TEXT NOT NULL,           -- 只存后 4 位，用于 UI 展示
  updated_by     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE account_token_grants (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  remaining   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  idem        TEXT UNIQUE
);

CREATE INDEX idx_account_token_grants_account ON account_token_grants(account_id, expires_at);

CREATE TABLE account_token_ledger (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  grant_id    TEXT,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  idem        TEXT UNIQUE,
  at          INTEGER NOT NULL
);

CREATE INDEX idx_account_token_ledger_account ON account_token_ledger(account_id, at);
