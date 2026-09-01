import { Request, Response } from 'express';
import { VmRepository } from '../repositories/VmRepository.js';
import { dbService } from '../db/database.js';

export class VmController {
  static async listVMs(req: Request, res: Response) {
    const { ownerEmail, vmid, connectionId } = req.query;
    const parsedVmid = vmid ? parseInt(String(vmid), 10) : undefined;
    const parsedEmail = ownerEmail ? String(ownerEmail) : undefined;
    const parsedConnectionId = typeof connectionId === 'string' && connectionId.trim() ? connectionId.trim() : undefined;
  
    try {
      const vms = await VmRepository.getVMs(parsedEmail, parsedVmid, parsedConnectionId);
      return res.json({ success: true, count: vms.length, data: vms });
    } catch (err: any) {
      return res.status(503).json({ success: false, error: err?.message || 'Unable to read VMs from the local database' });
    }
  }

  static async getVM(req: Request, res: Response) {
    const targetVmid = parseInt(String(req.params.vmid), 10);
    const vm = await VmRepository.getVMByVMID(targetVmid);
    if (vm) {
      return res.json({ success: true, data: vm });
    } else {
      return res.status(404).json({ success: false, error: `Proxmox VMID ${targetVmid} not found` });
    }
  }

  static async createVM(req: any, res: any) {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
    
    // Zod has already validated ownerEmail exists
    const { vmid, name, type, node, ownerEmail, cpus, memoryGb, diskGb, expiryDays, os } = req.body;
    
    const targetVmid = Number(vmid) || Math.floor(100 + Math.random() * 900);
    
    const existing = await VmRepository.getVMByVMID(targetVmid);
    if (existing) {
      return res.status(400).json({ success: false, error: `Proxmox VMID ${targetVmid} is already in use by ${existing.name}` });
    }
  
    const newVM = await dbService.createVM({
      vmid: targetVmid,
      name: name || `vm-${targetVmid}`,
      type: (type && type.toLowerCase().includes('lxc')) ? 'lxc' : 'qemu',
      node: node || 'pve-01',
      ownerEmail,
      cpus: Number(cpus) || 4,
      memoryGb: Number(memoryGb) || 8,
      diskGb: Number(diskGb) || 64,
      expiryDays: Number(expiryDays) || 30,
      os: os || 'Ubuntu 24.04 LTS',
    }, userEmail);
  
    return res.json({ success: true, message: `Proxmox VMID ${targetVmid} (${newVM.name}) provisioned and assigned to ${newVM.ownerEmail}`, data: newVM });
  }
}
