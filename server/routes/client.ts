import { Router } from 'express';
import { ovhService } from '../services/ovh.js';
import { dbService } from '../db/database.js';
import { emailService } from '../services/email.js';
import { hasTeamAccessScope, isDelegatedTeamAccessScope, type TeamAccessScope } from '../services/teamAccessPolicy.js';
import { proxmoxApi } from '../services/proxmox.js';
import { ProxmoxService } from '../services/proxmoxService.js';
import { requireAuth } from '../middleware.js';
import { proxmoxFetch } from '../services/proxmoxHttp.js';
import { mapProxmoxVmMetadata } from '../services/proxmoxVmMetadata.js';
import {
  isProviderCredentialKeyConfigured,
  PROXMOX_PROVIDER_UNAVAILABLE_MESSAGE,
} from '../services/secretBox.js';

interface PveEnvelope<T> { data?: T; }
interface PveVmStatus { status?: string; cpu?: number; cpus?: number; mem?: number; maxmem?: number; netin?: number; netout?: number; diskread?: number; diskwrite?: number; uptime?: number; }
interface PveConfig { ipconfig0?: string; net0?: string; [key: string]: unknown; }
interface PveAgentPayload { result?: Array<{ name?: string; 'ip-addresses'?: Array<{ 'ip-address-type'?: string; 'ip-address'?: string }> }>; }

async function readPveJson<T>(response: Response): Promise<T | null> {
  const payload: unknown = await response.json().catch(() => null);
  return payload && typeof payload === 'object' ? payload as T : null;
}

export const clientRouter = Router();
clientRouter.use(requireAuth);

const requireLiveProviderAccess = (_req: any, res: any, next: any) => {
  if (!isProviderCredentialKeyConfigured()) {
    return res.status(503).json({
      success: false,
      code: 'PROXMOX_PROVIDER_UNAVAILABLE',
      error: PROXMOX_PROVIDER_UNAVAILABLE_MESSAGE,
    });
  }
  next();
};

const CLIENT_NAVIGATION_DESTINATIONS = new Set([
  'overview',
  'instances',
  'instances-qemu',
  'instances-lxc',
  'client-instances-vnc',
  'client-instances-metrics',
  'client-instances-firewall',
  'client-instances-backups',
  'support',
  'team-access',
  'user-settings',
]);

clientRouter.get('/navigation-usage', async (req: any, res) => {
  const email = String(req.authUser?.email || '').toLowerCase();
  if (!email) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const usage = await dbService.getNavigationUsage(email, 5);
  res.json({ success: true, data: usage });
});

clientRouter.post('/navigation-usage', async (req: any, res) => {
  const email = String(req.authUser?.email || '').toLowerCase();
  const itemType = req.body?.itemType;
  const itemKey = String(req.body?.itemKey || '').trim();
  if (!email || !['destination', 'vm'].includes(itemType)) {
    return res.status(400).json({ success: false, error: 'Invalid navigation usage event.' });
  }

  if (itemType === 'destination') {
    if (!CLIENT_NAVIGATION_DESTINATIONS.has(itemKey)) {
      return res.status(400).json({ success: false, error: 'Unsupported navigation destination.' });
    }
    await dbService.recordNavigationUsage(email, { key: itemKey, type: 'destination' });
  } else {
    const vmid = Number(req.body?.vmid);
    const connId = typeof req.body?.connectionId === 'string' && req.body.connectionId.trim()
      ? req.body.connectionId.trim()
      : (itemKey.startsWith('vm:') && itemKey.split(':').length === 3 ? itemKey.split(':')[1] : undefined);
    const vm = Number.isInteger(vmid) ? await dbService.getVMByVMID(vmid, connId, email) : null;
    const delegatedAccess = vm ? await dbService.getSubUserAccess(vmid, email) : null;
    if (!vm || (String(vm.ownerEmail || '').toLowerCase() !== email && !delegatedAccess)) {
      return res.status(403).json({ success: false, error: 'You do not have access to this service.' });
    }
    const finalKey = vm.proxmoxConnectionId ? `vm:${vm.proxmoxConnectionId}:${vmid}` : `vm:${vmid}`;
    await dbService.recordNavigationUsage(email, { key: finalKey, type: 'vm', vmid });
  }

  res.status(204).end();
});

const isValidTeamEmail = (value: unknown): value is string => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

clientRouter.get('/team-access', async (req: any, res) => {
  const ownerEmail = String(req.authUser?.email || '').toLowerCase();
  if (!ownerEmail) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const data = await dbService.getTeamAccessOverview(ownerEmail);
  res.json({ success: true, data });
});

clientRouter.post('/team-access', async (req: any, res) => {
  const ownerEmail = String(req.authUser?.email || '').toLowerCase();
  const memberEmail = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  const vmid = Number(req.body?.vmid);
  const scope = String(req.body?.scope || '');
  if (!ownerEmail) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!Number.isInteger(vmid) || vmid <= 0 || !isValidTeamEmail(memberEmail) || !isDelegatedTeamAccessScope(scope)) {
    return res.status(400).json({ success: false, error: 'Provide a valid service, email address, and access level.' });
  }
  if (memberEmail === ownerEmail) {
    return res.status(400).json({ success: false, error: 'You already own this service and do not need delegated access.' });
  }

  const vm = await dbService.getVMByVMID(vmid);
  if (!vm || String(vm.ownerEmail || '').toLowerCase() !== ownerEmail) {
    return res.status(403).json({ success: false, error: 'Only the service owner can grant access.' });
  }

  const existingAccount = await dbService.findUserByEmail(memberEmail);
  if (existingAccount) {
    const member = await dbService.addSubUser(vmid, memberEmail, scope, ownerEmail);
    await dbService.logAudit(ownerEmail, 'GRANT_TEAM_ACCESS', `VMID ${vmid}`, `Granted ${scope} access to ${memberEmail}`);
    return res.status(201).json({
      success: true,
      data: { kind: 'member', member },
      message: `${memberEmail} now has ${scope} access to ${vm.name}.`,
    });
  }

  const smtpEnabled = await dbService.isSmtpRegistrationVerificationEnabled();
  if (!smtpEnabled) {
    return res.status(409).json({
      success: false,
      code: 'SMTP_REQUIRED_FOR_INVITATION',
      error: 'This email address is not registered. Enable SMTP before sending a secure registration invitation.',
    });
  }

  const invitation = await dbService.createTeamInvitation(vmid, memberEmail, scope, ownerEmail);
  const publicAppUrl = String(process.env.PUBLIC_APP_URL || 'http://localhost:5000').replace(/\/$/, '');
  const delivered = await emailService.sendTeamInvitation(memberEmail, {
    ownerName: String(req.authUser?.name || ownerEmail),
    serviceName: String(vm.name || `VM-${vmid}`),
    vmid,
    scope: scope as 'readonly' | 'power' | 'full',
    inviteUrl: `${publicAppUrl}/register`,
  });
  if (!delivered) {
    await dbService.revokeTeamInvitation(invitation.id, ownerEmail);
    return res.status(503).json({ success: false, error: 'The invitation email could not be delivered. No access has been granted.' });
  }

  await dbService.markTeamInvitationSent(invitation.id);
  await dbService.logAudit(ownerEmail, 'INVITE_TEAM_MEMBER', `VMID ${vmid}`, `Invited ${memberEmail} with ${scope} access`);
  return res.status(202).json({
    success: true,
    data: { kind: 'invitation', invitation: { ...invitation, sent_at: new Date().toISOString() } },
    message: `Invitation sent to ${memberEmail}. Access will activate automatically after they register with this address.`,
  });
});

