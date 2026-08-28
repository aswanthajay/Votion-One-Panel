/**
 * Admin VM Fleet extensions — registered by routes/admin.ts.
 *
 * Adds robust, Proxmox-backed VM management for the admin panel:
 *  - GET  /nodes              → live cluster node inventory (CPU/RAM/disk per node)
 *  - GET  /vms/options        → assignment wizard options (nodes, next free VMID, accounts)
 *  - GET  /vms/:vmid/live     → live status from Proxmox merged with DB assignment
 *  - POST /vms/:vmid/action   → lifecycle (start | stop | reboot | shutdown) on Proxmox + DB audit
 *  - POST /vms/:vmid/update   → admin edit of specs (cpus, memoryGb, diskGb, name, os, ipAddress)
 *  - GET  /summary            → cluster-wide summary (nodes, VM counts, totals)
 */
import { Router, Request, Response } from 'express';
import { dbService } from './db/database.js';
import { proxmoxFetch } from './services/proxmoxHttp.js';
import { requireAuth, requireAdmin, AuthenticatedRequest } from './middleware.js';

export const adminVmFleetRouter = Router();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PveNode { node: string; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number; name?: string; }
interface PveStatus { status?: string; cpu?: number; mem?: number; maxmem?: number; maxdisk?: number; disk?: number; netin?: number; netout?: number; uptime?: number; cpus?: number; rootfs?: { used?: number; total?: number }; memory?: { used?: number; total?: number }; }
interface PveVm { vmid: number; node: string; name?: string; type?: string; status?: string; maxcpu?: number; maxmem?: number; maxdisk?: number; }
interface PveEnvelope<T> { data?: T; }

async function readPveJson<T>(response: globalThis.Response): Promise<T> {
  return await response.json() as T;
}

interface ProxmoxConn {
  id: string;
  host_ip: string;
  port?: number;
  token_id: string;
  token_secret: string | null;
  name?: string;
}

function authHeaders(conn: ProxmoxConn) {
  return { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret || ''}` };
}

function cleanHost(conn: ProxmoxConn) {
  return conn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** All connections that can reach the cluster. */
async function getConns(): Promise<ProxmoxConn[]> {
  return (await dbService.getProxmoxConnectionCredentials()) || [];
}

/** Find the VM's node and type from the live cluster (first match by vmid). */
async function locateVM(vmid: number): Promise<{ conn: ProxmoxConn; node: string; type: string } | null> {
  const conns = await getConns();
  for (const conn of conns) {
    const host = cleanHost(conn);
    const port = conn.port || 8006;
    try {
      const nodesRes = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes`, { headers: authHeaders(conn) });
      if (!nodesRes.ok) continue;
      const nodesJson = await readPveJson<PveEnvelope<PveNode[]>>(nodesRes);
      for (const node of (nodesJson.data || [])) {
        for (const t of ['qemu', 'lxc']) {
          try {
            const res = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes/${node.node}/${t}/${vmid}/status/current`, { headers: authHeaders(conn) });
            if (res.ok) return { conn, node: node.node, type: t };
          } catch (e) { /* try next */ }
        }
      }
    } catch (e) { /* next connection */ }
  }
  return null;
}

/** Get the Proxmox live status for a VM, merged with the DB assignment row. */
async function getLiveVMSnapshot(vmid: number) {
  const db = await dbService.getVMByVMID(vmid);
  let live: any = null;
  const loc = await locateVM(vmid);
  if (loc) {
    try {
      const host = cleanHost(loc.conn);
      const port = loc.conn.port || 8006;
      const res = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes/${loc.node}/${loc.type}/${vmid}/status/current`, { headers: authHeaders(loc.conn) });
      if (res.ok) {
        const json = await readPveJson<PveEnvelope<PveStatus>>(res);
        const d = json.data || {};
        live = {
          status: d.status || 'unknown',
          cpuPct: Math.round((d.cpu || 0) * 100),
          memUsedMb: Math.round((d.mem || 0) / 1048576),
          memTotalMb: Math.round((d.maxmem || 0) / 1048576),
          memPct: d.maxmem ? Math.round(((d.mem || 0) / d.maxmem) * 100) : 0,
          diskUsedGb: d.maxdisk ? Math.round(((d.disk || 0) / d.maxdisk) * 100) : 0,
          uptimeSeconds: d.uptime || 0,
          netInBytes: d.netin || 0,
          netOutBytes: d.netout || 0,
          node: loc.node,
          type: loc.type,
        };
      }
    } catch (e) { /* live unavailable; DB snapshot wins */ }
  }
  return { db, live };
}

