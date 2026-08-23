import { Router } from 'express';
import { dbService } from '../db/database.js';
import { proxmoxApi } from '../services/proxmox.js';
import { ProxmoxService } from '../services/proxmoxService.js';
import { emailService } from '../services/email.js';
import { requireAdmin, requireAuth } from '../middleware.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// 1. POST /api/admin/vms/assign — Assign VMID to client user email with specs & expiry_date
adminRouter.post('/vms/assign', async (req, res) => {
  const userEmail = req.authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const { vmid, name, type, node, targetEmail, cpus, memoryGb, diskGb, expiryDays, os } = req.body;
  if (!targetEmail && !req.body.ownerEmail) {
    return res.status(400).json({ success: false, error: 'Target account email is required' });
  }

  const parsedVmid = Number(vmid) || Math.floor(100 + Math.random() * 900);
  const existing = await dbService.getVMByVMID(parsedVmid);

  if (existing) {
    // Reassign existing VM
    const vm = await dbService.assignVM(parsedVmid, targetEmail || req.body.ownerEmail, userEmail);
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
  const vm = await dbService.extendVMExpiry(vmid, days, userEmail);
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

  const vm = await dbService.suspendVM(vmid, suspend === true, userEmail);
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

  const vm = await dbService.assignVM(vmid, 'unassigned@votioncloud.org', userEmail);
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