clientRouter.put('/team-access/vms/:vmid/members/:memberId', async (req: any, res) => {
  const ownerEmail = String(req.authUser?.email || '').toLowerCase();
  const vmid = Number(req.params.vmid);
  const memberId = Number(req.params.memberId);
  const scope = String(req.body?.scope || '');
  if (!ownerEmail) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!Number.isInteger(vmid) || !Number.isInteger(memberId) || !isDelegatedTeamAccessScope(scope)) {
    return res.status(400).json({ success: false, error: 'Provide a valid service, team member, and access level.' });
  }
  const vm = await dbService.getVMByVMID(vmid);
  if (!vm || String(vm.ownerEmail || '').toLowerCase() !== ownerEmail) {
    return res.status(403).json({ success: false, error: 'Only the service owner can change team access.' });
  }
  const member = await dbService.updateSubUser(memberId, vmid, scope);
  if (!member) return res.status(404).json({ success: false, error: 'Team member access was not found.' });
  await dbService.logAudit(ownerEmail, 'UPDATE_TEAM_ACCESS', `VMID ${vmid}`, `Updated ${member.user_email} to ${scope} access`);
  res.json({ success: true, data: member, message: 'Team member access updated.' });
});

clientRouter.delete('/team-access/vms/:vmid/members/:memberId', async (req: any, res) => {
  const ownerEmail = String(req.authUser?.email || '').toLowerCase();
  const vmid = Number(req.params.vmid);
  const memberId = Number(req.params.memberId);
  if (!ownerEmail) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const vm = Number.isInteger(vmid) ? await dbService.getVMByVMID(vmid) : null;
  if (!vm || String(vm.ownerEmail || '').toLowerCase() !== ownerEmail) {
    return res.status(403).json({ success: false, error: 'Only the service owner can revoke team access.' });
  }
  const removed = await dbService.removeSubUser(memberId, vmid);
  if (!removed) return res.status(404).json({ success: false, error: 'Team member access was not found.' });
  await dbService.logAudit(ownerEmail, 'REVOKE_TEAM_ACCESS', `VMID ${vmid}`, `Revoked delegated access record ${memberId}`);
  res.json({ success: true, message: 'Team member access revoked immediately.' });
});

clientRouter.delete('/team-access/invitations/:invitationId', async (req: any, res) => {
  const ownerEmail = String(req.authUser?.email || '').toLowerCase();
  if (!ownerEmail) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const revoked = await dbService.revokeTeamInvitation(String(req.params.invitationId || ''), ownerEmail);
  if (!revoked) return res.status(404).json({ success: false, error: 'Pending invitation was not found.' });
  await dbService.logAudit(ownerEmail, 'REVOKE_TEAM_INVITATION', 'team-access', `Revoked invitation ${String(req.params.invitationId || '')}`);
  res.json({ success: true, message: 'Pending invitation revoked.' });
});

const proxmoxService = new ProxmoxService({
  hostIp: process.env.PVE_HOST || '',
  port: parseInt(process.env.PVE_PORT || '8006', 10),
  tokenId: process.env.PVE_TOKEN_ID || '',
  tokenSecret: process.env.PVE_TOKEN_SECRET || '',
  sslFingerprint: process.env.PVE_SSL_FINGERPRINT,
});

const adminRoles = new Set(['administrator', 'admin', 'moderator']);
type ClientVmScope = TeamAccessScope;
const requireClientVmScope = (requiredScope: ClientVmScope) => (req: any, res: any, next: any) => {
  const actualScope = req.clientVmScope as ClientVmScope | undefined;
  if (!hasTeamAccessScope(actualScope, requiredScope)) {
    return res.status(403).json({ success: false, error: 'Your delegated access level does not permit this action.' });
  }
  next();
};

const getConnectionForVm = async (vm: { proxmoxConnectionId?: string | null }) => {
  const connectionId = vm.proxmoxConnectionId;
  if (!connectionId) throw new Error('This VM is not associated with a Proxmox connection');

  const connections = await dbService.getProxmoxConnectionCredentials();
  const connection = connections.find(candidate => String(candidate.id) === String(connectionId));
  if (!connection) throw new Error('The Proxmox connection assigned to this VM is unavailable');
  return connection;
};

