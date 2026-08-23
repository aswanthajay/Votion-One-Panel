import { Router } from 'express';
import { dbService } from '../db/database.js';
import https from 'https';
import { requireAuth } from '../middleware.js';

export const vncRouter = Router();
vncRouter.use(requireAuth);

const adminRoles = new Set(['administrator', 'admin', 'moderator']);

// Minimal global cache for the PVEAuthCookie
export const vncCookieCache = new Map<string, { cookie: string, csrf: string, expiresAt: number }>();

async function getAuthCookie(host: string, port: number, username: string, password: string): Promise<any> {
  const cacheKey = `${host}:${port}:${username}`;
  const cached = vncCookieCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached;
  
  return new Promise((resolve, reject) => {
    const postData = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const req = https.request({
      hostname: host,
      port: port,
      path: '/api2/json/access/ticket',
      method: 'POST',
      rejectUnauthorized: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data) {
            const ticketData = {
              cookie: `PVEAuthCookie=${json.data.ticket}`,
              csrf: json.data.CSRFPreventionToken,
              expiresAt: Date.now() + 1000 * 60 * 60 // 1 hr cache
            };
            vncCookieCache.set(cacheKey, ticketData);
            resolve(ticketData);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

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

    // Call POST /vncproxy to generate ticket using API Token
    return new Promise((resolve) => {
      const vncproxyReq = https.request({
        hostname: host,
        port: port,
        path: `/api2/json/nodes/${nodePath.replace(/ /g, '%20')}/${type}/${vmid}/vncproxy`,
        method: 'POST',
        rejectUnauthorized: true,
        headers: {
          'Authorization': token,
          'Content-Length': '0' // Important for POST requests without body
        }
      }, (proxyRes) => {
        let proxyData = '';
        proxyRes.on('data', d => proxyData += d);
        proxyRes.on('end', () => {
          if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
            res.status(401).json({ 
              success: false, 
              error: 'API Token Unauthorized for console relay. The token lacks console privileges.' 
            });
            return resolve(null);
          }

          if (proxyRes.statusCode !== 200) {
            res.status(500).json({ 
              success: false, 
              error: `Console relay error (HTTP ${proxyRes.statusCode}): ${proxyData}` 
            });
            return resolve(null);
          }

          try {
            const json = JSON.parse(proxyData);
            if (json.data && json.data.ticket) {
              res.json({
                success: true,
                data: {
                  ticket: json.data.ticket,
                  port: json.data.port,
                  host,
                  apiPort: port
                }
              });
              resolve(null);
            } else {
              res.status(500).json({ success: false, error: 'Failed to allocate a console session ticket.', details: json });
              resolve(null);
            }
          } catch (e) {
            res.status(500).json({ success: false, error: 'Invalid response from Proxmox vncproxy: ' + proxyData });
            resolve(null);
          }
        });
      });
      vncproxyReq.on('error', (e) => {
        res.status(500).json({ success: false, error: 'Network error reaching the console relay service.' });
        resolve(null);
      });
      vncproxyReq.end();
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});
