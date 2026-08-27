-- Client-managed delegated service access. This migration is additive and preserves all existing access records.
ALTER TABLE vm_sub_users
  ADD COLUMN IF NOT EXISTS invited_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

UPDATE vm_sub_users
SET scope = 'readonly'
WHERE scope = 'read';

UPDATE vm_sub_users
SET accepted_at = NOW()
WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vm_sub_users_member_email
  ON vm_sub_users (user_email, vmid);

CREATE TABLE IF NOT EXISTS vm_sub_user_invitations (
  id VARCHAR(64) PRIMARY KEY,
  vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
  invitee_email VARCHAR(255) NOT NULL,
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('readonly', 'power', 'full')),
  invited_by VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT vm_sub_user_invitations_not_self CHECK (invitee_email <> invited_by)
);

CREATE UNIQUE INDEX IF NOT EXISTS vm_sub_user_invitations_pending_unique
  ON vm_sub_user_invitations (vmid, invitee_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vm_sub_user_invitations_owner_state
  ON vm_sub_user_invitations (invited_by, accepted_at, revoked_at, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_vm_sub_user_invitations_invitee_state
  ON vm_sub_user_invitations (invitee_email, accepted_at, revoked_at, expires_at DESC);

INSERT INTO mail_templates (template_key, subject, body, enabled)
VALUES (
  'team_invitation',
  '{ownerName} invited you to Votion One™',
  '<p style="margin: 0 0 16px;">{ownerName} has invited you to collaborate on {serviceName} in Votion One™.</p><p style="margin: 0;">Create your own account with this email address to activate access. Your permissions are limited to the service shown below and can be changed or revoked by the service owner at any time.</p>',
  true
)
ON CONFLICT (template_key) DO NOTHING;
