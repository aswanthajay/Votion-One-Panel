ALTER TABLE vm_reimage_requests
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS completed_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS completion_note TEXT;

CREATE INDEX IF NOT EXISTS idx_vm_reimage_requests_status_completed
  ON vm_reimage_requests (status, completed_at DESC);
