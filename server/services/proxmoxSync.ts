import { dbService } from '../db/database.js';
import { proxmoxFetch } from './proxmoxHttp.js';

const SYNC_INTERVAL_MS = 15_000;
const DEFAULT_OWNER_EMAIL = 'unassigned@votioncloud.org';

type ProxmoxConnection = {
  id: string;
  host_ip: string;
  port: number;
  token_id: string;
  token_secret: string | null;
  ssl_fingerprint?: string | null;
};

export type ProxmoxVmResource = {
  vmid: number;
  node: string;
  name?: string;
  type?: 'qemu' | 'lxc' | string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  cpu?: number;
  mem?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  uptime?: number;
  proxmoxConnectionId: string;
};

export class ProxmoxSyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  start(): void {
    if (this.timer) return;

    void this.syncNow();
    this.timer = setInterval(() => {
      void this.syncNow();
    }, SYNC_INTERVAL_MS);
    this.timer.unref?.();
    console.log(`[PROXMOX SYNC] Worker started (${SYNC_INTERVAL_MS / 1000}s interval)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log('[PROXMOX SYNC] Worker stopped');
  }

  async syncNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.performSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performSync(): Promise<void> {
    const connections = (await dbService.getProxmoxConnectionCredentials()) as ProxmoxConnection[];
    if (connections.length === 0) return;

    for (const connection of connections) {
      try {
        await this.syncConnection(connection);
      } catch (error: any) {
        console.error(`[PROXMOX SYNC] Connection ${connection.id} failed:`, error?.message || error);
      }
    }
  }

  private async syncConnection(connection: ProxmoxConnection): Promise<void> {
    const host = String(connection.host_ip || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const port = Number(connection.port) || 8006;
    if (!host || !connection.token_id || !connection.token_secret) {
      throw new Error('Connection is missing host or API token configuration');
    }

    const response = await proxmoxFetch(`https://${host}:${port}/api2/json/cluster/resources?type=vm`, {
      headers: {
        Authorization: `PVEAPIToken=${connection.token_id}=${connection.token_secret}`,
      },
      sslFingerprint: connection.ssl_fingerprint,
    });
    if (!response.ok) {
      throw new Error(`cluster/resources returned HTTP ${response.status}`);
    }

    const payload = await response.json() as { data?: ProxmoxVmResource[] };
    const resources = (payload.data || [])
      .filter(resource => Number.isInteger(Number(resource.vmid)) && resource.node)
      .map(resource => ({
        ...resource,
        vmid: Number(resource.vmid),
        node: String(resource.node),
        cpus: Number(resource.maxcpu || 1),
        maxmem: Number(resource.maxmem || 0),
        maxdisk: Number(resource.maxdisk || 0),
        type: resource.type === 'lxc' ? 'lxc' : 'qemu',
        proxmoxConnectionId: connection.id,
      }));

    if (resources.length === 0) return;

    const syncResult = await dbService.upsertProxmoxVMs(resources, DEFAULT_OWNER_EMAIL);
    const synchronizedVmKeys = new Set(syncResult.synchronizedVmKeys || resources.map(resource => `${resource.proxmoxConnectionId}:${resource.vmid}`));
    await dbService.insertVmMetricsBatch(resources.filter(resource => synchronizedVmKeys.has(`${resource.proxmoxConnectionId}:${resource.vmid}`)).map(resource => ({
      vmid: resource.vmid,
      proxmoxConnectionId: resource.proxmoxConnectionId,
      cpuPct: Number(resource.cpu || 0) * 100,
      ramBytes: Number(resource.mem || 0),
      netInBytes: Number(resource.netin || 0),
      netOutBytes: Number(resource.netout || 0),
      diskReadBytes: Number(resource.diskread || 0),
      diskWriteBytes: Number(resource.diskwrite || 0),
    })));

    console.log(`[PROXMOX SYNC] ${connection.id}: synchronized ${resources.length} VM(s)`);
  }
}

export const proxmoxSync = new ProxmoxSyncWorker();
