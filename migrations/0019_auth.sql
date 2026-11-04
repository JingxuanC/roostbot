-- 0019_auth.sql — 账号登录：邮箱验证 / 密码重置 / OIDC 一次性令牌。
--
-- 事实源：docs/build/wave1.md §A、docs/design/auth.md §4（账号方式）、§9（数据模型）。
--
-- accounts 已在 0001_core.sql 建好（id/email/password_hash/oidc_subject/created_at/disabled_at），
-- 这里只补两个时间戳列，不重建表：
--   * email_verified_at：NULL = 邮箱还没验证；未验证的密码登录统一拒绝（路由层给 auth.email_unverified）
--   * password_updated_at：最后一次设密码的时刻（建号、重置、OIDC 账号补密码都会写）
--
-- auth_tokens 是所有一次性令牌的唯一去处：邮箱验证、密码重置、OIDC state（+ PKCE verifier）。
-- 与 sessions 同一原则：明文只在签发响应/邮件里出现一次，库里只存 sha256(token)；
-- used_at 非空即已消费（单次使用），expires_at 之后一律作废。
-- 与 0001 一样不加外键：控制面是权威，约束留给控制面。

ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER;
ALTER TABLE accounts ADD COLUMN password_updated_at INTEGER;

CREATE TABLE auth_tokens (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  payload_json TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);

-- 按 hash 查（消费令牌只做这一条路径）；也顺带防重复 hash。
CREATE UNIQUE INDEX idx_auth_tokens_hash ON auth_tokens(token_hash);

-- 按账号 + 类型清理（重发验证邮件、改密后作废旧令牌）。
CREATE INDEX idx_auth_tokens_account ON auth_tokens(account_id, kind);
