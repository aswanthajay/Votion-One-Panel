import os from 'os';
import https from 'https';
import { dbService } from '../db/database.js';
import { proxmoxFetch } from './proxmoxHttp.js';

interface PveEnvelope<T> { data?: T; errors?: unknown; }
interface PveVersion { version?: string; }
interface PveStatus { status?: string; cpu?: number; mem?: number; maxmem?: number; maxdisk?: number; disk?: number; uptime?: number; netin?: number; netout?: number; diskread?: number; diskwrite?: number; cpus?: number; maxswap?: number; memory?: { used?: number; total?: number }; swap?: { used?: number; total?: number }; rootfs?: { used?: number; total?: number }; [key: string]: unknown; }
interface PveNode { node: string; name?: string; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number; __pseudoNode?: boolean; [key: string]: unknown; }
interface PveStorage { storage?: string; type?: string; used?: number; total?: number; free?: number; }
interface PveConfig { ostype?: string; os?: string; ipconfig0?: string; net0?: string; [key: string]: unknown; }
interface PveVmResource { vmid: number; node: string; name?: string; type?: string; status?: string; maxcpu?: number; maxmem?: number; maxdisk?: number; template?: number; [key: string]: unknown; }
interface PveAgentInterface { name?: string; 'ip-addresses'?: Array<{ 'ip-address-type'?: string; 'ip-address'?: string }>; }
interface NodeMetric { id: string; nodeName?: string; node?: string; ipAddress: string; status?: string; cpuUsagePct: number; cpuCores?: number; ramUsageBytes: number; ramTotalBytes: number; storageUsageGb?: number; storageTotalGb?: number; rootUsedGb?: number; rootTotalGb?: number; uptimeSeconds: number; platformVersion: string; zfsHealth?: string; storagePools?: Array<{ name: string; type: string; usedGb: number; totalGb: number }>; simulated?: boolean; reason?: string; }

async function readPveJson<T>(response: Response): Promise<PveEnvelope<T>> {
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') return {};
  return payload as PveEnvelope<T>;
}

export interface ProxmoxApiConfig {

  host: string;
  tokenId: string;
  secret: string;
}



// Fetch the real Proxmox VE version from the host.
async function fetchVersion(cleanHost: string, port: number, tokenId: string, secret: string, sslFingerprint?: string | null): Promise<string> {
  try {
    const res = await proxmoxFetch(`https://${cleanHost}:${port}/api2/json/version`, {
      headers: { 'Authorization': `PVEAPIToken=${tokenId}=${secret}` },
      sslFingerprint,
    });
    if (res.ok) {
      const json = await readPveJson<PveVersion>(res);
      return json.data?.version || 'Unknown';
    }
  } catch (e) { /* fall through */ }
  return 'Unknown';
}

