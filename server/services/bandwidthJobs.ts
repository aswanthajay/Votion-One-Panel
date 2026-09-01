import { dbService } from '../db/database.js';
import { queryDb } from '../db/db.js';
import { proxmoxFetch } from './proxmoxHttp.js';
import { updateVMNetworkRateLimit } from './proxmox.js';

let usageInterval: NodeJS.Timeout;
let limitInterval: NodeJS.Timeout;

async function syncUsages() {
  try {
    const vms = await queryDb('SELECT vmid, node, node_id, type, bandwidth_usage FROM vms');
    
    // Process VMs sequentially to avoid overwhelming Proxmox API (Convoy behavior)
    for (const vm of vms) {
      if (!vm.node_id) continue;
      
      const conn = (await dbService.getProxmoxConnectionCredentials(vm.node_id)) as any;
      if (!conn || (Array.isArray(conn) && conn.length === 0)) continue;
      
      const c = Array.isArray(conn) ? conn[0] : conn;
      const cleanHost = String(c.host_ip || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const type = vm.type === 'lxc' ? 'lxc' : 'qemu';
      const url = `https://${cleanHost}:${c.port || 8006}/api2/json/nodes/${encodeURIComponent(vm.node)}/${type}/${vm.vmid}/status/current`;
      
      try {
        const res = await proxmoxFetch(url, {
          headers: { 'Authorization': `PVEAPIToken=${c.token_id}=${c.secret}` },
          sslFingerprint: c.tls_fingerprint
        });
        
        if (res.ok) {
          const json = (await res.json()) as any;
          const status = json.data || {};
          
          if (status.netin !== undefined && status.netout !== undefined) {
            const rrdUrl = `https://${cleanHost}:${c.port || 8006}/api2/json/nodes/${encodeURIComponent(vm.node)}/${type}/${vm.vmid}/rrddata?timeframe=hour`;
            const rrdRes = await proxmoxFetch(rrdUrl, {
              headers: { 'Authorization': `PVEAPIToken=${c.token_id}=${c.secret}` },
              sslFingerprint: c.tls_fingerprint
            });
            
            if (rrdRes.ok) {
              const rrdJson = (await rrdRes.json()) as any;
              const data = rrdJson.data || [];
              let addedBytes = 0;
              addedBytes = 0; // TODO: properly calculate from RRD rates
              
              await queryDb('UPDATE vms SET bandwidth_usage = bandwidth_usage + $1 WHERE vmid = $2', [addedBytes, vm.vmid]);
            }
          }
        }
      } catch (err) {
        // ignore per-vm errors to continue loop
      }
    }
  } catch (err) {
    console.error('[BANDWIDTH] Error in syncUsages', err);
  }
}

async function syncLimits() {
  try {
    const vms = await queryDb('SELECT vmid, node, node_id, type, bandwidth_usage, bandwidth_limit FROM vms WHERE bandwidth_limit IS NOT NULL');
    
    // Process VMs sequentially
    for (const vm of vms) {
      if (!vm.node_id) continue;
      
      const conn = (await dbService.getProxmoxConnectionCredentials(vm.node_id)) as any;
      if (!conn || (Array.isArray(conn) && conn.length === 0)) continue;
      
      const c = Array.isArray(conn) ? conn[0] : conn;
      
      try {
        if (Number(vm.bandwidth_usage) >= Number(vm.bandwidth_limit)) {
          // Throttled (1MB/s)
          await updateVMNetworkRateLimit(c, vm.node, vm.vmid, vm.type === 'lxc', 1);
        } else {
          // Unthrottled
          await updateVMNetworkRateLimit(c, vm.node, vm.vmid, vm.type === 'lxc', null);
        }
      } catch (err) {
        // ignore
      }
    }
  } catch (err) {
    console.error('[BANDWIDTH] Error in syncLimits', err);
  }
}

export function startBandwidthJobs() {
  usageInterval = setInterval(() => { void syncUsages(); }, 5 * 60 * 1000);
  limitInterval = setInterval(() => { void syncLimits(); }, 10 * 60 * 1000);
  console.log('[BANDWIDTH] Background jobs started (Usage: 5m, Limits: 10m)');
}
