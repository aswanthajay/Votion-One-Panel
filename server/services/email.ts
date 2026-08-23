import nodemailer from 'nodemailer';
import { dbService } from '../db/database.js';

class EmailService {
  private transporter: nodemailer.Transporter | null = null;
  private isEnabled: boolean = false;
  private fromEmail: string = 'noreply@votioncloud.org';

  constructor() {
    this.refreshTransporter();
  }

  async refreshTransporter() {
    try {
      const config = await dbService.getSystemSetting('smtp_config');
      if (config && config.enabled) {
        this.isEnabled = true;
        this.fromEmail = config.from || 'noreply@votioncloud.org';
        this.transporter = nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure, // true for 465, false for other ports
          auth: {
            user: config.user,
            pass: config.pass,
          },
        });
        console.log('[SMTP] Mailer initialized and enabled.');
      } else {
        this.isEnabled = false;
        this.transporter = null;
        console.log('[SMTP] Mailer is currently disabled in system settings.');
      }
    } catch (err) {
      console.error('[SMTP] Failed to initialize mailer:', err);
      this.isEnabled = false;
    }
  }

  async sendEmail(to: string, subject: string, html: string) {
    if (!this.isEnabled || !this.transporter) {
      console.log(`[SMTP_MOCK] Skipped sending email to ${to} (Subject: ${subject}) because SMTP is disabled.`);
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"Stellar Panel" <${this.fromEmail}>`,
        to,
        subject,
        html,
      });
      console.log(`[SMTP] Email sent successfully to ${to}: ${info.messageId}`);
      return true;
    } catch (err) {
      console.error(`[SMTP] Error sending email to ${to}:`, err);
      return false;
    }
  }

  // Common transactional templates
  async sendWelcomeEmail(to: string, name: string) {
    const html = `
      <div style="font-family: sans-serif; color: #1a1a1a;">
        <h2>Welcome to Stellar Panel, ${name}!</h2>
        <p>Your account has been successfully created. You can now log in to the dashboard to manage your Proxmox VE infrastructure.</p>
        <p>Best regards,<br/>Stellar Panel Team</p>
      </div>
    `;
    return this.sendEmail(to, 'Welcome to Stellar Panel', html);
  }

  async sendTicketUpdate(to: string, ticketNumber: string, status: string) {
    const html = `
      <div style="font-family: sans-serif; color: #1a1a1a;">
        <h2>Support Ticket Update: ${ticketNumber}</h2>
        <p>Your support ticket status has been updated to: <strong>${status}</strong></p>
        <p>Please log in to the dashboard to view the full details.</p>
        <p>Best regards,<br/>Stellar Panel Support</p>
      </div>
    `;
    return this.sendEmail(to, `Support Ticket Update: ${ticketNumber}`, html);
  }
}

export const emailService = new EmailService();
