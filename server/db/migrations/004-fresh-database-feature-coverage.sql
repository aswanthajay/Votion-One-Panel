-- Complete fresh-database schema coverage for active platform features.

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

ALTER TABLE vm_billing_profiles
  ADD COLUMN IF NOT EXISTS bandwidth_quota_gb NUMERIC;

CREATE TABLE IF NOT EXISTS stellar_api_keys (
  id SERIAL PRIMARY KEY,
  user_email VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  key_prefix VARCHAR(32) NOT NULL,
  scope VARCHAR(100) NOT NULL DEFAULT 'read',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stellar_api_keys_user_created
  ON stellar_api_keys (user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stellar_api_keys_active_hash
  ON stellar_api_keys (key_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS vm_backup_queue (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
  provider_task_id VARCHAR(255),
  requested_by VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'running',
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vm_backup_queue_vmid_created
  ON vm_backup_queue (vmid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_backup_queue_status_created
  ON vm_backup_queue (status, created_at DESC);

CREATE TABLE IF NOT EXISTS rdns_requests (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
  ip_address VARCHAR(50) NOT NULL,
  ptr_record VARCHAR(255) NOT NULL,
  requested_by VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rdns_requests_status_created
  ON rdns_requests (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_rdns_requests_vmid_created
  ON rdns_requests (vmid, created_at DESC);

CREATE TABLE IF NOT EXISTS app_catalog (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  category VARCHAR(100) NOT NULL,
  icon VARCHAR(100),
  template_name VARCHAR(150) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_catalog_enabled_category
  ON app_catalog (enabled, category, name);

CREATE TABLE IF NOT EXISTS app_instances (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
  app_id VARCHAR(100) NOT NULL REFERENCES app_catalog(id) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'provisioning',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (vmid, app_id)
);
CREATE INDEX IF NOT EXISTS idx_app_instances_vmid_created
  ON app_instances (vmid, created_at DESC);

CREATE TABLE IF NOT EXISTS vm_sub_users (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
  user_email VARCHAR(255) NOT NULL,
  scope VARCHAR(100) NOT NULL DEFAULT 'read',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (vmid, user_email)
);
CREATE INDEX IF NOT EXISTS idx_vm_sub_users_vmid_created
  ON vm_sub_users (vmid, created_at ASC);
