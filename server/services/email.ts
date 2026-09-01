import nodemailer from 'nodemailer';
import { dbService } from '../db/database.js';

type TemplateVariables = Record<string, string | number | null | undefined>;

type BrandEmailOptions = {
  to: string;
  templateKey: string;
  fallbackSubject: string;
  fallbackBody: string;
  variables: TemplateVariables;
  eyebrow: string;
  title: string;
  preheader: string;
  action?: { label: string; url: string };
  code?: string;
  metadata?: Array<{ label: string; value: string }>;
  securityNote?: string;
};

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const interpolateTemplate = (template: string, variables: TemplateVariables): string => template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => escapeHtml(variables[key]));

const toPlainText = (html: string): string => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/<\/p>/gi, '\n\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const getPortalUrl = (): string => {
  const configuredUrl = String(process.env.PUBLIC_APP_URL || '').trim();
  if (!configuredUrl) return 'http://localhost:5000';

  try {
    const url = new URL(configuredUrl);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString().replace(/\/$/, '');
  } catch {
    // Use the local fallback when the deployment URL is not a valid absolute URL.
  }

  return 'http://localhost:5000';
};

const formatCurrency = (amountCents: number, currency: string): string => {
  const normalizedCurrency = String(currency || 'INR').toUpperCase();
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format((Number(amountCents) || 0) / 100);
  } catch {
    return `${((Number(amountCents) || 0) / 100).toFixed(2)} ${normalizedCurrency}`;
  }
};

class EmailService {
  private transporter: nodemailer.Transporter | null = null;
  private isEnabled = false;
  private fromEmail = 'noreply@votioncloud.org';

  constructor() {
    void this.refreshTransporter();
  }

  isReady(): boolean {
    return this.isEnabled && this.transporter !== null;
  }

  async refreshTransporter() {
    try {
      const config = await dbService.getSystemSetting('smtp_config');
      if (config && config.enabled) {
        this.isEnabled = true;
        this.fromEmail = config.from || 'noreply@votioncloud.org';
        const portNum = Number(config.port) || 587;
        // In SMTP specifications: port 465 is implicit SSL (secure: true).
        // Port 587 uses STARTTLS (secure: false). Setting secure: true on 587 causes an OpenSSL protocol mismatch error.
        const resolvedSecure = portNum === 465 ? true : false;

        this.transporter = nodemailer.createTransport({
          host: config.host,
          port: portNum,
          secure: resolvedSecure,
          requireTLS: portNum === 587,
          auth: {
            user: config.user,
            pass: config.pass,
          },
          tls: {
            rejectUnauthorized: false,
          },
          connectionTimeout: 8000,
          greetingTimeout: 8000,
          socketTimeout: 10000,
        });
        console.log(`[SMTP] Mailer initialized on ${config.host}:${portNum} (secure: ${resolvedSecure}, requireTLS: ${portNum === 587}).`);
      } else {
        this.isEnabled = false;
        this.transporter = null;
        console.log('[SMTP] Mailer is currently disabled in system settings.');
      }
    } catch (err) {
      console.error('[SMTP] Failed to initialize mailer:', err);
      this.isEnabled = false;
      this.transporter = null;
    }
  }

