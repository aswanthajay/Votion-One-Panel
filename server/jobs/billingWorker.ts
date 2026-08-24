import { dbService } from '../db/database.js';
import { proxmoxApi } from '../services/proxmox.js';
import { emailService } from '../services/email.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export class BillingLifecycleWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(intervalMs = 5 * 60 * 1000) {
    this.intervalMs = intervalMs;
  }

  start() {
    if (this.timer) return;
    console.log(`[BILLING WORKER] Lifecycle monitor registered (${Math.round(this.intervalMs / 60000)} minute interval; policy-controlled)`);
    this.timer = setInterval(() => void this.runCheck(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCheck() {
    if (this.running) return;
    this.running = true;
    try {
      const config = await dbService.getBillingConfig();
      if (config.automationEnabled !== true) return;

      const profiles = await dbService.getBillableVmBillingProfiles();
      for (const profile of profiles) {
        try {
          await dbService.createInvoiceForVm(profile.vmid);
        } catch (error: any) {
          console.error(`[BILLING WORKER] Invoice generation failed for VMID ${profile.vmid}:`, error?.message || error);
        }
      }

      await dbService.markOverdueInvoices();
      const invoices = await dbService.getBillingInvoices(undefined, undefined, 500);
      for (const invoice of invoices) {
        await this.processInvoice(invoice, config);
      }
    } catch (error: any) {
      console.error('[BILLING WORKER] Lifecycle sweep failed:', error?.message || error);
    } finally {
      this.running = false;
    }
  }

  private async processInvoice(invoice: any, config: any) {
    if (invoice.status === 'paid' || invoice.status === 'void' || invoice.status === 'waived') return;

    const now = Date.now();
    const dueAt = new Date(invoice.dueAt).getTime();
    const daysUntilDue = Math.ceil((dueAt - now) / DAY_MS);
    const daysBeforeDue = Math.max(0, Number(config.daysBeforeDue) || 0);
    let reminderKey: string | null = null;
    let severity: 'info' | 'warning' | 'critical' = 'info';

    if (daysUntilDue >= 0 && daysUntilDue <= daysBeforeDue) {
      reminderKey = `due-${daysUntilDue}`;
      severity = daysUntilDue <= 1 ? 'warning' : 'info';
    } else if (daysUntilDue < 0) {
      reminderKey = `overdue-${Math.min(30, Math.abs(daysUntilDue))}`;
      severity = 'critical';
    }

    if (reminderKey && await dbService.recordBillingEvent({
      invoiceId: invoice.id,
      vmid: invoice.vmid,
      eventKey: 'payment-reminder',
      periodKey: reminderKey,
      payload: { daysUntilDue, totalCents: invoice.totalCents, outstandingCents: invoice.outstandingCents },
    })) {
      const dueText = daysUntilDue >= 0 ? `is due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}` : `is ${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? '' : 's'} overdue`;
      const title = daysUntilDue >= 0 ? `Payment reminder · ${invoice.vmName || `VM-${invoice.vmid}`}` : `Payment overdue · ${invoice.vmName || `VM-${invoice.vmid}`}`;
      const message = `Invoice ${invoice.id} for VM-${invoice.vmid} ${dueText}. Outstanding balance: ${invoice.outstandingCents} ${invoice.currency}.`;
      await dbService.createNotification({ accountEmail: invoice.accountEmail, title, message, severity });
      if (config.reminderEmailsEnabled === true) {
        await emailService.sendEmail(
          invoice.accountEmail,
          title,
          `<div style="font-family:Arial,sans-serif;color:#1a1a1a"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p>Please review your billing details in the Votion One™ client portal.</p></div>`,
        );
      }
    }

    const eligibleAt = invoice.suspensionEligibleAt ? new Date(invoice.suspensionEligibleAt).getTime() : Number.POSITIVE_INFINITY;
    if (invoice.status === 'overdue' && now >= eligibleAt) {
      const reason = `Invoice ${invoice.id} remains unpaid after the configured grace period.`;
      const action = await dbService.createBillingSuspensionAction(invoice.id, invoice.vmid, reason);
      if (!action) return;

      if (await dbService.recordBillingEvent({
        invoiceId: invoice.id,
        vmid: invoice.vmid,
        eventKey: 'suspension-eligible',
        periodKey: invoice.id,
        payload: { executionEnabled: config.suspensionExecutionEnabled === true },
      })) {
        await dbService.createNotification({
          accountEmail: invoice.accountEmail,
          title: `Suspension review required · ${invoice.vmName || `VM-${invoice.vmid}`}`,
          message: config.suspensionExecutionEnabled === true
            ? `Invoice ${invoice.id} is eligible for reversible service suspension. The configured worker may stop the VM and mark access suspended; it will not delete the VM or its disks.`
            : `Invoice ${invoice.id} is eligible for reversible service suspension. Automatic suspension is disabled; no VM state was changed.`,
          severity: 'critical',
        });
      }

      if (config.suspensionExecutionEnabled === true && action.status === 'pending') {
        try {
          const vm = await dbService.getVMByVMID(invoice.vmid);
          if (!vm) throw new Error('VM record not found.');
          if (!vm.isSuspended) {
            await proxmoxApi.executePowerAction(vm.node, vm.vmid, 'stop', 'billing-worker@votioncloud.org');
            await dbService.suspendVM(vm.vmid, true, 'billing-worker@votioncloud.org');
          }
          await dbService.updateBillingSuspensionAction(action.id, 'executed', 'billing-worker@votioncloud.org');
          await dbService.setBillingInvoiceStatus(invoice.id, 'suspended');
          await dbService.setVmBillingStatus(vm.vmid, 'suspended');
          await dbService.logAudit('billing-worker@votioncloud.org', 'AUTO_BILLING_SUSPEND', `VMID ${vm.vmid}`, `Reversibly suspended after unpaid invoice ${invoice.id}; VM and disks retained.`);
        } catch (error: any) {
          await dbService.updateBillingSuspensionAction(action.id, 'failed', 'billing-worker@votioncloud.org', String(error?.message || error).slice(0, 500));
          console.error(`[BILLING WORKER] Suspension execution failed for VMID ${invoice.vmid}:`, error?.message || error);
        }
      }
    }
  }
}

export const billingWorker = new BillingLifecycleWorker();
