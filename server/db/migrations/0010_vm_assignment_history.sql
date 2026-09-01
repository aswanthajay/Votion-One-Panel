-- VM Assignment History: tracks every assign/unassign/reassign event per VM
CREATE TABLE IF NOT EXISTS vm_assignment_history (
  id SERIAL PRIMARY KEY,
  vmid INT NOT NULL,
  proxmox_connection_id VARCHAR(50) NOT NULL DEFAULT 'legacy-local',
  action VARCHAR(20) NOT NULL CHECK (action IN ('assign', 'unassign', 'reassign')),
  from_email TEXT,
  to_email TEXT,
  reason TEXT,
  expiry_date TIMESTAMPTZ,
  grace_period_days INT,
  performed_by TEXT NOT NULL,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vm_assignment_history_vm
  ON vm_assignment_history (proxmox_connection_id, vmid, performed_at DESC);
