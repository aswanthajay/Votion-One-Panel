import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;

export const pgPool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'votion',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'votion_proxmox_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export function hashPassword(password: string, customSalt?: string): { hash: string; salt: string } {
  const salt = customSalt || crypto.randomBytes(32).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return { hash: derivedKey.toString('hex'), salt };
}

export function verifyPassword(candidatePassword: string, storedHash: string, salt: string): boolean {
  if (!salt || !storedHash) return false;
  const candidateHash = crypto.pbkdf2Sync(candidatePassword, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

export async function initializeDatabaseSchema() {
  let client: any;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      client = await pgPool.connect();
      break;
    } catch (err: any) {
      console.log(`[POSTGRES] Connection attempt ${attempt}/30 failed (${err.code || err.message}). Retrying in 3s...`);
      if (attempt === 30) {
        console.error('[POSTGRES] Could not connect to PostgreSQL after 30 attempts. Exiting.');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'client',
        phone VARCHAR(50),
        support_pin VARCHAR(10),
        two_factor_active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS proxmox_connections (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        host_ip VARCHAR(50) NOT NULL,
        port INT NOT NULL,
        username VARCHAR(100) DEFAULT 'root@pam',
        password VARCHAR(255),
        token_id VARCHAR(100) NOT NULL,
        token_secret VARCHAR(255) NOT NULL,
        ssl_fingerprint VARCHAR(255),
        status VARCHAR(50) DEFAULT 'connected',
        last_tested TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id VARCHAR(50) PRIMARY KEY,
        node_name VARCHAR(100) NOT NULL,
        ip_address VARCHAR(50) NOT NULL,
        api_token VARCHAR(255),
        cluster_status VARCHAR(50) NOT NULL DEFAULT 'online',
        cpu_usage NUMERIC,
        ram_usage BIGINT,
        ram_total BIGINT,
        zfs_health VARCHAR(100),
        last_updated TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vms (
        vmid INT PRIMARY KEY,
        user_id INT REFERENCES accounts(id) ON DELETE SET NULL,
        node_id VARCHAR(50),
        vm_name VARCHAR(255) NOT NULL,
        os_type VARCHAR(100) NOT NULL DEFAULT 'Ubuntu 24.04 LTS',
        cpu_cores INT NOT NULL DEFAULT 4,
        ram_mb INT NOT NULL DEFAULT 4096,
        disk_gb INT NOT NULL DEFAULT 64,
        status VARCHAR(50) NOT NULL DEFAULT 'running',
        owner_email VARCHAR(255) NOT NULL,
        node VARCHAR(100) NOT NULL DEFAULT 'pve-01',
        expiry_date TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
        is_suspended BOOLEAN NOT NULL DEFAULT false,
        type VARCHAR(50) NOT NULL DEFAULT 'qemu',
        cpus INT DEFAULT 4,
        memory BIGINT DEFAULT 4294967296,
        maxmem BIGINT DEFAULT 8589934592,
        disk BIGINT DEFAULT 34359738368,
        maxdisk BIGINT DEFAULT 68719476736,
        uptime BIGINT DEFAULT 0,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(100) PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT NOW(),
        user_email VARCHAR(255) NOT NULL,
        action VARCHAR(100) NOT NULL,
        target VARCHAR(255) NOT NULL,
        details TEXT,
        status VARCHAR(50) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(50) PRIMARY KEY,
        ticket_number VARCHAR(50) UNIQUE NOT NULL,
        user_id INT REFERENCES accounts(id) ON DELETE CASCADE,
        vmid INT,
        subject VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'General',
        priority VARCHAR(50) NOT NULL DEFAULT 'medium',
        status VARCHAR(50) NOT NULL DEFAULT 'open',
        user_email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ticket_replies (
        id VARCHAR(100) PRIMARY KEY,
        ticket_id VARCHAR(50) REFERENCES tickets(id) ON DELETE CASCADE,
        sender_email VARCHAR(255) NOT NULL,
        sender_role VARCHAR(50) NOT NULL DEFAULT 'client',
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS vm_telemetry (
        id SERIAL PRIMARY KEY,
        vmid INT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        cpu_pct NUMERIC,
        ram_bytes BIGINT,
        net_in_bytes BIGINT,
        net_out_bytes BIGINT
      );
      
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS secondary_emails (
        id SERIAL PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
        secondary_email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(account_email, secondary_email)
      );

      CREATE TABLE IF NOT EXISTS passkeys (
        id SERIAL PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
        credential_id VARCHAR(255) NOT NULL UNIQUE,
        key_name VARCHAR(100) DEFAULT 'Hardware Passkey',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS totp_secrets (
        account_email VARCHAR(255) PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
        secret VARCHAR(100) NOT NULL,
        issuer VARCHAR(100) DEFAULT 'VOTION',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS support_sessions (
        id VARCHAR(100) PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        support_pin VARCHAR(10),
        expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS uploaded_files (
        id VARCHAR(100) PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        size_bytes BIGINT,
        mime_type VARCHAR(100),
        storage_path VARCHAR(500) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vm_snapshots (
        id SERIAL PRIMARY KEY,
        vmid INT NOT NULL,
        snapshot_name VARCHAR(100) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(100) PRIMARY KEY,
        user_email VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        priority VARCHAR(50) NOT NULL DEFAULT 'medium',
        progress_pct NUMERIC DEFAULT 0,
        started_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS firewall_rules (
        id SERIAL PRIMARY KEY,
        vmid INT NOT NULL,
        rule_type VARCHAR(10) NOT NULL DEFAULT 'in',
        action VARCHAR(20) NOT NULL DEFAULT 'ACCEPT',
        proto VARCHAR(10),
        dport VARCHAR(50),
        source VARCHAR(50),
        enabled BOOLEAN NOT NULL DEFAULT true,
        comment VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed default SMTP settings if missing
    await client.query(`
      ALTER TABLE proxmox_connections ADD COLUMN IF NOT EXISTS username VARCHAR(100) DEFAULT 'root@pam';
      ALTER TABLE proxmox_connections ADD COLUMN IF NOT EXISTS password VARCHAR(255);
    `);

    // Legacy migration: tasks column existed in old static constants — ensure table exists (created above)
    await client.query(`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tfa_secret VARCHAR(100);
    `);

    // Seed default SMTP settings if missing
    await client.query(`
      INSERT INTO system_settings (setting_key, setting_value)
      VALUES ('smtp_config', '{"enabled": false, "host": "", "port": 587, "user": "", "pass": "", "secure": false, "from": "noreply@votioncloud.org"}')
      ON CONFLICT (setting_key) DO NOTHING
    `);

    // Seed admin if missing
    const adminCheck = await client.query("SELECT * FROM accounts WHERE email = 'admin@votioncloud.org'");
    if (adminCheck.rows.length === 0) {
      const { hash, salt } = hashPassword('password123');
      await client.query(
        "INSERT INTO accounts (email, password_hash, name, role, support_pin) VALUES ($1, $2, $3, $4, $5)",
        ['admin@votioncloud.org', `${hash}:${salt}`, 'Aswanth Ajay (Admin)', 'administrator', '868975']
      );
    }
    
    // Seed devops if missing
    const devCheck = await client.query("SELECT * FROM accounts WHERE email = 'devops@votioncloud.org'");
    if (devCheck.rows.length === 0) {
      const { hash, salt } = hashPassword('password123');
      await client.query(
        "INSERT INTO accounts (email, password_hash, name, role, support_pin) VALUES ($1, $2, $3, $4, $5)",
        ['devops@votioncloud.org', `${hash}:${salt}`, 'DevOps Lead', 'moderator', '654321']
      );
    }

    console.log('⚡ PostgreSQL Database Schema & Proxmox Cloud Infrastructure Tables Initialized');
  } catch (err) {
    console.error('[POSTGRES] Critical Database Initialization Error:', err);
  } finally {
    client.release();
  }
}

// Ensure schema is created on startup
initializeDatabaseSchema();

// STATIC UI CONSTANTS
const CONSTANTS = {
  downloads: [
    { id: 'dl-1', name: 'Proxmox VE 8.2 ISO Installer', version: '8.2-1', size: '1.2 GB', type: 'ISO Image', url: '/downloads/proxmox-ve_8.2-1.iso' },
    { id: 'dl-2', name: 'VirtIO Windows Guest Drivers', version: '0.1.240', size: '612 MB', type: 'ISO Image', url: '/downloads/virtio-win-0.1.240.iso' },
  ],
  pricing: [
    { id: 'plan-starter', name: 'Proxmox Starter', price: '$29/mo', vcpus: 2, ramGb: 4, storageGb: 50, bandwidth: '2 TB' },
    { id: 'plan-pro', name: 'Proxmox Pro Cluster', price: '$89/mo', vcpus: 8, ramGb: 16, storageGb: 200, bandwidth: '10 TB', popular: true },
    { id: 'plan-enterprise', name: 'Proxmox Dedicated Node', price: '$249/mo', vcpus: 32, ramGb: 64, storageGb: 1000, bandwidth: 'Unlimited' },
  ],
  dataroom: [
    { id: 'dr-1', title: 'SOC 2 Type II Security Audit Report', category: 'Compliance', updatedAt: '2026-01-15', size: '4.2 MB', status: 'Verified' },
  ],
  tasks: [],
  inbox: [],
  telemetry: [],
};

export class DatabaseService {
  
  constructor() {
    this.startBackgroundJobs();
  }

  startBackgroundJobs() {
    setInterval(async () => {
      try {
        const res = await pgPool.query("SELECT * FROM vms WHERE expiry_date < NOW() AND is_suspended = false");
        for (const vm of res.rows) {
          await pgPool.query("UPDATE vms SET is_suspended = true, status = 'stopped' WHERE vmid = $1", [vm.vmid]);
          console.log(`[EXPIRY ENGINE] VMID ${vm.vmid} expired. Auto-suspended VM.`);
        }
      } catch (err) {}
    }, 10000);
    
    // Telemetry cleanup job (Runs every hour)
    setInterval(async () => {
      try {
        await pgPool.query("DELETE FROM vm_telemetry WHERE timestamp < NOW() - INTERVAL '7 days'");
      } catch (err) {}
    }, 3600000);
  }

  // TELEMETRY
  async insertVmTelemetry(vmid: number, cpuPct: number, ramBytes: number, netIn: number, netOut: number) {
    try {
      await pgPool.query(
        "INSERT INTO vm_telemetry (vmid, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes) VALUES ($1, $2, $3, $4, $5)",
        [vmid, cpuPct, ramBytes, netIn, netOut]
      );
    } catch (err) {
      console.error('Error inserting telemetry:', err);
    }
  }

  async getVmTelemetryHistory(vmid: number, hours: number = 24) {
    const res = await pgPool.query(
      "SELECT * FROM vm_telemetry WHERE vmid = $1 AND timestamp > NOW() - INTERVAL '1 hour' * $2 ORDER BY timestamp ASC",
      [vmid, hours]
    );
    return res.rows;
  }

  // ACCOUNTS & USERS
  async getAccounts() {
    const res = await pgPool.query('SELECT id, email, name, role, phone, support_pin as "supportPin", two_factor_active as "twoFactorActive", created_at FROM accounts ORDER BY id ASC');
    return res.rows;
  }

  async findUserByEmail(email: string) {
    const clean = email.toLowerCase().trim();
    const res = await pgPool.query('SELECT * FROM accounts WHERE email = $1', [clean]);
    return res.rows[0] || null;
  }

  async findUserBySupportPin(pin: string) {
    const cleanPin = pin.trim();
    const res = await pgPool.query('SELECT * FROM accounts WHERE support_pin = $1 LIMIT 1', [cleanPin]);
    return res.rows[0] || null;
  }

  async validateCredentials(email: string, candidatePassword: string) {
    const user = await this.findUserByEmail(email);
    if (!user) return { success: false, error: 'Invalid email address or password.' };

    const passHash = user.password_hash;
    let isValid = false;

    if (passHash && passHash.includes(':')) {
      const [hash, salt] = passHash.split(':');
      isValid = verifyPassword(candidatePassword, hash, salt);
    } else {
      isValid = passHash === candidatePassword;
    }

    if (!isValid) {
      await this.logAudit(email, 'AUTH_FAILED', 'Login Endpoint', `Failed password authentication for ${email}`, 'failed');
      return { success: false, error: 'Invalid email address or password.' };
    }

    await this.logAudit(user.email, 'USER_LOGIN', 'Login Endpoint', `User ${user.email} authenticated via PBKDF2 hash`, 'success');
    return {
      success: true,
      account: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        supportPin: user.support_pin,
        twoFactorActive: user.two_factor_active,
      },
    };
  }

  async registerUser(name: string, email: string, password: string, role: 'admin' | 'client' = 'client') {
    const clean = email.toLowerCase().trim();
    const { hash, salt } = hashPassword(password);
    const storedHash = `${hash}:${salt}`;
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    const res = await pgPool.query(
      `INSERT INTO accounts (email, password_hash, name, role, support_pin, two_factor_active, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW()) RETURNING *`,
      [clean, storedHash, name, role, pin]
    );
    return res.rows[0];
  }

  async updateUserProfile(email: string, updates: any) {
    const clean = email.toLowerCase().trim();
    const user = await this.findUserByEmail(clean);
    if (!user) return null;

    const name = updates.name || user.name;
    const phone = updates.phone || user.phone;
    const support_pin = updates.supportPin || user.support_pin;
    const two_factor_active = updates.twoFactorActive !== undefined ? updates.twoFactorActive : user.two_factor_active;
    
    await pgPool.query(
      `UPDATE accounts SET name = $1, phone = $2, support_pin = $3, two_factor_active = $4 WHERE email = $5`,
      [name, phone, support_pin, two_factor_active, clean]
    );
    
    await this.logAudit(clean, 'UPDATE_PROFILE', clean, 'Updated profile fields in PostgreSQL');
    return { id: user.id, email: clean, name, role: user.role, phone, supportPin: support_pin, twoFactorActive: two_factor_active };
  }

  async changeUserPassword(email: string, currentPass: string, newPass: string) {
    const authResult = await this.validateCredentials(email, currentPass);
    if (!authResult.success) {
      return { success: false, error: 'Current password is incorrect.' };
    }

    const { hash, salt } = hashPassword(newPass);
    const newHash = `${hash}:${salt}`;
    const clean = email.toLowerCase().trim();

    await pgPool.query('UPDATE accounts SET password_hash = $1 WHERE email = $2', [newHash, clean]);
    await this.logAudit(clean, 'CHANGE_PASSWORD', clean, 'Updated account password via PBKDF2 hash');
    return { success: true, message: 'Password updated successfully.' };
  }

  async regenerateSupportPin(email: string) {
    const clean = email.toLowerCase().trim();
    const newPin = Math.floor(100000 + Math.random() * 900000).toString();
    await pgPool.query('UPDATE accounts SET support_pin = $1 WHERE email = $2', [newPin, clean]);
    await this.logAudit(clean, 'REGENERATE_PIN', clean, `Generated new 6-digit Support PIN: ${newPin}`);
    return { success: true, supportPin: newPin };
  }

  async toggle2FA(email: string, active: boolean) {
    const clean = email.toLowerCase().trim();
    await pgPool.query('UPDATE accounts SET two_factor_active = $1 WHERE email = $2', [active, clean]);
    await this.logAudit(clean, active ? 'ENABLE_2FA' : 'DISABLE_2FA', clean, `2FA state updated to ${active}`);
    return { success: true, twoFactorActive: active };
  }

  // PROXMOX NODES
  async getNodes() {
    const res = await pgPool.query('SELECT * FROM nodes');
    return res.rows.map(n => ({
      id: n.id, node: n.node_name, ip: n.ip_address, status: n.cluster_status, cpuUsagePct: n.cpu_usage, ramUsageBytes: n.ram_usage, ramTotalBytes: n.ram_total, pveVersion: '8.2.4', zfsHealth: n.zfs_health, uptimeSeconds: 2419200,
    }));
  }

  async rebootNode(id: string, userEmail: string = 'system') {
    await pgPool.query("UPDATE nodes SET cluster_status = 'maintenance' WHERE id = $1 OR node_name = $1", [id]);
    await this.logAudit(userEmail, 'REBOOT_NODE', id, `Reboot signal sent to host ${id}`);
    setTimeout(() => { pgPool.query("UPDATE nodes SET cluster_status = 'online' WHERE id = $1 OR node_name = $1", [id]); }, 10000);
    return { id, status: 'maintenance' };
  }

  // VMS & EXPIRY SUSPENSION ENGINE
  async getVMs(ownerEmail?: string, vmid?: number) {
    let query = "SELECT * FROM vms";
    const params: any[] = [];
    const conditions = [];
    
    if (vmid) {
      params.push(vmid);
      conditions.push(`vmid = $${params.length}`);
    }
    if (ownerEmail) {
      params.push(ownerEmail.toLowerCase().trim());
      conditions.push(`owner_email = $${params.length}`);
    }
    
    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    
    const res = await pgPool.query(query, params);
    return res.rows.map(v => ({
      vmid: v.vmid, name: v.vm_name, type: v.type, node: v.node, ownerEmail: v.owner_email, status: v.is_suspended ? 'stopped' : v.status, cpus: v.cpu_cores, memory: v.ram_mb * 1048576, maxmem: v.maxmem, disk: v.disk_gb * 1073741824, maxdisk: v.maxdisk, uptime: v.is_suspended ? 0 : v.uptime, ipAddress: v.ip_address, os: v.os_type, expiryDate: v.expiry_date, isSuspended: v.is_suspended,
    }));
  }

  async getVMByVMID(vmid: number) {
    const vms = await this.getVMs(undefined, vmid);
    return vms[0] || null;
  }

  async createVM(vmData: any, userEmail: string = 'admin@votioncloud.org') {
    const vmid = Number(vmData.vmid) || Math.floor(100 + Math.random() * 900);
    const expiryDays = Number(vmData.expiryDays) || 30;
    const expiryDate = new Date(Date.now() + expiryDays * 86400000).toISOString();
    
    const name = vmData.name || `vm-${vmid}`;
    const type = vmData.type || 'qemu';
    const node = vmData.node || 'pve-01';
    const owner = vmData.ownerEmail || 'client@votioncloud.org';
    const cpus = vmData.cpus || 4;
    const ram = (vmData.memoryGb || 8) * 1024;
    const disk = vmData.diskGb || 64;
    const osType = vmData.os || (type === 'lxc' ? 'Alpine Linux 3.19' : 'Ubuntu 24.04 LTS');
    const ip = `10.0.10.${Math.floor(50 + Math.random() * 150)}`;

    await pgPool.query(
      `INSERT INTO vms (vmid, vm_name, type, node, owner_email, status, cpu_cores, ram_mb, disk_gb, os_type, expiry_date, is_suspended, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [vmid, name, type, node, owner, 'running', cpus, ram, disk, osType, expiryDate, false, ip]
    );

    await this.logAudit(userEmail, 'PROVISION_VM', `VMID ${vmid}`, `Provisioned VMID ${vmid} for ${owner}`);
    return await this.getVMByVMID(vmid);
  }

  async assignVM(vmid: number, targetEmail: string, userEmail: string = 'admin@votioncloud.org') {
    const res = await pgPool.query("UPDATE vms SET owner_email = $1 WHERE vmid = $2 RETURNING *", [targetEmail.trim(), vmid]);
    if ((res.rowCount ?? 0) > 0) {
      await this.logAudit(userEmail, 'REASSIGN_VM', `VMID ${vmid}`, `Reassigned to ${targetEmail}`);
      return res.rows[0];
    }
    return null;
  }

  async executeVMAction(vmid: number, action: string, userEmail: string = 'system') {
    const vm = await this.getVMByVMID(vmid);
    if (!vm) return null;

    if (vm.isSuspended && action !== 'unsuspend') {
      throw new Error(`VMID ${vmid} is suspended due to billing expiry. Cannot perform ${action}.`);
    }

    let status = vm.status;
    if (action === 'start') status = 'running';
    if (action === 'stop') status = 'stopped';
    if (action === 'reboot') status = 'running';

    await pgPool.query("UPDATE vms SET status = $1 WHERE vmid = $2", [status, vmid]);
    await this.logAudit(userEmail, `VM_${action.toUpperCase()}`, `VMID ${vmid}`, `Executed ${action}`);
    return await this.getVMByVMID(vmid);
  }

  async suspendVM(vmid: number, suspend: boolean, userEmail: string = 'admin@votioncloud.org') {
    await pgPool.query('UPDATE vms SET is_suspended = $1, status = $2 WHERE vmid = $3', [suspend, suspend ? 'stopped' : 'running', vmid]);
    await this.logAudit(userEmail, suspend ? 'SUSPEND_VM' : 'UNSUSPEND_VM', `VMID ${vmid}`, `${suspend ? 'Suspended' : 'Unsuspended'} VMID ${vmid}`);
    return await this.getVMByVMID(vmid);
  }

  async extendVMExpiry(vmid: number, additionalDays: number, userEmail: string = 'admin@votioncloud.org') {
    const vm = await this.getVMByVMID(vmid);
    if (!vm) return null;
    const currentExpiry = new Date(vm.expiryDate && new Date(vm.expiryDate) > new Date() ? vm.expiryDate : Date.now());
    const newExpiry = new Date(currentExpiry.getTime() + additionalDays * 86400000).toISOString();
    
    await pgPool.query('UPDATE vms SET expiry_date = $1, is_suspended = false, status = $2 WHERE vmid = $3', [newExpiry, 'running', vmid]);
    await this.logAudit(userEmail, 'EXTEND_VM_EXPIRY', `VMID ${vmid}`, `Extended expiry date to ${newExpiry}`);
    return await this.getVMByVMID(vmid);
  }

  async reinstallVMOS(vmid: number, osType: string, userEmail: string = 'client@votioncloud.org') {
    const vm = await this.getVMByVMID(vmid);
    if (!vm) return null;
    if (vm.isSuspended) throw new Error(`VMID ${vmid} is currently suspended. Reinstallation blocked.`);
    
    await pgPool.query('UPDATE vms SET os_type = $1, status = $2 WHERE vmid = $3', [osType, 'running', vmid]);
    await this.logAudit(userEmail, 'REINSTALL_OS', `VMID ${vmid}`, `Initiated Proxmox OS re-imaging with ${osType}`);
    return await this.getVMByVMID(vmid);
  }

  async deleteVM(vmid: number, userEmail: string = 'admin@votioncloud.org') {
    const res = await pgPool.query('DELETE FROM vms WHERE vmid = $1', [vmid]);
    if ((res.rowCount ?? 0) > 0) {
      await this.logAudit(userEmail, 'DELETE_VM', `VMID ${vmid}`, `Deleted VMID ${vmid}`);
      return true;
    }
    return false;
  }

  // SUPPORT TICKET SYSTEM & REPLIES
  async getSupportTickets(userEmail?: string) {
    let query = 'SELECT * FROM tickets';
    const params: any[] = [];
    if (userEmail) {
      query += ' WHERE user_email = $1';
      params.push(userEmail.toLowerCase().trim());
    }
    query += ' ORDER BY created_at DESC';
    const res = await pgPool.query(query, params);
    
    return res.rows.map(t => ({
      id: t.id, ticket_number: t.ticket_number, vmid: t.vmid, subject: t.subject, category: t.category, status: t.status, priority: t.priority, userEmail: t.user_email, createdAt: t.created_at,
    }));
  }

  async getTicketDetails(ticketId: string) {
    const tRes = await pgPool.query('SELECT * FROM tickets WHERE id = $1 OR ticket_number = $1', [ticketId]);
    if (tRes.rows.length === 0) return null;
    const ticket = tRes.rows[0];

    const rRes = await pgPool.query('SELECT * FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]);
    
    return {
      ticket: { id: ticket.id, ticket_number: ticket.ticket_number, vmid: ticket.vmid, subject: ticket.subject, category: ticket.category, status: ticket.status, priority: ticket.priority, userEmail: ticket.user_email, createdAt: ticket.created_at },
      replies: rRes.rows.map(r => ({ id: r.id, ticketId: r.ticket_id, senderEmail: r.sender_email, senderRole: r.sender_role, message: r.message, timestamp: r.created_at })),
    };
  }

  async createSupportTicket(subject: string, category: string, priority: string, vmid?: number, userEmail: string = 'admin@votioncloud.org') {
    const ticketId = `TICK-${Math.floor(1000 + Math.random() * 9000)}`;
    const email = userEmail.toLowerCase().trim();
    
    await pgPool.query(
      `INSERT INTO tickets (id, ticket_number, vmid, subject, category, status, priority, user_email, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [ticketId, ticketId, vmid || null, subject, category || 'General', 'open', priority || 'medium', email]
    );

    await this.logAudit(userEmail, 'CREATE_TICKET', ticketId, `Opened support ticket for VMID ${vmid || 'N/A'}`);
    return await this.getTicketDetails(ticketId);
  }

  async addTicketReply(ticketId: string, senderEmail: string, message: string, senderRole: 'admin' | 'client' = 'client') {
    const replyId = `rep-${Date.now()}`;
    await pgPool.query(
      `INSERT INTO ticket_replies (id, ticket_id, sender_email, sender_role, message, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [replyId, ticketId, senderEmail.toLowerCase().trim(), senderRole, message]
    );

    if (senderRole === 'admin') {
      await pgPool.query("UPDATE tickets SET status = 'replied' WHERE id = $1 AND status = 'open'", [ticketId]);
    }
    await this.logAudit(senderEmail, 'REPLY_TICKET', ticketId, `Added reply message`);
    return { id: replyId, ticketId, senderEmail, senderRole, message, timestamp: new Date().toISOString() };
  }

  async updateTicketStatus(ticketId: string, status: string, userEmail: string = 'admin@votioncloud.org') {
    await pgPool.query('UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2', [status, ticketId]);
    await this.logAudit(userEmail, 'UPDATE_TICKET_STATUS', ticketId, `Ticket status updated to ${status}`);
    return { success: true, ticketId, status };
  }

  // MODALS & TELEMETRY
  async getDownloads() { return CONSTANTS.downloads; }
  async getDataRoom() { return CONSTANTS.dataroom; }
  async getPricing() { return CONSTANTS.pricing; }
  async getReleaseNotes() { return []; }
  async getTerms() { return { title: 'VOTION Terms', sections: [] }; }
  async getHaFencing() { return []; }
  async getInbox() { return CONSTANTS.inbox; }
  async getTelemetry() { return CONSTANTS.telemetry; }
  
  async getAuditLogs() {
    const res = await pgPool.query("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50");
    return res.rows;
  }

  async logAudit(userEmail: string, action: string, target: string, details: string, status: string = 'success') {
    const logId = `log-${Date.now()}`;
    await pgPool.query(
      `INSERT INTO audit_logs (id, user_email, action, target, details, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [logId, userEmail, action, target, details, status]
    );
    return { id: logId, user_email: userEmail, action, target, details, status };
  }

  // SECONDARY EMAILS
  async getSecondaryEmails(accountEmail: string) {
    const res = await pgPool.query(
      'SELECT secondary_email as "secondaryEmail", created_at FROM secondary_emails WHERE account_email = $1 ORDER BY created_at ASC',
      [accountEmail.toLowerCase().trim()]
    );
    return res.rows;
  }

  async addSecondaryEmail(accountEmail: string, secondaryEmail: string) {
    const clean = secondaryEmail.toLowerCase().trim();
    const exists = await pgPool.query(
      'SELECT 1 FROM secondary_emails WHERE account_email = $1 AND secondary_email = $2',
      [accountEmail.toLowerCase().trim(), clean]
    );
    if (exists.rows.length > 0) {
      return { success: false, error: 'This secondary email is already registered.' };
    }
    await pgPool.query(
      'INSERT INTO secondary_emails (account_email, secondary_email) VALUES ($1, $2)',
      [accountEmail.toLowerCase().trim(), clean]
    );
    await this.logAudit(accountEmail, 'ADD_SECONDARY_EMAIL', accountEmail, `Added backup email ${clean}`);
    return { success: true, secondaryEmail: clean };
  }

  async removeSecondaryEmail(accountEmail: string, secondaryEmail: string) {
    const res = await pgPool.query(
      'DELETE FROM secondary_emails WHERE account_email = $1 AND secondary_email = $2',
      [accountEmail.toLowerCase().trim(), secondaryEmail.toLowerCase().trim()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // PASSKEYS
  async getPasskeys(accountEmail: string) {
    const res = await pgPool.query(
      'SELECT credential_id as "credentialId", key_name as "keyName", created_at FROM passkeys WHERE account_email = $1 ORDER BY created_at ASC',
      [accountEmail.toLowerCase().trim()]
    );
    return res.rows;
  }

  async addPasskey(accountEmail: string, credentialId: string, keyName: string = 'Hardware Passkey') {
    const exists = await pgPool.query('SELECT 1 FROM passkeys WHERE credential_id = $1', [credentialId]);
    if (exists.rows.length > 0) {
      return { success: false, error: 'This passkey is already registered.' };
    }
    await pgPool.query(
      'INSERT INTO passkeys (account_email, credential_id, key_name) VALUES ($1, $2, $3)',
      [accountEmail.toLowerCase().trim(), credentialId, keyName]
    );
    await this.logAudit(accountEmail, 'PASSKEY_REGISTER', accountEmail, `Registered passkey ${credentialId.slice(0, 16)}`);
    return { success: true, credentialId, keyName };
  }

  async deletePasskey(accountEmail: string, credentialId: string) {
    const res = await pgPool.query(
      'DELETE FROM passkeys WHERE account_email = $1 AND credential_id = $2',
      [accountEmail.toLowerCase().trim(), credentialId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // TOTP SECRETS
  async getTotpSecret(accountEmail: string) {
    const res = await pgPool.query('SELECT secret FROM totp_secrets WHERE account_email = $1', [accountEmail.toLowerCase().trim()]);
    return res.rows[0]?.secret || null;
  }

  async upsertTotpSecret(accountEmail: string, secret: string) {
    await pgPool.query(
      `INSERT INTO totp_secrets (account_email, secret) VALUES ($1, $2)
       ON CONFLICT (account_email) DO UPDATE SET secret = $2, created_at = NOW()`,
      [accountEmail.toLowerCase().trim(), secret]
    );
    return { success: true, secret };
  }

  // REMOTE SUPPORT SESSIONS
  async createSupportSession(accountEmail: string) {
    const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await this.findUserByEmail(accountEmail);
    await pgPool.query(
      'INSERT INTO support_sessions (id, account_email, support_pin) VALUES ($1, $2, $3)',
      [sessionId, accountEmail.toLowerCase().trim(), user?.support_pin || '------']
    );
    await this.logAudit(accountEmail, 'REMOTE_SESSION_START', accountEmail, `Remote support session opened: ${sessionId}`);
    return {
      success: true,
      sessionId,
      supportPin: user?.support_pin || '------',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    };
  }

  async getActiveSupportSession(accountEmail: string) {
    const res = await pgPool.query(
      "SELECT id, support_pin as \"supportPin\", status, expires_at FROM support_sessions WHERE account_email = $1 AND status = 'active' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
      [accountEmail.toLowerCase().trim()]
    );
    return res.rows[0] || null;
  }

  async closeSupportSession(sessionId: string, accountEmail: string) {
    await pgPool.query(
      "UPDATE support_sessions SET status = 'closed' WHERE id = $1 AND account_email = $2",
      [sessionId, accountEmail.toLowerCase().trim()]
    );
    await this.logAudit(accountEmail, 'REMOTE_SESSION_DISCONNECT', accountEmail, 'Remote support session terminated by user');
    return { success: true };
  }

  // FILE UPLOADS
  async recordUploadedFile(accountEmail: string, fileName: string, originalName: string, sizeBytes: number, mimeType: string, storagePath: string) {
    await pgPool.query(
      'INSERT INTO uploaded_files (id, account_email, file_name, original_name, size_bytes, mime_type, storage_path) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [fileName, accountEmail.toLowerCase().trim(), originalName, originalName, sizeBytes, mimeType, storagePath]
    );
    await this.logAudit(accountEmail, 'FILE_UPLOAD', originalName, `Uploaded ${Math.round(sizeBytes / 1024)} KB to secure storage`);
    return { success: true, fileName, sizeBytes };
  }

  async getUploadedFiles(accountEmail?: string) {
    let query = 'SELECT file_name as "fileName", original_name as "originalName", size_bytes as "sizeBytes", mime_type as "mimeType", created_at FROM uploaded_files';
    const params: any[] = [];
    if (accountEmail) {
      query += ' WHERE account_email = $1';
      params.push(accountEmail.toLowerCase().trim());
    }
    query += ' ORDER BY created_at DESC LIMIT 50';
    const res = await pgPool.query(query, params);
    return res.rows;
  }

  // VM SNAPSHOTS
  async createVmSnapshot(vmid: number, name: string, description: string) {
    await pgPool.query(
      'INSERT INTO vm_snapshots (vmid, snapshot_name, description) VALUES ($1, $2, $3)',
      [vmid, name, description]
    );
    await this.logAudit('admin@votioncloud.org', 'CREATE_SNAPSHOT', `VMID ${vmid}`, `Snapshot '${name}' registered`);
    return { success: true, name, description };
  }

  async getVmSnapshots(vmid: number) {
    const res = await pgPool.query(
      'SELECT snapshot_name as "name", description, snaptime as "snaptime", created_at FROM vm_snapshots WHERE vmid = $1 ORDER BY created_at DESC',
      [vmid]
    );
    return res.rows;
  }

  async deleteVmSnapshot(vmid: number, snapshotName: string) {
    const res = await pgPool.query('DELETE FROM vm_snapshots WHERE vmid = $1 AND snapshot_name = $2', [vmid, snapshotName]);
    return (res.rowCount ?? 0) > 0;
  }

  // TASKS PANEL
  async addTask(userEmail: string, title: string, description: string, status: string = 'pending', priority: string = 'medium', progressPct: number = 0) {
    const id = `task-${Date.now().toString(36)}`;
    await pgPool.query(
      'INSERT INTO tasks (id, user_email, title, description, status, priority, progress_pct) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, userEmail.toLowerCase().trim(), title, description, status, priority, progressPct]
    );
    return { success: true, id, title, status };
  }

  async getTasks() {
    const res = await pgPool.query(
      "SELECT * FROM tasks ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at DESC LIMIT 50"
    );
    return res.rows.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      progressPct: Number(t.progress_pct),
      userEmail: t.user_email,
      startedAt: t.started_at,
      createdAt: t.created_at,
    }));
  }

  async updateTaskStatus(id: string, status: string, progressPct?: number) {
    const updates: string[] = ['status = $1'];
    const params: any[] = [status, id];
    if (progressPct !== undefined) {
      params.splice(1, 0, progressPct);
      updates.push('progress_pct = $2');
    }
    await pgPool.query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    return { success: true };
  }

  // ADVANCED USER MANAGEMENT
  async createUserByAdmin(email: string, name: string, role: string, initialPassword?: string) {
    const clean = email.toLowerCase().trim();
    const exists = await this.findUserByEmail(clean);
    if (exists) {
      return { success: false, error: `Account with email ${clean} already exists.` };
    }
    const password = initialPassword && initialPassword.length >= 8 ? initialPassword : 'TempPass2026!';
    const { hash, salt } = hashPassword(password);
    const storedHash = `${hash}:${salt}`;
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    const res = await pgPool.query(
      `INSERT INTO accounts (email, password_hash, name, role, support_pin, two_factor_active, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW()) RETURNING id, email, name, role, support_pin`,
      [clean, storedHash, name, role, pin]
    );
    const created = res.rows[0];
    await this.logAudit('admin@votioncloud.org', 'CREATE_USER', created.email, `User provisioned with role ${role} (initial password hashed via PBKDF2)`);
    return { success: true, user: created, temporaryPassword: password };
  }

  async changeUserEmail(oldEmail: string, newEmail: string) {
    const old = oldEmail.toLowerCase().trim();
    const clean = newEmail.toLowerCase().trim();
    const exists = await this.findUserByEmail(clean);
    if (exists) {
      return { success: false, error: `An account with email ${clean} already exists.` };
    }
    const user = await this.findUserByEmail(old);
    if (!user) {
      return { success: false, error: 'Current account not found.' };
    }
    await pgPool.query("UPDATE accounts SET email = $1 WHERE email = $2", [clean, old]);
    await pgPool.query("UPDATE vms SET owner_email = $1 WHERE owner_email = $2", [clean, old]);
    await pgPool.query("UPDATE tickets SET user_email = $1 WHERE user_email = $2", [clean, old]);
    await pgPool.query("UPDATE audit_logs SET user_email = $1 WHERE user_email = $2", [clean, old]);
    await pgPool.query("UPDATE support_sessions SET account_email = $1 WHERE account_email = $2", [clean, old]);
    await this.logAudit(clean, 'CHANGE_EMAIL', old, `Primary email changed from ${old} to ${clean}`);
    return { success: true, email: clean };
  }

  // FIREWALL LOCAL STORE (used when Proxmox is unreachable so the panel stays functional)
  async getVmFirewallRules(vmid: number) {
    const res = await pgPool.query(
      'SELECT id, rule_type as "type", action, proto, dport, source, enabled, comment FROM firewall_rules WHERE vmid = $1 ORDER BY id ASC',
      [vmid]
    );
    return res.rows;
  }

  async getVmFirewallOptions(vmid: number) {
    const rules = await this.getVmFirewallRules(vmid);
    const enabled = rules.length > 0;
    return { enabled, policy_in: 'ACCEPT', policy_out: 'ACCEPT' };
  }

  async addVmFirewallRule(vmid: number, rule: { ruleType: string; action: string; proto?: string; dport?: string; enable?: boolean; comment?: string }) {
    const res = await pgPool.query(
      `INSERT INTO firewall_rules (vmid, rule_type, action, proto, dport, enabled, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [vmid, rule.ruleType, rule.action, rule.proto || null, rule.dport || null, rule.enable !== false, rule.comment || null]
    );
    return res.rows[0]?.id;
  }

  async removeVmFirewallRule(vmid: number, pos: number) {
    const res = await pgPool.query('DELETE FROM firewall_rules WHERE vmid = $1 AND id = $2', [vmid, pos]);
    return (res.rowCount ?? 0) > 0;
  }

  async setVmFirewallOptions(vmid: number, options: { enabled: boolean }) {
    await pgPool.query('UPDATE firewall_rules SET enabled = $1 WHERE vmid = $2', [options.enabled, vmid]);
    return { success: true };
  }

  async getAllUsers() {
    const res = await pgPool.query('SELECT id, email, name, role, phone, support_pin, two_factor_active, created_at FROM accounts ORDER BY created_at DESC');
    return res.rows;
  }

  async updateUserRole(userId: number, role: string) {
    const res = await pgPool.query('UPDATE accounts SET role = $1 WHERE id = $2 RETURNING *', [role, userId]);
    return res.rows[0] || null;
  }

  async deleteUser(userId: number) {
    const res = await pgPool.query('DELETE FROM accounts WHERE id = $1', [userId]);
    return (res.rowCount ?? 0) > 0;
  }

  // PROXMOX CONNECTIONS
  async getProxmoxConnections() {
    const res = await pgPool.query('SELECT * FROM proxmox_connections ORDER BY last_tested DESC');
    return res.rows;
  }

  async addProxmoxConnection(name: string, host_ip: string, port: number, username: string, password: string, token_id: string, token_secret: string, ssl_fingerprint: string) {
    const connId = `pve-conn-${Date.now()}`;
    const res = await pgPool.query(
      `INSERT INTO proxmox_connections (id, name, host_ip, port, username, password, token_id, token_secret, ssl_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [connId, name, host_ip, port, username || 'root@pam', password, token_id, token_secret, ssl_fingerprint]
    );
    return res.rows[0];
  }

  async deleteProxmoxConnection(id: string) {
    const res = await pgPool.query('DELETE FROM proxmox_connections WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  // SYSTEM SETTINGS
  async getSystemSetting(key: string) {
    const res = await pgPool.query('SELECT setting_value FROM system_settings WHERE setting_key = $1', [key]);
    if (res.rows.length > 0) return res.rows[0].setting_value;
    return null;
  }

  async updateSystemSetting(key: string, value: any) {
    const res = await pgPool.query(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW() RETURNING *`,
      [key, JSON.stringify(value)]
    );
    return res.rows[0].setting_value;
  }
}

export const dbService = new DatabaseService();
