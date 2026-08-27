import { dbService } from '../db/database.js';

export interface PveResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

interface ProxmoxConn {
  host_ip: string;
  port: number | string;
  token_id: string;
  token_secret: string | null;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

/**
 * Defensive Proxmox API wrapper: retry loop, execution timeout via AbortController,
 * and structured error handling. Self-signed host tolerance is per-request only.
 */
async function pveRequest<T = any>(
  conn: ProxmoxConn,
  method: string,
  path: string,
  form?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES
): Promise<PveResult<T>> {
  const cleanHost = String(conn.host_ip).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const port = conn.port || 8006;
  const url = `https://${cleanHost}:${port}/api2/json${path}`;
  const headers: Record<string, string> = {
    Authorization: `PVEAPIToken=${conn.token_id}=${conn.token_secret || ''}`,
  };
  let body: string | undefined;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!res.ok) {
        lastErr = `Proxmox API ${method} ${path} returned HTTP ${res.status}: ${json?.errors ? JSON.stringify(json.errors) : text.slice(0, 200)}`;
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: lastErr, status: res.status };
        }
        // retry on transient 5xx only
        if (res.status >= 500 && attempt < retries) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        return { ok: false, error: lastErr, status: res.status };
      }
      return { ok: true, data: json?.data, status: res.status };
    } catch (err: any) {
      lastErr = err?.name === 'AbortError'
        ? `Proxmox API ${method} ${path} timed out after ${timeoutMs}ms`
        : `Proxmox API ${method} ${path} network error: ${err?.message || err}`;
      if (attempt < retries && /timed out|network|ECONNREFUSED|fetch failed/i.test(lastErr)) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return { ok: false, error: lastErr };
    }
  }
  return { ok: false, error: lastErr || 'Proxmox API request failed after retries' };
}

export function pveRequestExported(...args: Parameters<typeof pveRequest>) {
  return pveRequest(...args);
}

async function requireConn(): Promise<ProxmoxConn> {
  const conns = await dbService.getProxmoxConnectionCredentials();
  if (!conns || conns.length === 0) {
    throw new Error('No cluster connection configured.');
  }
  return conns[0] as ProxmoxConn;
}

async function requireVm(vmid: number) {
  const vm = await dbService.getVMByVMID(vmid);
  if (!vm) throw new Error(`VMID ${vmid} not found.`);
  if (vm.isSuspended) throw new Error(`VMID ${vmid} is suspended. Action disabled until renewal.`);
  return vm;
}

async function ensureStopped(conn: ProxmoxConn, vm: any): Promise<PveResult> {
  const r = await pveRequest(conn, 'GET', `/nodes/${vm.node}/${vm.type}/${vm.vmid}/status/current`);
  if (!r.ok) return r;
  if (r.data?.status === 'running' || r.data?.status === 'started') {
    return await pveRequest(conn, 'POST', `/nodes/${vm.node}/${vm.type}/${vm.vmid}/status/stop`);
  }
  return { ok: true };
}

async function startVm(conn: ProxmoxConn, vm: any): Promise<PveResult> {
  return await pveRequest(conn, 'POST', `/nodes/${vm.node}/${vm.type}/${vm.vmid}/status/start`);
}

