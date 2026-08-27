CREATE TABLE IF NOT EXISTS user_navigation_usage (
  account_email VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
  item_key VARCHAR(120) NOT NULL,
  item_type VARCHAR(20) NOT NULL,
  vmid INT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_email, item_key),
  CONSTRAINT user_navigation_usage_item_type_check CHECK (item_type IN ('destination', 'vm')),
  CONSTRAINT user_navigation_usage_usage_count_check CHECK (usage_count >= 0),
  CONSTRAINT user_navigation_usage_vmid_check CHECK ((item_type = 'vm' AND vmid IS NOT NULL) OR (item_type = 'destination' AND vmid IS NULL))
);

CREATE INDEX IF NOT EXISTS user_navigation_usage_rank_idx
  ON user_navigation_usage (account_email, usage_count DESC, last_used_at DESC);
