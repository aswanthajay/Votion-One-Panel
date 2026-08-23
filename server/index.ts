import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { clientRouter } from './routes/client.js';
import { ticketRouter } from './routes/tickets.js';
import { vncRouter, vncCookieCache } from './routes/vnc.js';
import { expiryWorker } from './jobs/expiryWorker.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { WebSocketServer, WebSocket } from 'ws';
import { dbService } from './db/database.js';
import { proxmoxApi } from './services/proxmox.js';
import { proxmoxSync } from './services/proxmoxSync.js';
import { resolveSessionUser } from './middleware.js';
import https from 'https';

let ticketCache: { cookie: string, csrf: string, expiresAt: number } | null = null;

async function getProxmoxTicket(host: string, port: number, username: string, password: string): Promise<any> {
  if (ticketCache && Date.now() < ticketCache.expiresAt) return ticketCache;
  
  return new Promise((resolve) => {
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
            ticketCache = {
              cookie: `PVEAuthCookie=${json.data.ticket}`,
              csrf: json.data.CSRFPreventionToken,
              expiresAt: Date.now() + 1000 * 60 * 60 // 1 hour cache
            };
            resolve(ticketCache);
          } else resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = (process.env.CORS_ORIGINS || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000,http://127.0.0.1:3000'))
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// API Router Registrations
app.use('/api/v1', apiRouter);
app.use('/api/admin', adminRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/client', clientRouter);
app.use('/api/v1/client', clientRouter);
app.use('/api/tickets', ticketRouter);
app.use('/api/v1/tickets', ticketRouter);

app.use('/api/vnc', vncRouter);
app.use('/api/v1/vnc', vncRouter);

// Cache connection for synchronous WS proxy routing
let cachedConn: any = null;
dbService.getProxmoxConnections().then(conns => {
  if (conns && conns.length > 0) cachedConn = conns[0];
}).catch(() => {});

// Native WebSocket relay to Proxmox (http-proxy's util._extend is deprecated and
// throws on Node 22, crashing the whole server on every WS upgrade).
const vncWss = new WebSocketServer({ noServer: true });
vncWss.on('connection', (clientWs) => {
  // Client-side frame handlers are attached below when the upstream socket connects
  (clientWs as any).__upstream = null;
});

// Proxmox noVNC Proxy
const proxmoxProxy = createProxyMiddleware({
  secure: true,
  router: async (req: any) => {
    try {
      const conns = await dbService.getProxmoxConnections();
      if (conns && conns.length > 0) {
        const c = conns[0];
        const cleanHost = c.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const port = c.port || 8006;
        
        if (c.username && c.password) {
          const ticket = await getProxmoxTicket(cleanHost, port, c.username, c.password);
          if (ticket) {
            req.pveCookie = ticket.cookie;
            req.pveCsrf = ticket.csrf;
          }
        }
        
        req.proxmoxAuth = `PVEAPIToken=${c.token_id}=${c.token_secret}`;
        return `https://${cleanHost}:${port}`;
      }
    } catch (err) {
      console.error('[PROXY] Failed to fetch Proxmox connection', err);
    }
    return 'https://localhost:8006';
  },
  pathRewrite: (path, req: any) => {
    if (req.baseUrl === '/proxmox-console') {
      return path;
    }
    return req.baseUrl + path;
  },
  on: {
    proxyReq: (proxyReq: any, req: any) => {
      if (req.pveCookie) {
        proxyReq.setHeader('Cookie', req.pveCookie);
        proxyReq.setHeader('CSRFPreventionToken', req.pveCsrf);
      } else if (req.proxmoxAuth) {
        proxyReq.setHeader('Authorization', req.proxmoxAuth);
      }
    },
    proxyReqWs: (proxyReq: any, req: any) => {
      if (req.pveCookie) {
        proxyReq.setHeader('Cookie', req.pveCookie);
        proxyReq.setHeader('CSRFPreventionToken', req.pveCsrf);
      } else if (req.proxmoxAuth) {
        proxyReq.setHeader('Authorization', req.proxmoxAuth);
      }
    }
  }
});

app.use('/novnc', proxmoxProxy);
app.use('/api2', proxmoxProxy);
app.use('/pve2', proxmoxProxy);
app.use('/proxmox-console', proxmoxProxy);

// Start Automated Background Expiry Worker Cron Job
expiryWorker.start();
proxmoxSync.start();

const server = app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`🚀 VOTION ONE Platform Backend Server running on port ${PORT}`);
  console.log(`👉 API Endpoint: http://localhost:${PORT}/api/v1/health`);
  console.log(`🗄️ Database: PostgreSQL + TimescaleDB (TSDB) Telemetry Layer`);
  console.log(`🔐 Proxmox API Auth: PVEAPIToken=root@pam!votion_token`);
  console.log(`🎫 Support Ticket Router: Active (/api/tickets)`);
  console.log(`⏰ Expiry Worker: Active (10s interval sweep)`);
  console.log(`================================================================`);
});

server.on('upgrade', async (req: any, socket: any, head: any) => {
  console.log('[HTTP SERVER] Upgrade request received for URL:', req.url);
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  let sessionToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!sessionToken && typeof req.headers.cookie === 'string') {
    const cookieMatch = req.headers.cookie.match(/(?:^|;\s*)votion_auth_token=([^;]+)/);
    sessionToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  }
  const sessionUser = await resolveSessionUser(sessionToken);
  if (!sessionUser) {
    socket.destroy();
    return;
  }
  if (req.url?.startsWith('/api/vnc/ws') || req.url?.startsWith('/api/v1/vnc/ws')) {
    if (!cachedConn) {
      socket.destroy();
      return;
    }
    const cleanHost = cachedConn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const pvePort = cachedConn.port || 8006;
    req.proxmoxAuth = `PVEAPIToken=${cachedConn.token_id}=${cachedConn.token_secret}`;
    
    try {
      const url = new URL(req.url, 'http://localhost');
      // Normalize pseudo-node names. PVE's special 'info' node (the current host)
      // is valid for node-scoped API calls, so keep it. Only resolve the cluster
      // name ('pve-votion-cluster' — not a valid node path) to the real hosting
      // node via the live cluster/resources list.
      let node = url.searchParams.get('node');
      if (node && /pve-votion-cluster/i.test(node)) {
        try {
          const cleanH = cachedConn.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const pP = cachedConn.port || 8006;
          const resInfo = await fetch(`https://${cleanH}:${pP}/api2/json/cluster/resources?type=vm`, {
            method: 'GET',
            headers: { 'Authorization': req.proxmoxAuth }
          });
          if (resInfo.ok) {
            const jsonInfo = await resInfo.json();
            const match = (jsonInfo.data || []).find((v: any) => Number(v.vmid) === Number(url.searchParams.get('vmid')));
            if (match && match.node) node = match.node;
          }
        } catch (_e) {}
        if (!node || /pve-votion-cluster/i.test(node)) node = 'info';
      }
      if (!node) node = 'info';
      const vmid = url.searchParams.get('vmid');
      const requestedVm = vmid ? await dbService.getVMByVMID(Number(vmid)) : null;
      const sessionIsAdmin = ['administrator', 'admin', 'moderator'].includes(sessionUser.role);
      if (!requestedVm || (!sessionIsAdmin && String(requestedVm.ownerEmail).toLowerCase() !== String(sessionUser.email).toLowerCase())) {
        socket.destroy();
        return;
      }
      const vncport = url.searchParams.get('port');
      const ticket = url.searchParams.get('ticket');
      const type = url.searchParams.get('type') || 'qemu';
      
      const upstreamPath = `/api2/json/nodes/${node.replace(/ /g, '%20')}/${type}/${vmid}/vncwebsocket?port=${vncport}&vncticket=${encodeURIComponent(ticket || '')}`;
      console.log('[VNC WS RELAY] Connecting upstream: ' + upstreamPath);
      // Upgrade the client connection, then open a WebSocket to Proxmox and relay frames bidirectionally.
      vncWss.handleUpgrade(req as any, socket as any, head, (clientWs) => {
        let upstream: WebSocket | null = null;
        try {
          upstream = new WebSocket(`wss://${cleanHost}:${pvePort}${upstreamPath}`, {
            rejectUnauthorized: true,
            headers: { Authorization: req.proxmoxAuth }
          });
        } catch (e) {
          clientWs.close();
          return;
        }
        const closeBoth = () => {
          try { upstream?.close(); } catch (_e) {}
          try { clientWs.close(); } catch (_e) {}
        };
        upstream.on('open', () => {
          clientWs.on('message', (data, isBinary) => {
            if (upstream?.readyState === 1) upstream.send(data as any, { binary: isBinary as any });
          });
          clientWs.on('close', closeBoth);
          upstream.on('message', (data, isBinary) => {
            if (clientWs.readyState === 1) clientWs.send(data as any, { binary: isBinary as any });
          });
          upstream.on('close', closeBoth);
          upstream.on('error', closeBoth);
        });
        upstream.on('error', (err) => {
          console.error('[VNC WS RELAY ERROR]', err.message);
          closeBoth();
        });
        vncWss.emit('connection', clientWs, req as any);
      });
    } catch (e) {
      socket.destroy();
    }
  } else if (req.url?.startsWith('/novnc') || req.url?.startsWith('/api2') || req.url?.startsWith('/pve2') || req.url?.startsWith('/proxmox-console')) {
    proxmoxProxy.upgrade(req, socket, head);
  } else {
    console.log('[HTTP SERVER] Upgrade request did not match any proxy rules. Dropping.');
    socket.destroy();
  }
});
