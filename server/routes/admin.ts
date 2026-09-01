import { Router } from 'express';
import { dbService } from '../db/database.js';
import { emailService } from '../services/email.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import { adminVmFleetRouter } from '../adminVmFleet.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);
adminRouter.use(adminVmFleetRouter);

adminRouter.post('/operator-access', async (req, res) => {
  try {
    const actorEmail = req.authUser?.email;
    const accountEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!actorEmail || !accountEmail) return res.status(400).json({ success: false, error: 'Account email is required' });
    if (accountEmail.toLowerCase() === actorEmail.toLowerCase()) {
      return res.status(409).json({ success: false, error: 'Self-granting operator access is not permitted.' });
    }
    const enabled = req.body?.enabled === true;
    const account = await dbService.setOperatorAccess(accountEmail, enabled, actorEmail);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, data: account, message: `Operator access ${enabled ? 'granted' : 'revoked'} for ${account.email}.` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update operator access' });
  }
});

adminRouter.get('/reimage-requests', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !new Set(['pending', 'approved', 'rejected', 'cancelled', 'completed']).has(status)) {
      return res.status(400).json({ success: false, error: 'Unsupported reimage request status' });
    }
    const data = await dbService.getReimageRequests({ status });
    res.json({
      success: true,
      data,
      message: 'Manual approval queue only. Administrators perform the OS change separately and mark approved requests completed here.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch reimage requests' });
  }
});

adminRouter.post('/reimage-requests/:requestId/review', async (req, res) => {
  try {
    const reviewerEmail = req.authUser?.email;
    if (!reviewerEmail) return res.status(401).json({ success: false, error: 'Authentication required' });

    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ success: false, error: 'Decision must be approved or rejected' });
    }
    const reviewerNote = typeof req.body?.reviewerNote === 'string' ? req.body.reviewerNote.trim().slice(0, 1000) : undefined;
    const request = await dbService.reviewReimageRequest(req.params.requestId, decision, reviewerEmail, reviewerNote);
    if (!request) {
      return res.status(409).json({ success: false, error: 'Only a pending reimage request can be reviewed.' });
    }
    res.json({
      success: true,
      data: request,
      message: decision === 'approved'
        ? 'Request approved for manual administrator processing. No Proxmox operation has started.'
        : 'Request rejected. No Proxmox operation was performed.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to review reimage request' });
  }
});

adminRouter.post('/reimage-requests/:requestId/complete', async (req, res) => {
  try {
    const completedBy = req.authUser?.email;
    if (!completedBy) return res.status(401).json({ success: false, error: 'Authentication required' });
    const completionNote = typeof req.body?.completionNote === 'string' ? req.body.completionNote.trim().slice(0, 2000) : undefined;
    const request = await dbService.completeReimageRequest(req.params.requestId, completedBy, completionNote);
    if (!request) {
      return res.status(409).json({ success: false, error: 'Only an approved reimage request can be marked completed.' });
    }
    res.json({
      success: true,
      data: request,
      message: 'Request marked completed after manual administrator action. No automated Proxmox operation was performed.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to complete reimage request' });
  }
});

