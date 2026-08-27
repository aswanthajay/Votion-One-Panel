-- This compatibility migration predates the core schema baseline. On a fresh
-- database it defers every account-dependent object to the later coverage
-- migration, which runs after the accounts table has been created.
DO $$
BEGIN
  IF to_regclass('public.accounts') IS NOT NULL THEN
    ALTER TABLE accounts ALTER COLUMN support_pin TYPE VARCHAR(100);

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGSERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS password_reset_tokens_account_idx
      ON password_reset_tokens(account_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
      ON password_reset_tokens(expires_at)
      WHERE used_at IS NULL;
  END IF;
END $$;