const getVmEndpoint = (connection: any, vm: { node: string; type: string; vmid: number }, suffix: string) => {
  const cleanHost = String(connection.host_ip || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const resourceType = vm.type === 'lxc' ? 'lxc' : 'qemu';
  return `https://${cleanHost}:${connection.port || 8006}/api2/json/nodes/${encodeURIComponent(vm.node)}/${resourceType}/${vm.vmid}/${suffix}`;
};
clientRouter.use('/vms/:vmid', async (req, res, next) => {
  const vmid = Number(req.params.vmid);
  const user = (req as any).authUser;
  const userEmail = String(user?.email || '').toLowerCase();
  const isAdmin = Boolean(user && adminRoles.has(user.role));
  const connectionId = (
    req.query.connectionId ||
    req.query.proxmoxConnectionId ||
    req.headers['x-proxmox-connection-id'] ||
    req.body?.connectionId ||
    req.body?.proxmoxConnectionId
  ) as string | undefined;

  const vm = await dbService.getVMByVMID(vmid, connectionId, isAdmin ? undefined : userEmail);
  if (!vm) return res.status(404).json({ success: false, error: 'Server not found' });

  const isOwner = String(vm.ownerEmail || '').toLowerCase() === userEmail;
  let clientVmScope: ClientVmScope | null = isAdmin || isOwner ? 'owner' : null;

  if (!clientVmScope && userEmail) {
    const delegatedAccess = await dbService.getSubUserAccess(vmid, userEmail);
    if (delegatedAccess && isDelegatedTeamAccessScope(delegatedAccess.scope)) {
      clientVmScope = delegatedAccess.scope;
    }
  }

  if (!clientVmScope) {
    return res.status(403).json({ success: false, error: 'You do not have access to this service.' });
  }

  (req as any).authorizedVm = vm;
  (req as any).clientVmScope = clientVmScope;
  (req as any).isClientVmOwner = isOwner || isAdmin;
  next();
});

clientRouter.use([
  '/vms/:vmid/metadata',
  '/vms/:vmid/telemetry',
  '/vms/:vmid/power',
  '/vms/:vmid/firewall',
], requireLiveProviderAccess);

const allowedReimageOsByType: Record<'qemu' | 'lxc', Set<string>> = {
  qemu: new Set(['Ubuntu 24.04 LTS', 'Windows Server 2022 Standard', 'Debian 12 Bookworm']),
  lxc: new Set(['Alpine Linux 3.19 (LXC)', 'Debian 12 Bookworm']),
};

const parseReimageOs = (value: unknown) => typeof value === 'string' ? value.trim() : '';

// Approval-based OS reimage requests. These routes persist workflow state only;
// they never call Proxmox or mutate the VM's OS/status.

clientRouter.get('/reimage-requests', requireAuth, async (req, res) => {
  const userEmail = (req as any).authUser?.email;
  try {
    const data = await dbService.getReimageRequests({ requesterEmail: userEmail });
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

clientRouter.get('/vms/:vmid/reimage-requests', requireClientVmScope('owner'), async (req, res) => {
  const vm = (req as any).authorizedVm;
  if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });
  const data = await dbService.getReimageRequests({ vmid: vm.vmid });
  res.json({
    success: true,
    data,
    message: 'Reimage requests are reviewed by an administrator. No reimage has started.',
  });
});

clientRouter.post('/vms/:vmid/reimage-requests', requireClientVmScope('owner'), async (req, res) => {
  const vm = (req as any).authorizedVm;
  const userEmail = (req as any).authUser?.email;
  if (!vm || !userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  if (vm.isSuspended) return res.status(403).json({ success: false, error: 'Requests are blocked while this VM is suspended.' });

  const requestedOs = parseReimageOs(req.body?.targetOS || req.body?.requestedOs);
  if (!requestedOs || !allowedReimageOsByType[vm.type as 'qemu' | 'lxc']?.has(requestedOs)) {
    return res.status(400).json({ success: false, error: `The selected OS image is not permitted for ${vm.type.toUpperCase()} instances.` });
  }

  const requesterNote = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : undefined;
  try {
    const request = await dbService.createReimageRequest(vm.vmid, requestedOs, userEmail, requesterNote, vm.proxmoxConnectionId);
    if (!request) return res.status(404).json({ success: false, error: 'VM not found' });
    res.status(201).json({
      success: true,
      data: request,
      message: 'Your reimage request has been submitted for review.',
    });
  } catch (err: any) {
    res.status(409).json({ success: false, error: err.message || 'Unable to create reimage request' });
  }
});

clientRouter.post('/vms/:vmid/reimage-requests/:requestId/cancel', requireClientVmScope('owner'), async (req, res) => {
  const vm = (req as any).authorizedVm;
  const userEmail = (req as any).authUser?.email;
  if (!vm || !userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const user = (req as any).authUser;
  const isAdmin = Boolean(user && adminRoles.has(user.role));
  const request = await dbService.cancelReimageRequest(req.params.requestId, vm.vmid, userEmail, isAdmin);
  if (!request) return res.status(409).json({ success: false, error: 'Only a pending request owned by you can be cancelled.' });
  res.json({
    success: true,
    data: request,
    message: 'Your reimage request has been cancelled.',
  });
});

// 1. GET /api/client/vms
clientRouter.get('/vms', async (req, res) => {
  const user = (req as any).authUser;
  const userEmail = user?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const connectionId = typeof req.query.connectionId === 'string' && req.query.connectionId.trim()
    ? req.query.connectionId.trim()
    : undefined;
  const providerAvailable = isProviderCredentialKeyConfigured();
  
  let accessibleVms = [];
  if (user.role === 'admin') {
    accessibleVms = await dbService.getVMs();
  } else {
    accessibleVms = await dbService.getAccessibleClientVMs(userEmail);
  }
  
  const allowedVms = connectionId
    ? accessibleVms.filter((vm) => vm.proxmoxConnectionId === connectionId)
    : accessibleVms;
    const vms = allowedVms.map(vm => ({
      ...vm,
      ipAddress: vm.ipAddress || (vm as any).ip_address || '',
    }));
  res.json({ success: true, count: vms.length, data: vms, providerAvailable });
});

// Read-only client billing profile view. Effective assigned prices are returned
// without exposing catalog-wide assignments or administrator-only costs.
clientRouter.get('/billing/vm-profiles', async (req, res) => {
  const userEmail = (req as any).authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  try {
    const data = await dbService.getVmBillingProfiles(undefined, userEmail);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Unable to load billing profile', data: [] });
  }
});

const vmMetadataCache = new Map<string, { data: any; expiresAt: number }>();

// 1.5. GET /api/client/vms/:vmid/metadata — Fetch sanitized Cloud-Init and Proxmox VM details
clientRouter.get('/vms/:vmid/metadata', requireClientVmScope('readonly'), async (req, res) => {
  const vm = (req as any).authorizedVm;
  if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });

  const cacheKey = `${vm.proxmoxConnectionId || 'default'}:${vm.vmid}`;
  const cached = vmMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ success: true, data: cached.data });
  }

  try {
    const conn = await getConnectionForVm(vm);
    const configUrl = getVmEndpoint(conn, vm, 'config');
    const configResponse = await proxmoxFetch(configUrl, {
      method: 'GET',
      headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
      sslFingerprint: conn.ssl_fingerprint,
      timeoutMs: 4000,
    });

    if (!configResponse.ok) {
      return res.status(502).json({ success: false, error: 'Server configuration is currently unavailable' });
    }

    const configPayload = await readPveJson<PveEnvelope<PveConfig>>(configResponse);
    const config = (configPayload?.data || {}) as Record<string, unknown>;
    let guestAgentInterfaces: Array<Record<string, unknown>> = [];
    const agentEnabled = vm.type === 'qemu' && vm.status === 'running' && (
      config.agent === true || Number(config.agent) > 0 || String(config.agent || '').startsWith('1')
    );

    if (agentEnabled) {
      try {
        const agentResponse = await proxmoxFetch(getVmEndpoint(conn, vm, 'agent/network-get-interfaces'), {
          method: 'GET',
          headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
          sslFingerprint: conn.ssl_fingerprint,
          timeoutMs: 1500,
        });
        if (agentResponse.ok) {
          const agentPayload = await readPveJson<PveEnvelope<PveAgentPayload>>(agentResponse);
          guestAgentInterfaces = Array.isArray(agentPayload?.data?.result) ? agentPayload.data.result : [];
        }
      } catch {
        // Cloud-Init and Proxmox config remain the source of truth if the guest agent is unavailable.
      }
    }

    const resourceType = vm.type === 'lxc' ? 'lxc' : 'qemu';
    const metadata = mapProxmoxVmMetadata(config, resourceType, guestAgentInterfaces as any);
    vmMetadataCache.set(cacheKey, { data: metadata, expiresAt: Date.now() + 20000 });
    res.json({ success: true, data: metadata });
  } catch {
    res.status(502).json({ success: false, error: 'Unable to load server details' });
  }
});