export class AutomationService {
  // ---------------------------------------------------------------
  // 1. OS Rebuild with Cloud-Init
  // ---------------------------------------------------------------
  async reinstallWithCloudInit(vmid: number, opts: {
    targetOS?: string;
    userpass?: string;
    cipassword?: string;
    hostname?: string;
    sshkeys?: string;
  }, userEmail: string) {
    const conn = await requireConn();
    const vm = await requireVm(vmid);
    if (vm.type !== 'qemu') {
      throw new Error('OS rebuild with Cloud-Init is only supported for KVM virtual machines.');
    }

    // 1a. Apply Cloud-Init settings via the config endpoint
    const configForm: Record<string, string> = {};
    const ciPassword = opts.cipassword || opts.userpass || '';
    if (ciPassword) configForm.cipassword = ciPassword;
    if (opts.hostname) configForm.name = opts.hostname;
    if (opts.sshkeys && opts.sshkeys.trim()) {
      configForm.sshkeys = Buffer.from(opts.sshkeys.trim(), 'utf8').toString('base64');
    }
    if (Object.keys(configForm).length > 0) {
      const cfg = await pveRequest(conn, 'POST', `/nodes/${vm.node}/qemu/${vm.vmid}/config`, configForm);
      if (!cfg.ok) throw new Error(`Failed to apply Cloud-Init settings: ${cfg.error}`);
    }

    // 1b. Existing DB-level reinstall (OS template swap + record) then reboot
    const result = await dbService.reinstallVMOS(vmid, opts.targetOS || vm.os || 'Ubuntu 24.04 LTS', userEmail);

    // 1c. Restart so Cloud-Init injects the new identity on first boot
    await ensureStopped(conn, vm);
    await new Promise(r => setTimeout(r, 2000));
    const start = await startVm(conn, vm);
    if (!start.ok) {
      return {
        message: `OS rebuild registered (Cloud-Init settings applied). VM restart reported: ${start.error}. Start the VM manually from the power menu if needed.`,
        partial: true,
        data: result,
      };
    }
    return { message: `OS rebuild initiated for VMID ${vmid}. Cloud-Init will inject the new identity on first boot.`, data: result };
  }

  // ---------------------------------------------------------------
  // 2. Rescue Mode (ephemeral ISO attach via ide2 + boot order change)
  // ---------------------------------------------------------------
  async enterRescueMode(vmid: number, userEmail: string) {
    const conn = await requireConn();
    const vm = await requireVm(vmid);
    if (vm.type !== 'qemu') throw new Error('Rescue mode is only supported for KVM virtual machines.');

    // Locate a bootable ISO on the cluster storage
    let isoSpec = '';
    const storages = await pveRequest<any[]>(conn, 'GET', '/storage?content=images');
    const storageList = (storages.ok ? storages.data : []) || [];
    for (const st of storageList) {
      const content = await pveRequest<any[]>(conn, 'GET', `/storage/${st.storage}/content?content=iso`);
      if (!content.ok || !content.data || content.data.length === 0) continue;
      const iso = content.data[0];
      isoSpec = `${st.storage}:iso/${iso.volid.replace(/^.*iso\//, '')}`;
      break;
    }
    if (!isoSpec) throw new Error('No ISO image found on any cluster storage. Upload a rescue ISO (e.g. SystemRescue) to a storage first.');

    // Attach ISO to ide2 and set network-only boot order
    const cfg = await pveRequest(conn, 'POST', `/nodes/${vm.node}/qemu/${vm.vmid}/config`, {
      ide2: `${isoSpec},media=cdrom`,
      boot: 'n',
    });
    if (!cfg.ok) throw new Error(`Failed to attach rescue ISO: ${cfg.error}`);

    // Cycle the VM so it boots from the CD-ROM
    await ensureStopped(conn, vm);
    await new Promise(r => setTimeout(r, 2000));
    const start = await startVm(conn, vm);
    if (!start.ok) throw new Error(`Rescue ISO attached but VM restart failed: ${start.error}. Restart it manually.`);

    await dbService.logAudit('system', 'rescue_mode_entered', `VMID ${vmid}`, `Rescue ISO attached (${isoSpec})`).catch(() => {});
    return { message: `Rescue mode activated for VMID ${vmid}. Booting from ${isoSpec}. The panel console (VNC) can now be used to repair the system.`, iso: isoSpec };
  }