// ---------------------------------------------------------------------------
// 1. GET /api/admin/nodes — live node inventory
// ---------------------------------------------------------------------------
adminVmFleetRouter.get('/nodes', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // Reuse the proven node-metrics path from the Proxmox service (no direct re-import
    // of the class internals needed — it's the same logic as getNodeMetrics).
    const conns = await getConns();
    const nodes: any[] = [];
    for (const conn of conns) {
      const host = cleanHost(conn);
      const port = conn.port || 8006;
      try {
        const nodesRes = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes`, { headers: authHeaders(conn) });
        if (!nodesRes.ok) continue;
        const nodesJson = await readPveJson<PveEnvelope<PveNode[]>>(nodesRes);
        for (const n of (nodesJson.data || [])) {
          let cpus = 0;
          let memUsed = 0;
          let memTotal = 0;
          let diskUsed = 0;
          let diskTotal = 0;
          try {
            const stRes = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes/${n.node}/status`, { headers: authHeaders(conn) });
            if (stRes.ok) {
              const st = (await readPveJson<PveEnvelope<PveStatus>>(stRes)).data || {};
              cpus = st.cpus || 0;
              memUsed = (st.mem as number) || (st.memory && (st.memory.used as number)) || 0;
              memTotal = (st.maxmem as number) || (st.memory && (st.memory.total as number)) || 0;
              if (st.rootfs) { diskUsed = st.rootfs.used || 0; diskTotal = st.rootfs.total || 0; }
            }
          } catch (e) { /* best effort */ }
          nodes.push({
            node: n.node,
            name: conn.name || n.node,
            status: n.status || 'online',
            cpuUsagePct: Math.round((n.cpu || 0) * 100),
            cpuCores: cpus || n.maxcpu || 0,
            ramUsedGb: Math.round(memUsed / 1073741824),
            ramTotalGb: Math.round(memTotal / 1073741824),
            diskUsedGb: Math.round(diskUsed / 1073741824),
            diskTotalGb: Math.round(diskTotal / 1073741824),
            uptimeSeconds: n.uptime || 0,
          });
        }
      } catch (e) { /* connection unreachable */ }
    }
    res.json({ success: true, count: nodes.length, data: nodes });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /api/admin/vms/options — wizard payload for the assignment flow