// 2. GET /api/client/vms/:vmid/telemetry — Fetch live CPU %, RAM, and Bandwidth usage from Proxmox for VMID
clientRouter.get('/vms/:vmid/telemetry', requireClientVmScope('readonly'), async (req, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  const vm = (req as any).authorizedVm;

  if (!vm) {
    return res.status(404).json({ success: false, error: `Proxmox VMID ${vmid} not found` });
  }

  try {
    const conn = await getConnectionForVm(vm);

    // [Opportunistic] Fetch Cloud-Init IP if missing in DB without blocking the request
    if (!vm.ip_address || vm.ip_address.trim() === '') {
      proxmoxFetch(getVmEndpoint(conn, vm, 'config'), {
        method: 'GET',
        headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
        sslFingerprint: conn.ssl_fingerprint,
        timeoutMs: 8000,
      }).then(async (confRes) => {
        if (confRes.ok) {
          const confJson = await readPveJson<PveEnvelope<PveConfig>>(confRes);
          if (confJson?.data) {
            let ip = '';
            if (confJson.data.ipconfig0) {
              const match = confJson.data.ipconfig0.match(/ip=([0-9\.]+)(?:\/|,|$)/);
              if (match && match[1]) ip = match[1];
            } else if (confJson.data.net0) {
              const match = confJson.data.net0.match(/ip=([0-9\.]+)(?:\/|,|$)/);
              if (match && match[1]) ip = match[1];
            }
            if (ip) {
              await dbService.updateVmIpAddress(vm.vmid, conn.id, ip);
            }
          }
        }
      }).catch(() => { /* Ignore background failure */ });
    }

    const pveRes = await proxmoxFetch(getVmEndpoint(conn, vm, 'status/current'), {
      method: 'GET',
      headers: { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` },
      sslFingerprint: conn.ssl_fingerprint,
    });
    
    if (!pveRes.ok) throw new Error('Failed to fetch from Proxmox');
    const json = await readPveJson<PveEnvelope<PveVmStatus>>(pveRes);
    
    if (json?.data) {
      res.json({
        success: true,
        vmid,
        name: vm.name,
        status: json.data.status,
        isSuspended: vm.isSuspended,
        telemetry: {
          cpu: json.data.cpu || 0,
          cpus: json.data.cpus || vm.cpus || 1,
          mem: json.data.mem || 0,
          maxmem: json.data.maxmem || vm.memory || 8589934592,
          netin: json.data.netin || 0,
          netout: json.data.netout || 0,
          diskread: json.data.diskread || 0,
          diskwrite: json.data.diskwrite || 0,
          uptime: json.data.uptime || 0,
          timestamp: new Date().toISOString()
        },
      });
    } else {
      throw new Error('No data field');
    }
  } catch (err: any) {
    res.status(503).json({
      success: false,
      error: err?.message || 'Live VM telemetry is currently unavailable',
      vmid,
    });
  }
});

// 2.5. GET /api/client/vms/:vmid/metrics — Fetch historical telemetry data for charts & aggregations
clientRouter.get('/vms/:vmid/metrics', requireClientVmScope('readonly'), async (req, res) => {
  try {
    const vmid = parseInt(String(req.params.vmid), 10);
    // Fetch last 48 hours for comparison
    const rawHistory = await dbService.getVmTelemetryHistory(vmid, 48);
    
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    
    interface TelemetryPoint {
      timestamp: string;
      cpuPct: number;
      ramBytes: number;
      netInBytes: number;
      netOutBytes: number;
      diskReadBytes: number;
      diskWriteBytes: number;
    }
    type NumericTelemetryKey = Exclude<keyof TelemetryPoint, 'timestamp'>;
    interface TelemetryBucket {
      cpuPct: number[];
      ramBytes: number[];
      netInBytes: number;
      netOutBytes: number;
      diskReadBytes: number;
      diskWriteBytes: number;
      count: number;
    }

    const currentPeriod: TelemetryPoint[] = [];
    const previousPeriod: TelemetryPoint[] = [];
    
    rawHistory.forEach(row => {
      const time = new Date(row.timestamp).getTime();
      const pt = {
        timestamp: row.timestamp,
        cpuPct: Number(row.cpu_pct),
        ramBytes: Number(row.ram_bytes),
        netInBytes: Number(row.net_in_bytes),
        netOutBytes: Number(row.net_out_bytes),
        diskReadBytes: Number(row.diskread_bytes || 0),
        diskWriteBytes: Number(row.diskwrite_bytes || 0)
      };
      if (time > twentyFourHoursAgo) {
        currentPeriod.push(pt);
      } else {
        previousPeriod.push(pt);
      }
    });

    // Calculations
    const calcAvg = (arr: TelemetryPoint[], key: NumericTelemetryKey) => arr.length ? arr.reduce((acc, curr) => acc + curr[key], 0) / arr.length : 0;
    const calcMax = (arr: TelemetryPoint[], key: NumericTelemetryKey) => arr.length ? Math.max(...arr.map(x => x[key])) : 0;
    const calcMin = (arr: TelemetryPoint[], key: NumericTelemetryKey) => arr.length ? Math.min(...arr.map(x => x[key])) : 0;
    
    const cpuAvgCurrent = calcAvg(currentPeriod, 'cpuPct');
    const cpuAvgPrev = calcAvg(previousPeriod, 'cpuPct');
    const memAvgCurrent = calcAvg(currentPeriod, 'ramBytes');
    const memAvgPrev = calcAvg(previousPeriod, 'ramBytes');

    const getNetDiff = (arr: TelemetryPoint[], key: NumericTelemetryKey) => {
      if (arr.length < 2) return 0;
      // It's cumulative, so last - first
      const diff = arr[arr.length - 1][key] - arr[0][key];
      return diff > 0 ? diff : 0; // Handle reboots where counter resets to 0
    };

    const netInCurrent = getNetDiff(currentPeriod, 'netInBytes');
    const netInPrev = getNetDiff(previousPeriod, 'netInBytes');
    const netOutCurrent = getNetDiff(currentPeriod, 'netOutBytes');
    const netOutPrev = getNetDiff(previousPeriod, 'netOutBytes');
    const diskReadCurrent = getNetDiff(currentPeriod, 'diskReadBytes');
    const diskWriteCurrent = getNetDiff(currentPeriod, 'diskWriteBytes');

    const calcDelta = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : 0;

    // Downsample to hourly buckets for smooth chart rendering (max ~48 points)
    const bucketKey = (ts: string) => new Date(ts).toISOString().slice(0, 13);
    const bucket = (arr: TelemetryPoint[]) => {
      const map = new Map<string, TelemetryBucket>();
      arr.forEach(pt => {
        const k = bucketKey(pt.timestamp);
        if (!map.has(k)) map.set(k, { cpuPct: [], ramBytes: [], netInBytes: 0, netOutBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, count: 0 });
        const b = map.get(k);
        if (!b) return;
        b.cpuPct.push(pt.cpuPct);
        b.ramBytes.push(pt.ramBytes);
        b.count++;
      });
      // Cumulative deltas inside bucket from first sample
      arr.forEach(pt => {
        const k = bucketKey(pt.timestamp);
        const b = map.get(k);
        if (!b) return;
        b.netInBytes = pt.netInBytes;
        b.netOutBytes = pt.netOutBytes;
        b.diskReadBytes = pt.diskReadBytes;
        b.diskWriteBytes = pt.diskWriteBytes;
      });
      return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, b]) => {
        const bucketSamples = arr.filter(point => bucketKey(point.timestamp) === k);
        const first = bucketSamples[0];
        const last = bucketSamples[bucketSamples.length - 1];
        if (!first || !last) return null;

        const sampleIntervalSeconds = Math.max(0, (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 1000);
        const hasMeasuredInterval = bucketSamples.length > 1 && sampleIntervalSeconds > 0;
        const nIn = hasMeasuredInterval ? Math.max(0, last.netInBytes - first.netInBytes) : 0;
        const nOut = hasMeasuredInterval ? Math.max(0, last.netOutBytes - first.netOutBytes) : 0;
        const dR = hasMeasuredInterval ? Math.max(0, last.diskReadBytes - first.diskReadBytes) : 0;
        const dW = hasMeasuredInterval ? Math.max(0, last.diskWriteBytes - first.diskWriteBytes) : 0;

        return {
          timestamp: new Date(k + ':00:00Z').toISOString(),
          sampleIntervalSeconds,
          cpuPct: Number((b.cpuPct.reduce((a: number, c: number) => a + c, 0) / b.count).toFixed(2)),
          peakCpuPct: Number(Math.max(...b.cpuPct).toFixed(2)),
          ramBytes: Math.round(b.ramBytes.reduce((a: number, c: number) => a + c, 0) / b.count),
          peakRamBytes: Math.max(...b.ramBytes),
          netInBytes: nIn,
          netOutBytes: nOut,
          diskReadBytes: dR,
          diskWriteBytes: dW
        };
      }).filter((item): item is NonNullable<typeof item> => item !== null);
    };
    const bucketedHistory = bucket(currentPeriod);

    res.json({
      success: true,
      history: bucketedHistory, // Hourly-bucketed 24h for chart rendering
      aggregations: {
        cpu: { 
          average: cpuAvgCurrent, 
          peak: calcMax(currentPeriod, 'cpuPct'),
          min: calcMin(currentPeriod, 'cpuPct'),
          deltaPct: calcDelta(cpuAvgCurrent, cpuAvgPrev) 
        },
        mem: { 
          averageGb: memAvgCurrent / 1073741824, 
          peakGb: calcMax(currentPeriod, 'ramBytes') / 1073741824,
          deltaPct: calcDelta(memAvgCurrent, memAvgPrev) 
        },
        netIn: { 
          totalGb: netInCurrent / 1073741824, 
          deltaPct: calcDelta(netInCurrent, netInPrev) 
        },
        netOut: { 
          totalGb: netOutCurrent / 1073741824, 
          deltaPct: calcDelta(netOutCurrent, netOutPrev) 
        },
        diskRead: { totalGb: diskReadCurrent / 1073741824 },
        diskWrite: { totalGb: diskWriteCurrent / 1073741824 }
      }
    });
  } catch(err: any) {
    res.json({ success: false, error: err.message, history: [], aggregations: null });
  }
});

// 2.6. GET /api/client/vms/:vmid/export — Export VM telemetry history as CSV or JSON
clientRouter.get('/vms/:vmid/export', requireClientVmScope('readonly'), async (req, res) => {
  try {
    const vmid = parseInt(String(req.params.vmid), 10);
    const format = (req.query.format as string) || 'json';
    const range = (req.query.range as string) || '24h';
    const hours = range === '7d' ? 168 : range === '1h' ? 1 : 24;

    const vm = await dbService.getVMByVMID(vmid);
    if (!vm) return res.status(404).json({ success: false, error: `VMID ${vmid} not found` });

    const raw = await dbService.getVmTelemetryHistory(vmid, hours);
    const rows = raw.map((r: any) => ({
      timestamp: new Date(r.timestamp).toISOString(),
      cpuPct: Number(r.cpu_pct),
      ramBytes: Number(r.ram_bytes),
      ramPct: vm.maxmem ? Number((Number(r.ram_bytes) / Number(vm.maxmem) * 100).toFixed(2)) : 0,
      netInBytes: Number(r.net_in_bytes),
      netOutBytes: Number(r.net_out_bytes),
      diskReadBytes: Number(r.diskread_bytes || 0),
      diskWriteBytes: Number(r.diskwrite_bytes || 0),
    }));

    if (format === 'csv') {
      const header = 'timestamp,cpu_pct,ram_bytes,ram_pct,net_in_bytes,net_out_bytes,disk_read_bytes,disk_write_bytes';
      const lines = rows.map(r =>
        `${r.timestamp},${r.cpuPct.toFixed(2)},${r.ramBytes},${r.ramPct},${r.netInBytes},${r.netOutBytes},${r.diskReadBytes},${r.diskWriteBytes}`
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="vm-${vmid}-telemetry-${range}-${Date.now()}.csv"`);
      res.send([header, ...lines].join('\n'));
      return;
    }
    res.json({ success: true, format, range, vmid, name: vm.name, rows: rows.length, data: rows });
  } catch (err: any) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

// 3. POST /api/client/vms/:vmid/power — Accept action (start | stop | shutdown | reboot)
// STRICT SAFETY CHECK: If is_suspended === true, BLOCK request and return HTTP 403
clientRouter.post('/vms/:vmid/power', requireClientVmScope('power'), async (req, res) => {
  const userEmail = (req as any).authUser?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: 'Authentication required' });
  const vmid = parseInt(String(req.params.vmid), 10);
  const { action } = req.body;
  const allowedActions = new Set(['start', 'stop', 'shutdown', 'reboot']);
  if (!allowedActions.has(action)) {
    return res.status(400).json({ success: false, error: 'Unsupported power action. Use start, stop, shutdown, or reboot.' });
  }

  const vm = (req as any).authorizedVm || (await dbService.getVMByVMID(vmid, (req as any).body?.proxmoxConnectionId));
  if (!vm) {
    return res.status(404).json({ success: false, error: `Proxmox VMID ${vmid} not found` });
  }

  // STRICT SAFETY CHECK FOR EXPIRY SUSPENSION
  if (vm.isSuspended) {
    return res.status(403).json({
      success: false,
      error: 'Server is suspended due to expiration. Power actions are disabled until renewal.',
      isSuspended: true,
      vmid,
      expiryDate: vm.expiryDate,
    });
  }

  try {
    const updated = await proxmoxService.executePowerAction(vm.node, vmid, action, userEmail, vm.proxmoxConnectionId);
    res.json({
      success: true,
      message: `Power action ${action ? action.toUpperCase() : 'START'} executed for VMID ${vmid}`,
      data: updated,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || `Failed to execute ${action}` });
  }
});

// --- FIREWALL ENDPOINTS ---

// GET /api/v1/client/vms/:vmid/firewall — uses Proxmox live rules when a connection exists, otherwise falls back to the local rule store so the panel stays functional
clientRouter.get('/vms/:vmid/firewall', requireClientVmScope('readonly'), async (req, res) => {
  const vmid = parseInt(String(req.params.vmid), 10);
  try {
    const vm = (req as any).authorizedVm;
    if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });

    const conn = await getConnectionForVm(vm);
    const headers = { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` };

    // Fetch Options (to check if firewall is enabled)
    const optRes = await proxmoxFetch(getVmEndpoint(conn, vm, 'firewall/options'), {
      method: 'GET',
      headers,
      sslFingerprint: conn.ssl_fingerprint,
    });
    let options: Record<string, unknown> = {};
    if (optRes.ok) {
      const optJson = await readPveJson<PveEnvelope<Record<string, unknown>>>(optRes);
      options = optJson?.data || {};
    }

    // Fetch Rules
    const rulesRes = await proxmoxFetch(getVmEndpoint(conn, vm, 'firewall/rules'), {
      method: 'GET',
      headers,
      sslFingerprint: conn.ssl_fingerprint,
    });
    let rules: Array<Record<string, unknown>> = [];
    if (rulesRes.ok) {
      const rulesJson = await readPveJson<PveEnvelope<Array<Record<string, unknown>>>>(rulesRes);
      rules = rulesJson?.data || [];
    }

    res.json({ success: true, options, rules });
  } catch (err: any) {
    res.status(503).json({
      success: false,
      error: err?.message || 'Live firewall data is currently unavailable',
      options: {},
      rules: [],
    });
  }
});

// POST /api/v1/client/vms/:vmid/firewall/toggle
clientRouter.post('/vms/:vmid/firewall/toggle', requireClientVmScope('full'), async (req, res) => {
  try {
    const vmid = parseInt(String(req.params.vmid), 10);
    const { enable } = req.body;
    const vm = (req as any).authorizedVm;
    if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });

    const conn = await getConnectionForVm(vm);
    const headers = {
      'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const params = new URLSearchParams();
    params.append('enable', enable ? '1' : '0');

    const pveRes = await proxmoxFetch(getVmEndpoint(conn, vm, 'firewall/options'), {
      method: 'PUT',
      headers,
      body: params.toString(),
      sslFingerprint: conn.ssl_fingerprint,
    });

    if (!pveRes.ok) throw new Error('Failed to toggle firewall in Proxmox');
    await dbService.setVmFirewallOptions(vmid, { enabled: enable === true });
    res.json({ success: true });
  } catch (err: any) {
    res.status(503).json({ success: false, error: err.message || 'Unable to update firewall state' });
  }
});

// POST /api/v1/client/vms/:vmid/firewall
clientRouter.post('/vms/:vmid/firewall', requireClientVmScope('full'), async (req, res) => {
  try {
    const vmid = parseInt(String(req.params.vmid), 10);
    const { action, type, proto, dport, enable, comment } = req.body;
    const vm = (req as any).authorizedVm;
    if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });

    const conn = await getConnectionForVm(vm);
    const headers = {
      'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const params = new URLSearchParams();
    params.append('action', action || 'ACCEPT');
    params.append('type', type || 'in');
    params.append('enable', enable === false ? '0' : '1');
    if (proto) params.append('proto', proto);
    if (dport) params.append('dport', dport);
    if (comment) params.append('comment', comment);

    const pveRes = await proxmoxFetch(getVmEndpoint(conn, vm, 'firewall/rules'), {
      method: 'POST',
      headers,
      body: params.toString(),
      sslFingerprint: conn.ssl_fingerprint,
    });

    if (!pveRes.ok) {
      throw new Error('Failed to create rule in Proxmox');
    }
    // Mirror the rule in the local store so the panel stays consistent when the connection drops
    await dbService.addVmFirewallRule(vmid, { ruleType: type || 'in', action: action || 'ACCEPT', proto, dport, enable: enable !== false, comment });
    res.json({ success: true });
  } catch (err: any) {
    res.status(503).json({ success: false, error: err.message || 'Unable to create firewall rule' });
  }
});

// DELETE /api/v1/client/vms/:vmid/firewall/:pos
clientRouter.delete('/vms/:vmid/firewall/:pos', requireClientVmScope('full'), async (req, res) => {
  try {
    const vmid = parseInt(String(req.params.vmid), 10);
    const pos = parseInt(String(req.params.pos), 10);
    const vm = (req as any).authorizedVm;
    if (!vm) return res.status(404).json({ success: false, error: 'VM not found' });

    const conn = await getConnectionForVm(vm);
    const headers = { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` };

    const pveRes = await proxmoxFetch(getVmEndpoint(conn, vm, `firewall/rules/${pos}`), {
      method: 'DELETE',
      headers,
      sslFingerprint: conn.ssl_fingerprint,
    });

    if (!pveRes.ok) throw new Error('Failed to delete rule from Proxmox');
    await dbService.removeVmFirewallRule(vmid, pos);
    res.json({ success: true });
  } catch (err: any) {
    res.status(503).json({ success: false, error: err.message || 'Unable to delete firewall rule' });
  }
});

