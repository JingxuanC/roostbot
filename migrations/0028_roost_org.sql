-- Roost Console organization link for OIDC accounts. Null for password-only
-- accounts until they are linked; product billing uses this id, not the local
-- account id, as the wallet dimension.
ALTER TABLE accounts ADD COLUMN roost_org_id TEXT;
CREATE INDEX idx_accounts_roost_org ON accounts(roost_org_id);
