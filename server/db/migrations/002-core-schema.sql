-- Votion One core schema baseline.
-- This migration is additive and intentionally preserves existing data.

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'client',
  phone VARCHAR(50),
  support_pin VARCHAR(100),
  two_factor_active BOOLEAN NOT NULL DEFAULT false,
  tfa_secret VARCHAR(100),
  operator_access BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE accounts ALTER COLUMN support_pin TYPE VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS two_factor_active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tfa_secret VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operator_access BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS proxmox_connections (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  host_ip VARCHAR(50) NOT NULL,
  port INT NOT NULL,
  username VARCHAR(100) NOT NULL DEFAULT 'root@pam',
  password VARCHAR(255),
  token_id VARCHAR(100) NOT NULL,
  token_secret VARCHAR(255) NOT NULL,
  ssl_fingerprint VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'connected',
  last_tested TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE proxmox_connections ADD COLUMN IF NOT EXISTS username VARCHAR(100) DEFAULT 'root@pam';
ALTER TABLE proxmox_connections ADD COLUMN IF NOT EXISTS password VARCHAR(255);

CREATE TABLE IF NOT EXISTS nodes (
  id VARCHAR(50) PRIMARY KEY,
  node_name VARCHAR(100) NOT NULL,
  ip_address VARCHAR(50) NOT NULL,
  api_token VARCHAR(255),
  cluster_status VARCHAR(50) NOT NULL DEFAULT 'online',
  cpu_usage NUMERIC,
  ram_usage BIGINT,
  ram_total BIGINT,
  zfs_health VARCHAR(100),
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vms (
  vmid INT PRIMARY KEY,
  user_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  node_id VARCHAR(50),
  proxmox_connection_id VARCHAR(50) REFERENCES proxmox_connections(id) ON DELETE SET NULL,
  vm_name VARCHAR(255) NOT NULL,
  os_type VARCHAR(100) NOT NULL DEFAULT 'Ubuntu 24.04 LTS',
  cpu_cores INT NOT NULL DEFAULT 4,
  ram_mb INT NOT NULL DEFAULT 4096,
  disk_gb INT NOT NULL DEFAULT 64,
  status VARCHAR(50) NOT NULL DEFAULT 'running',
  owner_email VARCHAR(255) NOT NULL,
  node VARCHAR(100) NOT NULL DEFAULT 'pve-01',
  expiry_date TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  is_suspended BOOLEAN NOT NULL DEFAULT false,
  type VARCHAR(50) NOT NULL DEFAULT 'qemu',
  cpus INT DEFAULT 4,
  memory BIGINT DEFAULT 4294967296,
  maxmem BIGINT DEFAULT 8589934592,
  disk BIGINT DEFAULT 34359738368,
  maxdisk BIGINT DEFAULT 68719476736,
  uptime BIGINT DEFAULT 0,
  ip_address VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE vms ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);

CREATE TABLE IF NOT EXISTS vm_identity_conflicts (
  vmid INT NOT NULL,
  existing_proxmox_connection_id VARCHAR(50) NOT NULL,
  incoming_proxmox_connection_id VARCHAR(50) NOT NULL,
  existing_vm_name VARCHAR(255),
  incoming_vm_name VARCHAR(255),
  raw_node_name VARCHAR(100),
  detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vmid, existing_proxmox_connection_id, incoming_proxmox_connection_id)
);
CREATE INDEX IF NOT EXISTS idx_vm_identity_conflicts_detected ON vm_identity_conflicts (detected_at DESC);

CREATE TABLE IF NOT EXISTS vm_reimage_requests (
  id VARCHAR(100) PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
  requester_email VARCHAR(255) NOT NULL,
  requested_os VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requester_note TEXT,
  reviewer_email VARCHAR(255),
  reviewer_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  cancelled_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vm_reimage_requests_status_created ON vm_reimage_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_reimage_requests_vmid_created ON vm_reimage_requests (vmid, created_at DESC);

CREATE TABLE IF NOT EXISTS vm_reimage_image_profiles (
  id VARCHAR(100) PRIMARY KEY,
  os_label VARCHAR(100) NOT NULL,
  vm_type VARCHAR(20) NOT NULL,
  template_vmid INT,
  template_node VARCHAR(100),
  storage_id VARCHAR(100),
  version VARCHAR(100) NOT NULL,
  image_digest VARCHAR(255),
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMP,
  UNIQUE (os_label, vm_type, version)
);

CREATE TABLE IF NOT EXISTS vm_reimage_executions (
  id VARCHAR(100) PRIMARY KEY,
  request_id VARCHAR(100) NOT NULL UNIQUE REFERENCES vm_reimage_requests(id) ON DELETE RESTRICT,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE RESTRICT,
  request_snapshot JSONB NOT NULL,
  image_profile_id VARCHAR(100) REFERENCES vm_reimage_image_profiles(id) ON DELETE RESTRICT,
  image_profile_version VARCHAR(100),
  state VARCHAR(40) NOT NULL DEFAULT 'created',
  plan_hash VARCHAR(128),
  operator_email VARCHAR(255),
  operator_confirmed_at TIMESTAMP,
  preflight_snapshot JSONB,
  backup_reference VARCHAR(500),
  lease_owner VARCHAR(255),
  lease_expires_at TIMESTAMP,
  attempt_count INT NOT NULL DEFAULT 0,
  current_step VARCHAR(100),
  step_upids JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_result JSONB,
  error_code VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  queued_at TIMESTAMP,
  completed_at TIMESTAMP,
  blocked_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vm_reimage_executions_state_updated ON vm_reimage_executions (state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_reimage_executions_vmid_state ON vm_reimage_executions (vmid, state);

CREATE TABLE IF NOT EXISTS vm_reimage_audit_events (
  id VARCHAR(100) PRIMARY KEY,
  request_id VARCHAR(100) REFERENCES vm_reimage_requests(id) ON DELETE SET NULL,
  execution_id VARCHAR(100) REFERENCES vm_reimage_executions(id) ON DELETE SET NULL,
  actor_email VARCHAR(255) NOT NULL,
  actor_capability VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  from_state VARCHAR(40),
  to_state VARCHAR(40),
  correlation_id VARCHAR(100) NOT NULL,
  plan_hash VARCHAR(128),
  safe_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vm_reimage_audit_execution_created ON vm_reimage_audit_events (execution_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(100) PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  user_email VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target VARCHAR(255) NOT NULL,
  details TEXT,
  status VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id VARCHAR(50) PRIMARY KEY,
  ticket_number VARCHAR(50) UNIQUE NOT NULL,
  user_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  vmid INT,
  subject VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'General',
  priority VARCHAR(50) NOT NULL DEFAULT 'medium',
  status VARCHAR(50) NOT NULL DEFAULT 'open',
  user_email VARCHAR(255) NOT NULL,
  assigned_to VARCHAR(255),
  last_client_read_at TIMESTAMP,
  last_admin_read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(255);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_client_read_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_admin_read_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets (status, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets (assigned_to, updated_at DESC);

CREATE TABLE IF NOT EXISTS ticket_replies (
  id VARCHAR(100) PRIMARY KEY,
  ticket_id VARCHAR(50) REFERENCES tickets(id) ON DELETE CASCADE,
  sender_email VARCHAR(255) NOT NULL,
  sender_role VARCHAR(50) NOT NULL DEFAULT 'client',
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  target VARCHAR(20) NOT NULL DEFAULT 'cluster',
  vmid INT,
  node_name VARCHAR(100),
  metric VARCHAR(30) NOT NULL,
  operator VARCHAR(5) NOT NULL DEFAULT '>',
  threshold NUMERIC NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning',
  cooldown_minutes INT NOT NULL DEFAULT 10,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_target_node ON alert_rules (target, node_name, enabled);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL,
  rule_id INT,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning',
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vm_metrics (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  cpu_pct NUMERIC,
  ram_bytes BIGINT,
  net_in_bytes BIGINT,
  net_out_bytes BIGINT,
  diskread_bytes BIGINT,
  diskwrite_bytes BIGINT,
  UNIQUE (vmid, timestamp)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_metrics_vmid_ts ON vm_metrics (vmid, timestamp);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pricing_plans (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  monthly_price_cents BIGINT NOT NULL DEFAULT 0,
  vcpu_limit INT NOT NULL DEFAULT 1,
  ram_gb NUMERIC NOT NULL DEFAULT 1,
  disk_gb NUMERIC NOT NULL DEFAULT 10,
  bandwidth_gb NUMERIC,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vm_billing_profiles (
  vmid INT PRIMARY KEY REFERENCES vms(vmid) ON DELETE CASCADE,
  plan_id VARCHAR(100) REFERENCES pricing_plans(id) ON DELETE SET NULL,
  custom_monthly_price_cents BIGINT,
  billing_status VARCHAR(30) NOT NULL DEFAULT 'active',
  billing_cycle_day INT NOT NULL DEFAULT 1,
  grace_period_days INT,
  next_due_at TIMESTAMP,
  ip_count INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE vm_billing_profiles ADD COLUMN IF NOT EXISTS ip_count INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS billing_invoices (
  id VARCHAR(100) PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE RESTRICT,
  plan_id VARCHAR(100) REFERENCES pricing_plans(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  issued_at TIMESTAMP NOT NULL DEFAULT NOW(),
  due_at TIMESTAMP NOT NULL,
  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  tax_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,
  paid_cents BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  paid_at TIMESTAMP,
  last_reminder_at TIMESTAMP,
  suspension_eligible_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (vmid, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_invoice_account_due ON billing_invoices (account_email, due_at, status);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_overdue ON billing_invoices (status, suspension_eligible_at);

CREATE TABLE IF NOT EXISTS billing_payments (
  id VARCHAR(100) PRIMARY KEY,
  invoice_id VARCHAR(100) NOT NULL REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  account_email VARCHAR(255) NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  method VARCHAR(50) NOT NULL DEFAULT 'manual',
  external_reference VARCHAR(255),
  received_at TIMESTAMP NOT NULL DEFAULT NOW(),
  recorded_by VARCHAR(255) NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS billing_cost_bases (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  monthly_cost_cents BIGINT NOT NULL DEFAULT 0,
  allocation_method VARCHAR(30) NOT NULL DEFAULT 'fixed',
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE billing_cost_bases ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR';

CREATE TABLE IF NOT EXISTS billing_server_costs (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  node_name VARCHAR(100),
  proxmox_connection_id VARCHAR(50) REFERENCES proxmox_connections(id) ON DELETE SET NULL,
  monthly_cost_paise BIGINT NOT NULL DEFAULT 0,
  ip_cost_paise BIGINT NOT NULL DEFAULT 0,
  planned_vm_capacity INT NOT NULL DEFAULT 0,
  included_ip_count INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE billing_server_costs ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE billing_server_costs ALTER COLUMN node_name DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_server_costs_connection_unique ON billing_server_costs (proxmox_connection_id) WHERE proxmox_connection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_events (
  id VARCHAR(100) PRIMARY KEY,
  invoice_id VARCHAR(100) REFERENCES billing_invoices(id) ON DELETE SET NULL,
  vmid INT REFERENCES vms(vmid) ON DELETE SET NULL,
  event_key VARCHAR(100) NOT NULL,
  period_key VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, event_key, period_key)
);
CREATE INDEX IF NOT EXISTS idx_billing_events_invoice_created ON billing_events (invoice_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_suspension_actions (
  id VARCHAR(100) PRIMARY KEY,
  invoice_id VARCHAR(100) REFERENCES billing_invoices(id) ON DELETE SET NULL,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMP,
  reversed_at TIMESTAMP,
  actor_email VARCHAR(255),
  error_message TEXT,
  UNIQUE (vmid, invoice_id, status)
);
CREATE INDEX IF NOT EXISTS idx_billing_suspension_status ON billing_suspension_actions (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS secondary_emails (
  id SERIAL PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
  secondary_email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(account_email, secondary_email)
);
CREATE TABLE IF NOT EXISTS passkeys (
  id SERIAL PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
  credential_id VARCHAR(255) NOT NULL UNIQUE,
  key_name VARCHAR(100) NOT NULL DEFAULT 'Hardware Passkey',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS totp_secrets (
  account_email VARCHAR(255) PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
  secret VARCHAR(100) NOT NULL,
  issuer VARCHAR(100) NOT NULL DEFAULT 'VOTION',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS support_sessions (
  id VARCHAR(100) PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  support_pin VARCHAR(100),
  expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS uploaded_files (
  id VARCHAR(100) PRIMARY KEY,
  account_email VARCHAR(255) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT,
  mime_type VARCHAR(100),
  storage_path VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS vm_snapshots (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL,
  snapshot_name VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(100) PRIMARY KEY,
  user_email VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  priority VARCHAR(50) NOT NULL DEFAULT 'medium',
  progress_pct NUMERIC NOT NULL DEFAULT 0,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS firewall_rules (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL,
  rule_type VARCHAR(10) NOT NULL DEFAULT 'in',
  action VARCHAR(20) NOT NULL DEFAULT 'ACCEPT',
  proto VARCHAR(10),
  dport VARCHAR(50),
  source VARCHAR(50),
  enabled BOOLEAN NOT NULL DEFAULT true,
  comment VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS key_files (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kid VARCHAR(64) UNIQUE NOT NULL,
  secret_hash VARCHAR(64) NOT NULL,
  file_name VARCHAR(120) NOT NULL DEFAULT 'stellar-key.stk',
  revoked BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_key_files_account_created ON key_files (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id VARCHAR(100) PRIMARY KEY,
  owner_email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  task_type VARCHAR(50) NOT NULL,
  target_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  schedule_days JSONB NOT NULL DEFAULT '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]'::jsonb,
  schedule_time VARCHAR(5) NOT NULL DEFAULT '00:00',
  timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run TIMESTAMP,
  last_status VARCHAR(50),
  next_run TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner_next_run ON scheduled_tasks (owner_email, next_run);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled_next_run ON scheduled_tasks (enabled, next_run);

DO $$
BEGIN
  IF to_regclass('public.vm_telemetry') IS NOT NULL THEN
    INSERT INTO vm_metrics (vmid, timestamp, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes, diskread_bytes, diskwrite_bytes)
    SELECT vmid, timestamp, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes, diskread_bytes, diskwrite_bytes
    FROM vm_telemetry
    ON CONFLICT (vmid, timestamp) DO NOTHING;
  END IF;
END $$;

INSERT INTO system_settings (setting_key, setting_value)
VALUES ('smtp_config', '{"enabled": false, "host": "", "port": 587, "user": "", "pass": "", "secure": false, "from": "noreply@votioncloud.org"}')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO system_settings (setting_key, setting_value)
VALUES ('billing_config', '{"automationEnabled": false, "reminderEmailsEnabled": false, "suspensionExecutionEnabled": false, "daysBeforeDue": 7, "gracePeriodDays": 7, "suspendAfterDaysOverdue": 1, "taxRatePercent": 0, "currency": "INR"}')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO pricing_plans (id, name, currency, monthly_price_cents, vcpu_limit, ram_gb, disk_gb, bandwidth_gb, sort_order)
VALUES
  ('plan-starter', 'Proxmox Starter', 'USD', 2900, 2, 4, 50, 2048, 10),
  ('plan-pro', 'Proxmox Pro Cluster', 'USD', 8900, 8, 16, 200, 10240, 20),
  ('plan-enterprise', 'Proxmox Dedicated Node', 'USD', 24900, 32, 64, 1000, NULL, 30)
ON CONFLICT (id) DO NOTHING;
INSERT INTO billing_cost_bases (id, name, monthly_cost_cents, allocation_method)
VALUES ('cost-infrastructure', 'Proxmox infrastructure', 0, 'fixed')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mail_templates (
  id SERIAL PRIMARY KEY,
  template_key VARCHAR(100) UNIQUE NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE proxmox_connections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE vms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

INSERT INTO mail_templates (template_key, subject, body, enabled) VALUES
  ('welcome', 'Welcome to Stellar Platform', '<div style="font-family: sans-serif;"><h2>Welcome to the Stellar Platform, {name}!</h2><p>Your account has been successfully created. You can now log in to the dashboard to manage your virtual machines and services.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', true),
  ('ticket_update', 'Support Ticket Update: {ticketNumber}', '<div style="font-family: sans-serif;"><h2>Support Ticket Update: {ticketNumber}</h2><p>Your support ticket status has been updated to: <strong>{status}</strong></p><p>{message}</p><p>Best regards,<br/>Stellar Platform Support</p></div>', true),
  ('expiry_warning', 'Service Expiry Warning: VMID {vmid}', '<div style="font-family: sans-serif;"><h2>Service Expiry Warning</h2><p>Your virtual machine (VMID {vmid}) is approaching its expiry date. Please extend your service to avoid interruption.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', true),
  ('alert_fired', 'Stellar Alert: {title}', '<div style="font-family: sans-serif;"><h2>{title}</h2><p>{message}</p><p>Review the metrics dashboard for full details.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', true),
  ('password_reset', 'Your Stellar Platform password was changed', '<div style="font-family: sans-serif;"><h2>Password Changed</h2><p>The password for your account ({email}) was changed by an administrator. If you did not expect this, please contact support immediately.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', true),
  ('account_updated', 'Your Stellar Platform account was updated', '<div style="font-family: sans-serif;"><h2>Account Updated</h2><p>Your account details were updated by an administrator: {changes}.</p><p>If you did not expect this, please contact support immediately.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', true),
  ('connection_test', 'Cluster Connection Test Successful', '<div style="font-family: sans-serif;"><h2>Connection Test Passed</h2><p>The connection to the cluster endpoint ({host}:{port}) was verified successfully. Your panel is communicating with the compute infrastructure correctly.</p><p>Best regards,<br/>Stellar Platform</p></div>', true)
ON CONFLICT (template_key) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, enabled = EXCLUDED.enabled;