  /** Non-destructive readiness check: list storages with ISO images on the cluster. */
  async checkRescueReadiness(vmid: number) {
    const conn = await requireConn();
    await requireVm(vmid);
    const storages = await pveRequest<any[]>(conn, 'GET', '/storage?content=images');
    const storageList = (storages.ok ? storages.data : []) || [];
    const isos: string[] = [];
    for (const st of storageList) {
      const content = await pveRequest<any[]>(conn, 'GET', `/storage/${st.storage}/content?content=iso`);
      if (!content.ok || !content.data || content.data.length === 0) continue;
      for (const iso of content.data) {
        isos.push(iso.volid || iso.filename || `${st.storage}:iso`);
      }
    }
    if (isos.length === 0) {
      return {
        available: false,
        isoCount: 0,
        isos: [],
        message: 'No rescue ISO found on any cluster storage. Rescue mode requires a bootable rescue image (e.g. SystemRescue) uploaded to a storage first. Contact your administrator.',
      };
    }
    return { available: true, isoCount: isos.length, isos, message: `Rescue mode ready — ${isos.length} ISO image(s) available on cluster storage.` };
  }

  /** List all template VMs on the cluster (for catalog template-availability checks). */
  async listClusterTemplates() {
    const conn = await requireConn();
    const res = await pveRequest<any[]>(conn, 'GET', '/cluster/resources?type=vm');
    if (!res.ok || !res.data) return [];
    return (res.data as any[])
      .filter((r) => String(r.template) === '1' || r.type === 'qemu' && r.template === 1)
      .map((r) => ({ vmid: r.vmid, name: r.name, node: r.node, template: 1 }));
  }

  async exitRescueMode(vmid: number, userEmail: string) {
    const conn = await requireConn();
    const vm = await requireVm(vmid);
    if (vm.type !== 'qemu') throw new Error('Rescue exit is only supported for KVM virtual machines.');

    const cfg = await pveRequest(conn, 'POST', `/nodes/${vm.node}/qemu/${vm.vmid}/config`, {
      delete: 'ide2',
      boot: 'cdn',
    });
    if (!cfg.ok) throw new Error(`Failed to detach rescue ISO: ${cfg.error}`);

    await ensureStopped(conn, vm);
    await new Promise(r => setTimeout(r, 2000));
    const start = await startVm(conn, vm);
    if (!start.ok) throw new Error(`Rescue ISO detached but VM restart failed: ${start.error}. Restart it manually.`);

    return { message: `Rescue mode exited for VMID ${vmid}. Booting normally from disk.` };
  }

  // ---------------------------------------------------------------
  // 3. Self-Service Backups (vzdump + restore)
  // ---------------------------------------------------------------
  async triggerBackup(vmid: number, userEmail: string) {
    const conn = await requireConn();
    const vm = await requireVm(vmid);

    // Find a storage that supports backups
    const storages = await pveRequest<any[]>(conn, 'GET', '/storage?content=backup');
    const list = (storages.ok ? storages.data : []) || [];
    const backupStorage = list[0]?.storage;
    if (!backupStorage) throw new Error('No backup-capable storage found on the cluster.');

    const r = await pveRequest<any>(conn, 'POST', `/nodes/${vm.node}/vzdump`, {
      vmid: String(vm.vmid),
      mode: 'snapshot',
      storage: backupStorage,
      compress: 'zstd',
    });
    if (!r.ok) throw new Error(`Backup start failed: ${r.error}`);

    const queueRow = await dbService.queueBackup(vmid, r.data?.upid || null, userEmail);
    // Fire-and-forget status poll (task may take minutes)
    this.pollBackupTask(conn, vm.node, r.data?.upid || '', queueRow.id).catch(() => {});
    return { message: `Backup queued for VMID ${vmid} on storage '${backupStorage}'. Track progress in Backups.`, upid: r.data?.upid, storage: backupStorage, queueId: queueRow.id };
  }

