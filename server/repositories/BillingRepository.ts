import { pgPool } from '../db/database.js';

export interface BillingConfig {
  automationEnabled: boolean;
  reminderEmailsEnabled: boolean;
  suspensionExecutionEnabled: boolean;
  daysBeforeDue: number;
  gracePeriodDays: number;
  suspendAfterDaysOverdue: number;
  taxRatePercent: number;
  currency: string;
}

export interface BillingInvoice {
  id: string;
  accountEmail: string;
  vmid: number;
  vmName?: string;
  planId?: string;
  planName?: string;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date;
  dueAt: Date;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
  currency: string;
  status: 'open' | 'partially_paid' | 'overdue' | 'suspended' | 'paid' | 'void';
  paidAt?: Date | null;
  lastReminderAt?: Date | null;
  suspensionEligibleAt?: Date | null;
  notes?: string | null;
  createdAt: Date;
}

export class BillingRepository {

  static async getVmBillingProfiles(vmid?: number) {
    const where = vmid ? 'WHERE p.vmid = $1' : 'WHERE p.vmid IS NOT NULL';
    const params = vmid ? [vmid] : [];
    
    const res = await pgPool.query(
      `SELECT p.*, v.vm_name, v.owner_email, v.expiry_date, v.node, v.type,
             pl.name AS plan_name, pl.monthly_price_cents
       FROM vm_billing_profiles p
       JOIN vms v ON v.vmid = p.vmid
       LEFT JOIN pricing_plans pl ON pl.id = p.plan_id
       ${where}`,
      params
    );
    
    return res.rows.map(row => ({
      vmid: Number(row.vmid),
      vmName: row.vm_name,
      ownerEmail: row.owner_email,
      planId: row.plan_id,
      planName: row.plan_name,
      monthlyPriceCents: row.monthly_price_cents,
      billingStatus: row.billing_status,
      nextDueAt: row.next_due_at || row.expiry_date,
    }));
  }

  static async getBillableVmBillingProfiles() {
    const res = await pgPool.query(
      `SELECT p.*, v.vm_name, v.owner_email, v.expiry_date, v.node, v.type,
             pl.name AS plan_name, pl.monthly_price_cents
       FROM vm_billing_profiles p
       JOIN vms v ON v.vmid = p.vmid
       LEFT JOIN pricing_plans pl ON pl.id = p.plan_id
       WHERE v.owner_email NOT LIKE 'unassigned@%' 
         AND p.billing_status NOT IN ('closed', 'waived')
       ORDER BY p.vmid ASC`
    );
    
    return res.rows.map(row => ({
      vmid: Number(row.vmid),
      vmName: row.vm_name,
      ownerEmail: row.owner_email,
      planId: row.plan_id,
      planName: row.plan_name,
      monthlyPriceCents: row.monthly_price_cents,
      billingStatus: row.billing_status,
      nextDueAt: row.next_due_at || row.expiry_date,
    }));
  }
  static async getBillingInvoices(accountEmail?: string, status?: string, limit = 100): Promise<BillingInvoice[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    
    if (accountEmail) { 
      params.push(accountEmail.toLowerCase().trim()); 
      conditions.push(`i.account_email = $${params.length}`); 
    }
    
    if (status) { 
      params.push(status); 
      conditions.push(`i.status = $${params.length}`); 
    }
    
    params.push(Math.min(500, Math.max(1, limit)));
    
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const res = await pgPool.query(
      `SELECT i.*, v.vm_name, p.name AS plan_name 
       FROM billing_invoices i 
       JOIN vms v ON v.vmid = i.vmid 
       LEFT JOIN pricing_plans p ON p.id = i.plan_id 
       ${where} 
       ORDER BY i.due_at ASC, i.created_at DESC 
       LIMIT $${params.length}`,
      params
    );
    
    return res.rows.map(row => ({
      id: row.id,
      accountEmail: row.account_email,
      vmid: Number(row.vmid),
      vmName: row.vm_name,
      planId: row.plan_id,
      planName: row.plan_name,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      issuedAt: row.issued_at,
      dueAt: row.due_at,
      subtotalCents: Number(row.subtotal_cents),
      taxCents: Number(row.tax_cents),
      totalCents: Number(row.total_cents),
      paidCents: Number(row.paid_cents),
      outstandingCents: Math.max(0, Number(row.total_cents) - Number(row.paid_cents)),
      currency: row.currency,
      status: row.status,
      paidAt: row.paid_at,
      lastReminderAt: row.last_reminder_at,
      suspensionEligibleAt: row.suspension_eligible_at,
      notes: row.notes,
      createdAt: row.created_at,
    }));
  }

  static async getBillingInvoiceById(invoiceId: string): Promise<BillingInvoice | null> {
    const invoices = await this.getBillingInvoices(undefined, undefined, 500);
    return invoices.find(invoice => invoice.id === invoiceId) || null;
  }
}
