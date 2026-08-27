CREATE TABLE IF NOT EXISTS registration_verification_tokens (
  email VARCHAR(255) PRIMARY KEY,
  token_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  otp_hash VARCHAR(64) NOT NULL,
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT registration_verification_attempt_count_check CHECK (attempt_count >= 0 AND attempt_count <= 10)
);

CREATE INDEX IF NOT EXISTS registration_verification_tokens_expiry_idx
  ON registration_verification_tokens (expires_at);
