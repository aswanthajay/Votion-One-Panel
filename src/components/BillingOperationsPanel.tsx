import React, { useEffect, useMemo, useState } from 'react';
import {
  apiClient,
  ApiBillingConfig,
  ApiBillingCostBase,
  ApiBillingInvoice,
  ApiBillingSummary,
  ApiBillingSuspensionAction,
  ApiPricingPlan,
  ApiVmBillingProfile,
  BillingCurrency,
} from '../services/apiClient';

const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency,
  maximumFractionDigits: 2,
}).format((Number(cents) || 0) / 100);

const dateLabel = (value?: string) => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

interface PlanFormState {
  id: string;
  name: string;
  currency: BillingCurrency;
  monthlyPriceCents: string;
  vcpuLimit: string;
  ramGb: string;
  diskGb: string;
  bandwidthGb: string;
  isActive: boolean;
  sortOrder: string;
}

const emptyPlan: PlanFormState = {
  id: '',
  name: '',
  currency: 'USD',
  monthlyPriceCents: '0',
  vcpuLimit: '1',
  ramGb: '1',
  diskGb: '10',
  bandwidthGb: '',
  isActive: true,
  sortOrder: '0',
};

const emptyCost = { id: '', name: '', monthlyCostCents: '0', allocationMethod: 'fixed', isActive: true };
const billingCurrencyOptions: Array<{ value: BillingCurrency; label: string }> = [
  { value: 'USD', label: 'USD — US Dollar ($)' },
  { value: 'INR', label: 'INR — Indian Rupee (₹)' },
  { value: 'EUR', label: 'EUR — Euro (€)' },
];