  async sendEmail(to: string, subject: string, html: string, text = toPlainText(html)) {
    if (!this.isEnabled || !this.transporter) {
      console.log(`[SMTP_MOCK] Skipped sending email to ${to} (Subject: ${subject}) because SMTP is disabled.`);
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"Votion One™" <${this.fromEmail}>`,
        replyTo: this.fromEmail,
        to,
        subject,
        html,
        text,
        headers: {
          'X-Mailer': 'Votion One Cloud Platform',
          'X-Entity-Ref-ID': `votion-${Date.now()}`,
          'X-Auto-Response-Suppress': 'OOF, AutoReply',
        },
      });
      console.log(`[SMTP] Email sent successfully to ${to}: ${info.messageId}`);
      return true;
    } catch (err) {
      console.error(`[SMTP] Error sending email to ${to}:`, err);
      return false;
    }
  }

  private async resolveTemplate(templateKey: string, fallbackSubject: string, fallbackBody: string, variables: TemplateVariables) {
    try {
      const template = await dbService.getMailTemplate(templateKey);
      if (!template || template.enabled === false) {
        return template?.enabled === false ? null : {
          subject: interpolateTemplate(fallbackSubject, variables),
          body: interpolateTemplate(fallbackBody, variables),
        };
      }

      const subject = String(template.subject || '');
      const body = String(template.body || '');
      const usesLegacyBrand = /stellar\s+(?:panel|platform)/i.test(`${subject} ${body}`);
      if (!subject || !body || usesLegacyBrand) {
        return {
          subject: interpolateTemplate(fallbackSubject, variables),
          body: interpolateTemplate(fallbackBody, variables),
        };
      }

      return {
        subject: interpolateTemplate(subject, variables),
        body: interpolateTemplate(body, variables),
      };
    } catch (error) {
      console.error(`[SMTP] Template lookup failed for ${templateKey}; using the branded default:`, error);
      return {
        subject: interpolateTemplate(fallbackSubject, variables),
        body: interpolateTemplate(fallbackBody, variables),
      };
    }
  }

  private renderBrandEmail({ eyebrow, title, preheader, body, action, code, metadata, securityNote }: Omit<BrandEmailOptions, 'to' | 'templateKey' | 'fallbackSubject' | 'fallbackBody' | 'variables'> & { body: string }) {
    const portalUrl = getPortalUrl();
    const safeAction = action && /^https?:\/\//i.test(action.url) ? action : undefined;
    const metadataRows = metadata?.filter((item) => item.value).map((item) => `
      <tr>
        <td style="padding: 0 0 10px; color: #8f9696; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 18px; letter-spacing: 0.04em; text-transform: uppercase;">${escapeHtml(item.label)}</td>
        <td align="right" style="padding: 0 0 10px 16px; color: #f5f5f2; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 18px; font-weight: 700;">${escapeHtml(item.value)}</td>
      </tr>`).join('') || '';

    return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${escapeHtml(title)} · Votion One™</title>
</head>
<body style="margin: 0; padding: 0; background-color: #050505; color: #f5f5f2;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; mso-hide: all;">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#050505" style="width: 100%; min-width: 100%; background-color: #050505;">
    <tr>
      <td align="center" style="padding: 32px 16px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 640px;">
          <tr>
            <td style="padding: 0 12px 18px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="color: #f5f5f2; font-family: Georgia, 'Times New Roman', serif; font-size: 25px; line-height: 30px; font-weight: 700; letter-spacing: -0.03em;">Votion One<span style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; vertical-align: top; letter-spacing: 0;">™</span></td>
                  <td align="right" style="color: #9ea6a6; font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 16px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;">Cloud operations</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td bgcolor="#0c0c0c" style="background-color: #0c0c0c; border: 1px solid #252525; border-radius: 16px; overflow: hidden;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="height: 3px; background-color: #e7ebe7; font-size: 0; line-height: 0;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding: 42px 40px 18px;">
                    <p style="margin: 0 0 15px; color: #9ea6a6; font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 16px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;">${escapeHtml(eyebrow)}</p>
                    <h1 style="margin: 0; color: #f5f5f2; font-family: Georgia, 'Times New Roman', serif; font-size: 34px; line-height: 40px; font-weight: 700; letter-spacing: -0.035em;">${escapeHtml(title)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 10px 40px 8px; color: #d2d6d3; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 24px;">
                    ${body}
                  </td>
                </tr>
                ${code ? `<tr><td style="padding: 22px 40px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#151515" style="background-color: #151515; border: 1px solid #303030; border-radius: 10px;"><tr><td align="center" style="padding: 20px 16px; color: #ffffff; font-family: 'Courier New', Courier, monospace; font-size: 29px; line-height: 34px; font-weight: 700; letter-spacing: 0.24em;">${escapeHtml(code)}</td></tr></table><p style="margin: 10px 0 0; color: #929999; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 18px; text-align: center;">Use this one-time verification code within 15 minutes.</p></td></tr>` : ''}
                ${metadataRows ? `<tr><td style="padding: 24px 40px 6px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top: 1px solid #2d2d2d;"><tr><td style="padding-top: 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${metadataRows}</table></td></tr></table></td></tr>` : ''}
                ${safeAction ? `<tr><td style="padding: 26px 40px 12px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#f5f5f2" style="background-color: #f5f5f2; border-radius: 8px;"><a href="${escapeHtml(safeAction.url)}" target="_blank" style="display: inline-block; padding: 13px 19px; color: #090909; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 18px; font-weight: 700; letter-spacing: 0.01em; text-decoration: none;">${escapeHtml(safeAction.label)} <span style="font-size: 16px; line-height: 12px;">→</span></a></td></tr></table></td></tr>` : ''}
                ${securityNote ? `<tr><td style="padding: 20px 40px 38px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#111111" style="background-color: #111111; border-left: 2px solid #b7c0ba;"><tr><td style="padding: 14px 16px; color: #aeb4b0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 19px;"><strong style="color: #e4e7e4;">Security notice.</strong> ${escapeHtml(securityNote)}</td></tr></table></td></tr>` : '<tr><td style="height: 28px; font-size: 0; line-height: 0;">&nbsp;</td></tr>'}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 22px 14px 0; color: #737a78; font-family: Arial, Helvetica, sans-serif; font-size: 11px; line-height: 18px; text-align: center;">
              This is an automated service message from Votion One™.<br>
              <a href="${escapeHtml(portalUrl)}" target="_blank" style="color: #b8bfba; text-decoration: underline;">Open your secure workspace</a> &nbsp;·&nbsp; Please do not reply directly to this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private async sendBrandedTemplate(options: BrandEmailOptions) {
    const template = await this.resolveTemplate(options.templateKey, options.fallbackSubject, options.fallbackBody, options.variables);
    if (!template) {
      console.log(`[SMTP] ${options.templateKey} email suppressed because the template is disabled.`);
      return false;
    }

    const html = this.renderBrandEmail({ ...options, body: template.body });
    const text = `${options.title}\n\n${toPlainText(template.body)}${options.code ? `\n\nVerification code: ${options.code}` : ''}${options.action ? `\n\n${options.action.label}: ${options.action.url}` : ''}\n\nVotion One™`;
    return this.sendEmail(options.to, template.subject, html, text);
  }

  async sendRegistrationVerificationCode(to: string, name: string, otp: string) {
    const displayName = String(name || 'there').trim() || 'there';
    return this.sendBrandedTemplate({
      to,
      templateKey: 'registration_verification',
      fallbackSubject: 'Verify your Votion One™ email address',
      fallbackBody: '<p style="margin: 0 0 16px;">Hello {name},</p><p style="margin: 0;">A new Votion One™ workspace is being created with this email address. Enter the verification code below to confirm that you control this inbox and complete registration.</p>',
      variables: { name: displayName, email: to, otp },
      eyebrow: 'Account verification',
      title: 'Confirm your email address',
      preheader: 'Use the one-time code to complete your Votion One™ registration.',
      code: otp,
      securityNote: 'This code expires after 15 minutes and can be used once. Votion One™ personnel will never ask you to share it.',
    });
  }

  async sendTestEmail(to: string) {
    const portalUrl = getPortalUrl();
    return this.sendBrandedTemplate({
      to,
      templateKey: 'connection_test',
      fallbackSubject: 'Votion One™ SMTP Configuration Verification',
      fallbackBody: '<p style="margin: 0 0 16px;">This message confirms that outbound mail delivery is properly configured and functional for your Votion One™ cloud workspace.</p><p style="margin: 0;">If you received this message, your SMTP transport and DNS authentication records are active.</p>',
      variables: { email: to, portalUrl },
      eyebrow: 'System Diagnostics',
      title: 'SMTP Mail Delivery Verified',
      preheader: 'Your Votion One™ mail delivery subsystem is active and operating normally.',
      action: { label: 'Open Workspace Console', url: portalUrl },
      securityNote: 'This is an administrative test notification. No user account modifications have occurred.',
    });
  }

  async sendWelcomeEmail(to: string, name: string) {
    const displayName = String(name || 'there').trim() || 'there';
    const portalUrl = getPortalUrl();
    return this.sendBrandedTemplate({
      to,
      templateKey: 'welcome',
      fallbackSubject: 'Welcome to Votion One™',
      fallbackBody: '<p style="margin: 0 0 16px;">Hello {name},</p><p style="margin: 0;">Your account is now active. Sign in to your Votion One™ workspace to review services, monitor your environment, and work with your support team from one secure control surface.</p>',
      variables: { name: displayName, email: to },
      eyebrow: 'Workspace ready',
      title: 'Welcome to Votion One™',
      preheader: 'Your secure cloud operations workspace is ready.',
      action: { label: 'Open your workspace', url: portalUrl },
      securityNote: 'Keep your credentials private and enable only the access methods appropriate for your organization.',
    });
  }

  async sendTicketUpdate(to: string, ticketNumber: string, status: string, message?: string) {
    const portalUrl = getPortalUrl();
    return this.sendBrandedTemplate({
      to,
      templateKey: 'ticket_update',
      fallbackSubject: 'Support update · {ticketNumber}',
      fallbackBody: '<p style="margin: 0 0 16px;">Your support request has been updated by the Votion One™ service team.</p><p style="margin: 0;">Open your secure workspace to review the latest correspondence and any required next steps.</p>',
      variables: { ticketNumber, status, message: message || '' },
      eyebrow: 'Support desk',
      title: 'Your support request has moved forward',
      preheader: `An update is available for support request ${ticketNumber}.`,
      action: { label: 'Review support request', url: `${portalUrl}/support` },
      metadata: [
        { label: 'Request', value: ticketNumber },
        { label: 'Current status', value: status },
      ],
      securityNote: 'For your protection, reply only through the authenticated support workspace and do not send credentials by email.',
    });
  }

  async sendPasswordReset(to: string, resetUrl: string) {
    return this.sendBrandedTemplate({
      to,
      templateKey: 'password_reset',
      fallbackSubject: 'Reset your Votion One™ password',
      fallbackBody: '<p style="margin: 0 0 16px;">A request was received to reset the password for the Votion One™ account associated with {email}.</p><p style="margin: 0;">Use the secure link below to choose a new password and restore access to your workspace.</p>',
      variables: { email: to, resetUrl },
      eyebrow: 'Account security',
      title: 'Reset your password',
      preheader: 'A secure password reset link was requested for your account.',
      action: { label: 'Reset password securely', url: resetUrl },
      securityNote: 'This one-time link expires after 15 minutes. If you did not request it, no further action is needed; your current password remains unchanged.',
    });
  }

  async sendTeamInvitation(to: string, details: { ownerName: string; serviceName: string; vmid: number; scope: 'readonly' | 'power' | 'full'; inviteUrl: string }) {
    const scopeLabel = {
      readonly: 'Viewer',
      power: 'Operator',
      full: 'Manager',
    }[details.scope];
    return this.sendBrandedTemplate({
      to,
      templateKey: 'team_invitation',
      fallbackSubject: '{ownerName} invited you to Votion One™',
      fallbackBody: '<p style="margin: 0 0 16px;">{ownerName} has invited you to collaborate on {serviceName} in Votion One™.</p><p style="margin: 0;">Create your own account with this email address to activate access. Your permissions are limited to the service shown below and can be changed or revoked by the service owner at any time.</p>',
      variables: {
        ownerName: details.ownerName,
        serviceName: details.serviceName,
        vmid: details.vmid,
        scope: scopeLabel,
      },
      eyebrow: 'Team access invitation',
      title: 'You have been invited to collaborate',
      preheader: `${details.ownerName} invited you to a Votion One™ service workspace.`,
      action: { label: 'Create your account', url: details.inviteUrl },
      metadata: [
        { label: 'Service', value: details.serviceName },
        { label: 'Reference', value: `VM-${details.vmid}` },
        { label: 'Access level', value: scopeLabel },
      ],
      securityNote: 'This invitation is valid for seven days and is tied to this email address. Never forward the invitation link. If you were not expecting this invitation, you may safely ignore it.',
    });
  }


  async sendVmAssignmentEmail(to: string, details: { name: string; vmid: number; vmName: string; node: string; expiryDate?: string | null }) {
    const portalUrl = getPortalUrl();
    const expiryText = details.expiryDate
      ? new Date(details.expiryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'No expiry set';
    return this.sendBrandedTemplate({
      to,
      templateKey: 'vm_assignment',
      fallbackSubject: 'Your VPS has been assigned — VM-{vmid}',
      fallbackBody: '<p style="margin: 0 0 16px;">Hello {name},</p><p style="margin: 0;">A virtual server has been assigned to your Votion One account. You can access and manage it from your dashboard.</p>',
      variables: { name: details.name || 'there', vmid: details.vmid, vmName: details.vmName, node: details.node, expiryText },
      eyebrow: 'Service activation',
      title: `Your VPS is ready — ${details.vmName || `VM-${details.vmid}`}`,
      preheader: `VM-${details.vmid} (${details.vmName}) has been assigned to your account.`,
      action: { label: 'Open your workspace', url: portalUrl },
      metadata: [
        { label: 'VM Reference', value: `VM-${details.vmid}` },
        { label: 'VM Name', value: details.vmName || '—' },
        { label: 'Node', value: details.node || '—' },
        { label: 'Expiry', value: expiryText },
      ],
      securityNote: 'If you were not expecting this assignment, please contact support immediately.',
    });
  }

  async sendExpiryWarningEmail(to: string, details: { name: string; vmid: number; vmName: string; daysLeft: number; expiryDate: string }) {
    const portalUrl = getPortalUrl();
    const expiryText = new Date(details.expiryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const urgency = details.daysLeft <= 1 ? 'expires today' : `expires in ${details.daysLeft} day${details.daysLeft === 1 ? '' : 's'}`;
    return this.sendBrandedTemplate({
      to,
      templateKey: 'vm_expiry_warning',
      fallbackSubject: 'Service expiry notice — VM-{vmid} {urgency}',
      fallbackBody: '<p style="margin: 0 0 16px;">Hello {name},</p><p style="margin: 0;">Your virtual server VM-{vmid} ({vmName}) {urgency} on {expiryText}. Please contact support if you would like to renew your service.</p>',
      variables: { name: details.name || 'there', vmid: details.vmid, vmName: details.vmName, urgency, expiryText },
      eyebrow: 'Service expiry notice',
      title: `Your VPS ${urgency}`,
      preheader: `VM-${details.vmid} (${details.vmName}) ${urgency} on ${expiryText}.`,
      action: { label: 'Contact support', url: `${portalUrl}/support` },
      metadata: [
        { label: 'VM Reference', value: `VM-${details.vmid}` },
        { label: 'VM Name', value: details.vmName || '—' },
        { label: 'Expiry date', value: expiryText },
      ],
      securityNote: 'To keep your service active beyond the expiry date, please reach out to your service provider.',
    });
  }

  async sendBillingReminder(to: string, details: { title: string; message: string; invoiceId: string; vmid: number; dueText: string; outstandingCents: number; currency: string }) {
    const portalUrl = getPortalUrl();
    return this.sendBrandedTemplate({
      to,
      templateKey: 'billing_reminder',
      fallbackSubject: '{title}',
      fallbackBody: '<p style="margin: 0 0 16px;">{message}</p><p style="margin: 0;">Please review the invoice in your Votion One™ workspace. Timely payment helps maintain uninterrupted access to your service.</p>',
      variables: {
        title: details.title,
        message: details.message,
        invoiceId: details.invoiceId,
        vmid: details.vmid,
        dueText: details.dueText,
        outstandingBalance: formatCurrency(details.outstandingCents, details.currency),
      },
      eyebrow: 'Billing notice',
      title: details.title,
      preheader: `Invoice ${details.invoiceId} ${details.dueText}.`,
      action: { label: 'Review invoice', url: `${portalUrl}/billing` },
      metadata: [
        { label: 'Invoice', value: details.invoiceId },
        { label: 'Service reference', value: `VM-${details.vmid}` },
        { label: 'Outstanding balance', value: formatCurrency(details.outstandingCents, details.currency) },
      ],
      securityNote: 'Votion One™ will never ask you to send payment card details or credentials by email. Use the authenticated billing workspace for account activity.',
    });
  }
}

export const emailService = new EmailService();
