import { Router } from 'express';
import { dbService } from '../db/database.js';
import { requireAuth } from '../middleware.js';
import { ProxmoxHttpError, proxmoxFetch } from '../services/proxmoxHttp.js';

export const vncRouter = Router();
vncRouter.use(requireAuth);

const adminRoles = new Set(['administrator', 'admin', 'moderator']);


// 1. POST /api/vnc/init -> acquires VNC ticket and port from Proxmox
vncRouter.post('/init', async (req, res) => {
  try {
        const { vmid } = req.body;
    if (!vmid) {
      return res.status(400).json({ success: false, error: 'vmid is required' });
    }
    const vm = await dbService.getVMByVMID(Number(vmid));
    if (!vm) return res.status(404).json({ success: false, error: `Proxmox VMID ${vmid} not found` });
    const user = (req as any).authUser;
    if (!user || (!adminRoles.has(user.role) && String(vm.ownerEmail).toLowerCase() !== String(user.email).toLowerCase())) {
      return res.status(403).json({ success: false, error: 'You do not have access to this VM' });
    }
    const type = vm.type;
    const node = vm.node;

    const conns = await dbService.getProxmoxConnections();
    if (!conns || conns.length === 0) {
      return res.status(500).json({ success: false, error: 'No Proxmox connection configured.' });
    }

    const c = conns[0];
    const host = c.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const port = c.port || 8006;
    const token = `PVEAPIToken=${c.token_id}=${c.token_secret}`;

    // Use the node and type stored for the authorized VM; never trust caller-supplied routing fields.
    const nodePath = node;

    // Ask Proxmox to prepare a websocket-capable VNC proxy. Without both
    // parameters, PVE may open a plain VNC listener that cannot complete the
    // later vncwebsocket upgrade used by noVNC.
    const proxyBody = 'websocket=1&generate-password=1';
    const proxyResponse = await proxmoxFetch(`https://${host}:${port}/api2/json/nodes/${nodePath.replace(/ /g, '%20')}/${type}/${vmid}/vncproxy`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: proxyBody,
      sslFingerprint: c.ssl_fingerprint,
    });
    const proxyData = await proxyResponse.text();

    if (proxyResponse.status === 401 || proxyResponse.status === 403) {
      return res.status(401).json({
        success: false,
        error: 'API Token Unauthorized for console relay. The token lacks console privileges.',
      });
    }

    if (!proxyResponse.ok) {
      return res.status(500).json({
        success: false,
        error: `Console relay error (HTTP ${proxyResponse.status}): ${proxyData}`,
      });
    }

    try {
      const json = JSON.parse(proxyData);
      if (json.data && json.data.ticket) {
        return res.json({
          success: true,
          data: {
            ticket: json.data.ticket,
            password: json.data.password || json.data.ticket,
            port: json.data.port,
            host,
            apiPort: port,
          },
        });
      }
      return res.status(500).json({ success: false, error: 'Failed to allocate a console session ticket.' });
    } catch {
      return res.status(500).json({ success: false, error: 'Invalid response from Proxmox vncproxy.' });
    }
  } catch (e: any) {
    const code = String(e?.code || e?.cause?.code || '');
    const detail = `${e?.message || ''} ${code}`;
    const isTlsFailure = e instanceof ProxmoxHttpError || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|FINGERPRINT/i.test(detail);
    const isNetworkFailure = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(detail);
    res.status(500).json({
      success: false,
      error: isTlsFailure
        ? 'Proxmox TLS verification failed. Confirm that the saved SHA-256 SSL fingerprint matches the server certificate.'
        : isNetworkFailure
          ? 'Network error reaching the console relay service.'
          : (e?.message || 'Failed to initialize the VNC console.'),
    });
  }
});
