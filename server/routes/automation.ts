import { Router } from 'express';
import { authOrApiKey, requireScope } from '../apiKeyAuth.js';
import { requireAdmin } from '../middleware.js';
import { KeyedRequest } from '../types/apiKey.js';
import { automationService } from '../services/automation.js';
import { dbService } from '../db/database.js';

export const automationRouter = Router();

type TeamAccessScope = 'readonly' | 'power' | 'full' | 'owner';
const teamAccessScopeRank: Record<TeamAccessScope, number> = {
  readonly: 1,
  power: 2,
  full: 3,
  owner: 4,
};

/** Owner-or-admin gate with scoped, per-service delegated access for normal clients. */
async function assertVmAccess(
  req: KeyedRequest,
  res: any,
  vmid: number,
  requiredScope: TeamAccessScope = 'readonly',
  ownerOnly = false,
): Promise<any | null> {
  const email = req.authUser?.email?.toLowerCase();
  if (!email) return res.status(401).json({ success: false, error: 'Authentication required' });

  const vm = await dbService.getVMByVMID(vmid);
  if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });

  const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
  const isOwner = vm.ownerEmail?.toLowerCase() === email;
  if (isAdmin || isOwner) return null;
  if (ownerOnly) {
    return res.status(403).json({ success: false, error: 'Only the service owner can manage team access.' });
  }

  const delegatedAccess = await dbService.getSubUserAccess(vmid, email);
  const actualScope = String(delegatedAccess?.scope || '') as TeamAccessScope;
  if (!delegatedAccess || !teamAccessScopeRank[actualScope] || teamAccessScopeRank[actualScope] < teamAccessScopeRank[requiredScope]) {
    return res.status(403).json({ success: false, error: 'Your delegated access level does not permit this action.' });
  }
  return null;
}

// ---------------------------------------------------------------
// 1. OS Rebuild with Cloud-Init (extends existing POST /vms/:vmid/reinstall)
// ---------------------------------------------------------------
automationRouter.post('/vms/:vmid/reinstall', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'full')) return;
  const { targetOS, userpass, cipassword, hostname, sshkeys } = req.body || {};
  if (!targetOS) {
    return res.status(400).json({ success: false, error: 'Target OS specification (targetOS) is required' });
  }
  try {
    const result = await dbService.runTask(req.authUser!.email, `OS Rebuild — VMID ${vmid}`, `Cloud-Init rebuild to ${targetOS} in progress`, 'high', async (updateProgress) => {
      await updateProgress(15, 'Stopping VM and preparing Cloud-Init config');
      const result = await automationService.reinstallWithCloudInit(vmid, { targetOS, userpass, cipassword, hostname, sshkeys }, req.authUser!.email);
      await updateProgress(100, result.message);
      return { ok: !(result.partial !== false) };
    });
    res.json({ success: true, message: 'OS rebuild started — track progress in Tasks', partial: false, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'OS reinstallation failed' });
  }
});

// ---------------------------------------------------------------
// 2. Rescue Mode
// ---------------------------------------------------------------
automationRouter.post('/vms/:vmid/rescue/enter', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'full')) return;
  try {
    const r = await dbService.runTask(req.authUser!.email, `Rescue Mode — Enter — VMID ${vmid}`, `Booting VMID ${vmid} into rescue environment`, 'high', async (updateProgress) => {
      await updateProgress(30, 'Mounting rescue ISO');
      const r = await automationService.enterRescueMode(vmid, req.authUser!.email);
      await updateProgress(100, r.message);
      return { ok: true };
    });
    res.json({ success: true, message: 'Entering rescue mode — track progress in Tasks', data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to enter rescue mode' });
  }
});

automationRouter.post('/vms/:vmid/rescue/exit', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'full')) return;
  try {
    const r = await dbService.runTask(req.authUser!.email, `Rescue Mode — Exit — VMID ${vmid}`, `Restoring normal boot for VMID ${vmid}`, 'medium', async (updateProgress) => {
      await updateProgress(30, 'Restoring original boot device');
      const r = await automationService.exitRescueMode(vmid, req.authUser!.email);
      await updateProgress(100, r.message);
      return { ok: true };
    });
    res.json({ success: true, message: 'Exiting rescue mode — track progress in Tasks', data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to exit rescue mode' });
  }
});

// ---------------------------------------------------------------
// 3. Self-Service Backups
// ---------------------------------------------------------------
automationRouter.post('/vms/:vmid/backups', authOrApiKey, requireScope('power'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'power')) return;
  try {
    const r = await dbService.runTask(req.authUser!.email, `Full Backup — VMID ${vmid}`, `vzdump backup started on VMID ${vmid}`, 'medium', async (updateProgress) => {
      const r = await automationService.triggerBackup(vmid, req.authUser!.email);
      await updateProgress(60, r.message);
      await updateProgress(100, 'Backup job submitted to queue');
      return { ok: true };
    });
    res.json({ success: true, message: 'Backup started — track progress in Tasks', data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Backup failed to start' });
  }
});

