-- Add scoped connections to missing tables from 011

ALTER TABLE firewall_rules ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);
ALTER TABLE vm_snapshots ADD COLUMN IF NOT EXISTS proxmox_connection_id VARCHAR(50);

-- Backfill from vms
UPDATE firewall_rules f
SET proxmox_connection_id = v.proxmox_connection_id
FROM vms v
WHERE f.vmid = v.vmid AND f.proxmox_connection_id IS NULL;

UPDATE vm_snapshots s
SET proxmox_connection_id = v.proxmox_connection_id
FROM vms v
WHERE s.vmid = v.vmid AND s.proxmox_connection_id IS NULL;

-- Default
ALTER TABLE firewall_rules ALTER COLUMN proxmox_connection_id SET DEFAULT 'legacy-local';
ALTER TABLE vm_snapshots ALTER COLUMN proxmox_connection_id SET DEFAULT 'legacy-local';
ALTER TABLE firewall_rules ALTER COLUMN proxmox_connection_id SET NOT NULL;
ALTER TABLE vm_snapshots ALTER COLUMN proxmox_connection_id SET NOT NULL;

-- Foreign Keys (vm_snapshots had one in 002)
ALTER TABLE vm_snapshots DROP CONSTRAINT IF EXISTS vm_snapshots_vmid_fkey;
ALTER TABLE vm_snapshots ADD CONSTRAINT vm_snapshots_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;

ALTER TABLE firewall_rules DROP CONSTRAINT IF EXISTS firewall_rules_vmid_fkey;
ALTER TABLE firewall_rules ADD CONSTRAINT firewall_rules_vm_identity_fk FOREIGN KEY (proxmox_connection_id, vmid) REFERENCES vms(proxmox_connection_id, vmid) ON DELETE CASCADE;

-- Also add an index on firewall rules
CREATE INDEX IF NOT EXISTS idx_firewall_rules_identity ON firewall_rules(proxmox_connection_id, vmid);
CREATE INDEX IF NOT EXISTS idx_vm_snapshots_identity ON vm_snapshots(proxmox_connection_id, vmid);