// --- OVH Cloud Integration Routes ---

const requireOvhEnabled = (_req: any, res: any, next: any) => {
  if (!ovhService.isEnabled()) {
    return res.status(503).json({ success: false, error: 'OVH API integration is not enabled or configured by administrator' });
  }
  next();
};

const getVmIp = async (vm: any): Promise<string> => {
  try {
    const conn = await getConnectionForVm(vm);
    const headers = { 'Authorization': `PVEAPIToken=${conn.token_id}=${conn.token_secret}` };
    const resourceType = vm.type === 'lxc' ? 'lxc' : 'qemu';
    const url = `https://${conn.host_ip}:${conn.port || 8006}/api2/json/nodes/${vm.node}/${resourceType}/${vm.vmid}/config`;
    const response = await proxmoxFetch(url, { headers, sslFingerprint: conn.ssl_fingerprint });
    if (response.ok) {
      const json = await response.json() as { data?: Record<string, any> };
      const config = json.data || {};
      
      const ipconfigKey = Object.keys(config).find(key => /^ipconfig\d+$/.test(key));
      if (ipconfigKey && config[ipconfigKey]) {
        const parts = String(config[ipconfigKey]).split(',');
        const ipPart = parts.find(part => part.trim().toLowerCase().startsWith('ip='));
        if (ipPart) {
          const ipVal = ipPart.split('=')[1]?.trim().split('/')[0];
          if (ipVal && !/^(dhcp|manual|auto|none)$/i.test(ipVal) && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ipVal)) {
            return ipVal;
          }
        }
      }

      if (config.net0) {
        const parts = String(config.net0).split(',');
        const ipPart = parts.find(part => part.trim().toLowerCase().startsWith('ip='));
        if (ipPart) {
          const ipVal = ipPart.split('=')[1]?.trim().split('/')[0];
          if (ipVal && !/^(dhcp|manual|auto|none)$/i.test(ipVal) && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ipVal)) {
            return ipVal;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[OVH SYNC IP] Failed to fetch config from Proxmox for VM ${vm.vmid}, falling back to DB IP:`, err);
  }

  const rawIp = String(vm.ipAddress || '').trim();
  if (!rawIp) {
    throw new Error('This VM does not have a public IP address configured in the database or Proxmox');
  }
  const firstIp = rawIp.split(/[\s,]+/)[0];
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(firstIp)) {
    throw new Error(`The VM's IP address '${firstIp}' is not a valid IPv4 address for OVH controls`);
  }
  return firstIp;
};

clientRouter.get('/vms/:vmid/ovh/status', requireClientVmScope('readonly'), requireOvhEnabled, async (req: any, res) => {
  try {
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const [reverse, ddos, firewall] = await Promise.all([
      ovhService.getReverse(ip).catch(() => null),
      ovhService.getDdosState(ip).catch(() => ({ state: 'unknown', mode: 'automatic' as const })),
      ovhService.getFirewallState(ip).catch(() => ({ enabled: false, state: 'unknown' })),
    ]);
    res.json({ success: true, data: { ip, reverse, ddos, firewall } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.post('/vms/:vmid/ovh/rdns', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const { reverse } = req.body;
    await ovhService.setReverse(ip, String(reverse || '').trim());
    res.json({ success: true, message: 'Reverse DNS update request submitted to OVH successfully' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.post('/vms/:vmid/ovh/ddos', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const { mode } = req.body;
    if (mode !== 'automatic' && mode !== 'permanent') {
      return res.status(400).json({ success: false, error: 'Invalid DDoS mode' });
    }
    await ovhService.setDdosMitigation(ip, mode);
    res.json({ success: true, message: `DDoS mitigation mode updated to ${mode} successfully` });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.post('/vms/:vmid/ovh/firewall/toggle', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const { enabled } = req.body;
    await ovhService.toggleFirewall(ip, Boolean(enabled));
    res.json({ success: true, message: `OVH Edge Firewall ${enabled ? 'enabled' : 'disabled'} successfully` });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.get('/vms/:vmid/ovh/firewall/rules', requireClientVmScope('readonly'), requireOvhEnabled, async (req: any, res) => {
  try {
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const rules = await ovhService.getFirewallRules(ip);
    res.json({ success: true, data: rules });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.post('/vms/:vmid/ovh/firewall/rules', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const { sequence, action, protocol, sourcePort, destinationPort, source } = req.body;
    if (typeof sequence !== 'number' || sequence < 0 || sequence > 99) {
      return res.status(400).json({ success: false, error: 'Sequence number must be between 0 and 99' });
    }
    if (action !== 'permit' && action !== 'deny') {
      return res.status(400).json({ success: false, error: 'Action must be permit or deny' });
    }
    if (!['tcp', 'udp', 'icmp', 'ipv4'].includes(protocol)) {
      return res.status(400).json({ success: false, error: 'Protocol must be tcp, udp, icmp, or ipv4' });
    }
    await ovhService.createFirewallRule(ip, {
      sequence,
      action,
      protocol,
      sourcePort: sourcePort || undefined,
      destinationPort: destinationPort || undefined,
      source: source || undefined
    });
    res.json({ success: true, message: 'Edge Firewall rule created successfully' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.delete('/vms/:vmid/ovh/firewall/rules/:sequence', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const sequence = parseInt(req.params.sequence, 10);
    if (isNaN(sequence)) {
      return res.status(400).json({ success: false, error: 'Invalid sequence number' });
    }
    await ovhService.deleteFirewallRule(ip, sequence);
    res.json({ success: true, message: 'Edge Firewall rule deleted successfully' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.get('/vms/:vmid/ovh/game-ddos', requireClientVmScope('readonly'), requireOvhEnabled, async (req: any, res) => {
  try {
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const rules = await ovhService.getGameDdosRules(ip);
    res.json({ success: true, data: rules });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.post('/vms/:vmid/ovh/game-ddos', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const { port, protocol, game } = req.body;
    if (typeof port !== 'number' || port < 1 || port > 65535) {
      return res.status(400).json({ success: false, error: 'Port must be between 1 and 65535' });
    }
    if (protocol !== 'tcp' && protocol !== 'udp') {
      return res.status(400).json({ success: false, error: 'Protocol must be tcp or udp' });
    }
    if (!game || typeof game !== 'string') {
      return res.status(400).json({ success: false, error: 'Game profile is required' });
    }
    await ovhService.createGameDdosRule(ip, { port, protocol, game });
    res.json({ success: true, message: 'Game DDoS port profile created successfully' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

clientRouter.delete('/vms/:vmid/ovh/game-ddos/:ruleId', requireClientVmScope('full'), requireOvhEnabled, async (req: any, res) => {
  try {
    const isAdmin = ['administrator', 'admin', 'moderator'].includes(req.authUser?.role || '');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only administrators are authorized to modify OVH network configurations.' });
    }
    const vm = req.authorizedVm;
    const ip = await getVmIp(vm);
    const ruleId = parseInt(req.params.ruleId, 10);
    if (isNaN(ruleId)) {
      return res.status(400).json({ success: false, error: 'Invalid rule ID' });
    }
    await ovhService.deleteGameDdosRule(ip, ruleId);
    res.json({ success: true, message: 'Game DDoS port profile rule deleted successfully' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/v1/client/vms/:vmid/cloud-init/sync-ssh
clientRouter.post('/vms/:vmid/cloud-init/sync-ssh', requireClientVmScope('full'), async (req, res) => {
  try {
    const vm = (req as any).authorizedVm;
    if (vm.type !== 'qemu') {
      return res.status(400).json({ success: false, error: 'Cloud-Init SSH injection is only supported for QEMU virtual machines.' });
    }
    
    // Get the user's SSH keys
    const userEmail = (req as any).authUser?.email;
    const user = await dbService.findUserByEmail(userEmail);
    if (!user || !user.ssh_keys || user.ssh_keys.trim() === '') {
      return res.status(400).json({ success: false, error: 'No SSH keys found in your profile. Please add them in Account Settings -> Security.' });
    }

    const conns = await dbService.getProxmoxConnectionCredentials();
    const c = vm.proxmoxConnectionId
      ? conns.find((conn: any) => String(conn.id) === String(vm.proxmoxConnectionId))
      : conns[0];
      
    if (!c) {
      return res.status(500).json({ success: false, error: 'No Proxmox connection configured.' });
    }

    const cleanHost = String(c.host_ip || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${cleanHost}:${c.port || 8006}/api2/json/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/config`;
    
    // URL Encode the SSH keys as required by application/x-www-form-urlencoded
    const formData = new URLSearchParams();
    // Proxmox requires sshkeys to be URI encoded within the form data
    formData.append('sshkeys', encodeURIComponent(user.ssh_keys.trim()));
    
    const headers = { 
      'Authorization': `PVEAPIToken=${c.token_id}=${c.token_secret}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    const putRes = await proxmoxFetch(url, {
      method: 'POST',
      headers,
      body: formData.toString(),
      sslFingerprint: c.ssl_fingerprint
    });
    
    if (!putRes.ok) {
      const errorText = await putRes.text();
      return res.status(500).json({ success: false, error: 'Unable to deploy SSH public keys: ' + errorText });
    }

    res.json({ success: true, message: 'SSH keys deployed successfully. Please restart your server to apply changes.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/client/vms/:vmid/password
clientRouter.post('/vms/:vmid/password', requireClientVmScope('full'), async (req, res) => {
  try {
    const vm = (req as any).authorizedVm;
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password is required' });
    }

    const conns = await dbService.getProxmoxConnectionCredentials();
    const c = vm.proxmoxConnectionId
      ? conns.find((conn: any) => String(conn.id) === String(vm.proxmoxConnectionId))
      : conns[0];
      
    if (!c) {
      return res.status(500).json({ success: false, error: 'No Proxmox connection configured.' });
    }

    const cleanHost = String(c.host_ip || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const baseUrl = `https://${cleanHost}:${c.port || 8006}/api2/json/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}`;
    const headers = { 
      'Authorization': `PVEAPIToken=${c.token_id}=${c.token_secret}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    // 1. Always set cipassword
    const ciForm = new URLSearchParams();
    ciForm.append('cipassword', password);
    
    await proxmoxFetch(`${baseUrl}/config`, {
      method: 'POST',
      headers,
      body: ciForm.toString(),
      sslFingerprint: c.ssl_fingerprint
    });

    // 2. Attempt Live Password injection via QEMU Guest Agent (like Convoy does)
    let agentResult = 'Live update not available';
    let isLiveUpdated = false;
    
    try {
      const osInfoRes = await proxmoxFetch(`${baseUrl}/agent/get-osinfo`, {
        method: 'GET',
        headers,
        sslFingerprint: c.ssl_fingerprint
      });
      
      if (osInfoRes.ok) {
        const osInfo = (await osInfoRes.json()) as any;
        const osName = String(osInfo.data?.result?.name || '').toLowerCase();
        const username = osName.includes('windows') ? 'Administrator' : 'root';

        const agentForm = new URLSearchParams();
        agentForm.append('username', username);
        agentForm.append('password', password);

        const agentRes = await proxmoxFetch(`${baseUrl}/agent/set-user-password`, {
          method: 'POST',
          headers,
          body: agentForm.toString(),
          sslFingerprint: c.ssl_fingerprint
        });

        if (agentRes.ok) {
          isLiveUpdated = true;
          agentResult = `Live update successful (${username})`;
        } else {
          agentResult = `Agent Error: ${await agentRes.text()}`;
        }
      }
    } catch (e: any) {
      agentResult = e.message;
    }

    res.json({ 
      success: true, 
      message: isLiveUpdated ? 'Password updated successfully.' : 'Password updated. Please restart your server to apply changes.',
      liveUpdated: isLiveUpdated,
      agentResult
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