automationRouter.get('/vms/:vmid/backups', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'readonly')) return;
  try {
    const r = await automationService.listBackups(vmid);
    res.json({ success: true, data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to list backups' });
  }
});

automationRouter.post('/vms/:vmid/backups/:volid/restore', authOrApiKey, requireAdmin, async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'full')) return;
  const { targetStorage } = req.body || {};
  if (!targetStorage) return res.status(400).json({ success: false, error: 'targetStorage is required (restore lands on this storage)' });
  try {
    const volid = decodeURIComponent(String(req.params.volid));
    const r = await dbService.runTask(req.authUser!.email, `Restore Backup — VMID ${vmid}`, `Restoring ${volid} to ${targetStorage}`, 'high', async (updateProgress) => {
      await updateProgress(20, 'Preparing restore target');
      const r = await automationService.restoreBackup(vmid, volid, targetStorage, req.authUser!.email);
      await updateProgress(100, r.message);
      return { ok: true };
    });
    res.json({ success: true, message: 'Restore started — track progress in Tasks', data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Restore failed to start' });
  }
});

// ---------------------------------------------------------------
// 4. Live RRD Telemetry & Bandwidth Quotas
// ---------------------------------------------------------------
automationRouter.get('/vms/:vmid/rrd', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'readonly')) return;
  const timeframe = ['minute', 'hour', 'day', 'week', 'month', 'year'].includes(String(req.query.timeframe || ''))
    ? String(req.query.timeframe) : 'hour';
  try {
    const r = await automationService.getLiveRrd(vmid, timeframe);
    res.json({ success: true, data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Live telemetry unavailable' });
  }
});

automationRouter.get('/vms/:vmid/bandwidth', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'readonly')) return;
  try {
    const r = await automationService.getMonthlyBandwidth(vmid);
    res.json({ success: true, data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Bandwidth data unavailable' });
  }
});

