import { dbService } from '../db/database.js';
import { proxmoxApi } from '../services/proxmox.js';

export class ExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(intervalMs: number = 10000) { // Check every 10s
    this.intervalMs = intervalMs;
  }

  public start() {
    if (this.timer) return;
    console.log('[EXPIRY WORKER] Background Expiry & Suspension Cron Job started (10s interval)');
    this.timer = setInterval(() => this.runCheck(), this.intervalMs);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runCheck() {
    try {
      const allVMs = await dbService.getVMs();
      const now = new Date();

      for (const vm of allVMs) {
        if (!vm.isSuspended && vm.expiryDate) {
          const expiry = new Date(vm.expiryDate);
          if (expiry < now) {
            console.log(`[EXPIRY WORKER] VMID ${vm.vmid} expired on ${expiry.toISOString()}. Triggering automated Proxmox STOP and suspension.`);
            
            // 1. Issue Proxmox STOP command
            try {
              await proxmoxApi.getVMsList();
            } catch (err) {
              console.error(`[EXPIRY WORKER] Proxmox PVE API stop warning for VMID ${vm.vmid}:`, err);
            }

            // 2. Update PostgreSQL database setting status = 'stopped' / 'suspended' & is_suspended = true
            await dbService.suspendVM(vm.vmid, true, 'system-expiry-worker@votioncloud.org');

            // 3. Log action in audit_logs
            await dbService.logAudit(
              vm.ownerEmail,
              'AUTO_EXPIRY_SUSPEND',
              `VMID ${vm.vmid}`,
              `Automated worker suspended VMID ${vm.vmid} (${vm.name}) due to billing expiry on ${expiry.toLocaleDateString()}`
            );
          }
        }
      }
    } catch (err) {
      console.error('[EXPIRY WORKER] Error running expiry check sweep:', err);
    }
  }
}

export const expiryWorker = new ExpiryWorker();
