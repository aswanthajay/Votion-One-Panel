-- Provider operation ledger for idempotent, auditable asynchronous VM actions.
CREATE TABLE IF NOT EXISTS provider_operations (
  id VARCHAR(100) PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE RESTRICT,
  action VARCHAR(50) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  idempotency_key VARCHAR(150) NOT NULL,
  provider_task_id VARCHAR(255),
  requested_by VARCHAR(255) NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB,
  error_code VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (vmid, action, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_provider_operations_vmid_created ON provider_operations (vmid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_operations_state_updated ON provider_operations (state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_operations_provider_task ON provider_operations (provider_task_id) WHERE provider_task_id IS NOT NULL;
