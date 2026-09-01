import { dbService } from '../db/database.js';
import { ProxmoxService } from '../services/proxmoxService.js';
import { pgPool } from '../db/database.js';

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
      const res = await pgPool.query(`SELECT vmid, node, proxmox_connection_id as "proxmoxConnectionId", owner_email as "ownerEmail", expiry_date as "expiryDate" FROM vms WHERE is_suspended = false AND expiry_date < NOW()`);
      const allVMs = res.rows;
      const now = new Date();

      for (const vm of allVMs) {
        if (vm.expiryDate) {
          const expiry = new Date(vm.expiryDate);
          if (true) {
            console.log(`[EXPIRY WORKER] VMID ${vm.vmid} expired on ${expiry.toISOString()}. Triggering automated Proxmox STOP and suspension.`);
            
            // 1. Issue Proxmox STOP command
            try {
              const proxmoxSvc = new ProxmoxService({} as any);
              await proxmoxSvc.executePowerAction(vm.node, vm.vmid, 'stop', 'system-expiry-worker@votioncloud.org', vm.proxmoxConnectionId || undefined);
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