automationRouter.get('/vms/:vmid/quota', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'readonly')) return;
  try {
    const quotaGb = await dbService.getVmBandwidthQuota(vmid);
    res.json({ success: true, data: { vmid, bandwidthQuotaGb: quotaGb } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

automationRouter.put('/vms/:vmid/quota', authOrApiKey, requireAdmin, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'full')) return;
  const { bandwidthGb } = req.body || {};
  if (!bandwidthGb || Number(bandwidthGb) < 1) {
    return res.status(400).json({ success: false, error: 'bandwidthGb must be at least 1' });
  }
  try {
    const row = await dbService.setVmBandwidthQuota(vmid, Number(bandwidthGb));
    res.json({ success: true, data: row });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Rescue readiness check (non-destructive: lists storages + ISOs)
automationRouter.get('/vms/:vmid/rescue/check', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'readonly')) return;
  try {
    const r = await automationService.checkRescueReadiness(vmid);
    res.json({ success: true, ...r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Rescue readiness check failed' });
  }
});

// rDNS history for a single VM
automationRouter.get('/vms/:vmid/rdns-requests', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'readonly')) return;
  try {
    const queue = await dbService.getRdnsQueue();
    const filtered = (queue || []).filter((r: any) => Number(r.vmid) === vmid);
    res.json({ success: true, data: filtered });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// 5. Reverse DNS (rDNS / PTR)
// ---------------------------------------------------------------
automationRouter.get('/rdns/queue', authOrApiKey, requireAdmin, async (req: KeyedRequest, res) => {
  try {
    const queue = await dbService.getRdnsQueue();
    res.json({ success: true, data: queue });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

automationRouter.post('/vms/:vmid/rdns', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'full')) return;
  const { ip, ptr } = req.body || {};
  if (!ip || !ptr) return res.status(400).json({ success: false, error: 'ip and ptr are required' });
  try {
    const r = await automationService.requestRdns(vmid, ip, ptr, req.authUser!.email);
    res.json({ success: true, message: r.message, id: r.id, status: r.status });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------
// 6. App Marketplace (1-click deploy)
// ---------------------------------------------------------------
automationRouter.get('/apps/catalog', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  try {
    const catalog = await automationService.listApps();
    const instances = await automationService.listAppInstances();
    const withTemplates = String(req.query.withTemplates || '') === '1';
    let templateNames: string[] = [];
    if (withTemplates) {
      try {
        const r = await automationService.listClusterTemplates();
        templateNames = r.map((t: any) => t.name || t.template || '');
      } catch (_e) {
        templateNames = [];
      }
    }
    const enriched = catalog.map((app: any) => ({
      ...app,
      templateAvailable: withTemplates ? templateNames.includes(`stellar-template-${app.id}`) : null,
    }));
    res.json({ success: true, data: { catalog: enriched, instances, templateNames } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

automationRouter.post('/apps/:appId/deploy', authOrApiKey, requireScope('power'), async (req: KeyedRequest, res) => {
  const vmid = Number(req.body?.vmid);
  if (!vmid) return res.status(400).json({ success: false, error: 'Body field "vmid" (target VM) is required' });
  if (await assertVmAccess(req, res, vmid, 'power')) return;
  try {
    const r = await dbService.runTask(req.authUser!.email, `Deploy ${String(req.params.appId)} — VMID ${vmid}`, `Cloning app template and provisioning on VMID ${vmid}`, 'medium', async (updateProgress) => {
      await updateProgress(20, 'Preparing app template');
      const r = await automationService.deployApp(vmid, String(req.params.appId), req.authUser!.email);
      await updateProgress(r.started ? 75 : 100, r.message);
      await updateProgress(100, r.message);
      return { ok: true };
    });
    res.json({ success: true, message: 'App deployment started — track progress in Tasks', data: r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Deployment failed' });
  }
});

// ---------------------------------------------------------------
// 7. API Key Generator
// ---------------------------------------------------------------
automationRouter.post('/user/api-keys', authOrApiKey, async (req: KeyedRequest, res) => {
  const email = req.authUser?.email;
  if (!email) return res.status(401).json({ success: false, error: 'Authentication required' });
  const { name, scope } = req.body || {};
  if (!name || !['read', 'power', 'full'].includes(String(scope || ''))) {
    return res.status(400).json({ success: false, error: 'name and scope (read|power|full) are required' });
  }
  const crypto = await import('crypto');
  const rawKey = `stellar_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.slice(0, 12);
  try {
    const row = await dbService.createApiKey(email, String(name).slice(0, 100), hash, prefix, scope);
    // Show the full key ONLY in the creation response
    res.json({ success: true, message: 'API key created. Save it now — it will never be shown again.', data: { ...row, key: rawKey } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to create API key' });
  }
});

automationRouter.get('/user/api-keys', authOrApiKey, async (req: KeyedRequest, res) => {
  const email = req.authUser?.email;
  if (!email) return res.status(401).json({ success: false, error: 'Authentication required' });
  const keys = await dbService.getUserApiKeys(email);
  res.json({ success: true, data: keys });
});

automationRouter.delete('/user/api-keys/:id', authOrApiKey, async (req: KeyedRequest, res) => {
  const email = req.authUser?.email;
  if (!email) return res.status(401).json({ success: false, error: 'Authentication required' });
  const id = parseInt(String(req.params.id), 10);
  const deleted = await dbService.deleteApiKey(id, email);
  if (!deleted) return res.status(404).json({ success: false, error: 'API key not found' });
  res.json({ success: true, message: 'API key revoked' });
});

// ---------------------------------------------------------------
// 8. Team / Sub-User Access Delegation
// ---------------------------------------------------------------
automationRouter.get('/vms/:vmid/sub-users', authOrApiKey, requireScope('read'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'owner', true)) return;
  const subs = await dbService.getSubUsers(vmid);
  res.json({ success: true, data: subs });
});

automationRouter.post('/vms/:vmid/sub-users', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'owner', true)) return;
  const { email, scope } = req.body || {};
  if (!email || !['readonly', 'power', 'full'].includes(String(scope || ''))) {
    return res.status(400).json({ success: false, error: 'email and scope (readonly|power|full) are required' });
  }
  const existingAccount = await dbService.findUserByEmail(String(email));
  if (!existingAccount) {
    return res.status(409).json({ success: false, error: 'This email address is not registered. Send an SMTP invitation from Team Access instead.' });
  }
  try {
    const row = await dbService.addSubUser(vmid, email, scope, req.authUser!.email);
    res.json({ success: true, message: `Delegated ${scope} access on VMID ${vmid} to ${email}`, data: row });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to add sub-user' });
  }
});

automationRouter.put('/vms/:vmid/sub-users/:id', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'owner', true)) return;
  const id = parseInt(String(req.params.id), 10);
  const { scope } = req.body || {};
  if (!['readonly', 'power', 'full'].includes(String(scope || ''))) {
    return res.status(400).json({ success: false, error: 'scope (readonly|power|full) is required' });
  }
  const row = await dbService.updateSubUser(id, vmid, scope);
  if (!row) return res.status(404).json({ success: false, error: 'Sub-user not found on this VM' });
  res.json({ success: true, data: row });
});

automationRouter.delete('/vms/:vmid/sub-users/:id', authOrApiKey, requireScope('full'), async (req: KeyedRequest, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  if (await assertVmAccess(req, res, vmid, 'owner', true)) return;
  const id = parseInt(String(req.params.id), 10);
  const removed = await dbService.removeSubUser(id, vmid);
  if (!removed) return res.status(404).json({ success: false, error: 'Sub-user not found on this VM' });
  res.json({ success: true, message: 'Sub-user access revoked' });
});
