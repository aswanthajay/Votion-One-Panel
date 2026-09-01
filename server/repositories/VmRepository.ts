import { pgPool } from '../db/database.js';

export interface VmEntity {
  vmid: number;
  vmKey: string;
  name: string;
  type: string;
  node: string;
  proxmoxConnectionId: string | null;
  proxmoxConnectionName: string | null;
  ownerEmail: string;
  status: string;
  cpus: number;
  memory: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  ipAddress: string | null;
  os: string | null;
  expiryDate: Date | null;
  isSuspended: boolean;
}

export class VmRepository {
  /**
   * Retrieves VMs based on owner email, specific VMID, or connection ID.
   */
  static async getVMs(ownerEmail?: string, vmid?: number, proxmoxConnectionId?: string): Promise<VmEntity[]> {
    let query = 'SELECT v.*, pc.name AS proxmox_connection_name FROM vms v LEFT JOIN proxmox_connections pc ON pc.id = v.proxmox_connection_id';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (vmid) {
      params.push(vmid);
      conditions.push(`vmid = $${params.length}`);
    }
    if (ownerEmail) {
      params.push(ownerEmail.toLowerCase().trim());
      conditions.push(`owner_email = $${params.length}`);
    }
    if (proxmoxConnectionId) {
      params.push(proxmoxConnectionId.trim());
      conditions.push(`v.proxmox_connection_id = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY vmid ASC';

    const res = await pgPool.query(query, params);
    
    // We map raw DB columns to the Domain Entity
    return res.rows.map(v => ({
      vmid: v.vmid,
      vmKey: `${v.proxmox_connection_id || 'legacy-local'}:${v.node || 'unknown'}:${v.vmid}`,
      name: v.vm_name,
      type: v.type,
      node: v.node,
      proxmoxConnectionId: v.proxmox_connection_id || null,
      proxmoxConnectionName: v.proxmox_connection_name || null,
      ownerEmail: v.owner_email,
      status: v.is_suspended ? 'stopped' : v.status,
      cpus: v.cpu_cores,
      memory: v.ram_mb * 1048576,
      maxmem: v.maxmem,
      disk: v.disk_gb * 1073741824,
      maxdisk: v.maxdisk,
      uptime: v.is_suspended ? 0 : v.uptime,
      ipAddress: v.ip_address,
      os: v.os_type,
      expiryDate: v.expiry_date,
      isSuspended: v.is_suspended,
    }));
  }

  /**
   * Retrieves a single VM by its VMID and Proxmox Connection ID.
   */
  static async getVMByVMID(vmid: number, proxmoxConnectionId?: string): Promise<VmEntity | null> {
    const vms = await this.getVMs(undefined, vmid, proxmoxConnectionId);
    if (vms.length === 0) return null;
    return vms[0];
  }
}