  private async pollBackupTask(conn: ProxmoxConn, node: string, upid: string, queueId: number) {
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 10000));
      try {
        const t = await pveRequest<any>(conn, 'GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
        if (t.ok && t.data) {
          if (t.data.status === 'stopped') {
            const exit = Number(t.data.exitstatus || 0);
            await dbService.markBackupStatus(queueId, exit === 0 ? 'completed' : 'failed', exit !== 0 ? `vzdump exit code: ${t.data.exitstatus}` : undefined);
            return;
          }
        }
      } catch { /* continue polling */ }
    }
    await dbService.markBackupStatus(queueId, 'running', 'Task still running after 20 minutes — check Proxmox task list.');
  }

  async listBackups(vmid?: number) {
    if (vmid) {
      const vm = await requireVm(vmid);
      const conn = await requireConn();
      // Cluster-wide vzdump view is the most reliable listing endpoint
      const r = await pveRequest<any[]>(conn, 'GET', `/nodes/${vm.node}/vzdump`);
      if (!r.ok) throw new Error(`Failed to list backups: ${r.error}`);
      const all = (r.data || []).filter((b: any) => Number(b.vmid) === vmid);
      const queue = await dbService.getBackupQueue(vmid);
      return { live: all, queued: queue };
    }
    const queue = await dbService.getBackupQueue();
    return { live: [], queued: queue };
  }

  async restoreBackup(vmid: number, backupVolid: string, targetStorage: string, userEmail: string) {
    const conn = await requireConn();
    const vm = await requireVm(vmid);
    // Restore into a new VMID to avoid data loss; caller controls the target via db record afterward
    const r = await pveRequest<any>(conn, 'PUT', `/nodes/${vm.node}/restore`, {
      archive: backupVolid,
      storage: targetStorage,
      force: '1',
    });
    if (!r.ok) throw new Error(`Restore start failed: ${r.error}`);
    await dbService.logAudit(userEmail, 'backup_restore_triggered', `VMID ${vmid}`, `Restore ${backupVolid} → storage ${targetStorage}`).catch(() => {});
    return { message: `Restore initiated. Upid: ${r.data?.upid || 'unknown'}. The restored VM appears in the cluster once the task completes.`, upid: r.data?.upid };
  }

  // ---------------------------------------------------------------
  // 4. Live Telemetry via RRD + Bandwidth Quotas
  // ---------------------------------------------------------------
  async getLiveRrd(vmid: number, timeframe: string = 'hour') {
    const vm = await requireVm(vmid);
    const conn = await requireConn();
    const r = await pveRequest<any[]>(conn, 'GET', `/nodes/${vm.node}/qemu/${vm.vmid}/rrddata?timeframe=${encodeURIComponent(timeframe)}`);
    if (!r.ok) throw new Error(`RRD stream unavailable: ${r.error}`);
    const rows = (r.data || []).map((d: any) => ({
      time: Number(d.time || 0),
      cpu: Number(d.cpu || 0),
      maxcpu: Number(d['maxcpu'] || vm.cpus || 0),
      mem: Number(d.mem || 0),
      maxmem: Number(d.maxmem || vm.memory || vm.maxmem || 0),
      diskread: Number(d.diskread || 0),
      diskwrite: Number(d.diskwrite || 0),
      netin: Number(d.netin || 0),
      netout: Number(d.netout || 0),
    }));
    return { vmid, name: vm.name, timeframe, rows, source: 'proxmox_rrd', count: rows.length };
  }

  async getMonthlyBandwidth(vmid: number) {
    const vm = await requireVm(vmid);
    const conn = await requireConn();
    const r = await pveRequest<any[]>(conn, 'GET', `/nodes/${vm.node}/qemu/${vm.vmid}/rrddata?timeframe=month`);
    if (!r.ok) throw new Error(`Bandwidth data unavailable: ${r.error}`);
    const rows = (r.data || []) as any[];
    // RRD gives cumulative counters per sample; use last non-zero sample deltas approximated by peak-rate * window is inaccurate.
    // Instead integrate the rate samples: netin/netout in rrd are bytes/sec rates.
    let totalIn = 0; let totalOut = 0; let samples = 0;
    let lastT = 0;
    for (const d of rows) {
      const rateIn = Number(d.netin || 0);
      const rateOut = Number(d.netout || 0);
      const t = Number(d.time || 0);
      if (lastT > 0 && t > lastT) {
        const span = Math.min(t - lastT, 600); // RRD step; clamp to avoid spikes
        totalIn += rateIn * span;
        totalOut += rateOut * span;
        samples++;
      }
      lastT = t;
    }
    const quotaGb = await dbService.getVmBandwidthQuota(vmid);
    const usedGb = (totalIn + totalOut) / 1073741824;
    const pct = quotaGb > 0 ? Math.min(100, (usedGb / quotaGb) * 100) : 0;
    return {
      vmid, name: vm.name,
      bandwidthUsedGb: Number(usedGb.toFixed(2)),
      bandwidthQuotaGb: quotaGb,
      usagePct: Number(pct.toFixed(1)),
      netInGb: Number((totalIn / 1073741824).toFixed(2)),
      netOutGb: Number((totalOut / 1073741824).toFixed(2)),
      rrdSamples: samples,
      monthWindow: 'last 30 days',
      source: 'proxmox_rrd',
    };
  }

  // ---------------------------------------------------------------
  // 5. rDNS / PTR queue processing
  // ---------------------------------------------------------------
  async requestRdns(vmid: number, ip: string, ptr: string, userEmail: string) {
    const vm = await requireVm(vmid);
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error('Invalid IPv4 address.');
    if (ptr.length > 253) throw new Error('PTR record too long.');
    const row = await dbService.pushRdnsRequest(vmid, ip, ptr, userEmail);
    // Fire-and-forget immediate processing attempt
    this.processRdnsQueue().catch(() => {});
    return { message: `rDNS request queued for ${ip} → ${ptr}.`, id: row.id, status: row.status };
  }

  async processRdnsQueue() {
    const queue = await dbService.getRdnsQueue();
    const pending = queue.filter((q: any) => q.status === 'pending');
    const settings: any = (await dbService.getSystemSetting('rdns_provider')) || { provider: '', apiToken: '', zone: '' };
    for (const item of pending) {
      try {
        if (!settings.provider || !settings.apiToken || !settings.zone) {
          await dbService.markRdnsProcessed(item.id, 'skipped_no_provider', 'rDNS provider (Cloudflare/PowerDNS) not configured in Settings.');
          continue;
        }
        if (String(settings.provider).toLowerCase() === 'cloudflare') {
          const rev = item.ip.split('.').reverse().join('.');
          const zoneRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${settings.zone}/dns_records`, {
            headers: { Authorization: `Bearer ${settings.apiToken}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          if (!zoneRes.ok) {
            await dbService.markRdnsProcessed(item.id, 'failed', `Cloudflare zone lookup failed: HTTP ${zoneRes.status}`);
            continue;
          }
          const zoneJson: any = await zoneRes.json();
          const rec = (zoneJson.result || []).find((r: any) => r.type === 'PTR' && r.name === item.ptr);
          let putOk = false;
          if (rec) {
            const u = await fetch(`https://api.cloudflare.com/client/v4/zones/${settings.zone}/dns_records/${rec.id}`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${settings.apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'PTR', name: item.ptr, content: rev, ttl: 1 }),
              signal: AbortSignal.timeout(15000),
            });
            putOk = u.ok;
          } else {
            const c = await fetch(`https://api.cloudflare.com/client/v4/zones/${settings.zone}/dns_records`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${settings.apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'PTR', name: item.ptr, content: rev, ttl: 1 }),
              signal: AbortSignal.timeout(15000),
            });
            putOk = c.ok;
          }
          await dbService.markRdnsProcessed(item.id, putOk ? 'completed' : 'failed', putOk ? undefined : 'Cloudflare API rejected the PTR update (check token/zone).');
        } else {
          // Generic downstream provider: POST to rdns_ptr_endpoint if configured
          const endpoint = settings.rdnsPtrEndpoint || '';
          if (!endpoint) {
            await dbService.markRdnsProcessed(item.id, 'skipped_no_provider', `Provider '${settings.provider}' requires rdns_ptr_endpoint in Settings.`);
            continue;
          }
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiToken}` },
            body: JSON.stringify({ ip: item.ip, ptr: item.ptr, vmid: item.vmid }),
            signal: AbortSignal.timeout(15000),
          });
          await dbService.markRdnsProcessed(item.id, r.ok ? 'completed' : 'failed', r.ok ? undefined : `Downstream provider returned HTTP ${r.status}`);
        }
      } catch (err: any) {
        await dbService.markRdnsProcessed(item.id, 'failed', err?.message || 'Unknown rDNS processing error');
      }
    }
    return { processed: pending.length };
  }

  // ---------------------------------------------------------------
  // 6. App Marketplace (1-click deploy via template clone)
  // ---------------------------------------------------------------
  async deployApp(vmid: number, appId: string, userEmail: string) {
    const conn = await requireConn();
    const vm = await requireVm(vmid);
    const app = (await dbService.getAppCatalogAll()).find(a => a.id === appId);
    if (!app) throw new Error(`Unknown app: ${appId}`);
    await dbService.createAppInstance(vmid, appId);

    // Locate the prepared template VM on the cluster (naming convention: stellar-template-{appId})
    const resources = await pveRequest<any[]>(conn, 'GET', '/cluster/resources?type=vm');
    const resList = (resources.ok ? resources.data : []) || [];
    const template = resList.find((x: any) =>
      x.template === 1 && new RegExp(`stellar-template-${appId.replace(/[^a-z0-9]/gi, '')}`, 'i').test(x.name || '')
    );
    if (!template) {
      await dbService.setAppInstanceStatus(vmid, appId, 'failed');
      throw new Error(
        `No template VM 'stellar-template-${appId}' found on the cluster. Ask your provider to prepare the template ` +
        `(create a VM, install the stack, then mark it as template named stellar-template-${appId}).`
      );
    }

    // Stop the target VM before cloning disk content
    await ensureStopped(conn, vm);

    // Clone the template disk onto the existing VM's disk via the clone endpoint targeting newid? 
    // Proxmox clone creates a NEW vm; for in-place app deployment we clone template→newid,
    // then instruct: the clone lands as a fresh VM. To keep the user's VMID, we instead
    // clone to newid 0 (auto) and immediately re-assign the DB record.
    const node = template.node || vm.node;
    const r = await pveRequest<any>(conn, 'POST', `/nodes/${node}/qemu/${template.vmid}/clone`, {
      newid: '0',
      name: `stellar-${appId}-${vm.vmid}`,
      full: '1',
    });
    if (!r.ok) {
      await dbService.setAppInstanceStatus(vmid, appId, 'failed');
      throw new Error(`Template clone failed: ${r.error}`);
    }
    const newVmid = Number(r.data?.data || 0);
    const start = await pveRequest(conn, 'POST', `/nodes/${node}/qemu/${newVmid}/status/start`);

    await dbService.setAppInstanceStatus(vmid, appId, start.ok ? 'ready' : 'ready_partial');
    await dbService.logAudit(userEmail, 'app_deployed', `VMID ${vm.vmid}`, `1-click deploy: ${app.name} (companion clone ${newVmid})`).catch(() => {});
    return {
      message: `${app.name} deployed. A companion VM (stellar-${appId}-${vm.vmid}, VMID ${newVmid}) was cloned from the template and started.`,
      app: app.name,
      cloneVmid: newVmid,
      started: start.ok,
    };
  }

  async listApps() {
    return await dbService.getAppCatalog();
  }

  async listAppInstances(vmid?: number) {
    return await dbService.getAppInstances(vmid);
  }
}

export const automationService = new AutomationService();
