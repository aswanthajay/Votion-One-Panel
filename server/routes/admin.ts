import { Router } from 'express';
import { dbService } from '../db/database.js';
import { proxmoxApi } from '../services/proxmox.js';
import { ProxmoxService } from '../services/proxmoxService.js';
import { emailService } from '../services/email.js';
import { requireAdmin, requireAuth } from '../middleware.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.post('/operator-access', async (req, res) => {
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
});

adminRouter.get('/reimage-requests', async (req, res) => {
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
});

adminRouter.post('/reimage-requests/:requestId/review', async (req, res) => {
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
});

adminRouter.post('/reimage-requests/:requestId/complete', async (req, res) => {
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
});

// 1. POST /api/admin/vms/assign — Assign VMID to client user email with specs & expiry_date
adminRouter.post('/vms/assign', async (req, res) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const { vmid, name, type, node, targetEmail, cpus, memoryGb, diskGb, expiryDays, expiryDate, neverExpire, os, proxmoxConnectionId } = req.body;
  if (!targetEmail && !req.body.ownerEmail) {
    return res.status(400).json({ success: false, error: 'Target account email is required' });
  }

  const parsedVmid = Number(vmid) || Math.floor(100 + Math.random() * 900);
  const existing = await dbService.getVMByVMID(parsedVmid, proxmoxConnectionId || undefined);

  if (existing) {
    // Reassign existing VM
    const vm = await dbService.assignVM(parsedVmid, targetEmail || req.body.ownerEmail, userEmail, neverExpire === true ? null : expiryDate, proxmoxConnectionId || undefined);
    return res.json({
      success: true,
      message: `Proxmox VMID ${parsedVmid} reassigned to ${targetEmail || req.body.ownerEmail}`,
      data: vm,
    });
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
    neverExpire: neverExpire === true,
    proxmoxConnectionId,
    os: os || 'Ubuntu 24.04 LTS',
  }, userEmail);

  res.json({
    success: true,
    message: `Proxmox VMID ${parsedVmid} allocated and assigned to ${newVM.ownerEmail}`,
    data: newVM,
  });
});

// 2. GET /api/admin/vms — List all VMs across the cluster with assigned client email, status, and expiry date
adminRouter.get('/vms', async (req, res) => {
  const vms = await proxmoxApi.getAllProxmoxVMs();
  res.json({ success: true, count: vms.length, data: vms });
});

// 3. PUT /api/admin/vms/:vmid/expiry — Update or extend the expiry_date for a server
adminRouter.put('/vms/:vmid/expiry', async (req, res) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const vmid = parseInt(req.params.vmid, 10);
  const { additionalDays } = req.body;

  const days = Number(additionalDays) || 30;
  const proxmoxConnectionId = String(req.body?.proxmoxConnectionId || '').trim() || undefined;
  const vm = await dbService.extendVMExpiry(vmid, days, userEmail, proxmoxConnectionId);
  if (vm) {
    res.json({ success: true, message: `Proxmox VMID ${vmid} expiry date extended by ${days} days`, data: vm });
  } else {
    res.status(404).json({ success: false, error: `VMID ${vmid} not found` });
  }
});

// 4. POST /api/admin/vms/:vmid/suspend — Manually suspend/unsuspend a server
adminRouter.post('/vms/:vmid/suspend', async (req, res) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const vmid = parseInt(req.params.vmid, 10);
  const { suspend } = req.body;
  const proxmoxConnectionId = String(req.body?.proxmoxConnectionId || '').trim() || undefined;

  const vm = await dbService.suspendVM(vmid, suspend === true, userEmail, proxmoxConnectionId);
  if (vm) {
    res.json({ success: true, message: `Proxmox VMID ${vmid} ${suspend ? 'suspended' : 'unsuspended'}`, data: vm });
  } else {
    res.status(404).json({ success: false, error: `VMID ${vmid} not found` });
  }
});

// 5. DELETE /api/admin/vms/:vmid/unassign — Remove VM assignment from user
adminRouter.delete('/vms/:vmid/unassign', async (req, res) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const vmid = parseInt(req.params.vmid, 10);
  const proxmoxConnectionId = String(req.query.proxmoxConnectionId || '').trim() || undefined;

  const vm = await dbService.assignVM(vmid, 'unassigned@votioncloud.org', userEmail, undefined, proxmoxConnectionId);
  if (vm) {
    res.json({ success: true, message: `Proxmox VMID ${vmid} unassigned from user`, data: vm });
  } else {
    res.status(404).json({ success: false, error: `VMID ${vmid} not found` });
  }
});

// 6. GET /api/admin/settings/smtp — Get SMTP config
adminRouter.get('/settings/smtp', async (req, res) => {
  const config = await dbService.getSystemSetting('smtp_config') || { enabled: false, host: '', port: 587, user: '', pass: '', secure: false, from: 'noreply@votioncloud.org' };
  res.json({ success: true, data: config });
});

// 7. POST /api/admin/settings/smtp — Update SMTP config
adminRouter.post('/settings/smtp', async (req, res) => {
  const config = req.body;
  await dbService.updateSystemSetting('smtp_config', config);
  // Re-init the email service transporter with new settings
  await emailService.refreshTransporter();
  res.json({ success: true, message: 'SMTP settings updated successfully' });
});

// 8. POST /api/admin/settings/smtp/test — Test SMTP config
adminRouter.post('/settings/smtp/test', async (req, res) => {
  const { testEmail } = req.body;
  if (!testEmail) {
    return res.status(400).json({ success: false, error: 'testEmail is required' });
  }
  const html = `
    <div style="font-family: sans-serif; color: #1a1a1a;">
      <h2>SMTP Test Successful</h2>
      <p>Your Stellar Panel SMTP configuration is working correctly.</p>
      <p>Best regards,<br/>Stellar Panel</p>
    </div>
  `;
  const success = await emailService.sendEmail(testEmail, 'Stellar Panel SMTP Test', html);
  if (success) {
    res.json({ success: true, message: 'Test email sent successfully' });
  } else {
    res.status(500).json({ success: false, error: 'Failed to send test email. Check server logs.' });
  }
});
