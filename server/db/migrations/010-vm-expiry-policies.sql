-- Allow platform administrators to assign a VM without an expiry date.
ALTER TABLE vms ALTER COLUMN expiry_date DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vms_expiry_active
  ON vms (expiry_date)
  WHERE expiry_date IS NOT NULL AND is_suspended = false;
