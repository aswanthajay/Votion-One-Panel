import 'dotenv/config';
import crypto from 'crypto';
import os from 'os';
import pg from 'pg';
const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL?.trim();
const poolConfig: pg.PoolConfig = databaseUrl
  ? { connectionString: databaseUrl }
  : {
      host: (process.env.PGHOST || 'localhost').trim(),
      port: parseInt((process.env.PGPORT || '5433').trim(), 10),
      user: (process.env.PGUSER || 'votion').trim(),
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE || 'votion_proxmox_db',
    };

export const pgPool = new Pool({
  ...poolConfig,
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

      CREATE TABLE IF NOT EXISTS vm_reimage_requests (
        id VARCHAR(100) PRIMARY KEY,
        vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE CASCADE,
        requester_email VARCHAR(255) NOT NULL,
        requested_os VARCHAR(100) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        requester_note TEXT,
        reviewer_email VARCHAR(255),
        reviewer_note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMP,
        cancelled_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_vm_reimage_requests_status_created
        ON vm_reimage_requests (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vm_reimage_requests_vmid_created
        ON vm_reimage_requests (vmid, created_at DESC);

      CREATE TABLE IF NOT EXISTS vm_reimage_image_profiles (
        id VARCHAR(100) PRIMARY KEY,
        os_label VARCHAR(100) NOT NULL,
        vm_type VARCHAR(20) NOT NULL,
        template_vmid INT,
        template_node VARCHAR(100),
        storage_id VARCHAR(100),
        version VARCHAR(100) NOT NULL,
        image_digest VARCHAR(255),
        enabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        retired_at TIMESTAMP,
        UNIQUE (os_label, vm_type, version)
      );

      CREATE TABLE IF NOT EXISTS vm_reimage_executions (
        id VARCHAR(100) PRIMARY KEY,
        request_id VARCHAR(100) NOT NULL UNIQUE REFERENCES vm_reimage_requests(id) ON DELETE RESTRICT,
        vmid INT NOT NULL REFERENCES vms(vmid) ON DELETE RESTRICT,
        request_snapshot JSONB NOT NULL,
        image_profile_id VARCHAR(100) REFERENCES vm_reimage_image_profiles(id) ON DELETE RESTRICT,
        image_profile_version VARCHAR(100),
        state VARCHAR(40) NOT NULL DEFAULT 'created',
        plan_hash VARCHAR(128),
        operator_email VARCHAR(255),
        operator_confirmed_at TIMESTAMP,
        preflight_snapshot JSONB,
        backup_reference VARCHAR(500),
        lease_owner VARCHAR(255),
        lease_expires_at TIMESTAMP,
        attempt_count INT NOT NULL DEFAULT 0,
        current_step VARCHAR(100),
        step_upids JSONB NOT NULL DEFAULT '[]'::jsonb,
        validation_result JSONB,
        error_code VARCHAR(100),
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        queued_at TIMESTAMP,
        completed_at TIMESTAMP,
        blocked_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_vm_reimage_executions_state_updated
        ON vm_reimage_executions (state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vm_reimage_executions_vmid_state
        ON vm_reimage_executions (vmid, state);

      CREATE TABLE IF NOT EXISTS vm_reimage_audit_events (
        id VARCHAR(100) PRIMARY KEY,
        request_id VARCHAR(100) REFERENCES vm_reimage_requests(id) ON DELETE SET NULL,
        execution_id VARCHAR(100) REFERENCES vm_reimage_executions(id) ON DELETE SET NULL,
        actor_email VARCHAR(255) NOT NULL,
        actor_capability VARCHAR(100) NOT NULL,
        action VARCHAR(100) NOT NULL,
        from_state VARCHAR(40),
        to_state VARCHAR(40),
        correlation_id VARCHAR(100) NOT NULL,
        plan_hash VARCHAR(128),
        safe_details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_vm_reimage_audit_execution_created
        ON vm_reimage_audit_events (execution_id, created_at DESC);

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
      
      CREATE TABLE IF NOT EXISTS alert_rules (
        id SERIAL PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        target VARCHAR(20) NOT NULL DEFAULT 'cluster',
        vmid INT,
        metric VARCHAR(30) NOT NULL,
        operator VARCHAR(5) NOT NULL DEFAULT '>',
        threshold NUMERIC NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        cooldown_minutes INT NOT NULL DEFAULT 10,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        rule_id INT,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        is_read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vm_telemetry (
        id SERIAL PRIMARY KEY,
        vmid INT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        cpu_pct NUMERIC,
        ram_bytes BIGINT,
        net_in_bytes BIGINT,
        net_out_bytes BIGINT,
        diskread_bytes BIGINT,
        diskwrite_bytes BIGINT,
        UNIQUE (vmid, timestamp)
      );

      CREATE TABLE IF NOT EXISTS vm_metrics (
        id SERIAL PRIMARY KEY,
        vmid INT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        cpu_pct NUMERIC,
        ram_bytes BIGINT,
        net_in_bytes BIGINT,
        net_out_bytes BIGINT,
        diskread_bytes BIGINT,
        diskwrite_bytes BIGINT,
        UNIQUE (vmid, timestamp)
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
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operator_access BOOLEAN NOT NULL DEFAULT false;
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

    // Optional bootstrap accounts. Credentials must be provisioned outside source control.
    const seedAccountFromEnv = async (prefix: 'BOOTSTRAP_ADMIN' | 'BOOTSTRAP_DEVOPS', role: 'administrator' | 'moderator') => {
      const email = process.env[`${prefix}_EMAIL`]?.trim().toLowerCase();
      const password = process.env[`${prefix}_PASSWORD`];
      const supportPin = process.env[`${prefix}_SUPPORT_PIN`];
      const name = process.env[`${prefix}_NAME`] || (role === 'administrator' ? 'Panel Administrator' : 'Panel Moderator');
      if (!email || !password || !supportPin) {
        console.warn(`[POSTGRES] ${prefix} account not seeded: required environment variables are missing.`);
        return;
      }
      const existing = await client.query('SELECT id FROM accounts WHERE email = $1', [email]);
      if (existing.rows.length === 0) {
        const { hash, salt } = hashPassword(password);
        await client.query(
          'INSERT INTO accounts (email, password_hash, name, role, support_pin) VALUES ($1, $2, $3, $4, $5)',
          [email, `${hash}:${salt}`, name, role, supportPin]
        );
      }
    };
    await seedAccountFromEnv('BOOTSTRAP_ADMIN', 'administrator');
    await seedAccountFromEnv('BOOTSTRAP_DEVOPS', 'moderator');

    console.log('⚡ PostgreSQL Database Schema & Proxmox Cloud Infrastructure Tables Initialized');
  } catch (err) {
    console.error('[POSTGRES] Critical Database Initialization Error:', err);
  } finally {
    client.release();
  }
}

// The server entrypoint awaits initializeDatabaseSchema() before starting workers or accepting requests.



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
    this.migrateVmMetricsTable()
      .then(() => this.migrateVmTelemetryColumns())
      .catch((err) => {
        console.warn('[DB MIGRATION] vm_metrics migration failed:', err.message);
      });
    this.migrateAlertTables().catch((err) => {
      console.warn('[DB MIGRATION] alert table migration failed:', err.message);
    });
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
        await pgPool.query("DELETE FROM vm_metrics WHERE timestamp < NOW() - INTERVAL '7 days'");
      } catch (err) {}
    }, 3600000);
  }

  // ============ ALERT RULES ============
  async getAlertRules(accountEmail?: string) {
    let query = 'SELECT * FROM alert_rules';
    const params: any[] = [];
    if (accountEmail) {
      query += ' WHERE account_email = $1';
      params.push(accountEmail.toLowerCase().trim());
    }
    query += ' ORDER BY created_at DESC';
    const res = await pgPool.query(query, params);
    return res.rows.map((r: any) => ({
      id: r.id,
      accountEmail: r.account_email,
      name: r.name,
      target: r.target,
      vmid: r.vmid,
      metric: r.metric,
      operator: r.operator,
      threshold: Number(r.threshold),
      severity: r.severity,
      cooldownMinutes: Number(r.cooldown_minutes),
      enabled: r.enabled,
      createdAt: r.created_at,
    }));
  }

  async createAlertRule(rule: {
    accountEmail: string;
    name?: string;
    target: 'cluster' | 'vm';
    vmid?: number;
    metric: string;
    operator: '>' | '<' | '>=' | '<=' | '==';
    threshold: number;
    severity?: 'info' | 'warning' | 'critical';
    cooldownMinutes?: number;
    enabled?: boolean;
  }) {
    const res = await pgPool.query(
      `INSERT INTO alert_rules (account_email, name, target, vmid, metric, operator, threshold, severity, cooldown_minutes, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        rule.accountEmail.toLowerCase().trim(),
        rule.name || `${rule.metric} ${rule.operator} ${rule.threshold}`,
        rule.target,
        rule.vmid ?? null,
        rule.metric,
        rule.operator,
        rule.threshold,
        rule.severity || 'warning',
        rule.cooldownMinutes ?? 10,
        rule.enabled !== false,
      ]
    );
    return res.rows[0]?.id;
  }

  async updateAlertRule(id: number, accountEmail: string, updates: any) {
    const fields: string[] = [];
    const params: any[] = [];
    const apply = (key: string, value: any) => {
      if (value !== undefined) {
        params.push(value);
        fields.push(`${key} = $${params.length}`);
      }
    };
    apply('name', updates.name);
    apply('target', updates.target);
    apply('vmid', updates.vmid);
    apply('metric', updates.metric);
    apply('operator', updates.operator);
    apply('threshold', updates.threshold);
    apply('severity', updates.severity);
    apply('cooldown_minutes', updates.cooldownMinutes);
    apply('enabled', updates.enabled);
    if (fields.length === 0) return false;
    params.push(id, accountEmail.toLowerCase().trim());
    await pgPool.query(`UPDATE alert_rules SET ${fields.join(', ')} WHERE id = $${params.length - 1} AND account_email = $${params.length}`, params);
    return true;
  }

  async deleteAlertRule(id: number, accountEmail: string) {
    const res = await pgPool.query('DELETE FROM alert_rules WHERE id = $1 AND account_email = $2', [id, accountEmail.toLowerCase().trim()]);
    return res.rowCount > 0;
  }

  // Check rules against a telemetry sample; returns fired notification rows (may be empty)
  async evaluateAlertRules(sample: {
    accountEmail: string;
    cpuPct: number;      // cluster average CPU
    memPct: number;      // cluster memory utilization
    vmid?: number;
    vmCpuPct?: number;
    vmMemPct?: number;
  }): Promise<{ accountEmail: string; ruleId: number; title: string; message: string; severity: string }[]> {
    // Load active enabled rules for this account (or globally visible admin rules)
    const res = await pgPool.query(
      "SELECT * FROM alert_rules WHERE enabled = true ORDER BY id ASC"
    );
    const fired: { accountEmail: string; ruleId: number; title: string; message: string; severity: string }[] = [];

    const compare = (op: string, value: number, threshold: number): boolean => {
      switch (op) {
        case '>': return value > threshold;
        case '>=': return value >= threshold;
        case '<': return value < threshold;
        case '<=': return value <= threshold;
        case '==': return Math.abs(value - threshold) < 0.01;
        default: return value > threshold;
      }
    };

    const metricValue = (rule: any): number | null => {
      if (rule.target === 'vm' || rule.vmid) {
        if (rule.vmid !== sample.vmid) return null;
        switch (rule.metric) {
          case 'cpu_pct': return sample.vmCpuPct ?? null;
          case 'mem_pct': return sample.vmMemPct ?? null;
          case 'cpu': return sample.cpuPct;
          case 'mem': return sample.memPct;
          default: return null;
        }
      }
      switch (rule.metric) {
        case 'cpu_pct':
        case 'cpu': return sample.cpuPct;
        case 'mem_pct':
        case 'mem': return sample.memPct;
        case 'net_in':
        case 'net_out': return null; // requires aggregation — unsupported for live checks
        default: return null;
      }
    };

    for (const rule of res.rows) {
      const value = metricValue(rule);
      if (value === null) continue;
      if (!compare(rule.operator, value, Number(rule.threshold))) continue;

      // Cooldown: skip if this rule fired a notification recently
      const cooldownSec = Math.max(1, Number(rule.cooldown_minutes)) * 60;
      const recent = await pgPool.query(
        "SELECT id FROM notifications WHERE rule_id = $1 AND created_at > NOW() - ($2 || ' seconds')::INTERVAL LIMIT 1",
        [rule.id, String(cooldownSec)]
      );
      if (recent.rows.length > 0) continue;

      const targets = rule.target === 'vm' ? `VMID ${rule.vmid ?? sample.vmid ?? '-'}` : 'Cluster';
      const unit = rule.metric.includes('mem') ? '%' : '%';
      const title = `Alert: ${rule.name || rule.metric} breached`;
      const message = `${targets} ${rule.metric.replace('_', ' ')} is now ${value.toFixed(1)}${unit} — exceeds rule "${rule.name || ''}" (${rule.operator} ${Number(rule.threshold).toFixed(1)}${unit}). Severity: ${rule.severity}.`;
      fired.push({ accountEmail: rule.account_email || sample.accountEmail, ruleId: rule.id, title, message, severity: rule.severity || 'warning' });
    }
    return fired;
  }

  async createNotification(notif: { accountEmail: string; ruleId?: number; title: string; message: string; severity?: string }) {
    const res = await pgPool.query(
      "INSERT INTO notifications (account_email, rule_id, title, message, severity) VALUES ($1, $2, $3, $4, $5)",
      [notif.accountEmail.toLowerCase().trim(), notif.ruleId ?? null, notif.title, notif.message, notif.severity || 'warning']
    );
    return res.rowCount > 0;
  }

  async getNotifications(accountEmail: string, unreadOnly: boolean = false) {
    let query = 'SELECT * FROM notifications';
    const params: any[] = [];
    if (unreadOnly) {
      query += ' WHERE account_email = $1 AND is_read = false';
      params.push(accountEmail.toLowerCase().trim());
    } else if (accountEmail) {
      query += ' WHERE account_email = $1';
      params.push(accountEmail.toLowerCase().trim());
    }
    query += ' ORDER BY created_at DESC LIMIT 100';
    const res = await pgPool.query(query, params);
    return res.rows.map((r: any) => ({
      id: r.id,
      accountEmail: r.account_email,
      ruleId: r.rule_id,
      title: r.title,
      message: r.message,
      severity: r.severity,
      isRead: r.is_read,
      createdAt: r.created_at,
    }));
  }

  async getNotificationCount(accountEmail: string) {
    const res = await pgPool.query("SELECT COUNT(*)::int AS count FROM notifications WHERE account_email = $1 AND is_read = false", [accountEmail.toLowerCase().trim()]);
    return Number(res.rows[0]?.count || 0);
  }

  async markNotificationsRead(accountEmail: string, ids?: number[]) {
    if (ids && ids.length > 0) {
      const res = await pgPool.query(
        "UPDATE notifications SET is_read = true WHERE account_email = $1 AND id = ANY($2)",
        [accountEmail.toLowerCase().trim(), ids]
      );
      return res.rowCount;
    }
    const res = await pgPool.query(
      "UPDATE notifications SET is_read = true WHERE account_email = $1",
      [accountEmail.toLowerCase().trim()]
    );
    return res.rowCount;
  }

  async deleteNotification(id: number, accountEmail: string) {
    const res = await pgPool.query('DELETE FROM notifications WHERE id = $1 AND account_email = $2', [id, accountEmail.toLowerCase().trim()]);
    return res.rowCount > 0;
  }

  async clearAllNotifications(accountEmail: string) {
    const res = await pgPool.query('DELETE FROM notifications WHERE account_email = $1', [accountEmail.toLowerCase().trim()]);
    return res.rowCount;
  }

  // TELEMETRY (column migration for existing databases)
  async migrateAlertTables() {
    // Create alert tables via CREATE TABLE IF NOT EXISTS (idempotent, executed at boot)
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id SERIAL PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        target VARCHAR(20) NOT NULL DEFAULT 'cluster',
        vmid INT,
        metric VARCHAR(30) NOT NULL,
        operator VARCHAR(5) NOT NULL DEFAULT '>',
        threshold NUMERIC NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        cooldown_minutes INT NOT NULL DEFAULT 10,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        rule_id INT,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        is_read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Auto-create a sensible default rule for new installations: cluster CPU > 85%
    const existing = await pgPool.query("SELECT id FROM alert_rules LIMIT 1");
    if (existing.rows.length === 0) {
      await pgPool.query(
        "INSERT INTO alert_rules (account_email, name, target, vmid, metric, operator, threshold, severity, cooldown_minutes, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        ['admin@votioncloud.org', 'Cluster CPU high', 'cluster', null, 'cpu_pct', '>', 85, 'warning', 10, true]
      );
      await pgPool.query(
        "INSERT INTO alert_rules (account_email, name, target, vmid, metric, operator, threshold, severity, cooldown_minutes, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        ['admin@votioncloud.org', 'VM memory critical', 'vm', null, 'mem_pct', '>', 90, 'critical', 10, true]
      );
    }
    console.log('[ALERTS] Alert tables ready.');
  }

  async migrateVmMetricsTable() {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS vm_metrics (
        id SERIAL PRIMARY KEY,
        vmid INT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        cpu_pct NUMERIC,
        ram_bytes BIGINT,
        net_in_bytes BIGINT,
        net_out_bytes BIGINT,
        diskread_bytes BIGINT,
        diskwrite_bytes BIGINT,
        UNIQUE (vmid, timestamp)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_metrics_vmid_ts ON vm_metrics (vmid, timestamp);
    `);
    try {
      await pgPool.query(`
        INSERT INTO vm_metrics (vmid, timestamp, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes, diskread_bytes, diskwrite_bytes)
        SELECT vmid, timestamp, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes, diskread_bytes, diskwrite_bytes
        FROM vm_telemetry
        ON CONFLICT (vmid, timestamp) DO NOTHING;
      `);
    } catch (err: any) {
      console.warn('[DB MIGRATION] vm_metrics backfill skipped:', err.message);
    }
  }

  async migrateVmTelemetryColumns() {
    const cols = await pgPool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'vm_metrics'");
    const names = cols.rows.map(r => r.column_name);
    if (!names.includes('diskread_bytes')) {
      await pgPool.query("ALTER TABLE vm_metrics ADD COLUMN IF NOT EXISTS diskread_bytes BIGINT");
    }
    if (!names.includes('diskwrite_bytes')) {
      await pgPool.query("ALTER TABLE vm_metrics ADD COLUMN IF NOT EXISTS diskwrite_bytes BIGINT");
    }
    // Guarantee one sample per VM per second: duplicates from restarts or race
    // conditions are merged instead of creating double-counted history.
    try {
      await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_metrics_vmid_ts ON vm_metrics (vmid, timestamp)");
    } catch (err: any) {
      console.warn('[DB MIGRATION] unique telemetry index:', err.message);
    }
  }

  async upsertProxmoxVMs(resources: Array<{ vmid: number; node: string; name?: string; status?: string; cpus?: number; maxmem?: number; maxdisk?: number; type?: string }>, defaultOwnerEmail: string) {
    if (resources.length === 0) return;
    await pgPool.query(
      `INSERT INTO vms (vmid, vm_name, node, status, cpus, maxmem, maxdisk, memory, disk, cpu_cores, ram_mb, disk_gb, owner_email, type)
       SELECT resource.vmid,
              COALESCE(NULLIF(resource.name, ''), 'vm-' || resource.vmid),
              resource.node,
              COALESCE(NULLIF(resource.status, ''), 'unknown'),
              GREATEST(COALESCE(resource.cpus, 1), 1),
              COALESCE(resource.maxmem, 0),
              COALESCE(resource.maxdisk, 0),
              COALESCE(resource.maxmem, 0),
              COALESCE(resource.maxdisk, 0),
              GREATEST(COALESCE(resource.cpus, 1), 1),
              GREATEST(CEIL(COALESCE(resource.maxmem, 0) / 1048576.0)::int, 1),
              GREATEST(CEIL(COALESCE(resource.maxdisk, 0) / 1073741824.0)::int, 1),
              $2,
              CASE WHEN resource.type = 'lxc' THEN 'lxc' ELSE 'qemu' END
       FROM jsonb_to_recordset($1::jsonb) AS resource(
         vmid INT, node TEXT, name TEXT, status TEXT, cpus INT, maxmem BIGINT, maxdisk BIGINT, type TEXT
       )
       ON CONFLICT (vmid) DO UPDATE SET
         vm_name = EXCLUDED.vm_name,
         node = EXCLUDED.node,
         status = CASE
           WHEN vms.status IN ('starting', 'stopping', 'restarting') AND EXCLUDED.status = 'unknown' THEN vms.status
           ELSE EXCLUDED.status
         END,
         cpus = EXCLUDED.cpus,
         maxmem = EXCLUDED.maxmem,
         maxdisk = EXCLUDED.maxdisk,
         memory = EXCLUDED.memory,
         disk = EXCLUDED.disk,
         cpu_cores = EXCLUDED.cpu_cores,
         ram_mb = EXCLUDED.ram_mb,
         disk_gb = EXCLUDED.disk_gb,
         type = EXCLUDED.type`,
      [JSON.stringify(resources), defaultOwnerEmail]
    );
  }

  async insertVmMetricsBatch(samples: Array<{ vmid: number; cpuPct: number; ramBytes: number; netInBytes: number; netOutBytes: number; diskReadBytes?: number; diskWriteBytes?: number }>) {
    if (samples.length === 0) return;
    await pgPool.query(
      `INSERT INTO vm_metrics (vmid, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes, diskread_bytes, diskwrite_bytes)
       SELECT sample.vmid, sample.cpu_pct, sample.ram_bytes, sample.net_in_bytes, sample.net_out_bytes, sample.diskread_bytes, sample.diskwrite_bytes
       FROM jsonb_to_recordset($1::jsonb) AS sample(
         vmid INT, cpu_pct NUMERIC, ram_bytes BIGINT, net_in_bytes BIGINT, net_out_bytes BIGINT, diskread_bytes BIGINT, diskwrite_bytes BIGINT
       )
       ON CONFLICT (vmid, timestamp) DO UPDATE SET
         cpu_pct = EXCLUDED.cpu_pct,
         ram_bytes = EXCLUDED.ram_bytes,
         net_in_bytes = EXCLUDED.net_in_bytes,
         net_out_bytes = EXCLUDED.net_out_bytes,
         diskread_bytes = EXCLUDED.diskread_bytes,
         diskwrite_bytes = EXCLUDED.diskwrite_bytes`,
      [JSON.stringify(samples)]
    );
  }

  async updateVmStatus(vmid: number, status: string) {
    const result = await pgPool.query('UPDATE vms SET status = $1 WHERE vmid = $2 RETURNING *', [status, vmid]);
    return result.rows[0] || null;
  }

  async insertVmTelemetry(vmid: number, cpuPct: number, ramBytes: number, netIn: number, netOut: number, diskRead?: number, diskWrite?: number) {
    // UPSERT with a per-VMID+timestamp uniqueness rule: if a sample for this exact
    // second already exists, it is refreshed instead of duplicated. A matching unique
    // index is created automatically by migrateVmTelemetryColumns() on startup.
    try {
      await pgPool.query(
        `INSERT INTO vm_metrics (vmid, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes, diskread_bytes, diskwrite_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (vmid, timestamp) DO UPDATE SET
           cpu_pct = EXCLUDED.cpu_pct,
           ram_bytes = EXCLUDED.ram_bytes,
           net_in_bytes = EXCLUDED.net_in_bytes,
           net_out_bytes = EXCLUDED.net_out_bytes,
           diskread_bytes = EXCLUDED.diskread_bytes,
           diskwrite_bytes = EXCLUDED.diskwrite_bytes`,
        [vmid, cpuPct, ramBytes, netIn, netOut, diskRead ?? null, diskWrite ?? null]
      );
    } catch (err) {
      console.error('Error inserting telemetry:', err);
    }
  }

  async getVmTelemetryHistory(vmid: number, hours: number = 24) {
    const res = await pgPool.query(
      "SELECT * FROM vm_metrics WHERE vmid = $1 AND timestamp > NOW() - INTERVAL '1 hour' * $2 ORDER BY timestamp ASC",
      [vmid, hours]
    );
    return res.rows;
  }

  // ADMIN: Full cluster telemetry history across all VMs (used by the admin dashboard chart)
  async getTelemetryHistory(hours: number = 24) {
    const res = await pgPool.query(
      `SELECT timestamp, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes,
              diskread_bytes, diskwrite_bytes
              FROM vm_metrics
       WHERE timestamp > NOW() - INTERVAL '1 hour' * $1
       ORDER BY timestamp ASC`,
      [hours]
    );
    return res.rows;
  }

  // ADMIN: Per-node aggregated stats (peak/min/avg over the window)
  async getNodeTelemetryAggregates(hours: number = 24) {
    const res = await pgPool.query(
      `SELECT vmid,
              round(avg(cpu_pct)::numeric, 2) AS avg_cpu,
              round(max(cpu_pct)::numeric, 2) AS peak_cpu,
              round(min(cpu_pct)::numeric, 2) AS min_cpu,
              round(avg(ram_bytes)::numeric, 0) AS avg_ram_bytes,
              max(ram_bytes) AS peak_ram_bytes,
              sum(net_in_bytes) AS total_net_in_bytes,
              sum(net_out_bytes) AS total_net_out_bytes
              FROM vm_metrics
       WHERE timestamp > NOW() - INTERVAL '1 hour' * $1
       GROUP BY vmid`,
      [hours]
    );
    return res.rows;
  }

  // ACCOUNTS & USERS
  async ensureMailTemplatesTable() {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS mail_templates (
        id SERIAL PRIMARY KEY,
        template_key VARCHAR(100) UNIQUE NOT NULL,
        subject VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE proxmox_connections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE vms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);
    await this.seedMailTemplates();
  }

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
      id: n.id, node: n.node_name, ip: n.ip_address, status: n.cluster_status, cpuUsagePct: n.cpu_usage, ramUsageBytes: n.ram_usage, ramTotalBytes: n.ram_total, platformVersion: '8.2.4', zfsHealth: n.zfs_health, uptimeSeconds: 2419200,
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
    let params: any[] = [];
    let conditions = [];
    
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
    if (res.rowCount > 0) {
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

  private mapReimageRequest(row: any) {
    return {
      id: row.id,
      vmid: Number(row.vmid),
      vmName: row.vm_name || undefined,
      vmType: row.vm_type || undefined,
      ownerEmail: row.owner_email || undefined,
      requesterEmail: row.requester_email,
      requestedOs: row.requested_os,
      status: row.status,
      requesterNote: row.requester_note || undefined,
      reviewerEmail: row.reviewer_email || undefined,
      reviewerNote: row.reviewer_note || undefined,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || undefined,
      cancelledAt: row.cancelled_at || undefined,
    };
  }

  async createReimageRequest(vmid: number, requestedOs: string, requesterEmail: string, requesterNote?: string) {
    const vm = await this.getVMByVMID(vmid);
    if (!vm) return null;
    if (vm.isSuspended) throw new Error(`VMID ${vmid} is currently suspended. Reimage requests are blocked.`);

    const duplicate = await pgPool.query(
      `SELECT id FROM vm_reimage_requests
       WHERE vmid = $1 AND status = 'pending'
       LIMIT 1`,
      [vmid],
    );
    if (duplicate.rows.length > 0) {
      throw new Error('A pending OS reimage request already exists for this VM.');
    }

    const id = `reimage-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const email = requesterEmail.toLowerCase().trim();
    await pgPool.query(
      `INSERT INTO vm_reimage_requests
       (id, vmid, requester_email, requested_os, status, requester_note, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, NOW())`,
      [id, vmid, email, requestedOs, requesterNote?.trim() || null],
    );

    await this.logAudit(
      email,
      'REQUEST_REIMAGE_OS',
      `VMID ${vmid}`,
      `Submitted approval request ${id} for ${requestedOs}; no Proxmox operation was started.`,
    );

    const result = await pgPool.query(
      `SELECT r.*, v.vm_name, v.type AS vm_type, v.owner_email
       FROM vm_reimage_requests r
       JOIN vms v ON v.vmid = r.vmid
       WHERE r.id = $1`,
      [id],
    );
    return this.mapReimageRequest(result.rows[0]);
  }

  async getReimageRequests(options: { vmid?: number; requesterEmail?: string; status?: string } = {}) {
    const params: any[] = [];
    const conditions: string[] = [];
    if (options.vmid !== undefined) {
      params.push(options.vmid);
      conditions.push(`r.vmid = $${params.length}`);
    }
    if (options.requesterEmail) {
      params.push(options.requesterEmail.toLowerCase().trim());
      conditions.push(`LOWER(r.requester_email) = $${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conditions.push(`r.status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pgPool.query(
      `SELECT r.*, v.vm_name, v.type AS vm_type, v.owner_email
       FROM vm_reimage_requests r
       JOIN vms v ON v.vmid = r.vmid
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 100`,
      params,
    );
    return result.rows.map(row => this.mapReimageRequest(row));
  }

  private mapReimageExecution(row: any) {
    return {
      id: row.id,
      requestId: row.request_id,
      vmid: Number(row.vmid),
      vmName: row.vm_name || undefined,
      vmType: row.vm_type || undefined,
      ownerEmail: row.owner_email || undefined,
      requestedOs: row.requested_os,
      requesterEmail: row.requester_email,
      requestStatus: row.request_status,
      imageProfileId: row.image_profile_id || undefined,
      imageProfileVersion: row.image_profile_version || undefined,
      state: row.state,
      planHash: row.plan_hash || undefined,
      operatorEmail: row.operator_email || undefined,
      operatorConfirmedAt: row.operator_confirmed_at || undefined,
      preflightSnapshot: row.preflight_snapshot || undefined,
      backupReference: row.backup_reference || undefined,
      leaseOwner: row.lease_owner || undefined,
      leaseExpiresAt: row.lease_expires_at || undefined,
      attemptCount: Number(row.attempt_count || 0),
      currentStep: row.current_step || undefined,
      stepUpids: row.step_upids || [],
      validationResult: row.validation_result || undefined,
      errorCode: row.error_code || undefined,
      errorMessage: row.error_message || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      queuedAt: row.queued_at || undefined,
      completedAt: row.completed_at || undefined,
      blockedAt: row.blocked_at || undefined,
    };
  }

  private reimageExecutionSelect = `
    SELECT e.*, r.requested_os, r.requester_email, r.status AS request_status,
           v.vm_name, v.type AS vm_type, v.owner_email
    FROM vm_reimage_executions e
    JOIN vm_reimage_requests r ON r.id = e.request_id
    JOIN vms v ON v.vmid = e.vmid
  `;

  async getApprovedReimageRequest(requestId: string) {
    const result = await pgPool.query(
      `SELECT r.*, v.vm_name, v.type AS vm_type, v.owner_email, v.node, v.status AS vm_status, v.is_suspended
       FROM vm_reimage_requests r
       JOIN vms v ON v.vmid = r.vmid
       WHERE r.id = $1 AND r.status = 'approved'`,
      [requestId],
    );
    return result.rows[0] || null;
  }

  async getEnabledReimageImageProfile(osLabel: string, vmType: 'qemu' | 'lxc') {
    const result = await pgPool.query(
      `SELECT id, os_label, vm_type, template_vmid, template_node, storage_id, version, image_digest
       FROM vm_reimage_image_profiles
       WHERE os_label = $1 AND vm_type = $2 AND enabled = true AND retired_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [osLabel, vmType],
    );
    return result.rows[0] || null;
  }

  async getReimageExecution(executionId: string) {
    const result = await pgPool.query(
      `${this.reimageExecutionSelect} WHERE e.id = $1`,
      [executionId],
    );
    return result.rows[0] ? this.mapReimageExecution(result.rows[0]) : null;
  }

  async getReimageExecutions(options: { operatorEmail?: string; state?: string } = {}) {
    const params: any[] = [];
    const conditions: string[] = [];
    if (options.operatorEmail) {
      params.push(options.operatorEmail.toLowerCase().trim());
      conditions.push(`LOWER(e.operator_email) = $${params.length}`);
    }
    if (options.state) {
      params.push(options.state);
      conditions.push(`e.state = $${params.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await pgPool.query(
      `${this.reimageExecutionSelect}${where} ORDER BY e.created_at DESC LIMIT 100`,
      params,
    );
    return result.rows.map(row => this.mapReimageExecution(row));
  }

  async createReimageExecution(input: {
    requestId: string;
    vmid: number;
    requestSnapshot: Record<string, unknown>;
    imageProfileId: string;
    imageProfileVersion: string;
    planHash: string;
    operatorEmail: string;
  }) {
    const client = await pgPool.connect();
    let executionId: string;
    try {
      await client.query('BEGIN');
      const request = await client.query(
        `SELECT r.id, r.vmid, r.status, v.vm_name, v.type AS vm_type, v.owner_email
         FROM vm_reimage_requests r JOIN vms v ON v.vmid = r.vmid
         WHERE r.id = $1 FOR UPDATE`,
        [input.requestId],
      );
      if (request.rows.length === 0) throw new Error('APPROVED_REQUEST_NOT_FOUND');
      if (request.rows[0].status !== 'approved') throw new Error('APPROVED_REQUEST_NOT_ACTIVE');
      if (Number(request.rows[0].vmid) !== input.vmid) throw new Error('EXECUTION_VM_MISMATCH');

      const existing = await client.query(
        `SELECT id FROM vm_reimage_executions
         WHERE request_id = $1 AND state NOT IN ('completed', 'failed', 'cancelled')
         ORDER BY created_at DESC LIMIT 1`,
        [input.requestId],
      );
      if (existing.rows.length > 0) {
        executionId = existing.rows[0].id;
      } else {
        executionId = `reimage-exec-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
        await client.query(
          `INSERT INTO vm_reimage_executions
           (id, request_id, vmid, request_snapshot, image_profile_id, image_profile_version, state, plan_hash, operator_email, current_step)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'created', $7, $8, 'created')`,
          [executionId, input.requestId, input.vmid, JSON.stringify(input.requestSnapshot), input.imageProfileId, input.imageProfileVersion, input.planHash, input.operatorEmail.toLowerCase().trim()],
        );
        await client.query(
          `INSERT INTO vm_reimage_audit_events
           (id, request_id, execution_id, actor_email, actor_capability, action, from_state, to_state, correlation_id, plan_hash, safe_details)
           VALUES ($1, $2, $3, $4, 'reimage.execute', 'CREATE_EXECUTION', NULL, 'created', $5, $6, $7::jsonb)`,
          [`reimage-audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, input.requestId, executionId, input.operatorEmail.toLowerCase().trim(), executionId, input.planHash, JSON.stringify({ vmid: input.vmid, imageProfileId: input.imageProfileId, imageProfileVersion: input.imageProfileVersion })],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return await this.getReimageExecution(executionId);
  }

  async markReimagePreflightPassed(executionId: string, operatorEmail: string, snapshot: Record<string, unknown>, planHash: string) {
    const email = operatorEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE vm_reimage_executions
       SET state = 'awaiting_confirmation', preflight_snapshot = $2::jsonb, plan_hash = $3,
           operator_email = $4, current_step = 'preflight', updated_at = NOW()
       WHERE id = $1 AND state IN ('created', 'preflight_passed')
       RETURNING id`,
      [executionId, JSON.stringify(snapshot), planHash, email],
    );
    if (result.rows.length === 0) return null;
    await this.recordReimageAuditEvent({ executionId, actorEmail: email, action: 'PREFLIGHT_PASSED', fromState: 'created', toState: 'awaiting_confirmation', planHash, safeDetails: { checkCount: Object.keys(snapshot).length } });
    return await this.getReimageExecution(executionId);
  }

  async queueReimageExecution(executionId: string, operatorEmail: string, planHash: string) {
    const email = operatorEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE vm_reimage_executions
       SET state = 'queued', operator_email = $2, operator_confirmed_at = NOW(), queued_at = NOW(), current_step = 'queued', updated_at = NOW()
       WHERE id = $1 AND state = 'awaiting_confirmation' AND plan_hash = $3
       RETURNING id`,
      [executionId, email, planHash],
    );
    if (result.rows.length === 0) return null;
    await this.recordReimageAuditEvent({ executionId, actorEmail: email, action: 'QUEUE_EXECUTION', fromState: 'awaiting_confirmation', toState: 'queued', planHash, safeDetails: { executionEnabled: false } });
    return await this.getReimageExecution(executionId);
  }

  async blockReimageExecution(executionId: string, actorEmail: string, errorCode: string, errorMessage: string) {
    const email = actorEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE vm_reimage_executions
       SET state = 'blocked', error_code = $2, error_message = $3, blocked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND state NOT IN ('completed', 'failed', 'cancelled')
       RETURNING id`,
      [executionId, errorCode, errorMessage.slice(0, 500)],
    );
    if (result.rows.length === 0) return null;
    await this.recordReimageAuditEvent({ executionId, actorEmail: email, action: 'BLOCK_EXECUTION', fromState: undefined, toState: 'blocked', safeDetails: { errorCode } });
    return await this.getReimageExecution(executionId);
  }

  async acquireReimageExecutionLease(executionId: string, workerId: string, leaseMs = 120000) {
    const result = await pgPool.query(
      `UPDATE vm_reimage_executions
       SET state = 'processing', lease_owner = $2, lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1, current_step = 'processing', updated_at = NOW()
       WHERE id = $1 AND state = 'queued'
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       RETURNING id`,
      [executionId, workerId, leaseMs],
    );
    return result.rows.length > 0 ? await this.getReimageExecution(executionId) : null;
  }

  async cancelReimageExecution(executionId: string, operatorEmail: string) {
    const email = operatorEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE vm_reimage_executions
       SET state = 'cancelled', error_code = 'OPERATOR_CANCELLED', error_message = 'Cancelled by operator before any Proxmox mutation.', updated_at = NOW()
       WHERE id = $1 AND operator_email = $2
         AND state IN ('created', 'preflight_passed', 'awaiting_confirmation', 'queued')
       RETURNING id`,
      [executionId, email],
    );
    if (result.rows.length === 0) return null;
    await this.recordReimageAuditEvent({ executionId, actorEmail: email, action: 'CANCEL_EXECUTION', toState: 'cancelled', safeDetails: { mutationAttempted: false } });
    return await this.getReimageExecution(executionId);
  }

  async recordReimageAuditEvent(input: { requestId?: string; executionId?: string; actorEmail: string; action: string; fromState?: string; toState?: string; correlationId?: string; planHash?: string; safeDetails?: Record<string, unknown> }) {
    const id = `reimage-audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await pgPool.query(
      `INSERT INTO vm_reimage_audit_events
       (id, request_id, execution_id, actor_email, actor_capability, action, from_state, to_state, correlation_id, plan_hash, safe_details)
       VALUES ($1, $2, $3, $4, 'reimage.execute', $5, $6, $7, $8, $9, $10::jsonb)`,
      [id, input.requestId || null, input.executionId || null, input.actorEmail.toLowerCase().trim(), input.action, input.fromState || null, input.toState || null, input.correlationId || input.executionId || id, input.planHash || null, JSON.stringify(input.safeDetails || {})],
    );
    return { id };
  }

  async cancelReimageRequest(requestId: string, vmid: number, requesterEmail: string, isAdmin = false) {
    const email = requesterEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE vm_reimage_requests
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND vmid = $2 AND status = 'pending'
         AND ($3 = true OR LOWER(requester_email) = $4)
       RETURNING *`,
      [requestId, vmid, isAdmin, email],
    );
    if (result.rows.length === 0) return null;

    await this.logAudit(
      email,
      'CANCEL_REIMAGE_REQUEST',
      `VMID ${vmid}`,
      `Cancelled OS reimage request ${requestId}; no Proxmox operation was started.`,
    );
    return this.mapReimageRequest(result.rows[0]);
  }

  async reviewReimageRequest(requestId: string, decision: 'approved' | 'rejected', reviewerEmail: string, reviewerNote?: string) {
    const email = reviewerEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE vm_reimage_requests
       SET status = $2, reviewer_email = $3, reviewer_note = $4, reviewed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [requestId, decision, email, reviewerNote?.trim() || null],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    await this.logAudit(
      email,
      `${decision.toUpperCase()}_REIMAGE_REQUEST`,
      `VMID ${row.vmid}`,
      `${decision === 'approved' ? 'Approved' : 'Rejected'} OS reimage request ${requestId} for ${row.requested_os}. Approval does not start a Proxmox operation.`,
    );

    const detailed = await pgPool.query(
      `SELECT r.*, v.vm_name, v.type AS vm_type, v.owner_email
       FROM vm_reimage_requests r
       JOIN vms v ON v.vmid = r.vmid
       WHERE r.id = $1`,
      [requestId],
    );
    return this.mapReimageRequest(detailed.rows[0]);
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
    if (res.rowCount > 0) {
      await this.logAudit(userEmail, 'DELETE_VM', `VMID ${vmid}`, `Deleted VMID ${vmid}`);
      return true;
    }
    return false;
  }

  // SUPPORT TICKET SYSTEM & REPLIES
  async getSupportTickets(userEmail?: string) {
    let query = 'SELECT * FROM tickets';
    let params: any[] = [];
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

  async updateTicketStatus(ticketId: string, status: string, userEmail: string) {
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
    return res.rowCount > 0;
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
    return res.rowCount > 0;
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
    let params: any[] = [];
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
    return res.rowCount > 0;
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

    async setOperatorAccess(accountEmail: string, enabled: boolean, actorEmail: string) {
    const email = accountEmail.toLowerCase().trim();
    const result = await pgPool.query(
      `UPDATE accounts SET operator_access = $1 WHERE email = $2
       RETURNING email, name, role, operator_access`,
      [enabled, email],
    );
    if (result.rows.length === 0) return null;
    await this.logAudit(
      actorEmail,
      enabled ? 'GRANT_REIMAGE_OPERATOR_ACCESS' : 'REVOKE_REIMAGE_OPERATOR_ACCESS',
      email,
      `Dedicated reimage operator access ${enabled ? 'granted' : 'revoked'}.`,
    );
    return {
      email: result.rows[0].email,
      name: result.rows[0].name,
      role: result.rows[0].role,
      operatorAccess: result.rows[0].operator_access === true,
    };
  }

  // ADVANCED USER MANAGEMENT
  async createUserByAdmin(email: string, name: string, role: string, initialPassword: string | undefined, actorEmail: string) {
    const clean = email.toLowerCase().trim();
    const exists = await this.findUserByEmail(clean);
    if (exists) {
      return { success: false, error: `Account with email ${clean} already exists.` };
    }
    if (!initialPassword || initialPassword.length < 8) return { success: false, error: 'An initial password of at least 8 characters is required.' };
    const password = initialPassword;
    const { hash, salt } = hashPassword(password);
    const storedHash = `${hash}:${salt}`;
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    const res = await pgPool.query(
      `INSERT INTO accounts (email, password_hash, name, role, support_pin, two_factor_active, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW()) RETURNING id, email, name, role, support_pin`,
      [clean, storedHash, name, role, pin]
    );
    const created = res.rows[0];
    await this.logAudit(actorEmail, 'CREATE_USER', created.email, `User provisioned with role ${role} (initial password hashed via PBKDF2)`);
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
    return res.rowCount > 0;
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
    return res.rowCount > 0;
  }


  async updateAdminUserProfile(userId: number, payload: { name?: string; email?: string; role?: string; phone?: string }) {
    const user = (await pgPool.query('SELECT * FROM accounts WHERE id = $1', [userId])).rows[0] || null;
    if (!user) return { success: false, error: 'User not found' };
    const newName = payload.name !== undefined ? payload.name : user.name;
    const newRole = payload.role !== undefined ? payload.role : user.role;
    const newPhone = payload.phone !== undefined ? payload.phone : user.phone;
    let newEmail = user.email;
    if (payload.email !== undefined && payload.email.toLowerCase().trim() !== user.email.toLowerCase().trim()) {
      const ce = await this.changeUserEmail(user.email, payload.email);
      if (!ce.success) return ce;
      newEmail = ce.email;
    }
    const res = await pgPool.query('UPDATE accounts SET name = $1, role = $2, phone = $3, updated_at = NOW() WHERE id = $4 RETURNING id, email, name, role, phone', [newName, newRole, newPhone, userId]);
    return { success: true, user: res.rows[0] || user };
  }

  async resetUserPassword(userId: number, newPassword: string) {
    const user = await pgPool.query('SELECT email FROM accounts WHERE id = $1', [userId]);
    if (!user.rows[0]) return { success: false, error: 'User not found' };
    if (newPassword.length < 8) return { success: false, error: 'Password must be at least 8 characters' };
    const { hash, salt } = hashPassword(newPassword);
    await pgPool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [`${hash}:${salt}`, userId]);
    return { success: true, email: user.rows[0].email };
  }

  async updateProxmoxConnection(id: string, payload: { name?: string; host_ip?: string; port?: number; username?: string; password?: string; token_id?: string; token_secret?: string; ssl_fingerprint?: string }) {
    const existing = await pgPool.query('SELECT * FROM proxmox_connections WHERE id = $1', [id]);
    if (!existing.rows[0]) return { success: false, error: 'Connection not found' };
    const e = existing.rows[0];
    const name = payload.name !== undefined ? payload.name : e.name;
    const host_ip = payload.host_ip !== undefined ? payload.host_ip : e.host_ip;
    const port = payload.port !== undefined ? payload.port : e.port;
    const username = payload.username !== undefined ? payload.username : e.username;
    const password = payload.password !== undefined && payload.password !== '' ? payload.password : e.password;
    const token_id = payload.token_id !== undefined ? payload.token_id : e.token_id;
    const token_secret = payload.token_secret !== undefined && payload.token_secret !== '' ? payload.token_secret : e.token_secret;
    const ssl_fingerprint = payload.ssl_fingerprint !== undefined ? payload.ssl_fingerprint : e.ssl_fingerprint;
    const res = await pgPool.query(
      `UPDATE proxmox_connections SET name = $1, host_ip = $2, port = $3, username = $4, password = $5, token_id = $6, token_secret = $7, ssl_fingerprint = $8, updated_at = NOW() WHERE id = $9 RETURNING *`,
      [name, host_ip, port, username, password, token_id, token_secret, ssl_fingerprint, id]
    );
    return { success: true, connection: res.rows[0] };
  }

  async getAuditLogsFiltered(opts: { action?: string; user_email?: string; status?: string; search?: string; limit?: number; offset?: number } = {}) {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.action) { params.push(opts.action); where.push(`action = $${params.length}`); }
    if (opts.user_email) { params.push(opts.user_email.toLowerCase().trim()); where.push(`user_email = $${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
    if (opts.search) { params.push(`%${opts.search}%`); where.push(`(details ILIKE $${params.length} OR target ILIKE $${params.length} OR user_email ILIKE $${params.length})`); }
    const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
    const offset = Math.max(opts.offset || 0, 0);
    const [countRes, res] = await Promise.all([
      pgPool.query(`SELECT COUNT(*)::int AS total FROM audit_logs${whereClause}`, params),
      pgPool.query(`SELECT * FROM audit_logs${whereClause} ORDER BY timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    ]);
    return { total: countRes.rows[0].total, logs: res.rows };
  }

  async getAuditLogStats() {
    const [total, byAction, byStatus, byUser] = await Promise.all([
      pgPool.query('SELECT COUNT(*)::int AS total FROM audit_logs'),
      pgPool.query(`SELECT action, COUNT(*)::int AS count FROM audit_logs GROUP BY action ORDER BY count DESC LIMIT 15`),
      pgPool.query(`SELECT status, COUNT(*)::int AS count FROM audit_logs GROUP BY status`),
      pgPool.query(`SELECT user_email, COUNT(*)::int AS count FROM audit_logs GROUP BY user_email ORDER BY count DESC LIMIT 10`),
    ]);
    return {
      total: total.rows[0].total,
      byAction: byAction.rows,
      byStatus: byStatus.rows,
      byUser: byUser.rows,
    };
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
    return res.rowCount > 0;
  }

  // SYSTEM SETTINGS

  async seedMailTemplates() {
    const templates = [
      { template_key: 'welcome', subject: 'Welcome to Stellar Platform', body: '<div style="font-family: sans-serif;"><h2>Welcome to the Stellar Platform, {name}!</h2><p>Your account has been successfully created. You can now log in to the dashboard to manage your virtual machines and services.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', enabled: true },
      { template_key: 'ticket_update', subject: 'Support Ticket Update: {ticketNumber}', body: '<div style="font-family: sans-serif;"><h2>Support Ticket Update: {ticketNumber}</h2><p>Your support ticket status has been updated to: <strong>{status}</strong></p><p>{message}</p><p>Best regards,<br/>Stellar Platform Support</p></div>', enabled: true },
      { template_key: 'expiry_warning', subject: 'Service Expiry Warning: VMID {vmid}', body: '<div style="font-family: sans-serif;"><h2>Service Expiry Warning</h2><p>Your virtual machine (VMID {vmid}) is approaching its expiry date. Please extend your service to avoid interruption.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', enabled: true },
      { template_key: 'alert_fired', subject: 'Stellar Alert: {title}', body: '<div style="font-family: sans-serif;"><h2>{title}</h2><p>{message}</p><p>Review the metrics dashboard for full details.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', enabled: true },
      { template_key: 'password_reset', subject: 'Your Stellar Platform password was changed', body: '<div style="font-family: sans-serif;"><h2>Password Changed</h2><p>The password for your account ({email}) was changed by an administrator. If you did not expect this, please contact support immediately.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', enabled: true },
      { template_key: 'account_updated', subject: 'Your Stellar Platform account was updated', body: '<div style="font-family: sans-serif;"><h2>Account Updated</h2><p>Your account details were updated by an administrator: {changes}.</p><p>If you did not expect this, please contact support immediately.</p><p>Best regards,<br/>Stellar Platform Support</p></div>', enabled: true },
      { template_key: 'connection_test', subject: 'Cluster Connection Test Successful', body: '<div style="font-family: sans-serif;"><h2>Connection Test Passed</h2><p>The connection to the cluster endpoint ({host}:{port}) was verified successfully. Your panel is communicating with the compute infrastructure correctly.</p><p>Best regards,<br/>Stellar Platform</p></div>', enabled: true },
    ];
    for (const t of templates) {
      await pgPool.query(
        `INSERT INTO mail_templates (template_key, subject, body, enabled) VALUES ($1, $2, $3, $4) ON CONFLICT (template_key) DO UPDATE SET subject = $2, body = $3, enabled = $4`,
        [t.template_key, t.subject, t.body, t.enabled]
      );
    }
    return templates.map(t => t.template_key);
  }

  async getMailTemplates() {
    try { await this.ensureMailTemplatesTable(); } catch { /* ignore */ }

    const res = await pgPool.query('SELECT * FROM mail_templates ORDER BY id ASC');
    return res.rows;
  }

  async updateMailTemplate(templateKey: string, payload: { subject?: string; body?: string; enabled?: boolean }) {
    const existing = await pgPool.query('SELECT * FROM mail_templates WHERE template_key = $1', [templateKey]);
    if (!existing.rows[0]) return { success: false, error: 'Template not found' };
    const e = existing.rows[0];
    const subject = payload.subject !== undefined ? payload.subject : e.subject;
    const body = payload.body !== undefined ? payload.body : e.body;
    const enabled = payload.enabled !== undefined ? payload.enabled : e.enabled;
    const res = await pgPool.query('UPDATE mail_templates SET subject = $1, body = $2, enabled = $3 WHERE template_key = $4 RETURNING *', [subject, body, enabled, templateKey]);
    return { success: true, template: res.rows[0] };
  }

  async getMailNotifications() {
    const v = await this.getSystemSetting('mail_notifications');
    return v || { smtp_enabled: false, alert_emails: 'admin@votioncloud.org', expiry_warning_emails: 'admin@votioncloud.org', welcome_emails: 'admin@votioncloud.org', alert_enabled: true, expiry_enabled: true, welcome_enabled: true };
  }

  async updateMailNotifications(payload: any) {
    const cur = await this.getMailNotifications();
    return await this.updateSystemSetting('mail_notifications', { ...cur, ...payload });
  }

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
