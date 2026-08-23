import { dbService } from '../db/database.js';
import { automationService } from '../services/automation.js';

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const THRESHOLDS = [80, 100];
const notifiedCache = new Map<string, number>(); // "vmid:threshold" -> notified hour

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Bandwidth quota watcher: every 10 minutes, checks each VM's monthly bandwidth
 * against its quota. When 80% or 100% is reached, a notification is created and
 * (if SMTP mail notifications are enabled) an alert email is dispatched.
 */
async function sweep() {
  try {
    const conns = await dbService.getProxmoxConnections();
    if (!conns || conns.length === 0) return;
    const vms = await dbService.getVMs();
    const mailNotif: any = (await dbService.getMailNotifications()) || {};
    const alertEmails = String(mailNotif.alert_emails || 'admin@votioncloud.org')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const nowHour = Math.floor(Date.now() / 3600000);
    for (const vm of vms) {
      const vmid = vm.vmid || vm.id;
      if (!vmid) continue;
      try {
        const bw = await automationService.getMonthlyBandwidth(vmid);
        const pct = Number(bw.usagePct || 0);
        const label = vm.name || `VMID ${vmid}`;
        for (const t of THRESHOLDS) {
          const cacheKey = `${vmid}:${t}`;
          if (pct >= t && notifiedCache.get(cacheKey) !== nowHour) {
            notifiedCache.set(cacheKey, nowHour);
            const title = t === 100
              ? `Bandwidth quota exhausted — ${label}`
              : `Bandwidth quota warning (${pct.toFixed(0)}%) — ${label}`;
            const message = t === 100
              ? `VM ${label} has used ${bw.bandwidthUsedGb} GB of its ${bw.bandwidthQuotaGb} GB monthly allowance. Further traffic may be throttled or suspended per policy.`
              : `VM ${label} has used ${bw.bandwidthUsedGb} GB of its ${bw.bandwidthQuotaGb} GB monthly allowance (${pct.toFixed(1)}% consumed).`;
            const ownerEmail = vm.ownerEmail || alertEmails[0] || 'admin@votioncloud.org';
            try {
              await dbService.createNotification({
                accountEmail: String(ownerEmail),
                title,
                message,
                severity: t === 100 ? 'critical' : 'warning',
              });
            } catch { /* notification insert failure is non-fatal */ }
            if (mailNotif.alert_enabled && alertEmails.length > 0) {
              try {
                const { emailService } = await import('../services/email.js');
                if (emailService && typeof emailService.sendEmail === 'function') {
                  await emailService.sendEmail(
                    alertEmails.join(','),
                    title,
                    `<h3>${title}</h3><p>${message}</p>`
                  );
                }
              } catch { /* mailer failure is non-fatal; notification remains */ }
            }
          }
        }
      } catch { /* single VM failure must not stop the sweep */ }
    }
  } catch { /* sweep failures are logged by the interval wrapper */ }
}

export const quotaWorker = {
  start() {
    if (timer) return;
    timer = setInterval(sweep, INTERVAL_MS);
    // First sweep after a short delay (allow boot sequence to settle)
    setTimeout(sweep, 45000).unref?.();
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
