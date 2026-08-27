-- Refresh only the legacy seeded mail copy. Administrator-authored templates remain unchanged.
UPDATE mail_templates
SET
  subject = 'Welcome to Votion One™',
  body = '<p style="margin: 0 0 16px;">Hello {name},</p><p style="margin: 0;">Your account is now active. Sign in to your Votion One™ workspace to review services, monitor your environment, and work with your support team from one secure control surface.</p>',
  updated_at = NOW()
WHERE template_key = 'welcome'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

UPDATE mail_templates
SET
  subject = 'Support update · {ticketNumber}',
  body = '<p style="margin: 0 0 16px;">Your support request has been updated by the Votion One™ service team.</p><p style="margin: 0;">Open your secure workspace to review the latest correspondence and any required next steps.</p>',
  updated_at = NOW()
WHERE template_key = 'ticket_update'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

UPDATE mail_templates
SET
  subject = 'Service renewal notice · VMID {vmid}',
  body = '<p style="margin: 0 0 16px;">Your service reference VM-{vmid} is approaching its renewal date.</p><p style="margin: 0;">Review your billing workspace to maintain uninterrupted access and confirm the next service period.</p>',
  updated_at = NOW()
WHERE template_key = 'expiry_warning'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

UPDATE mail_templates
SET
  subject = 'Votion One™ operational alert · {title}',
  body = '<p style="margin: 0 0 16px;">{message}</p><p style="margin: 0;">Review the Operations workspace for current metrics, event context, and any required response.</p>',
  updated_at = NOW()
WHERE template_key = 'alert_fired'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

UPDATE mail_templates
SET
  subject = 'Reset your Votion One™ password',
  body = '<p style="margin: 0 0 16px;">A request was received to reset the password for the Votion One™ account associated with {email}.</p><p style="margin: 0;">Use the secure link provided in the email to choose a new password and restore access to your workspace.</p>',
  updated_at = NOW()
WHERE template_key = 'password_reset'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

UPDATE mail_templates
SET
  subject = 'Your Votion One™ account was updated',
  body = '<p style="margin: 0 0 16px;">Your account details were updated: {changes}.</p><p style="margin: 0;">If this was not expected, contact your authorized support team immediately through the secure workspace.</p>',
  updated_at = NOW()
WHERE template_key = 'account_updated'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

UPDATE mail_templates
SET
  subject = 'Infrastructure connection verified',
  body = '<p style="margin: 0 0 16px;">The connection to the configured infrastructure endpoint ({host}:{port}) was verified successfully.</p><p style="margin: 0;">The Votion One™ control plane can communicate with the configured compute environment.</p>',
  updated_at = NOW()
WHERE template_key = 'connection_test'
  AND (subject ILIKE '%stellar%' OR body ILIKE '%stellar%');

INSERT INTO mail_templates (template_key, subject, body, enabled)
VALUES
  ('registration_verification', 'Verify your Votion One™ email address', '<p style="margin: 0 0 16px;">Hello {name},</p><p style="margin: 0;">A new Votion One™ workspace is being created with this email address. Enter the one-time verification code in the email to confirm that you control this inbox and complete registration.</p>', true),
  ('billing_reminder', '{title}', '<p style="margin: 0 0 16px;">{message}</p><p style="margin: 0;">Please review the invoice in your Votion One™ workspace. Timely payment helps maintain uninterrupted access to your service.</p>', true)
ON CONFLICT (template_key) DO NOTHING;