// ---------------------------------------------------------------------------
adminVmFleetRouter.get('/vms/options', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const conns = await getConns();
    const allVms = await dbService.getVMs();
    const accounts = await dbService.getAccounts();
    const takenVmid = new Set(allVms.map(v => v.vmid));

    // Suggest the next free VMID (Proxmox convention: start at 100, skip taken).
    let nextFreeVmid = 100;
    while (takenVmid.has(nextFreeVmid)) nextFreeVmid++;

    const nodes = conns.map(c => ({
      node: 'auto',
      name: c.name || c.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    }));

    // Discover real nodes per connection when possible (best effort, non-blocking).
    for (const conn of conns) {
      try {
        const host = cleanHost(conn);
        const port = conn.port || 8006;
        const nodesRes = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes`, { headers: authHeaders(conn) });
        if (nodesRes.ok) {
          const nodesJson = await readPveJson<PveEnvelope<PveNode[]>>(nodesRes);
          for (const n of (nodesJson.data || [])) {
            if (!nodes.some(x => x.node === n.node)) {
              nodes.push({ node: n.node, name: conn.name || n.node });
            }
          }
        }
      } catch (e) { /* keep connection name fallback */ }
    }

    res.json({
      success: true,
      data: {
        nextFreeVmid,
        takenCount: takenVmid.size,
        nodes,
        accounts: (accounts || []).map((a: any) => ({
          id: a.id,
          email: a.email,
          name: a.name,
          role: a.role,
          phone: a.phone,
          supportTier: a.support_tier,
        })),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. GET /api/admin/vms/:vmid/live — live status merged with DB assignment
// ---------------------------------------------------------------------------
adminVmFleetRouter.get('/vms/:vmid/live', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const vmid = parseInt(String(req.params.vmid), 10);
    if (!vmid) return res.status(400).json({ success: false, error: 'Invalid VMID' });
    const snapshot = await getLiveVMSnapshot(vmid);
    if (!snapshot.db) return res.status(404).json({ success: false, error: `VMID ${vmid} not found` });
    res.json({ success: true, data: { ...snapshot.db, live: snapshot.live } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. POST /api/admin/vms/:vmid/action — lifecycle (start|stop|reboot|shutdown)
// ---------------------------------------------------------------------------
adminVmFleetRouter.post('/vms/:vmid/action', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const userEmail = req.authUser!.email;
  const vmid = parseInt(String(req.params.vmid), 10);
  const { action } = req.body || {};
  const allowed = ['start', 'stop', 'reboot', 'shutdown'];
  if (!allowed.includes(action)) {
    return res.status(400).json({ success: false, error: `action must be one of ${allowed.join(', ')}` });
  }
  try {
    const db = await dbService.getVMByVMID(vmid);
    if (!db) return res.status(404).json({ success: false, error: `VMID ${vmid} not found` });

    let pveResult: { ok: boolean; message: string } = { ok: false, message: 'No Proxmox connection available' };

    if (db.isSuspended && action !== 'start') {
      return res.status(409).json({ success: false, error: `VMID ${vmid} is suspended due to billing expiry. Extend or unsuspend first.` });
    }

    // Try to execute on the real Proxmox cluster
    const loc = await locateVM(vmid);
    if (loc) {
      try {
        const host = cleanHost(loc.conn);
        const port = loc.conn.port || 8006;
        const path = `https://${host}:${port}/api2/json/nodes/${loc.node}/${loc.type}/${vmid}/status/${action}`;
        const fetchRes = await proxmoxFetch(path, { method: 'POST', headers: authHeaders(loc.conn) });
        if (fetchRes.ok) {
          pveResult = { ok: true, message: `Proxmox accepted the ${action} request` };
        } else {
          const txt = await fetchRes.text();
          pveResult = { ok: false, message: `Proxmox returned ${fetchRes.status}: ${txt.slice(0, 200)}` };
        }
      } catch (e: any) {
        pveResult = { ok: false, message: `Proxmox request failed: ${e.message}` };
      }
    }

    // Always keep the local DB status in sync (single source of truth for the panel)
    await dbService.executeVMAction(vmid, action === 'shutdown' ? 'stop' : action, userEmail);

    const updated = await dbService.getVMByVMID(vmid);
    res.json({
      success: true,
      pve: pveResult,
      message: `VMID ${vmid} ${action}${pveResult.ok ? '' : ' (local status updated; Proxmox unreachable)'} — new status: ${updated?.status || 'unknown'}`,
      data: updated,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 5. POST /api/admin/vms/:vmid/update — edit VM specs / assignment details
// ---------------------------------------------------------------------------
adminVmFleetRouter.post('/vms/:vmid/update', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const userEmail = req.authUser!.email;
  const vmid = parseInt(String(req.params.vmid), 10);
  const { name, os, ipAddress, cpus, memoryGb, diskGb, expiryDays } = req.body || {};
  try {
    const vm = await dbService.getVMByVMID(vmid);
    if (!vm) return res.status(404).json({ success: false, error: `VMID ${vmid} not found` });

    const sets: string[] = [];
    const vals: any[] = [];
    if (name !== undefined) { sets.push('vm_name = $' + (vals.length + 1)); vals.push(String(name).trim()); }
    if (os !== undefined) { sets.push('os_type = $' + (vals.length + 1)); vals.push(String(os).trim()); }
    if (ipAddress !== undefined) { sets.push('ip_address = $' + (vals.length + 1)); vals.push(String(ipAddress).trim()); }
    if (cpus !== undefined && Number(cpus) > 0) { sets.push('cpu_cores = $' + (vals.length + 1)); vals.push(Number(cpus)); sets.push('cpus = $' + (vals.length + 1)); vals.push(Number(cpus)); }
    if (memoryGb !== undefined && Number(memoryGb) > 0) { sets.push('ram_mb = $' + (vals.length + 1)); vals.push(Number(memoryGb) * 1024); sets.push('memory = $' + (vals.length + 1)); vals.push(Number(memoryGb) * 1073741824); }
    if (diskGb !== undefined && Number(diskGb) > 0) { sets.push('disk_gb = $' + (vals.length + 1)); vals.push(Number(diskGb)); sets.push('disk = $' + (vals.length + 1)); vals.push(Number(diskGb) * 1073741824); }
    if (expiryDays !== undefined && Number(expiryDays) > 0) {
      const vm = await dbService.getVMByVMID(vmid);
      const base = vm && vm.expiryDate && new Date(vm.expiryDate) > new Date() ? new Date(vm.expiryDate) : new Date();
      sets.push('expiry_date = $' + (vals.length + 1)); vals.push(new Date(base.getTime() + Number(expiryDays) * 86400000).toISOString());
    }

    if (sets.length > 0) {
      vals.push(vmid);
      const { pgPool } = await import('./db/database.js');
      await pgPool.query(`UPDATE vms SET ${sets.join(', ')} WHERE vmid = $${vals.length}`, vals);
      await dbService.logAudit(userEmail, 'UPDATE_VM', `VMID ${vmid}`, `Updated: ${Object.keys(req.body || {}).join(', ')}`);
    }
    res.json({ success: true, message: `VMID ${vmid} updated`, data: await dbService.getVMByVMID(vmid) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 6. GET /api/admin/summary — cluster-wide summary for the admin dashboard
// ---------------------------------------------------------------------------
adminVmFleetRouter.get('/summary', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const allVms = await dbService.getVMs();
    const conns = await getConns();
    let totalRamGb = 0;
    let totalDiskGb = 0;
    let totalCpus = 0;
    const byStatus: Record<string, number> = {};
    for (const v of allVms) {
      const s = v.isSuspended ? 'suspended' : (v.status || 'unknown');
      byStatus[s] = (byStatus[s] || 0) + 1;
      totalRamGb += (v.memory ? Math.round(v.memory / 1073741824) : 8);
      totalDiskGb += (v.disk ? Math.round(v.disk / 1073741824) : 64);
      totalCpus += v.cpus || 4;
    }
    // Cluster capacity per connected node (best effort, non-blocking) — used by the
    // fleet summary allocation chart. Skipped if a connection is unreachable.
    const nodeCapacity: { name: string; node: string; cpuCores: number; ramTotalGb: number; vms: number }[] = [];
    for (const conn of conns) {
      try {
        const host = cleanHost(conn);
        const port = conn.port || 8006;
        const nodesRes = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes`, { headers: authHeaders(conn) });
        if (!nodesRes.ok) continue;
        const nodePayload = await readPveJson<PveEnvelope<PveNode[]>>(nodesRes);
        for (const n of nodePayload.data || []) {
          const cpus = n.maxcpu || 0;
          let memTotal = 0;
          try {
            const stRes = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes/${n.node}/status`, { headers: authHeaders(conn) });
            if (stRes.ok) {
              const st = (await readPveJson<PveEnvelope<PveStatus>>(stRes)).data || {};
              // This cluster's API reports RAM under memory.total rather than maxmem.
              memTotal = (st.maxmem as number) || (st.memory && (st.memory.total as number)) || 0;
            }
          } catch (e) { /* best effort */ }
          nodeCapacity.push({
            name: conn.name || n.node,
            node: n.node,
            cpuCores: cpus || (n.maxcpu || 0),
            ramTotalGb: Math.round(memTotal / 1073741824),
            vms: allVms.filter(v => v.node === n.node).length,
          });
        }
      } catch (e) { /* keep the loop going */ }
    }
    // Fallback: when live capacity can't be read, derive totals from allocations
    if (nodeCapacity.length === 0 && conns.length > 0) {
      nodeCapacity.push({ name: conns[0].name || 'Engine', node: 'auto', cpuCores: totalCpus, ramTotalGb: totalRamGb, vms: allVms.length });
    }

    res.json({
      success: true,
      data: {
        totalVms: allVms.length,
        totalNodes: conns.length,
        totalCpus,
        totalRamGb,
        totalDiskGb,
        byStatus,
        unassigned: allVms.filter(v => /^unassigned@/i.test(v.ownerEmail || '')).length,
        nodeCapacity,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