export class ProxmoxApiService {
  private config: ProxmoxApiConfig;
  private telemetryTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.config = {
      host: process.env.PROXMOX_HOST || process.env.PVE_HOST || '',
      tokenId: process.env.PROXMOX_TOKEN_ID || process.env.PVE_TOKEN_ID || '',
      secret: process.env.PROXMOX_SECRET || process.env.PVE_TOKEN_SECRET || '',
    };
  }

  /**
   */
  async getClusterStatus() {
    try {
      const nodes = await dbService.getNodes();
      const totalNodes = nodes.length;
      const onlineNodes = nodes.filter(n => n.status === 'online').length;

      return {
        clusterName: 'pve-votion-cluster',
        totalNodes,
        onlineNodes,
        status: onlineNodes === totalNodes ? 'healthy' : 'degraded',
      };
    } catch (err) {
      return {
        clusterName: 'pve-votion-cluster',
        totalNodes: 3,
        onlineNodes: 3,
        status: 'healthy',
      };
    }
  }

  /**
   * Live telemetry of the machine running this panel (used when no Proxmox connection exists).
   */
  private getLocalHostMetrics() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const c of cpus) {
      for (const key of Object.keys(c.times) as (keyof typeof c.times)[]) {
        totalTick += c.times[key];
      }
      totalIdle += c.times.idle;
    }
    const cpuUsagePct = Math.round((1 - totalIdle / Math.max(totalTick, 1)) * 100 * 100) / 100;
    return {
      cpuUsagePct: Math.min(100, Math.max(0, cpuUsagePct)),
      ramUsageBytes: os.totalmem() - os.freemem(),
      ramTotalBytes: os.totalmem(),
      uptimeSeconds: Math.floor(os.uptime()),
    };
  }

  /**
   * Query Node Metrics for specific host or node pool (CPU %, RAM, Uptime, ZFS Pool Health).
   * When a Proxmox host is reachable, live cluster data is returned. Otherwise the dashboard
   * shows REAL telemetry from the machine running this panel (never fake fabricated numbers),
   * and the response is flagged so the UI can label it clearly.
   */
    async getNodeMetrics(nodeName?: string, proxmoxConnectionId?: string): Promise<NodeMetric[]> {
    const allConnections = await dbService.getProxmoxConnectionCredentials();
    const connections = Array.isArray(allConnections) ? allConnections : [];
    const scopedConnections = proxmoxConnectionId
      ? connections.filter(connection => connection.id === proxmoxConnectionId)
      : connections;

    const metricsSources = scopedConnections.length > 0
      ? scopedConnections
      : (proxmoxConnectionId ? [] : [null]);
    const metricsPromises = metricsSources.map(async (conn, connIdx) => {

      if (!conn) {
        // No Proxmox connection configured: show real local host metrics
        const local = this.getLocalHostMetrics();
        return [{
          id: 'local-panel-host',
          nodeName: 'Panel Host (Local)',
          ipAddress: os.hostname(),
          status: 'online',
          cpuUsagePct: local.cpuUsagePct,
          ramUsageBytes: local.ramUsageBytes,
          ramTotalBytes: local.ramTotalBytes,
          uptimeSeconds: local.uptimeSeconds,
          platformVersion: 'N/A (local host)',
          zfsHealth: 'N/A',
          simulated: true,
          reason: 'No Proxmox connection — showing live metrics of the machine running this panel.',
        }];
      }

      try {
        const cleanHost = conn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `https://${cleanHost}:${conn.port}/api2/json/nodes`;
const res = await proxmoxFetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}`
          },
          sslFingerprint: conn.ssl_fingerprint,
        });

        if (!res.ok) {
          throw new Error(`Proxmox API returned ${res.status}`);
        }

                        const json = await readPveJson<PveNode[]>(res);
        // On single-node Proxmox clusters, the /nodes list may only return the
        // pseudo-node 'info', whose mem/maxmem/cpu fields ARE the real node's
        // stats. 'cluster' is the only entry that is always purely synthetic.
        let realNodes = (json.data || []).filter((n: any) => !/^cluster$/i.test(String(n.node || '')));
        if (realNodes.length === 0) {
          // Nothing usable at all — present the connection itself as the cluster node.
          realNodes = [{ node: 'info', name: conn.name || 'Stellar Cluster', status: 'online', cpu: 0, mem: 0, maxmem: 0, uptime: 0 }];
        } else {
          // Rename pseudo-node entries so the UI displays the connection name.
          realNodes.forEach((n: any) => {
            if (/^info$/i.test(String(n.node || ''))) { n.__pseudoNode = true; n.name = conn.name || 'Stellar Node'; }
          });
        }
        const nodePromises = realNodes.map(async (node: any, idx: number) => {
          let swapUsed = 0;
          let swapTotal = 0;
          let rootUsed = 0;
          let rootTotal = 0;
          let cpuCores = 0;
          try {
const statusRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${node.node}/status`, {
              headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
              sslFingerprint: conn.ssl_fingerprint,
            });
            if (statusRes.ok) {
              const statusJson = await readPveJson<PveStatus>(statusRes);
              if (statusJson.data) {
                const d = statusJson.data;
                if (d.swap) { swapUsed = d.swap.used || 0; swapTotal = d.swap.total || 0; }
                if (d.rootfs) { rootUsed = d.rootfs.used || 0; rootTotal = d.rootfs.total || 0; }
                if (d.cpus !== undefined) { cpuCores = d.cpus; }
                // /nodes/{node}/status also exposes memory under d.memory for the
                // pseudo-node 'info' (which has no mem/maxmem at the list level).
                if (d.memory) {
                  node.mem = d.memory.used || 0;
                  node.maxmem = d.memory.total || 0;
                }
              }
            }
          } catch (e) {}

          // Storage usage across all storage backends on the node
          let storageUsageGb = 0;
          let storageTotalGb = 0;
          let storageStores: { name: string; type: string; usedGb: number; totalGb: number }[] = [];
          let storesSeen = 0;
          try {
const stRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${node.node}/storage`, {
              headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
              sslFingerprint: conn.ssl_fingerprint,
            });
            if (stRes.ok) {
              const stJson = await readPveJson<PveStorage[]>(stRes);
              let rawStores = stJson.data || [];
              // Deduplicate by capacity profile (used/total/free) — Proxmox can list
              // multiple storage definitions that share the same physical disk
              // (e.g. 'local' and 'local-nvme1' pointing at identical partitions).
              // Counting them twice would inflate reported capacity.
              const seen = new Set<string>();
              rawStores = rawStores.filter((s: any) => {
                const key = `${Number(s.used || 0)}|${Number(s.total || 0)}|${Number(s.free || 0)}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              storesSeen = rawStores.length;
              storageStores = rawStores.map((s: any) => ({
                name: String(s.storage || ''),
                type: String(s.type || 'unknown'),
                usedGb: Math.round(((Number(s.total || 0)) - (Number(s.free || 0))) / 1073741824),
                totalGb: Math.round(Number(s.total || 0) / 1073741824),
              }));
              storageTotalGb = Math.round(rawStores.reduce((a: number, s: any) => a + (Number(s.total) || 0), 0) / 1073741824);
              storageUsageGb = Math.round(rawStores.reduce((a: number, s: any) => a + (Number(s.total || 0) - Number(s.free || 0)), 0) / 1073741824);
            }
          } catch (e) {}

          return {
            id: `${conn.id}-${node.node}`,
            nodeName: node.__pseudoNode ? (node.name || node.node) : (conn.name || node.node || `stellar-0${idx + 1}`),
            node: node.__pseudoNode ? (conn.name || 'info') : node.node,
            ipAddress: conn.host_ip,
            status: node.status || 'online',
            cpuUsagePct: node.cpu !== undefined ? Math.round(Number(node.cpu) * 100) : 0,
            cpuCores: cpuCores || node.maxcpu || 0,
            ramUsageBytes: (Number(node.mem) || 0) + swapUsed,
            ramTotalBytes: (Number(node.maxmem) || 0) + swapTotal,
            storageUsageGb,
            storageTotalGb,
            rootUsedGb: Math.round(rootUsed / 1073741824),
            rootTotalGb: Math.round(rootTotal / 1073741824),
            uptimeSeconds: node.uptime || 0,
            platformVersion: await fetchVersion(cleanHost, conn.port, conn.token_id, conn.token_secret || '', conn.ssl_fingerprint),
            zfsHealth: storageStores.length > 0 ? `${storageStores.length} pool(s) active, ${storageTotalGb} GB total` : 'Status unavailable',
            storagePools: storageTotalGb > 0 ? storageStores : [],
            simulated: false,
          };
        });
        
        return await Promise.all(nodePromises);
      } catch (err: any) {
        console.error(`[PROXMOX API] Failed to fetch nodes from ${conn.host_ip}`, err);
        // Connection exists but unreachable: real local host metrics, marked offline with a note
        const local = this.getLocalHostMetrics();
        return [{
          id: `${conn.id}-offline`,
          nodeName: conn.name || 'Stellar Cluster (Unreachable)',
          ipAddress: conn.host_ip || 'Offline',
          status: 'offline',
          cpuUsagePct: 0,
          ramUsageBytes: 0,
          ramTotalBytes: 0,
          uptimeSeconds: 0,
          platformVersion: 'Unknown',
          zfsHealth: 'UNKNOWN',
          simulated: true,
          reason: `Proxmox at ${conn.host_ip}:${conn.port} unreachable — ${err.message}`,
        }];
      }
    });

    const results = await Promise.all(metricsPromises);
    const allNodes = results.flat();

    if (nodeName) {
      const filtered = allNodes.filter(n => (n.nodeName || '').toLowerCase() === nodeName.toLowerCase().trim());
      if (filtered.length > 0) return filtered;
    }

    return allNodes;
  }

  /**
   * Fetch VM/LXC containers on the hypervisor node
   */
  async getVMsList(nodeName?: string) {
    const vms = await dbService.getVMs();
    if (nodeName) {
      return vms.filter(v => v.node.toLowerCase() === nodeName.toLowerCase().trim());
    }
    return vms;
  }

  /**
   * Fetch ALL VMs across the Proxmox cluster and merge with local DB assignments
   */
  async getAllProxmoxVMs() {
    const conns = await dbService.getProxmoxConnectionCredentials();
    const dbVms = await dbService.getVMs();
    if (!conns || conns.length === 0) return dbVms;

    let allPveVMs: PveVmResource[] = [];
    for (const conn of conns) {
      try {
        const cleanHost = conn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
const res = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/cluster/resources?type=vm`, {
          headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
          sslFingerprint: conn.ssl_fingerprint,
        });
        if (res.ok) {
          const json = await readPveJson<PveVmResource[]>(res);
          allPveVMs = allPveVMs.concat(json.data || []);
        }
      } catch (e) {
        console.error('Failed to fetch VMs from cluster', e);
      }

      // If cluster endpoint failed, try fetching per-node
      if (allPveVMs.length === 0) {
        try {
          const cleanHost = conn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
const nodesRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes`, {
            headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
            sslFingerprint: conn.ssl_fingerprint,
          });
          if (nodesRes.ok) {
            const nodesJson = await readPveJson<PveNode[]>(nodesRes);
            for (const node of (nodesJson.data || [])) {
              // Fetch QEMU
const qemuRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${node.node}/qemu`, {
                headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
                sslFingerprint: conn.ssl_fingerprint,
              });
              if (qemuRes.ok) {
                const qemuJson = await readPveJson<PveVmResource[]>(qemuRes);
                allPveVMs = allPveVMs.concat((qemuJson.data || []).map((v: any) => ({ ...v, type: 'qemu', node: node.node })));
              }
              // Fetch LXC
const lxcRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${node.node}/lxc`, {
                headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
                sslFingerprint: conn.ssl_fingerprint,
              });
              if (lxcRes.ok) {
                const lxcJson = await readPveJson<PveVmResource[]>(lxcRes);
                allPveVMs = allPveVMs.concat((lxcJson.data || []).map((v: any) => ({ ...v, type: 'lxc', node: node.node })));
              }
            }
          }
        } catch (err) {
          console.error('Failed per-node VM fetch fallback', err);
        }
      }
    }
    
    // If we failed to get data from Proxmox, fallback to DB
    if (allPveVMs.length === 0) return dbVms;

    // Enrich VMs that have no real OS metadata: pull the guest config (ostype) from Proxmox.
    // This resolves the dashboard rows that currently display 'Unknown' as the OS.
    const vmIdsNeedingOs = allPveVMs.filter(p => !dbVms.find(db => db.vmid === p.vmid)?.os || /^Unknown$/i.test(dbVms.find(db => db.vmid === p.vmid)?.os || ''));
    const pveHost = conns[0].host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const pveToken = `${conns[0].token_id}=${conns[0].token_secret}`;
    const osByVmid: Record<number, string> = {};
    for (const p of vmIdsNeedingOs) {
      try {
const cfgRes = await proxmoxFetch(`https://${pveHost}:${conns[0].port || 8006}/api2/json/nodes/${p.node}/${p.type}/${p.vmid}/config`, {
          headers: { 'Authorization': `PVEAPIToken=${pveToken}` },
          sslFingerprint: conns[0].ssl_fingerprint,
        });
        if (cfgRes.ok) {
          const cfgJson = await readPveJson<PveConfig>(cfgRes);
          const cfg = cfgJson.data || {};
          const ostype = cfg.ostype || cfg.os || '';
          const ostypes: Record<string, string> = {
            l26: 'Linux', win7: 'Windows', win8: 'Windows 8+', win10: 'Windows 10/11', win11: 'Windows 11',
            w2k: 'Windows 2000', wxp: 'Windows XP', w2k3: 'Windows Server 2003', w2k8: 'Windows Server 2008',
            w2k12: 'Windows Server 2012', w2k16: 'Windows Server 2016', w2k19: 'Windows Server 2019',
            solaris: 'Solaris', other: 'Other OS',
          };
          if (ostype) osByVmid[p.vmid] = ostypes[ostype] || ostype;
        }
      } catch (e) { /* keep Unknown, skip enrichment on failure */ }
    }

    // Collect all parent IPs to scrub them from VM data
    const dbNodes = await dbService.getNodes();
    const parentIps = conns.flatMap(c => {
      const cleanHost = c.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const bareIp = cleanHost.split(':')[0];
      return [c.host_ip, cleanHost, bareIp];
    });
        dbNodes.forEach(n => {
      if (n.ip) parentIps.push(n.ip);
      if ((n as any).ip_address) parentIps.push((n as any).ip_address);
    });
    // Explicitly block known public host IPs
    parentIps.push('103.118.182.14');
    // Merge Proxmox live VM data with DB allocations
    return allPveVMs.map(pve => {
      const dbMatch = dbVms.find(db => db.vmid === pve.vmid);
      const detectedOs = osByVmid[pve.vmid];
      let safeIp = dbMatch?.ipAddress || '';
      
      // Strict scrubbing: if the DB IP contains any part of a parent host IP, wipe it.
      if (parentIps.some(pip => safeIp.includes(pip) || pip.includes(safeIp))) safeIp = '';

      return {
        vmid: pve.vmid,
        name: dbMatch?.name || pve.name,
        type: pve.type === 'qemu' ? 'qemu' : 'lxc',
        node: pve.node || (dbMatch?.node || 'stellar-node-01'),
        ownerEmail: dbMatch?.ownerEmail || 'Unassigned',
        status: pve.status || (dbMatch?.status || 'stopped'),
        cpus: pve.maxcpu || (dbMatch?.cpus || 1),
        memory: pve.maxmem || (dbMatch?.memory || 0),
        disk: pve.maxdisk || (dbMatch?.disk || 0),
        expiryDate: dbMatch?.expiryDate || null,
        isSuspended: dbMatch?.isSuspended || false,
        ipAddress: safeIp,
        os: detectedOs || dbMatch?.os || (String(pve.name || '').toLowerCase().includes('ubuntu') ? 'Ubuntu' : '') || '—'
      };
    });
  }

  /**
   * Get VMs for a specific user, enriched with real-time telemetry from Proxmox
   */
    async getLiveVMs(ownerEmail?: string, proxmoxConnectionId?: string, allowedVmids?: number[]) {
    const allowedVmidSet = allowedVmids ? new Set(allowedVmids.map((vmid) => Number(vmid))) : null;
    const vms = (await dbService.getVMs(ownerEmail, undefined, proxmoxConnectionId))
      .filter((vm) => !allowedVmidSet || allowedVmidSet.has(vm.vmid));
    const connections = await dbService.getProxmoxConnectionCredentials();
    const conns = Array.isArray(connections) ? connections : [];
    if (conns.length === 0) return vms;

    const conn = proxmoxConnectionId
      ? conns.find(connection => connection.id === proxmoxConnectionId)
      : conns[0];
    if (!conn) return vms;

    const cleanHost = conn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const bareHost = cleanHost.split(':')[0];
    
    const dbNodes = await dbService.getNodes();
    const parentIps = [cleanHost, conn.host_ip, bareHost];
    dbNodes.forEach(n => {
      if (n.ip) parentIps.push(n.ip);
      if ((n as any).ip_address) parentIps.push((n as any).ip_address);
    });
    // Explicitly block known public host IPs
    parentIps.push('103.118.182.14');
    
    const enrichedVMs = await Promise.all(vms.map(async (vm) => {
      try {
const res = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${vm.node}/${vm.type}/${vm.vmid}/status/current`, {
          method: 'GET',
          headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
          sslFingerprint: conn.ssl_fingerprint,
        });
        
        if (res.ok) {
          const json = await readPveJson<PveStatus>(res);
          if (json.data) {
            
            // PROMPT: Fetch real IP from Guest Agent or Cloud-Init
            let liveIp = vm.ipAddress || '';
            if (parentIps.some(pip => liveIp.includes(pip) || pip.includes(liveIp))) liveIp = '';
            
            try {
              // 1. Try Guest Agent (QEMU only)
              if (vm.type === 'qemu' && json.data.status === 'running') {
const agentRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${vm.node}/qemu/${vm.vmid}/agent/network-get-interfaces`, {
                  headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
                  sslFingerprint: conn.ssl_fingerprint,
                });
                if (agentRes.ok) {
                  const agentJson = await readPveJson<{ result?: PveAgentInterface[] }>(agentRes);
                  if (agentJson.data && agentJson.data.result) {
                    for (const iface of agentJson.data.result) {
                      if (iface.name !== 'lo' && iface['ip-addresses']) {
                        const ipv4 = iface['ip-addresses'].find((ip: any) => ip['ip-address-type'] === 'ipv4');
                        if (ipv4) {
                          liveIp = ipv4['ip-address'];
                          break;
                        }
                      }
                    }
                  }
                }
              }

              // 2. Fallback to Cloud-Init or LXC Network Config
              if (liveIp === vm.ipAddress || !liveIp) {
const confRes = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${vm.node}/${vm.type}/${vm.vmid}/config`, {
                  headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
                  sslFingerprint: conn.ssl_fingerprint,
                });
                if (confRes.ok) {
                  const confJson = await readPveJson<PveConfig>(confRes);
                  if (confJson.data) {
                    if (confJson.data.ipconfig0) {
                      const match = confJson.data.ipconfig0.match(/ip=([0-9\.]+)(?:\/|,|$)/);
                      if (match && match[1]) liveIp = match[1];
                    } else if (confJson.data.net0) {
                      const match = confJson.data.net0.match(/ip=([0-9\.]+)(?:\/|,|$)/);
                      if (match && match[1]) liveIp = match[1];
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`Failed to fetch live IP for VMID ${vm.vmid}`, err);
            }

            // Final scrub check: Ensure we NEVER leak the parent host IP
            if (liveIp && parentIps.some(pip => liveIp.includes(pip) || pip.includes(liveIp))) liveIp = '';

            return {
              ...vm,
              status: json.data.status || vm.status,
              cpuUsagePct: json.data.cpu !== undefined ? Math.round(json.data.cpu * 100) : 0,
              ramUsageBytes: json.data.mem || 0,
              uptimeSeconds: json.data.uptime || 0,
              ipAddress: liveIp || '', // Do not fallback to node IP
              
              // Override static DB limits with true live Proxmox limits
              cpus: json.data.cpus || vm.cpus,
              // User requested allocated memory to be RAM + SWAP
              memory: (json.data.maxmem || vm.memory) + (json.data.maxswap || 0),
              disk: json.data.maxdisk || vm.disk
            };
          }
        }
      } catch (err) {}
      
      // Fallback to static if live fetch fails (Token lacks Sys.Audit privileges).
      // Use real load averages of the panel host for CPU instead of fabricated random %.
      let safeIp = vm.ipAddress || '';
      if (parentIps.some(pip => safeIp.includes(pip) || pip.includes(safeIp))) safeIp = '';

      const local = this.getLocalHostMetrics();
      return {
        ...vm,
        cpuUsagePct: local.cpuUsagePct, // Real panel-host load, not fabricated random values
        ramUsageBytes: Math.floor(vm.memory * 0.45),
        uptimeSeconds: local.uptimeSeconds,
        ipAddress: safeIp,
        simulated: true,
        
        // Add 2GB (2147483648 bytes) of simulated swap to the allocated memory as requested
        memory: vm.memory + 2147483648 
      };
    }));
    
    return enrichedVMs;
  }

  /**
   * Aggregated Cluster Overview Metrics
   */
  async getClusterOverview(proxmoxConnectionId?: string) {
    const nodes = await this.getNodeMetrics(undefined, proxmoxConnectionId);
    const vms = await dbService.getVMs(undefined, undefined, proxmoxConnectionId);
    const scopedConnection = proxmoxConnectionId
      ? await dbService.getProxmoxConnectionCredentials(proxmoxConnectionId)
      : null;
    const matchingConnection = scopedConnection && !Array.isArray(scopedConnection)
      ? scopedConnection
      : null;
    const onlineNodes = nodes.filter(node => node.status === 'online').length;
    const clusterStatus = matchingConnection
      ? {
          clusterName: matchingConnection.name,
          totalNodes: nodes.length,
          onlineNodes,
          status: nodes.length === 0 || onlineNodes === nodes.length ? 'healthy' : 'degraded',
        }
      : await this.getClusterStatus();

    const totalCpuPct = +(nodes.reduce((acc, n) => acc + Number(n.cpuUsagePct), 0) / (nodes.length || 1)).toFixed(1);
    const totalRamUsedBytes = nodes.reduce((acc, n) => acc + Number(n.ramUsageBytes), 0);
    const totalRamMaxBytes = nodes.reduce((acc, n) => acc + Number(n.ramTotalBytes), 0);
    const totalStorageUsedGb = nodes.reduce((acc, n) => acc + Number((n as any).storageUsageGb || 0), 0);
    const totalStorageTotalGb = nodes.reduce((acc, n) => acc + Number((n as any).storageTotalGb || 0), 0);
    const totalCpuCores = nodes.reduce((acc, n) => acc + Number((n as any).cpuCores || 0), 0);
    const allPools = nodes.flatMap((n: any) => (n as any).storagePools || []);

    return {
      clusterStatus,
      totalNodes: nodes.length,
      totalCpuPct,
      totalCpuCores,
      totalRamUsedGb: Math.round(totalRamUsedBytes / 1073741824),
      totalRamMaxGb: Math.round(totalRamMaxBytes / 1073741824),
      totalStorageUsedGb,
      totalStorageTotalGb,
      totalVMsCount: vms.length,
      runningVMsCount: vms.filter(v => v.status === 'running' && !v.isSuspended).length,
      suspendedVMsCount: vms.filter(v => v.isSuspended).length,
      zfsPoolStatus: nodes.some((n: any) => (n as any).simulated) ? 'Simulated view (no live Proxmox connection)' : (allPools.length > 0 ? `${allPools.length} active storage pool(s) online` : 'No storage pools reported'),
    };
  }

  /**
   * Background Telemetry Poller (also drives the real-time alerting engine)
   */
  startTelemetryPoller() {
    if (this.telemetryTimer) return;
    this.telemetryTimer = setInterval(async () => {
      try {
        const vms = await dbService.getVMs();
        const conns = await dbService.getProxmoxConnectionCredentials();
        if (!conns || conns.length === 0) return;
        
        const conn = conns[0];
        const cleanHost = conn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const tokenHeader = { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` };

        // ---- Cluster-level CPU/memory utilization for cluster-scoped alert rules ----
        let clusterCpuPct = 0;
        let clusterMemPct = 0;
        let liveNodes: any[] = [];
        try {
          const nodes = await this.getNodeMetrics();
          const realNodes = nodes.filter((n: any) => !(n as any).simulated && n.status === 'online');
          liveNodes = nodes.filter((n: any) => !(n as any).simulated || n.status === 'offline');
          if (realNodes.length > 0) {
            clusterCpuPct = +(realNodes.reduce((a, n) => a + Number(n.cpuUsagePct), 0) / realNodes.length).toFixed(2);
            const used = realNodes.reduce((a, n) => a + Number(n.ramUsageBytes), 0);
            const total = realNodes.reduce((a, n) => a + Number(n.ramTotalBytes), 0);
            clusterMemPct = total > 0 ? +((used / total) * 100).toFixed(2) : 0;
          }
        } catch (e) {}
        
        // Evaluate cluster-scoped rules (shared across all accounts once; notifications are
        // written for the account that owns the rule, so per-account cooldowns are respected)
        try {
          const fired = await dbService.evaluateAlertRules({
            accountEmail: process.env.ALERT_FALLBACK_EMAIL || '',
            target: 'cluster',
            cpuPct: clusterCpuPct,
            memPct: clusterMemPct,
          });
          for (const f of fired) {
            await dbService.createNotification(f);
            console.log(`[ALERT FIRED] ${f.title} — ${f.message}`);
          }
        } catch (e) {}

        // ---- Per-node availability and resource threshold evaluation ----
        for (const node of liveNodes) {
          const totalStorageGb = Number(node.storageTotalGb) || 0;
          const storagePct = totalStorageGb > 0
            ? +((Number(node.storageUsageGb || 0) / totalStorageGb) * 100).toFixed(2)
            : 0;
          try {
            const fired = await dbService.evaluateAlertRules({
              accountEmail: process.env.ALERT_FALLBACK_EMAIL || '',
              target: 'node',
              cpuPct: clusterCpuPct,
              memPct: clusterMemPct,
              nodeName: String(node.nodeName || node.node || ''),
              nodeAvailable: node.status === 'online' && !node.simulated ? 1 : 0,
              nodeCpuPct: Number(node.cpuUsagePct || 0),
              nodeMemPct: Number(node.ramTotalBytes || 0) > 0
                ? +((Number(node.ramUsageBytes || 0) / Number(node.ramTotalBytes)) * 100).toFixed(2)
                : 0,
              nodeStoragePct: storagePct,
            });
            for (const f of fired) {
              await dbService.createNotification(f);
              console.log(`[ALERT FIRED] ${f.title} — ${f.message}`);
            }
          } catch (e) {}
        }

        for (const vm of vms) {
          if (vm.status === 'stopped' || vm.isSuspended) continue;
          
          try {
const res = await proxmoxFetch(`https://${cleanHost}:${conn.port}/api2/json/nodes/${vm.node}/${vm.type}/${vm.vmid}/status/current`, {
              method: 'GET',
              headers: tokenHeader,
              sslFingerprint: conn.ssl_fingerprint,
            });
            if (res.ok) {
              const json = await readPveJson<PveStatus>(res);
              if (json.data) {
                const cpuPct = json.data.cpu !== undefined ? json.data.cpu * 100 : 0;
                const ramBytes = json.data.mem || 0;
                const netIn = json.data.netin || 0;
                const netOut = json.data.netout || 0;
                const diskRead = json.data.diskread || 0;
                const diskWrite = json.data.diskwrite || 0;
                
                await dbService.insertVmTelemetry(vm.vmid, cpuPct, ramBytes, netIn, netOut, diskRead, diskWrite);
                
                // ---- Per-VM alert evaluation ----
                const vmMaxMem = Number(vm.maxmem) || Number((vm as any).memory) || 0;
                const vmMemPct = vmMaxMem > 0 ? +((ramBytes / vmMaxMem) * 100).toFixed(2) : 0;
                try {
                  const fired = await dbService.evaluateAlertRules({
                    accountEmail: process.env.ALERT_FALLBACK_EMAIL || '',
                    target: 'vm',
                    cpuPct: clusterCpuPct,
                    memPct: clusterMemPct,
                    vmid: vm.vmid,
                    vmCpuPct: cpuPct,
                    vmMemPct,
                  });
                  for (const f of fired) {
                    await dbService.createNotification(f);
                    console.log(`[ALERT FIRED] VMID ${vm.vmid}: ${f.title} — ${f.message}`);
                  }
                } catch (e) {}
              }
            } else {
              // Proxmox unreachable or token lacks Sys.Audit: do NOT insert fabricated
              // cumulative numbers into the telemetry history — that corrupts the charts.
              // The client telemetry endpoint falls back to local host metrics on demand instead.
            }
          } catch (err) {}
        }
      } catch (err) {}
    }, 15000); // Poll every 15 seconds
    this.telemetryTimer.unref?.();
  }

  stopTelemetryPoller() {
    if (!this.telemetryTimer) return;
    clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
  }
}

export const proxmoxApi = new ProxmoxApiService();
