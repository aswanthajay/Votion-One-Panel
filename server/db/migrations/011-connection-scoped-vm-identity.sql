-- Promote VM identity from global VMID to (Proxmox connection, VMID).
-- Existing rows without a connection are retained under a local legacy scope so
-- older installations remain bootable and can be reassigned explicitly later.

INSERT INTO proxmox_connections (
  id, name, host_ip, port, username, token_id, token_secret, ssl_fingerprint, status
)
VALUES (
  'legacy-local', 'Legacy local inventory', '127.0.0.1', 8006, 'root@pam',
  'legacy', 'legacy', '', 'legacy'
)
ON CONFLICT (id) DO NOTHING;

UPDATE vms
SET proxmox_connection_id = 'legacy-local'
WHERE proxmox_connection_id IS NULL;

ALTER TABLE vms
  ALTER COLUMN proxmox_connection_id SET DEFAULT 'legacy-local',
  ALTER COLUMN proxmox_connection_id SET NOT NULL;

-- Add the scope column to every first-party VM-dependent table.
ALTER TABLE vm_reimage_requests ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_reimage_executions ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_metrics ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_billing_profiles ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE billing_suspension_actions ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_backup_queue ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE rdns_requests ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE app_instances ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_sub_users ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_sub_user_invitations ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE user_navigation_usage ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);

-- Backfill all dependent rows while VMID is still unique in pre-migration data.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'vm_reimage_requests', 'vm_reimage_executions', 'tickets', 'vm_metrics',
    'vm_billing_profiles', 'billing_invoices', 'billing_events',
    'billing_suspension_actions', 'provider_operations', 'vm_backup_queue',
    'rdns_requests', 'app_instances', 'vm_sub_users', 'vm_sub_user_invitations',
    'user_navigation_usage', 'alert_rules'
  ] LOOP
    EXECUTE format(
      'UPDATE %I child SET proxmox_connection_id = vm.proxmox_connection_id
       FROM vms vm
       WHERE child.vmid = vm.vmid AND child.proxmox_connection_id IS NULL',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN proxmox_connection_id SET DEFAULT ''legacy-local''',
      table_name
    );
  END LOOP;
END $$;

-- Remove VMID-only foreign keys before changing the VM primary key.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT n.nspname AS schema_name, child.relname AS table_name, con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    WHERE con.contype = 'f'
      AND parent.relname = 'vms'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I', fk.schema_name, fk.table_name, fk.constraint_name);
  END LOOP;
END $$;

ALTER TABLE vms DROP CONSTRAINT IF EXISTS vms_pkey;
ALTER TABLE vms DROP CONSTRAINT IF EXISTS vms_connection_vmid_unique;
ALTER TABLE vms ADD PRIMARY KEY (proxmox_connection_id, vmid);

-- Restore composite referential integrity.
ALTER TABLE vm_reimage_requests ADD CONSTRAINT vm_reimage_requests_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE vm_reimage_executions ADD CONSTRAINT vm_reimage_executions_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE RESTRICT;
ALTER TABLE tickets ADD CONSTRAINT tickets_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE SET NULL;
ALTER TABLE vm_metrics ADD CONSTRAINT vm_metrics_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE vm_billing_profiles ADD CONSTRAINT vm_billing_profiles_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE RESTRICT;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE SET NULL;
ALTER TABLE billing_suspension_actions ADD CONSTRAINT billing_suspension_actions_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE RESTRICT;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE RESTRICT;
ALTER TABLE vm_backup_queue ADD CONSTRAINT vm_backup_queue_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE rdns_requests ADD CONSTRAINT rdns_requests_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE app_instances ADD CONSTRAINT app_instances_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE vm_sub_users ADD CONSTRAINT vm_sub_users_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;
ALTER TABLE vm_sub_user_invitations ADD CONSTRAINT vm_sub_user_invitations_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;

-- Replace global VMID uniqueness on VM-dependent records with scoped uniqueness.
ALTER TABLE vm_billing_profiles DROP CONSTRAINT IF EXISTS vm_billing_profiles_pkey;
ALTER TABLE vm_billing_profiles ADD PRIMARY KEY (proxmox_connection_id, vmid);
ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_vmid_period_start_period_end_key;
ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_vm_period_unique UNIQUE (proxmox_connection_id, vmid, period_start, period_end);
ALTER TABLE billing_suspension_actions DROP CONSTRAINT IF EXISTS billing_suspension_actions_vmid_invoice_id_status_key;
ALTER TABLE billing_suspension_actions ADD CONSTRAINT billing_suspension_actions_vm_invoice_status_unique UNIQUE (proxmox_connection_id, vmid, invoice_id, status);
ALTER TABLE vm_metrics DROP CONSTRAINT IF EXISTS vm_metrics_vmid_timestamp_key;
DROP INDEX IF EXISTS idx_vm_metrics_vmid_ts;
ALTER TABLE vm_metrics ADD CONSTRAINT vm_metrics_vm_timestamp_unique UNIQUE (proxmox_connection_id, vmid, timestamp);
ALTER TABLE provider_operations DROP CONSTRAINT IF EXISTS provider_operations_vmid_action_idempotency_key_key;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_vm_action_idempotency_unique UNIQUE (proxmox_connection_id, vmid, action, idempotency_key);
ALTER TABLE vm_sub_users DROP CONSTRAINT IF EXISTS vm_sub_users_vmid_user_email_key;
ALTER TABLE vm_sub_users ADD CONSTRAINT vm_sub_users_vm_user_unique UNIQUE (proxmox_connection_id, vmid, user_email);
ALTER TABLE vm_sub_user_invitations DROP CONSTRAINT IF EXISTS vm_sub_user_invitations_vmid_invitee_email_key;
ALTER TABLE vm_sub_user_invitations ADD CONSTRAINT vm_sub_user_invitations_vm_invitee_unique UNIQUE (proxmox_connection_id, vmid, invitee_email);

CREATE INDEX IF NOT EXISTS idx_vms_connection_vmid ON vms (proxmox_connection_id, vmid);
CREATE INDEX IF NOT EXISTS idx_vm_metrics_identity_timestamp ON vm_metrics (proxmox_connection_id, vmid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vms_owner_connection ON vms (owner_email, proxmox_connection_id);