// 1. POST /api/admin/vms/provision — Create & Assign net-new VM (Wizard)
adminRouter.post('/vms/provision', async (req, res) => {
  try {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
    
    const { vmid, name, type, node, targetEmail, cpus, memoryGb, diskGb, expiryDays, expiryDate, neverExpire, os, proxmoxConnectionId } = req.body;
    if (!targetEmail && !req.body.ownerEmail) {
      return res.status(400).json({ success: false, error: 'Target account email is required' });
    }

    const parsedVmid = Number(vmid) || Math.floor(100 + Math.random() * 900);
    const existing = await dbService.getVMByVMID(parsedVmid, proxmoxConnectionId || undefined);

    if (existing) {
      return res.status(400).json({ success: false, error: `VMID ${parsedVmid} already exists on this connection. Please use the direct Assign button instead.` });
    }

    // Create & assign new VM
    const newVM = await dbService.createVM({
      vmid: parsedVmid,
      name: name || `vm-${parsedVmid}`,
      type: (type && type.toLowerCase().includes('lxc')) ? 'lxc' : 'qemu',
      node: node || 'pve-01',
      ownerEmail: targetEmail || req.body.ownerEmail,
      cpus: Number(cpus) || 4,
      memoryGb: Number(memoryGb) || 8,
      diskGb: Number(diskGb) || 64,
      expiryDays: Number(expiryDays) || 30,
      expiryDate,
      neverExpire,
      os: os || 'Ubuntu 24.04 LTS',
      proxmoxConnectionId: proxmoxConnectionId || 'legacy-local',
    }, userEmail);

    return res.json({ 
      success: true, 
      message: `Proxmox VMID ${parsedVmid} (${newVM.name}) provisioned and assigned to ${newVM.ownerEmail}`, 
      data: newVM 
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to provision VM' });
  }
});

// 2. POST /api/admin/vms/assign — Direct assign existing unassigned Proxmox VM to customer
adminRouter.post('/vms/assign', async (req, res) => {
  try {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { vmid, targetEmail, expiryDays, expiryDate, proxmoxConnectionId } = req.body;
    if (!vmid || !targetEmail) {
      return res.status(400).json({ success: false, error: 'Both vmid and targetEmail are required' });
    }

    const parsedVmid = Number(vmid);
    const existing = await dbService.getVMByVMID(parsedVmid, proxmoxConnectionId || undefined);
    if (!existing) {
      return res.status(404).json({ success: false, error: `Proxmox VMID ${parsedVmid} not found in cluster inventory` });
    }

    const targetExpiry = expiryDate ? new Date(expiryDate).toISOString() : new Date(Date.now() + (Number(expiryDays) || 30) * 86400000).toISOString();
    const updated = await dbService.assignVM(parsedVmid, targetEmail, userEmail, targetExpiry, proxmoxConnectionId || existing.proxmoxConnectionId || undefined);
    return res.json({
      success: true,
      message: `Server ${existing.name} (VMID ${parsedVmid}) successfully assigned to ${targetEmail}`,
      data: updated
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to assign VM' });
  }
});

adminRouter.get('/vms', async (req, res) => {
  try {
    const vms = await dbService.getVMs();
    res.json({ success: true, count: vms.length, data: vms });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch VMs' });
  }
});

adminRouter.post('/vms/:vmid/suspend', async (req, res) => {
  try {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
    const vmid = Number(req.params.vmid);
    const proxmoxConnectionId = typeof req.body?.proxmoxConnectionId === 'string' ? req.body.proxmoxConnectionId.trim() : undefined;
    const suspend = req.body?.suspend !== false;
    const updated = await dbService.suspendVM(vmid, suspend, userEmail, proxmoxConnectionId);
    if (!updated) {
      return res.status(404).json({ success: false, error: `Proxmox VMID ${vmid} not found` });
    }
    res.json({
      success: true,
      message: suspend ? `VMID ${vmid} suspended successfully.` : `VMID ${vmid} unsuspended successfully.`,
      data: updated,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to suspend VM' });
  }
});

adminRouter.delete('/vms/:vmid/unassign', async (req, res) => {
  try {
    const userEmail = req.authUser?.email;
    if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
    const vmid = Number(req.params.vmid);
    const proxmoxConnectionId = typeof req.query?.proxmoxConnectionId === 'string' ? req.query.proxmoxConnectionId.trim() : 'legacy-local';
    const reason = typeof req.query?.reason === 'string' ? req.query.reason.trim() : 'Admin unassigned';
    const unassigned = await dbService.unassignVM(vmid, proxmoxConnectionId, reason, userEmail);
    if (!unassigned) {
      return res.status(404).json({ success: false, error: `Proxmox VMID ${vmid} not found or could not be unassigned` });
    }
    res.json({ success: true, message: `VMID ${vmid} unassigned from client and returned to pool`, data: unassigned });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to unassign VM' });
  }
});

adminRouter.get('/settings/smtp', async (_req, res) => {
  try {
    const config = await dbService.getSystemSetting('smtp_config');
    res.json({ success: true, data: config });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch SMTP settings' });
  }
});

adminRouter.post('/settings/smtp', async (req, res) => {
  try {
    const config = req.body;
    await dbService.updateSystemSetting('smtp_config', config);
    if (typeof emailService.refreshTransporter === 'function') {
      await emailService.refreshTransporter();
    }
    res.json({ success: true, message: 'SMTP configuration saved successfully', data: config });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update SMTP settings' });
  }
});

adminRouter.post('/settings/smtp/test', async (req, res) => {
  try {
    const targetEmail = req.body?.targetEmail || req.body?.testEmail;
    if (!targetEmail) return res.status(400).json({ success: false, error: 'Target email is required for testing' });
    if (!emailService.isReady()) {
      return res.status(503).json({ success: false, error: 'SMTP is disabled or has not initialized. Save an enabled SMTP configuration first.' });
    }
    const result = await emailService.sendTestEmail(targetEmail);
    if (result) {
      res.json({ success: true, message: `Test email dispatched to ${targetEmail}` });
    } else {
      res.status(502).json({ success: false, error: 'SMTP provider rejected the test message. Check host, port, credentials, and sender address in server logs.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'SMTP test failed' });
  }
});