export const BillingOperationsPanel: React.FC = () => {
  const [summary, setSummary] = useState<ApiBillingSummary | null>(null);
  const [plans, setPlans] = useState<ApiPricingPlan[]>([]);
  const [invoices, setInvoices] = useState<ApiBillingInvoice[]>([]);
  const [profiles, setProfiles] = useState<ApiVmBillingProfile[]>([]);
  const [suspensionActions, setSuspensionActions] = useState<ApiBillingSuspensionAction[]>([]);
  const [costBases, setCostBases] = useState<ApiBillingCostBase[]>([]);
  const [config, setConfig] = useState<ApiBillingConfig | null>(null);
  const [planForm, setPlanForm] = useState(emptyPlan);
  const [costForm, setCostForm] = useState(emptyCost);
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const sections = ['summary', 'pricing plans', 'invoices', 'billing policy', 'cost bases', 'VM billing assignments', 'suspension actions'] as const;
    const requests = [
      apiClient.getBillingSummary(),
      apiClient.getBillingPlans(),
      apiClient.getBillingInvoices(),
      apiClient.getBillingConfig(),
      apiClient.getBillingCostBases(),
      apiClient.getVmBillingProfiles(),
      apiClient.getBillingSuspensionActions(),
    ] as const;
    const results = await Promise.allSettled(requests);
    const [summaryResult, plansResult, invoicesResult, configResult, costBasesResult, profilesResult, actionsResult] = results;
    if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
    if (plansResult.status === 'fulfilled') setPlans(plansResult.value);
    if (invoicesResult.status === 'fulfilled') setInvoices(invoicesResult.value);
    if (configResult.status === 'fulfilled') setConfig(configResult.value);
    if (costBasesResult.status === 'fulfilled') setCostBases(costBasesResult.value);
    if (profilesResult.status === 'fulfilled') setProfiles(profilesResult.value);
    if (actionsResult.status === 'fulfilled') setSuspensionActions(actionsResult.value);
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [
      `${sections[index]}: ${result.reason instanceof Error ? result.reason.message : 'request failed'}`,
    ] : []);
    if (failures.length > 0) {
      setError(`Some billing data could not be loaded. ${failures.join(' · ')}`);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const filteredInvoices = useMemo(() => invoiceFilter === 'all' ? invoices : invoices.filter(invoice => invoice.status === invoiceFilter), [invoices, invoiceFilter]);
  const outstandingRatio = summary && summary.billedCents > 0 ? Math.min(100, (summary.outstandingCents / summary.billedCents) * 100) : 0;

  const savePlan = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving('plan');
    setError(null);
    try {
      await apiClient.upsertBillingPlan({
        id: planForm.id || undefined,
        name: planForm.name,
        currency: planForm.currency,
        monthlyPriceCents: Number(planForm.monthlyPriceCents),
        vcpuLimit: Number(planForm.vcpuLimit),
        ramGb: Number(planForm.ramGb),
        diskGb: Number(planForm.diskGb),
        bandwidthGb: planForm.bandwidthGb === '' ? null : Number(planForm.bandwidthGb),
        isActive: planForm.isActive,
        sortOrder: Number(planForm.sortOrder),
      });
      setPlanForm(emptyPlan);
      setNotice('Pricing catalog updated.');
      await load();
    } catch (saveError: any) {
      setError(saveError?.message || 'Unable to save pricing plan.');
    } finally {
      setSaving(null);
    }
  };

  const saveCost = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving('cost');
    setError(null);
    try {
      await apiClient.upsertBillingCostBase({ ...costForm, monthlyCostCents: Number(costForm.monthlyCostCents) });
      setCostForm(emptyCost);
      setNotice('Cost basis updated.');
      await load();
    } catch (saveError: any) {
      setError(saveError?.message || 'Unable to save cost basis.');
    } finally {
      setSaving(null);
    }
  };

  const updateConfig = async (patch: Partial<ApiBillingConfig>) => {
    if (!config) return;
    let confirmation: string | undefined;
    if (patch.suspensionExecutionEnabled === true && !config.suspensionExecutionEnabled) {
      confirmation = window.prompt('This can suspend overdue VMs without deleting them. Type ENABLE_REVERSIBLE_SUSPENSION_AUTOMATION to continue.') || undefined;
      if (confirmation !== 'ENABLE_REVERSIBLE_SUSPENSION_AUTOMATION') {
        setNotice('Automatic suspension remains disabled.');
        return;
      }
    }
    setSaving('config');
    setError(null);
    try {
      const next = await apiClient.updateBillingConfig({ ...patch, confirmation });
      setConfig(next);
      setNotice('Billing policy saved.');
    } catch (saveError: any) {
      setError(saveError?.message || 'Unable to save billing policy.');
    } finally {
      setSaving(null);
    }
  };

  const recordPayment = async (invoice: ApiBillingInvoice) => {
    const amount = window.prompt(`Record payment for ${invoice.id}. Enter amount in cents (outstanding: ${invoice.outstandingCents}).`);
    if (!amount) return;
    setSaving(`payment:${invoice.id}`);
    try {
      await apiClient.recordBillingPayment(invoice.id, Number(amount), 'Recorded from billing operations');
      setNotice(`Payment recorded for ${invoice.id}.`);
      await load();
    } catch (paymentError: any) {
      setError(paymentError?.message || 'Unable to record payment.');
    } finally {
      setSaving(null);
    }
  };

  const saveVmProfile = async (profile: ApiVmBillingProfile, planId: string, customPrice: string) => {
    setSaving(`vm:${profile.vmid}`);
    try {
      await apiClient.updateVmBillingProfile(profile.vmid, {
        planId: planId || undefined,
        customMonthlyPriceCents: customPrice === '' ? null : Number(customPrice),
        billingStatus: profile.billingStatus,
        billingCycleDay: profile.billingCycleDay,
        gracePeriodDays: profile.gracePeriodDays,
      });
      setNotice(`Billing profile saved for VM-${profile.vmid}.`);
      await load();
    } catch (saveError: any) {
      setError(saveError?.message || 'Unable to save VM billing profile.');
    } finally {
      setSaving(null);
    }
  };

  const reverseAction = async (action: ApiBillingSuspensionAction) => {
    const confirmation = window.prompt(`Paid-service recovery for VM-${action.vmid} will be attempted only after the linked invoice is fully paid. Type RESTORE_PAID_SERVICE to continue.`) || '';
    if (confirmation !== 'RESTORE_PAID_SERVICE') {
      setNotice('Recovery was not initiated.');
      return;
    }
    setSaving(`recovery:${action.id}`);
    setError(null);
    try {
      await apiClient.reverseBillingSuspension(action.id);
      setNotice(`Paid service recovery completed for VM-${action.vmid}.`);
      await load();
    } catch (recoveryError: any) {
      setError(recoveryError?.message || 'Unable to restore paid service.');
    } finally {
      setSaving(null);
    }
  };

  const fieldClass = 'w-full rounded border border-[#dedfdf] bg-white px-3 py-2 text-sm text-[#1a1a1a] outline-none focus:border-[#1a1a1a]';
  const cardClass = 'rounded-lg border border-[#dedfdf] bg-white';
  const statusClass = (status: string) => status === 'paid' ? 'text-[#176b52] bg-[#eef9f4] border-[#b8e3cf]' : status === 'overdue' ? 'text-[#8d3028] bg-[#fff1ef] border-[#f0c0bb]' : status === 'partially_paid' ? 'text-[#8b5e00] bg-[#fff8e8] border-[#f3d19a]' : 'text-[#656b6b] bg-[#f4f5f5] border-[#dedfdf]';
  const actionStatusClass = (status: string) => status === 'executed' ? 'text-[#8d3028] bg-[#fff1ef] border-[#f0c0bb]' : status === 'reversed' ? 'text-[#176b52] bg-[#eef9f4] border-[#b8e3cf]' : status === 'failed' ? 'text-[#8b5e00] bg-[#fff8e8] border-[#f3d19a]' : 'text-[#656b6b] bg-[#f4f5f5] border-[#dedfdf]';

  return (
    <main className="app-content min-h-full bg-[#fbfaf9] px-4 py-5 sm:px-6 lg:px-8" aria-busy={loading}>
      <div className="mx-auto max-w-[1440px]">
        <header className="mb-6 flex flex-col gap-4 border-b border-[#dedfdf] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8b5e00]">Finance operations</p>
            <h1 className="text-[25px] font-semibold tracking-[-0.02em] text-[#1a1a1a]">Billing control plane</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#656b6b]">Manage recurring pricing, invoice collection, overdue policy, reversible suspension intent, and estimated gross margin from one auditable workspace.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="h-9 rounded border border-[#1a1a1a] bg-white px-4 text-xs font-semibold text-[#1a1a1a] hover:bg-[#f4f5f5] disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh data'}</button>
        </header>

        {error && <div role="alert" className="mb-5 rounded border border-[#e4b5b0] bg-[#fff7f6] px-4 py-3 text-sm text-[#8d3028]">{error}</div>}
        {notice && <div role="status" className="mb-5 rounded border border-[#b8e3cf] bg-[#eef9f4] px-4 py-3 text-sm text-[#176b52]">{notice}<button type="button" onClick={() => setNotice(null)} className="ml-3 font-semibold underline">Dismiss</button></div>}

        <section className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-6" aria-label="Billing KPIs">
          {[
            ['Billed this cycle', summary ? money(summary.billedCents) : '—'],
            ['Collected', summary ? money(summary.collectedCents) : '—'],
            ['Outstanding', summary ? money(summary.outstandingCents) : '—'],
            ['Overdue', summary ? `${summary.overdueCount} · ${money(summary.overdueCents)}` : '—'],
            ['Estimated gross profit', summary ? money(summary.estimatedGrossProfitCents) : '—'],
            ['Estimated margin', summary ? `${summary.estimatedMarginPercent.toFixed(1)}%` : '—'],
          ].map(([label, value]) => <div key={label} className={`${cardClass} min-h-[104px] p-4`}><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#8a9090]">{label}</p><p className="mt-3 text-xl font-semibold tabular-nums text-[#1a1a1a]">{value}</p></div>)}
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,0.7fr)]">
          <section className={`${cardClass} overflow-hidden`}>
            <div className="flex items-start justify-between gap-4 border-b border-[#dedfdf] px-5 py-4"><div><h2 className="text-sm font-semibold text-[#1a1a1a]">Revenue collection</h2><p className="mt-1 text-xs text-[#656b6b]">Invoice-level collection state and reversible service controls.</p></div><span className="text-xs font-mono text-[#656b6b]">{summary?.invoiceCount || 0} invoices</span></div>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#ededed] px-5 py-3"><span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8a9090]">Filter</span>{['all', 'open', 'overdue', 'partially_paid', 'paid'].map(status => <button key={status} type="button" onClick={() => setInvoiceFilter(status)} className={`rounded border px-2.5 py-1 text-[11px] font-semibold ${invoiceFilter === status ? 'border-[#1a1a1a] bg-[#1a1a1a] text-white' : 'border-[#dedfdf] text-[#656b6b] hover:bg-[#f4f5f5]'}`}>{status.replace('_', ' ')}</button>)}</div>
            <div className="overflow-x-auto"><table className="min-w-[760px] w-full text-left"><thead className="bg-[#fbfaf9] text-[10px] uppercase tracking-[0.12em] text-[#8a9090]"><tr><th className="px-5 py-3 font-semibold">Invoice</th><th className="px-3 py-3 font-semibold">Account / VM</th><th className="px-3 py-3 font-semibold">Due</th><th className="px-3 py-3 font-semibold">Balance</th><th className="px-3 py-3 font-semibold">Status</th><th className="px-5 py-3 text-right font-semibold">Action</th></tr></thead><tbody className="divide-y divide-[#ededed]">{filteredInvoices.length === 0 ? <tr><td colSpan={6} className="px-5 py-12 text-center text-sm text-[#8a9090]">No invoices match this filter.</td></tr> : filteredInvoices.map(invoice => <tr key={invoice.id} className="text-xs text-[#1a1a1a]"><td className="px-5 py-3"><span className="font-mono font-semibold">{invoice.id}</span><span className="mt-1 block text-[10px] text-[#8a9090]">{invoice.planName || 'Custom pricing'}</span></td><td className="px-3 py-3"><span className="font-semibold">{invoice.accountEmail}</span><span className="mt-1 block text-[10px] text-[#8a9090]">VM-{invoice.vmid} · {invoice.vmName || 'Unnamed guest'}</span></td><td className="px-3 py-3 whitespace-nowrap">{dateLabel(invoice.dueAt)}</td><td className="px-3 py-3 whitespace-nowrap font-mono">{money(invoice.outstandingCents, invoice.currency)}</td><td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase ${statusClass(invoice.status)}`}>{invoice.status.replace('_', ' ')}</span></td><td className="px-5 py-3 text-right">{invoice.outstandingCents > 0 && <button type="button" onClick={() => void recordPayment(invoice)} disabled={saving !== null} className="rounded border border-[#1a1a1a] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[#f4f5f5] disabled:opacity-50">Record payment</button>}</td></tr>)}</tbody></table></div>
          </section>

          <section className={`${cardClass} p-5`}>
            <div className="mb-4 flex items-start justify-between gap-4"><div><h2 className="text-sm font-semibold text-[#1a1a1a]">Billing policy</h2><p className="mt-1 text-xs leading-5 text-[#656b6b]">Automation is fail-closed. Enabling suspension requires a separate explicit confirmation.</p></div><span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase ${config?.automationEnabled ? 'border-[#b8e3cf] bg-[#eef9f4] text-[#176b52]' : 'border-[#dedfdf] bg-[#f4f5f5] text-[#656b6b]'}`}>{config?.automationEnabled ? 'active' : 'dry run'}</span></div>
            {config && <div className="space-y-4"><label className="flex items-center justify-between gap-3 text-xs font-semibold text-[#1a1a1a]"><span>Billing lifecycle automation</span><input type="checkbox" checked={config.automationEnabled} onChange={event => void updateConfig({ automationEnabled: event.target.checked })} /></label><label className="flex items-center justify-between gap-3 text-xs font-semibold text-[#1a1a1a]"><span>Reminder emails</span><input type="checkbox" checked={config.reminderEmailsEnabled} onChange={event => void updateConfig({ reminderEmailsEnabled: event.target.checked })} /></label><label className="flex items-center justify-between gap-3 text-xs font-semibold text-[#1a1a1a]"><span>Automatic reversible suspension</span><input type="checkbox" checked={config.suspensionExecutionEnabled} onChange={event => void updateConfig({ suspensionExecutionEnabled: event.target.checked })} /></label><div className="grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-[#1a1a1a]">Reminder lead days<input className={`${fieldClass} mt-1`} type="number" min="0" max="365" value={config.daysBeforeDue} onChange={event => setConfig({ ...config, daysBeforeDue: Number(event.target.value) })} /></label><label className="text-xs font-semibold text-[#1a1a1a]">Grace period days<input className={`${fieldClass} mt-1`} type="number" min="0" max="365" value={config.gracePeriodDays} onChange={event => setConfig({ ...config, gracePeriodDays: Number(event.target.value) })} /></label><label className="text-xs font-semibold text-[#1a1a1a]">Suspend after overdue<input className={`${fieldClass} mt-1`} type="number" min="0" max="365" value={config.suspendAfterDaysOverdue} onChange={event => setConfig({ ...config, suspendAfterDaysOverdue: Number(event.target.value) })} /></label><label className="text-xs font-semibold text-[#1a1a1a]">Tax rate %<input className={`${fieldClass} mt-1`} type="number" min="0" max="100" step="0.01" value={config.taxRatePercent} onChange={event => setConfig({ ...config, taxRatePercent: Number(event.target.value) })} /></label><label className="text-xs font-semibold text-[#1a1a1a]">Default billing currency<select className={`${fieldClass} mt-1`} value={config.currency} onChange={event => setConfig({ ...config, currency: event.target.value as BillingCurrency })}>{billingCurrencyOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div><button type="button" onClick={() => void updateConfig(config)} disabled={saving !== null} className="h-9 w-full rounded bg-[#1a1a1a] px-4 text-xs font-semibold text-white hover:bg-[#333] disabled:opacity-50">{saving === 'config' ? 'Saving…' : 'Save policy'}</button><div className="border-t border-[#ededed] pt-3 text-[11px] leading-5 text-[#656b6b]">Suspension preserves the VM and its disks. It should be enabled only after payment status, reminder delivery, recovery, and legal/commercial policy are reviewed.</div></div>}
          </section>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <section className={`${cardClass} overflow-hidden`}><div className="border-b border-[#dedfdf] px-5 py-4"><h2 className="text-sm font-semibold text-[#1a1a1a]">Pricing catalog</h2><p className="mt-1 text-xs text-[#656b6b]">Publish resource-based plans in cents to avoid floating-point billing ambiguity.</p></div><form onSubmit={savePlan} className="grid gap-3 border-b border-[#ededed] bg-[#fbfaf9] p-5 sm:grid-cols-2"><input className={fieldClass} placeholder="Plan name" value={planForm.name} onChange={event => setPlanForm({ ...planForm, name: event.target.value })} required /><select className={fieldClass} value={planForm.currency} onChange={event => setPlanForm({ ...planForm, currency: event.target.value as BillingCurrency })} aria-label="Plan currency">{billingCurrencyOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><input className={fieldClass} type="number" min="0" placeholder="Monthly price (cents)" value={planForm.monthlyPriceCents} onChange={event => setPlanForm({ ...planForm, monthlyPriceCents: event.target.value })} required /><input className={fieldClass} type="number" min="1" placeholder="vCPU limit" value={planForm.vcpuLimit} onChange={event => setPlanForm({ ...planForm, vcpuLimit: event.target.value })} required /><input className={fieldClass} type="number" min="0.1" step="0.1" placeholder="RAM GB" value={planForm.ramGb} onChange={event => setPlanForm({ ...planForm, ramGb: event.target.value })} required /><input className={fieldClass} type="number" min="0.1" step="0.1" placeholder="Disk GB" value={planForm.diskGb} onChange={event => setPlanForm({ ...planForm, diskGb: event.target.value })} required /><input className={fieldClass} type="number" min="0" placeholder="Bandwidth GB (optional)" value={planForm.bandwidthGb} onChange={event => setPlanForm({ ...planForm, bandwidthGb: event.target.value })} /><button type="submit" disabled={saving !== null} className="h-9 rounded bg-[#1a1a1a] px-4 text-xs font-semibold text-white hover:bg-[#333] disabled:opacity-50 sm:col-span-2">{saving === 'plan' ? 'Saving…' : planForm.id ? 'Update plan' : 'Add plan'}</button></form><div className="divide-y divide-[#ededed]">{plans.map(plan => <div key={plan.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-[#1a1a1a]">{plan.name} <span className="ml-1 text-[10px] font-mono text-[#8a9090]">{plan.id}</span></p><p className="mt-1 text-xs text-[#656b6b]">{money(plan.monthlyPriceCents, plan.currency)} / month · {plan.vcpuLimit} vCPU · {plan.ramGb} GB RAM · {plan.diskGb} GB disk</p></div><div className="flex gap-2"><button type="button" onClick={() => setPlanForm({ id: plan.id, name: plan.name, currency: plan.currency, monthlyPriceCents: String(plan.monthlyPriceCents), vcpuLimit: String(plan.vcpuLimit), ramGb: String(plan.ramGb), diskGb: String(plan.diskGb), bandwidthGb: plan.bandwidthGb === null ? '' : String(plan.bandwidthGb), isActive: plan.isActive, sortOrder: String(plan.sortOrder) })} className="rounded border border-[#dedfdf] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[#f4f5f5]">Edit</button><button type="button" onClick={() => void apiClient.toggleBillingPlan(plan.id, !plan.isActive).then(() => load()).catch(saveError => setError(saveError.message))} className="rounded border border-[#dedfdf] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[#f4f5f5]">{plan.isActive ? 'Disable' : 'Enable'}</button></div></div>)}</div></section>

          <section className={`${cardClass} overflow-hidden`}><div className="border-b border-[#dedfdf] px-5 py-4"><h2 className="text-sm font-semibold text-[#1a1a1a]">Cost basis & profitability</h2><p className="mt-1 text-xs text-[#656b6b]">Enter actual monthly infrastructure and operating costs to turn revenue into an estimate—not a financial statement.</p></div><form onSubmit={saveCost} className="grid gap-3 border-b border-[#ededed] bg-[#fbfaf9] p-5 sm:grid-cols-[1fr_1fr_1fr_auto]"><input className={fieldClass} placeholder="Cost name" value={costForm.name} onChange={event => setCostForm({ ...costForm, name: event.target.value })} required /><input className={fieldClass} type="number" min="0" placeholder="Monthly cost (cents)" value={costForm.monthlyCostCents} onChange={event => setCostForm({ ...costForm, monthlyCostCents: event.target.value })} required /><select className={fieldClass} value={costForm.allocationMethod} onChange={event => setCostForm({ ...costForm, allocationMethod: event.target.value })} aria-label="Cost allocation method"><option value="fixed">Fixed overhead</option><option value="per_vm">Per VM</option><option value="per_vcpu">Per vCPU</option><option value="per_gb_ram">Per GB RAM</option><option value="per_gb_disk">Per GB disk</option></select><button type="submit" disabled={saving !== null} className="h-9 rounded bg-[#1a1a1a] px-4 text-xs font-semibold text-white hover:bg-[#333] disabled:opacity-50">{saving === 'cost' ? 'Saving…' : costForm.id ? 'Update cost' : 'Add cost'}</button></form><div className="divide-y divide-[#ededed]">{costBases.length === 0 ? <div className="px-5 py-10 text-center text-sm text-[#8a9090]">No cost bases configured. Add infrastructure, licensing, support, or payment costs to improve profitability estimates.</div> : costBases.map(cost => <div key={cost.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-[#1a1a1a]">{cost.name}</p><p className="mt-1 text-xs text-[#656b6b]">{money(cost.monthlyCostCents)} / month · {cost.allocationMethod.replace('_', ' ')}</p></div><div className="flex items-center gap-2"><span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase ${cost.isActive ? 'border-[#b8e3cf] bg-[#eef9f4] text-[#176b52]' : 'border-[#dedfdf] text-[#8a9090]'}`}>{cost.isActive ? 'active' : 'inactive'}</span><button type="button" onClick={() => setCostForm({ id: cost.id, name: cost.name, monthlyCostCents: String(cost.monthlyCostCents), allocationMethod: cost.allocationMethod, isActive: cost.isActive })} className="rounded border border-[#dedfdf] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[#f4f5f5]">Edit</button></div></div>)}</div><div className="px-5 py-4"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-semibold text-[#656b6b]">Outstanding as % of billed</span><span className="font-mono font-semibold text-[#1a1a1a]">{outstandingRatio.toFixed(1)}%</span></div><div className="h-2 overflow-hidden rounded bg-[#ededed]"><div className="h-full rounded bg-[#8b5e00]" style={{ width: `${outstandingRatio}%` }} /></div></div></section>
        </div>

        <section className={`${cardClass} mt-6 overflow-hidden`}><div className="border-b border-[#dedfdf] px-5 py-4"><h2 className="text-sm font-semibold text-[#1a1a1a]">Per-system billing assignments</h2><p className="mt-1 text-xs text-[#656b6b]">Assign a published plan or an explicit custom monthly amount to each customer VM. These values drive future invoices.</p></div><div className="overflow-x-auto"><table className="min-w-[980px] w-full text-left"><thead className="bg-[#fbfaf9] text-[10px] uppercase tracking-[0.12em] text-[#8a9090]"><tr><th className="px-5 py-3 font-semibold">System</th><th className="px-3 py-3 font-semibold">Account</th><th className="px-3 py-3 font-semibold">Plan</th><th className="px-3 py-3 font-semibold">Custom monthly cents</th><th className="px-3 py-3 font-semibold">Effective price</th><th className="px-5 py-3 text-right font-semibold">Action</th></tr></thead><tbody className="divide-y divide-[#ededed]">{profiles.length === 0 ? <tr><td colSpan={6} className="px-5 py-12 text-center text-sm text-[#8a9090]">No billing profiles yet. Assign a plan to a customer VM to begin invoicing.</td></tr> : profiles.map(profile => <VmBillingRow key={profile.vmid} profile={profile} plans={plans} saving={saving} onSave={saveVmProfile} />)}</tbody></table></div></section>

        <section className={`${cardClass} mt-6 overflow-hidden`}><div className="flex items-start justify-between gap-4 border-b border-[#dedfdf] px-5 py-4"><div><h2 className="text-sm font-semibold text-[#1a1a1a]">Suspension action ledger</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-[#656b6b]">Every policy-generated action is retained here with its reason, linked balance, and recovery state. No actions are generated while suspension execution is disabled.</p></div><span className="text-xs font-mono text-[#656b6b]">{suspensionActions.length} actions</span></div>{suspensionActions.length === 0 ? <div className="px-5 py-10 text-center text-sm text-[#8a9090]">No suspension actions recorded. The current fail-closed policy is preserving service and VM resources.</div> : <div className="overflow-x-auto"><table className="min-w-[900px] w-full text-left"><thead className="bg-[#fbfaf9] text-[10px] uppercase tracking-[0.12em] text-[#8a9090]"><tr><th className="px-5 py-3 font-semibold">Action</th><th className="px-3 py-3 font-semibold">System / account</th><th className="px-3 py-3 font-semibold">Outstanding</th><th className="px-3 py-3 font-semibold">Requested</th><th className="px-3 py-3 font-semibold">Status</th><th className="px-5 py-3 text-right font-semibold">Recovery</th></tr></thead><tbody className="divide-y divide-[#ededed]">{suspensionActions.map(action => <tr key={action.id} className="text-xs text-[#1a1a1a]"><td className="px-5 py-3"><span className="font-mono font-semibold">{action.id}</span><span className="mt-1 block max-w-[260px] truncate text-[10px] text-[#8a9090]" title={action.reason}>{action.reason || 'Policy action'}</span></td><td className="px-3 py-3"><span className="font-semibold">VM-{action.vmid} · {action.vm_name || 'Unnamed guest'}</span><span className="mt-1 block text-[10px] text-[#8a9090]">{action.account_email || '—'}</span></td><td className="px-3 py-3 font-mono">{money(Math.max(0, Number(action.total_cents || 0) - Number(action.paid_cents || 0)))} </td><td className="px-3 py-3 whitespace-nowrap">{dateLabel(action.requested_at)}</td><td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase ${actionStatusClass(action.status)}`}>{action.status}</span></td><td className="px-5 py-3 text-right">{action.status === 'executed' ? <button type="button" onClick={() => void reverseAction(action)} disabled={saving !== null} className="rounded border border-[#1a1a1a] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[#f4f5f5] disabled:opacity-50">{saving === `recovery:${action.id}` ? 'Recovering…' : 'Recover paid service'}</button> : <span className="text-[11px] text-[#8a9090]">No action</span>}</td></tr>)}</tbody></table></div>}</section>
      </div>
    </main>
  );
};

const VmBillingRow: React.FC<{ profile: ApiVmBillingProfile; plans: ApiPricingPlan[]; saving: string | null; onSave: (profile: ApiVmBillingProfile, planId: string, customPrice: string) => Promise<void> }> = ({ profile, plans, saving, onSave }) => {
  const [planId, setPlanId] = useState(profile.planId || '');
  const [customPrice, setCustomPrice] = useState(profile.customMonthlyPriceCents === null ? '' : String(profile.customMonthlyPriceCents));
  useEffect(() => { setPlanId(profile.planId || ''); setCustomPrice(profile.customMonthlyPriceCents === null ? '' : String(profile.customMonthlyPriceCents)); }, [profile.planId, profile.customMonthlyPriceCents]);
  return <tr className="text-xs text-[#1a1a1a]"><td className="px-5 py-3"><span className="font-semibold">VM-{profile.vmid} · {profile.vmName || 'Unnamed guest'}</span><span className="mt-1 block text-[10px] text-[#8a9090]">Due {dateLabel(profile.nextDueAt)}</span></td><td className="px-3 py-3 font-medium">{profile.ownerEmail || '—'}</td><td className="px-3 py-3"><select className="rounded border border-[#dedfdf] bg-white px-2 py-1.5 text-xs" value={planId} onChange={event => setPlanId(event.target.value)}><option value="">Custom / none</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></td><td className="px-3 py-3"><input className="w-36 rounded border border-[#dedfdf] px-2 py-1.5 font-mono text-xs" type="number" min="0" placeholder="optional" value={customPrice} onChange={event => setCustomPrice(event.target.value)} /></td><td className="px-3 py-3 font-mono">{money(profile.monthlyPriceCents)}</td><td className="px-5 py-3 text-right"><button type="button" onClick={() => void onSave(profile, planId, customPrice)} disabled={saving !== null} className="rounded border border-[#1a1a1a] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[#f4f5f5] disabled:opacity-50">{saving === `vm:${profile.vmid}` ? 'Saving…' : 'Save'}</button></td></tr>;
};
