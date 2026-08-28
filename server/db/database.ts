import 'dotenv/config';
import crypto from 'crypto';
import os from 'os';
import pg from 'pg';
import { loadRuntimeConfiguration } from '../services/runtimeConfig.js';
import { isPendingTeamInvitationActive } from '../services/teamAccessPolicy.js';
import {
  decryptCredential,
  encryptCredential,
  hashSupportPin,
  isEncryptedCredential,
  isProviderCredentialKeyConfigured,
  ProxmoxProviderUnavailableError,
} from '../services/secretBox.js';
const { Pool } = pg;

loadRuntimeConfiguration();

export type ProxmoxConnectionPublic = {
  id: string;
  name: string;
  host_ip: string;
  port: number;
  username: string;
  token_id: string;
  ssl_fingerprint: string | null;
  status: string;
  last_tested: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type ProxmoxConnectionStored = ProxmoxConnectionPublic & {
  password: string | null;
  token_secret: string | null;
};

const PROXMOX_PUBLIC_COLUMNS = 'id, name, host_ip, port, username, token_id, ssl_fingerprint, status, last_tested, created_at, updated_at';
const PROXMOX_SECRET_COLUMNS = `${PROXMOX_PUBLIC_COLUMNS}, password, token_secret`;

function toProxmoxPublic(row: ProxmoxConnectionStored): ProxmoxConnectionPublic {
  return {
    id: String(row.id),
    name: String(row.name || ''),
    host_ip: String(row.host_ip || ''),
    port: Number(row.port || 8006),
    username: String(row.username || ''),
    token_id: String(row.token_id || ''),
    ssl_fingerprint: row.ssl_fingerprint || null,
    status: String(row.status || 'unknown'),
    last_tested: row.last_tested || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function decryptProxmoxCredentials(row: ProxmoxConnectionStored): ProxmoxConnectionStored {
  return {
    ...row,
    password: decryptCredential(row.password),
    token_secret: decryptCredential(row.token_secret),
  };
}

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

export const REQUIRED_DATABASE_TABLES = [
  'accounts',
  'password_reset_tokens',
  'registration_verification_tokens',
  'user_navigation_usage',
  'proxmox_connections',
  'nodes',
  'vms',
  'vm_identity_conflicts',
  'vm_reimage_requests',
  'vm_reimage_image_profiles',
  'vm_reimage_executions',
  'vm_reimage_audit_events',
  'audit_logs',
  'tickets',
  'ticket_replies',
  'alert_rules',
  'notifications',
  'vm_metrics',
  'system_settings',
  'pricing_plans',
  'vm_billing_profiles',
  'billing_invoices',
  'billing_payments',
  'billing_cost_bases',
  'billing_server_costs',
  'billing_events',
  'billing_suspension_actions',
  'secondary_emails',
  'passkeys',
  'totp_secrets',
  'support_sessions',
  'uploaded_files',
  'vm_snapshots',
  'tasks',
  'firewall_rules',
  'key_files',
  'scheduled_tasks',
  'mail_templates',
  'provider_operations',
  'stellar_api_keys',
  'vm_backup_queue',
  'rdns_requests',
  'app_catalog',
  'app_instances',
  'vm_sub_users',
] as const;

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
  // Startup is intentionally read-only. The ordered migration runner owns all DDL.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pgPool.query('SELECT 1');
      const result = await pgPool.query<{ missing: string[] }>(`
        SELECT ARRAY(
          SELECT required.name
          FROM unnest($1::text[]) AS required(name)
          WHERE to_regclass('public.' || required.name) IS NULL
        ) AS missing
      `, [REQUIRED_DATABASE_TABLES]);
      const missing = result.rows[0]?.missing || [];
      if (missing.length > 0) throw new Error(`Required database tables are missing: ${missing.join(', ')}`);
      return;
    } catch (err: any) {
      if (attempt === 30) throw err;
      console.warn(`[POSTGRES] Readiness attempt ${attempt}/30 failed (${err.code || err.message}). Retrying in 3s...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
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
    // Schema changes are applied only by the ordered migration runner before startup.
    this.startBackgroundJobs();
  }

  startBackgroundJobs() {
    // Billing lifecycle decisions are handled by the explicit billing worker.
    // The old expiry-only loop is intentionally removed so an expired date alone
    // cannot silently suspend a VM outside the configured payment policy.

    // Telemetry cleanup job (runs every hour). Unref keeps the job active in the
    // application server without preventing one-off migration and verification
    // commands from exiting after their database work completes.
    const telemetryCleanupTimer = setInterval(async () => {
      try {
        await pgPool.query("DELETE FROM vm_metrics WHERE timestamp < NOW() - INTERVAL '7 days'");
      } catch (err) {}
    }, 3600000);
    telemetryCleanupTimer.unref();
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
      nodeName: r.node_name,
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
    target: 'cluster' | 'vm' | 'node';
    vmid?: number;
    nodeName?: string;
    metric: string;
    operator: '>' | '<' | '>=' | '<=' | '==';
    threshold: number;
    severity?: 'info' | 'warning' | 'critical';
    cooldownMinutes?: number;
    enabled?: boolean;
  }) {
    const res = await pgPool.query(
      `INSERT INTO alert_rules (account_email, name, target, vmid, node_name, metric, operator, threshold, severity, cooldown_minutes, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        rule.accountEmail.toLowerCase().trim(),
        rule.name || `${rule.metric} ${rule.operator} ${rule.threshold}`,
        rule.target,
        rule.vmid ?? null,
        rule.nodeName ?? null,
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
    apply('node_name', updates.nodeName);
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
    return (res.rowCount ?? 0) > 0;
  }

  // Check rules against a telemetry sample; returns fired notification rows (may be empty)
  async evaluateAlertRules(sample: {
    accountEmail: string;
    target?: 'cluster' | 'node' | 'vm';
    cpuPct: number;      // cluster average CPU
    memPct: number;      // cluster memory utilization
    vmid?: number;
    vmCpuPct?: number;
    vmMemPct?: number;
    nodeName?: string;
    nodeAvailable?: number;
    nodeCpuPct?: number;
    nodeMemPct?: number;
    nodeStoragePct?: number;
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
      if (rule.target === 'node' || rule.node_name) {
        if (rule.node_name && rule.node_name !== '*' && rule.node_name.toLowerCase() !== String(sample.nodeName || '').toLowerCase()) return null;
        switch (rule.metric) {
          case 'node_availability': return sample.nodeAvailable ?? null;
          case 'node_cpu_pct': return sample.nodeCpuPct ?? null;
          case 'node_mem_pct': return sample.nodeMemPct ?? null;
          case 'node_storage_pct': return sample.nodeStoragePct ?? null;
          default: return null;
        }
      }
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
      if (sample.target && rule.target !== sample.target) continue;
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

      const targets = rule.target === 'vm'
        ? `VMID ${rule.vmid ?? sample.vmid ?? '-'}`
        : rule.target === 'node'
          ? `Node ${sample.nodeName || rule.node_name || 'unknown'}`
          : 'Cluster';
      const isAvailability = rule.metric === 'node_availability';
      const unit = isAvailability ? '' : '%';
      const valueText = isAvailability ? (value >= 0.5 ? 'online' : 'offline') : `${value.toFixed(1)}${unit}`;
      const thresholdText = isAvailability ? (Number(rule.threshold) >= 0.5 ? 'online' : 'offline') : `${Number(rule.threshold).toFixed(1)}${unit}`;
      const title = `Alert: ${rule.name || rule.metric} breached`;
      const message = isAvailability
        ? `${targets} is ${valueText} — breached rule "${rule.name || rule.metric}" (${rule.operator} ${thresholdText}). Severity: ${rule.severity}.`
        : `${targets} ${rule.metric.replaceAll('_', ' ')} is now ${valueText} — breached rule "${rule.name || ''}" (${rule.operator} ${thresholdText}). Severity: ${rule.severity}.`;
      fired.push({ accountEmail: rule.account_email || sample.accountEmail, ruleId: rule.id, title, message, severity: rule.severity || 'warning' });
    }
    return fired;
  }

  async createNotification(notif: { accountEmail: string; ruleId?: number; title: string; message: string; severity?: string }) {
    const res = await pgPool.query(
      "INSERT INTO notifications (account_email, rule_id, title, message, severity) VALUES ($1, $2, $3, $4, $5)",
      [notif.accountEmail.toLowerCase().trim(), notif.ruleId ?? null, notif.title, notif.message, notif.severity || 'warning']
    );
    return (res.rowCount ?? 0) > 0;
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
    return (res.rowCount ?? 0) > 0;
  }

  async clearAllNotifications(accountEmail: string) {
    const res = await pgPool.query('DELETE FROM notifications WHERE account_email = $1', [accountEmail.toLowerCase().trim()]);
    return res.rowCount;
    }

  async upsertProxmoxVMs(resources: Array<{ vmid: number; node: string; name?: string; status?: string; cpus?: number; maxmem?: number; maxdisk?: number; type?: string; proxmoxConnectionId: string }>, defaultOwnerEmail: string) {
    if (resources.length === 0) return { synchronized: 0, conflicts: 0, synchronizedVmids: [] as number[] };
    const vmids = resources.map(resource => resource.vmid);
    const existing = await pgPool.query(
      'SELECT vmid, proxmox_connection_id, vm_name FROM vms WHERE vmid = ANY($1::int[])',
      [vmids]
    );
    const existingByVmid = new Map(existing.rows.map(row => [Number(row.vmid), row]));
    const safeResources = resources.filter(resource => {
      const row = existingByVmid.get(resource.vmid);
      if (!row?.proxmox_connection_id || row.proxmox_connection_id === resource.proxmoxConnectionId) return true;
      void pgPool.query(
        `INSERT INTO vm_identity_conflicts (vmid, existing_proxmox_connection_id, incoming_proxmox_connection_id, existing_vm_name, incoming_vm_name, raw_node_name, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (vmid, existing_proxmox_connection_id, incoming_proxmox_connection_id) DO UPDATE SET
           existing_vm_name = EXCLUDED.existing_vm_name,
           incoming_vm_name = EXCLUDED.incoming_vm_name,
           raw_node_name = EXCLUDED.raw_node_name,
           detected_at = NOW()`,
        [resource.vmid, row.proxmox_connection_id, resource.proxmoxConnectionId, row.vm_name, resource.name || `vm-${resource.vmid}`, resource.node]
      ).catch(error => console.error('[PROXMOX SYNC] Unable to record VM identity conflict:', error?.message || error));
      return false;
    });
    if (safeResources.length === 0) return { synchronized: 0, conflicts: resources.length, synchronizedVmids: [] as number[] };
    const dbResources = safeResources.map(resource => ({
      ...resource,
      proxmox_connection_id: resource.proxmoxConnectionId,
    }));
    await pgPool.query(
      `INSERT INTO vms (vmid, vm_name, node, proxmox_connection_id, status, cpus, maxmem, maxdisk, memory, disk, cpu_cores, ram_mb, disk_gb, owner_email, type)
       SELECT resource.vmid,
              COALESCE(NULLIF(resource.name, ''), 'vm-' || resource.vmid),
              resource.node,
              resource.proxmox_connection_id,
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
         vmid INT, node TEXT, name TEXT, proxmox_connection_id TEXT, status TEXT, cpus INT, maxmem BIGINT, maxdisk BIGINT, type TEXT
       )
       ON CONFLICT (vmid) DO UPDATE SET
         vm_name = EXCLUDED.vm_name,
         node = EXCLUDED.node,
         proxmox_connection_id = COALESCE(vms.proxmox_connection_id, EXCLUDED.proxmox_connection_id),
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
         type = EXCLUDED.type
       WHERE vms.proxmox_connection_id IS NULL
          OR vms.proxmox_connection_id = EXCLUDED.proxmox_connection_id`,
      [JSON.stringify(dbResources), defaultOwnerEmail]
    );
    return { synchronized: safeResources.length, conflicts: resources.length - safeResources.length, synchronizedVmids: safeResources.map(resource => resource.vmid) };
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
  async getTelemetryHistory(hours: number = 24, vmids?: number[]) {
    const params: any[] = [hours];
    const vmFilter = vmids ? (vmids.length > 0 ? `AND vmid = ANY($2::int[])` : 'AND FALSE') : '';
    if (vmids) params.push(vmids);
    const res = await pgPool.query(
      `SELECT timestamp, cpu_pct, ram_bytes, net_in_bytes, net_out_bytes,
              diskread_bytes, diskwrite_bytes
              FROM vm_metrics
       WHERE timestamp > NOW() - INTERVAL '1 hour' * $1
       ${vmFilter}
       ORDER BY timestamp ASC`,
      params
    );
    return res.rows;
  }

  // ADMIN: Per-node aggregated stats (peak/min/avg over the window)
  async getNodeTelemetryAggregates(hours: number = 24, vmids?: number[]) {
    const params: any[] = [hours];
    const vmFilter = vmids ? (vmids.length > 0 ? `AND vmid = ANY($2::int[])` : 'AND FALSE') : '';
    if (vmids) params.push(vmids);
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
       ${vmFilter}
       GROUP BY vmid`,
      params
    );
    return res.rows;
  }

    // ACCOUNTS & USERS

  async getAccounts() {
    const res = await pgPool.query('SELECT id, email, name, role, phone, two_factor_active as "twoFactorActive", created_at FROM accounts ORDER BY id ASC');
    return res.rows;
  }

  async findUserByEmail(email: string) {
    const clean = email.toLowerCase().trim();
    const res = await pgPool.query('SELECT * FROM accounts WHERE email = $1', [clean]);
    return res.rows[0] || null;
    }

  async createPasswordResetToken(email: string): Promise<string | null> {
    const user = await this.findUserByEmail(email);
    if (!user) return null;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pgPool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE account_id = $1 AND used_at IS NULL', [user.id]);
    await pgPool.query(
      `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
      [user.id, tokenHash],
    );
    return rawToken;
  }

  async resetPasswordWithToken(rawToken: string, newPassword: string): Promise<boolean> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const tokenResult = await client.query<{ account_id: number }>(
        'SELECT account_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE',
        [tokenHash],
      );
      const accountId = tokenResult.rows[0]?.account_id;
      if (!accountId) {
        await client.query('ROLLBACK');
        return false;
      }
      const { hash, salt } = hashPassword(newPassword);
      await client.query('UPDATE accounts SET password_hash = $1, updated_at = NOW() WHERE id = $2', [`${hash}:${salt}`, accountId]);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1', [tokenHash]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
                supportPinConfigured: Boolean(user.support_pin),

        twoFactorActive: user.two_factor_active,
      },
    };
  }

    async registerUser(name: string, email: string, password: string, role: 'admin' | 'client' = 'client') {
    const clean = email.toLowerCase().trim();
    const { hash, salt } = hashPassword(password);
    const storedHash = `${hash}:${salt}`;
    const pin = crypto.randomInt(100000, 1000000).toString();
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO accounts (email, password_hash, name, role, support_pin, two_factor_active, created_at)
         VALUES ($1, $2, $3, $4, $5, false, NOW()) RETURNING *`,
        [clean, storedHash, name, role, hashSupportPin(pin)],
      );
      const acceptedTeamInvitations = role === 'client'
        ? await this.acceptPendingTeamInvitations(client, clean)
        : 0;
      await client.query('COMMIT');
      return { ...res.rows[0], acceptedTeamInvitations };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async isSmtpRegistrationVerificationEnabled() {
    const config = await this.getSystemSetting('smtp_config');
    return Boolean(config?.enabled);
  }

  async createRegistrationVerification(name: string, email: string, password: string) {
    const cleanEmail = email.toLowerCase().trim();
    const tokenId = crypto.randomBytes(24).toString('base64url');
    const otp = crypto.randomInt(100000, 1000000).toString();
    const { hash, salt } = hashPassword(password);
    const secret = process.env.TOKEN_SECRET;
    if (!secret) throw new Error('Registration verification is unavailable.');
    const otpHash = crypto.createHmac('sha256', secret).update(`${cleanEmail}:${tokenId}:${otp}`).digest('hex');

    await pgPool.query(
      `INSERT INTO registration_verification_tokens (email, token_id, name, password_hash, otp_hash, attempt_count, expires_at, created_at, last_sent_at)
       VALUES ($1, $2, $3, $4, $5, 0, NOW() + INTERVAL '15 minutes', NOW(), NOW())
       ON CONFLICT (email) DO UPDATE SET
         token_id = EXCLUDED.token_id,
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         otp_hash = EXCLUDED.otp_hash,
         attempt_count = 0,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW(),
         last_sent_at = NOW()`,
      [cleanEmail, tokenId, name.trim().slice(0, 255), `${hash}:${salt}`, otpHash],
    );

    return { tokenId, otp, expiresInMinutes: 15 };
  }

  async discardRegistrationVerification(email: string, tokenId?: string) {
    const cleanEmail = email.toLowerCase().trim();
    await pgPool.query(
      tokenId
        ? 'DELETE FROM registration_verification_tokens WHERE email = $1 AND token_id = $2'
        : 'DELETE FROM registration_verification_tokens WHERE email = $1',
      tokenId ? [cleanEmail, tokenId] : [cleanEmail],
    );
  }

  async completeRegistrationVerification(email: string, tokenId: string, otp: string) {
    const cleanEmail = email.toLowerCase().trim();
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const pending = await client.query(
        'SELECT * FROM registration_verification_tokens WHERE email = $1 AND token_id = $2 FOR UPDATE',
        [cleanEmail, tokenId],
      );
      const verification = pending.rows[0];
      if (!verification) {
        await client.query('ROLLBACK');
        return { success: false, error: 'This verification code is invalid or has expired.' };
      }
      if (new Date(verification.expires_at).getTime() <= Date.now()) {
        await client.query('DELETE FROM registration_verification_tokens WHERE email = $1', [cleanEmail]);
        await client.query('COMMIT');
        return { success: false, error: 'This verification code has expired. Request a new code to continue.' };
      }
      if (Number(verification.attempt_count) >= 5) {
        await client.query('DELETE FROM registration_verification_tokens WHERE email = $1', [cleanEmail]);
        await client.query('COMMIT');
        return { success: false, error: 'Too many verification attempts. Request a new code to continue.' };
      }

      const secret = process.env.TOKEN_SECRET;
      if (!secret) throw new Error('Registration verification is unavailable.');
      const expected = crypto.createHmac('sha256', secret).update(`${cleanEmail}:${tokenId}:${otp}`).digest('hex');
      const isValid = crypto.timingSafeEqual(Buffer.from(verification.otp_hash, 'hex'), Buffer.from(expected, 'hex'));
      if (!isValid) {
        await client.query('UPDATE registration_verification_tokens SET attempt_count = attempt_count + 1 WHERE email = $1', [cleanEmail]);
        await client.query('COMMIT');
        return { success: false, error: 'The verification code is incorrect.' };
      }

      const existing = await client.query('SELECT id FROM accounts WHERE email = $1 FOR UPDATE', [cleanEmail]);
      if (existing.rows[0]) {
        await client.query('DELETE FROM registration_verification_tokens WHERE email = $1', [cleanEmail]);
        await client.query('COMMIT');
        return { success: false, error: 'An account with this email address already exists.' };
      }

      const supportPin = crypto.randomInt(100000, 1000000).toString();
      const account = await client.query(
        `INSERT INTO accounts (email, password_hash, name, role, support_pin, two_factor_active, created_at)
         VALUES ($1, $2, $3, 'client', $4, false, NOW()) RETURNING *`,
        [cleanEmail, verification.password_hash, verification.name, hashSupportPin(supportPin)],
      );
      const acceptedTeamInvitations = await this.acceptPendingTeamInvitations(client, cleanEmail);
      await client.query('DELETE FROM registration_verification_tokens WHERE email = $1', [cleanEmail]);
      await client.query('COMMIT');
      return { success: true, account: account.rows[0], acceptedTeamInvitations };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

    async recordNavigationUsage(accountEmail: string, item: { key: string; type: 'destination' | 'vm'; vmid?: number }) {
    const email = accountEmail.toLowerCase().trim();
    const key = String(item.key || '').trim().slice(0, 120);
    if (!email || !key || !['destination', 'vm'].includes(item.type)) return;
    const vmid = item.type === 'vm' ? Number(item.vmid) : null;
    if (item.type === 'vm' && (!Number.isInteger(vmid) || Number(vmid) <= 0)) return;

    await pgPool.query(
      `INSERT INTO user_navigation_usage (account_email, item_key, item_type, vmid, usage_count, last_used_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
       ON CONFLICT (account_email, item_key) DO UPDATE SET
         usage_count = user_navigation_usage.usage_count + 1,
         item_type = EXCLUDED.item_type,
         vmid = EXCLUDED.vmid,
         last_used_at = NOW()`,
      [email, key, item.type, vmid],
    );
  }

  async getNavigationUsage(accountEmail: string, limit = 5) {
    const email = accountEmail.toLowerCase().trim();
    const resultLimit = Math.max(1, Math.min(5, Math.floor(limit)));
    const res = await pgPool.query(
      `SELECT usage.item_key, usage.item_type, usage.vmid, usage.usage_count, usage.last_used_at,
              CASE WHEN usage.item_type = 'vm' THEN vm.vm_name ELSE NULL END AS vm_name,
              CASE WHEN usage.item_type = 'vm' THEN vm.status ELSE NULL END AS vm_status
       FROM user_navigation_usage AS usage
       LEFT JOIN vms AS vm ON vm.vmid = usage.vmid AND vm.owner_email = usage.account_email
       WHERE usage.account_email = $1
         AND (usage.item_type = 'destination' OR vm.vmid IS NOT NULL)
       ORDER BY usage.usage_count DESC, usage.last_used_at DESC
       LIMIT $2`,
      [email, resultLimit],
    );
    return res.rows.map(row => ({
      key: String(row.item_key),
      type: row.item_type === 'vm' ? 'vm' as const : 'destination' as const,
      vmid: row.vmid === null ? null : Number(row.vmid),
      name: row.vm_name ? String(row.vm_name) : null,
      status: row.vm_status ? String(row.vm_status) : null,
      usageCount: Number(row.usage_count),
      lastUsedAt: row.last_used_at,
    }));
  }

  async updateUserProfile(email: string, updates: any) {

    const clean = email.toLowerCase().trim();
    const user = await this.findUserByEmail(clean);
    if (!user) return null;

    const name = updates.name || user.name;
    const phone = updates.phone || user.phone;
    const support_pin = updates.supportPin ? hashSupportPin(String(updates.supportPin)) : user.support_pin;
    const two_factor_active = updates.twoFactorActive !== undefined ? updates.twoFactorActive : user.two_factor_active;
    
    await pgPool.query(
      `UPDATE accounts SET name = $1, phone = $2, support_pin = $3, two_factor_active = $4 WHERE email = $5`,
      [name, phone, support_pin, two_factor_active, clean]
    );
    
    await this.logAudit(clean, 'UPDATE_PROFILE', clean, 'Updated profile fields in PostgreSQL');
    return { id: user.id, email: clean, name, role: user.role, phone, supportPinConfigured: Boolean(support_pin), twoFactorActive: two_factor_active };
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
    const newPin = crypto.randomInt(100000, 1000000).toString();
    await pgPool.query('UPDATE accounts SET support_pin = $1 WHERE email = $2', [hashSupportPin(newPin), clean]);
    await this.logAudit(clean, 'REGENERATE_PIN', clean, 'Generated a new Support PIN');
    return { success: true, supportPinConfigured: true };
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
  async getVMs(ownerEmail?: string, vmid?: number, proxmoxConnectionId?: string) {
    let query = 'SELECT v.*, pc.name AS proxmox_connection_name FROM vms v LEFT JOIN proxmox_connections pc ON pc.id = v.proxmox_connection_id';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (vmid) {
      params.push(vmid);
      conditions.push(`vmid = $${params.length}`);
    }
    if (ownerEmail) {
      params.push(ownerEmail.toLowerCase().trim());
      conditions.push(`owner_email = $${params.length}`);
    }
    if (proxmoxConnectionId) {
      params.push(proxmoxConnectionId.trim());
      conditions.push(`v.proxmox_connection_id = $${params.length}`);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;


    
    const res = await pgPool.query(query, params);
    return res.rows.map(v => ({
      vmid: v.vmid, name: v.vm_name, type: v.type, node: v.node, proxmoxConnectionId: v.proxmox_connection_id || null, proxmoxConnectionName: v.proxmox_connection_name || null, ownerEmail: v.owner_email, status: v.is_suspended ? 'stopped' : v.status, cpus: v.cpu_cores, memory: v.ram_mb * 1048576, maxmem: v.maxmem, disk: v.disk_gb * 1073741824, maxdisk: v.maxdisk, uptime: v.is_suspended ? 0 : v.uptime, ipAddress: v.ip_address, os: v.os_type, expiryDate: v.expiry_date, isSuspended: v.is_suspended,
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
      completedAt: row.completed_at || undefined,
      completedBy: row.completed_by || undefined,
      completionNote: row.completion_note || undefined,
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

  async completeReimageRequest(requestId: string, completedBy: string, completionNote?: string) {
    const email = completedBy.toLowerCase().trim();
    const note = completionNote?.trim().slice(0, 2000) || null;
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE vm_reimage_requests
         SET status = 'completed', completed_at = NOW(), completed_by = $2, completion_note = $3
         WHERE id = $1 AND status = 'approved'
         RETURNING *`,
        [requestId, email, note],
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = result.rows[0];
      await client.query(
        `UPDATE vms SET os_type = $1 WHERE vmid = $2`,
        [row.requested_os, row.vmid],
      );
      await client.query('COMMIT');
      await this.logAudit(
        email,
        'COMPLETE_REIMAGE_REQUEST',
        `VMID ${row.vmid}`,
        `Marked OS reimage request ${requestId} completed after manual administrator action. No automated Proxmox operation was performed.`,
      );
      const detailed = await pgPool.query(
        `SELECT r.*, v.vm_name, v.type AS vm_type, v.owner_email
         FROM vm_reimage_requests r
         JOIN vms v ON v.vmid = r.vmid
         WHERE r.id = $1`,
        [requestId],
      );
      return this.mapReimageRequest(detailed.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
  async getSupportTickets(userEmail?: string, filters: { search?: string; status?: string; priority?: string; assignedTo?: string; viewerEmail?: string; viewerRole?: 'admin' | 'client' } = {}) {
    const params: any[] = [];
    const conditions: string[] = [];
    const addParam = (value: any) => { params.push(value); return `$${params.length}`; };

    if (userEmail) conditions.push(`t.user_email = ${addParam(userEmail.toLowerCase().trim())}`);
    if (filters.search?.trim()) {
      const search = addParam(`%${filters.search.trim()}%`);
      conditions.push(`(t.id ILIKE ${search} OR t.subject ILIKE ${search} OR t.category ILIKE ${search} OR t.user_email ILIKE ${search})`);
    }
    if (filters.status && ['open', 'in-progress', 'replied', 'resolved', 'closed'].includes(filters.status)) {
      conditions.push(`t.status = ${addParam(filters.status)}`);
    }
    if (filters.priority && ['low', 'medium', 'high', 'urgent'].includes(filters.priority)) {
      conditions.push(`t.priority = ${addParam(filters.priority)}`);
    }
    if (filters.assignedTo) {
      conditions.push(filters.assignedTo === 'unassigned' ? 't.assigned_to IS NULL' : `t.assigned_to = ${addParam(filters.assignedTo.toLowerCase().trim())}`);
    }

    const res = await pgPool.query(
      `SELECT t.*, COUNT(r.id)::int AS reply_count, MAX(r.created_at) AS last_reply_at,
              (ARRAY_AGG(r.sender_role ORDER BY r.created_at DESC))[1] AS last_reply_role
       FROM tickets t
       LEFT JOIN ticket_replies r ON r.ticket_id = t.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       GROUP BY t.id
       ORDER BY CASE WHEN t.status IN ('open', 'in-progress', 'replied') THEN 0 ELSE 1 END,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                COALESCE(MAX(r.created_at), t.updated_at, t.created_at) DESC`,
      params,
    );

    const viewerEmail = filters.viewerEmail?.toLowerCase().trim();
    const viewerRole = filters.viewerRole || 'client';
    return res.rows.map(t => {
      const lastReplyAt = t.last_reply_at || t.created_at;
      const readAt = viewerRole === 'admin' ? t.last_admin_read_at : t.last_client_read_at;
      const unread = Boolean(viewerEmail && t.last_reply_role && t.last_reply_role !== viewerRole && (!readAt || new Date(readAt).getTime() < new Date(lastReplyAt).getTime()));
      return {
        id: t.id,
        ticket_number: t.ticket_number,
        vmid: t.vmid,
        subject: t.subject,
        category: t.category,
        status: t.status,
        priority: t.priority,
        userEmail: t.user_email,
        assignedTo: t.assigned_to,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        replyCount: Number(t.reply_count || 0),
        lastReplyAt,
        lastReplyRole: t.last_reply_role || null,
        unread,
      };
    });
  }

  async getTicketDetails(ticketId: string) {
    const tRes = await pgPool.query('SELECT * FROM tickets WHERE id = $1 OR ticket_number = $1', [ticketId]);
    if (tRes.rows.length === 0) return null;
    const ticket = tRes.rows[0];
    const rRes = await pgPool.query('SELECT * FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]);

    return {
      ticket: {
        id: ticket.id,
        ticket_number: ticket.ticket_number,
        vmid: ticket.vmid,
        subject: ticket.subject,
        category: ticket.category,
        status: ticket.status,
        priority: ticket.priority,
        userEmail: ticket.user_email,
        assignedTo: ticket.assigned_to,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
      },
      replies: rRes.rows.map(r => ({ id: r.id, ticketId: r.ticket_id, senderEmail: r.sender_email, senderRole: r.sender_role, message: r.message, timestamp: r.created_at })),
    };
  }

  async createSupportTicket(subject: string, category: string, priority: string, vmid?: number, userEmail: string = 'admin@votioncloud.org') {
    const ticketId = `TICK-${Date.now().toString().slice(-8)}-${Math.floor(100 + Math.random() * 900)}`;
    const email = userEmail.toLowerCase().trim();
    await pgPool.query(
      `INSERT INTO tickets (id, ticket_number, vmid, subject, category, status, priority, user_email, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [ticketId, ticketId, vmid || null, subject, category || 'General', 'open', priority || 'medium', email]
    );
    await this.logAudit(userEmail, 'CREATE_TICKET', ticketId, `Opened support ticket for VMID ${vmid || 'N/A'}`);
    return await this.getTicketDetails(ticketId);
  }

  async createSupportTicketWithInitialReply(subject: string, category: string, priority: string, vmid: number | undefined, userEmail: string, message?: string) {
    const client = await pgPool.connect();
    const email = userEmail.toLowerCase().trim();
    const ticketId = `TICK-${Date.now().toString().slice(-8)}-${crypto.randomInt(100, 1000)}`;
    const replyId = message?.trim() ? `rep-${Date.now()}-${crypto.randomInt(100000, 1000000)}` : null;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tickets (id, ticket_number, vmid, subject, category, status, priority, user_email, created_at)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, NOW())`,
        [ticketId, ticketId, vmid || null, subject, category || 'General', priority || 'medium', email],
      );
      if (replyId && message) {
        await client.query(
          `INSERT INTO ticket_replies (id, ticket_id, sender_email, sender_role, message, created_at)
           VALUES ($1, $2, $3, 'client', $4, NOW())`,
          [replyId, ticketId, email, message.trim()],
        );
        await client.query("UPDATE tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);
      }
      await client.query(
        `INSERT INTO audit_logs (id, user_email, action, target, details, status) VALUES ($1, $2, $3, $4, $5, $6)`,
        [`log-${Date.now()}-${crypto.randomInt(1000, 10000)}`, email, 'CREATE_TICKET', ticketId, `Opened support ticket for VMID ${vmid || 'N/A'}`, 'success'],
      );
      await client.query('COMMIT');
      return await this.getTicketDetails(ticketId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async addTicketReply(ticketId: string, senderEmail: string, message: string, senderRole: 'admin' | 'client' = 'client') {
    const replyId = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await pgPool.query(
      `INSERT INTO ticket_replies (id, ticket_id, sender_email, sender_role, message, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [replyId, ticketId, senderEmail.toLowerCase().trim(), senderRole, message]
    );
    await pgPool.query(
      `UPDATE tickets SET updated_at = NOW(), status = CASE
         WHEN $2 = 'admin' THEN 'replied'
         WHEN status IN ('replied', 'resolved') THEN 'open'
         ELSE status
       END WHERE id = $1`,
      [ticketId, senderRole],
    );
    await this.logAudit(senderEmail, 'REPLY_TICKET', ticketId, 'Added reply message');
    return { id: replyId, ticketId, senderEmail, senderRole, message, timestamp: new Date().toISOString() };
  }

  async updateTicketStatus(ticketId: string, status: string, userEmail: string) {
    const result = await pgPool.query('UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id', [status, ticketId]);
    if (result.rowCount === 0) throw new Error('Support ticket not found');
    await this.logAudit(userEmail, 'UPDATE_TICKET_STATUS', ticketId, `Ticket status updated to ${status}`);
    return { success: true, ticketId, status };
  }

  async updateTicketPriority(ticketId: string, priority: string, userEmail: string) {
    const result = await pgPool.query('UPDATE tickets SET priority = $1, updated_at = NOW() WHERE id = $2 RETURNING id', [priority, ticketId]);
    if (result.rowCount === 0) throw new Error('Support ticket not found');
    await this.logAudit(userEmail, 'UPDATE_TICKET_PRIORITY', ticketId, `Ticket priority updated to ${priority}`);
    return { success: true, ticketId, priority };
  }

  async assignTicket(ticketId: string, assigneeEmail: string | null, userEmail: string) {
    const normalized = assigneeEmail?.trim().toLowerCase() || null;
    const result = await pgPool.query('UPDATE tickets SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING id', [normalized, ticketId]);
    if (result.rowCount === 0) throw new Error('Support ticket not found');
    await this.logAudit(userEmail, 'ASSIGN_TICKET', ticketId, normalized ? `Assigned ticket to ${normalized}` : 'Removed ticket assignment');
    return { success: true, ticketId, assignedTo: normalized };
  }

  async markTicketRead(ticketId: string, viewerEmail: string, viewerRole: 'admin' | 'client') {
    const column = viewerRole === 'admin' ? 'last_admin_read_at' : 'last_client_read_at';
    const ownerCondition = viewerRole === 'admin' ? '' : ' AND user_email = $2';
    const result = await pgPool.query(`UPDATE tickets SET ${column} = NOW() WHERE id = $1${ownerCondition} RETURNING id`, viewerRole === 'admin' ? [ticketId] : [ticketId, viewerEmail.toLowerCase().trim()]);
    if (result.rowCount === 0) throw new Error('Support ticket not found');
    return { success: true, ticketId, viewerRole };
  }

  async getSupportAgents() {
    const result = await pgPool.query("SELECT email, name, role FROM accounts WHERE role IN ('admin', 'administrator', 'moderator') ORDER BY name NULLS LAST, email ASC");
    return result.rows.map(row => ({ email: row.email, name: row.name, role: row.role }));
  }

  // MODALS & TELEMETRY
  async getDownloads() { return CONSTANTS.downloads; }
  async getDataRoom() { return CONSTANTS.dataroom; }
    async getPricing() { return await this.getPricingPlans(true); }

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
      [sessionId, accountEmail.toLowerCase().trim(), user?.support_pin || null]
    );
    await this.logAudit(accountEmail, 'REMOTE_SESSION_START', accountEmail, `Remote support session opened: ${sessionId}`);
    return {
      success: true,
      sessionId,
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    };
  }

  async getActiveSupportSession(accountEmail: string) {
    const res = await pgPool.query(
      "SELECT id, status, expires_at FROM support_sessions WHERE account_email = $1 AND status = 'active' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
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
    const existing = await this.getProxmoxConnectionCredentials(id);
    if (!existing) return { success: false, error: 'Connection not found' };
    const password = payload.password !== undefined && payload.password !== '' ? payload.password : existing.password;
    const token_secret = payload.token_secret !== undefined && payload.token_secret !== '' ? payload.token_secret : existing.token_secret;
    const res = await pgPool.query<ProxmoxConnectionStored>(
      `UPDATE proxmox_connections SET name = $1, host_ip = $2, port = $3, username = $4, password = $5, token_id = $6, token_secret = $7, ssl_fingerprint = $8, updated_at = NOW()
       WHERE id = $9 RETURNING ${PROXMOX_SECRET_COLUMNS}`,
      [payload.name ?? existing.name, payload.host_ip ?? existing.host_ip, payload.port ?? existing.port, payload.username ?? existing.username, encryptCredential(password), payload.token_id ?? existing.token_id, encryptCredential(token_secret), payload.ssl_fingerprint ?? existing.ssl_fingerprint, id],
    );
    const updated = res.rows[0];
    return { success: true, connection: updated ? toProxmoxPublic(decryptProxmoxCredentials(updated)) : null };
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
  async hasStoredProxmoxConnectionCredentials(): Promise<boolean> {
    const result = await pgPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM proxmox_connections
       WHERE COALESCE(password, '') <> '' OR COALESCE(token_secret, '') <> ''`,
    );
    return Number(result.rows[0]?.count || 0) > 0;
  }

  async migrateProxmoxCredentials(): Promise<number> {
    if (!isProviderCredentialKeyConfigured()) throw new ProxmoxProviderUnavailableError();
    const res = await pgPool.query<{ id: string; password: string | null; token_secret: string | null }>(
      'SELECT id, password, token_secret FROM proxmox_connections',
    );
    let migrated = 0;
    for (const row of res.rows) {
      if (isEncryptedCredential(row.password) && isEncryptedCredential(row.token_secret)) continue;
      await pgPool.query(
        'UPDATE proxmox_connections SET password = $1, token_secret = $2, updated_at = NOW() WHERE id = $3',
        [encryptCredential(row.password), encryptCredential(row.token_secret), row.id],
      );
      migrated++;
    }
    return migrated;
  }

  async getProxmoxConnections(): Promise<ProxmoxConnectionPublic[]> {
    const res = await pgPool.query<ProxmoxConnectionStored>(`SELECT ${PROXMOX_PUBLIC_COLUMNS} FROM proxmox_connections ORDER BY last_tested DESC`);
    return res.rows.map(toProxmoxPublic);
  }

  async getProxmoxConnectionOverview() {
    const res = await pgPool.query(
      `SELECT pc.id, pc.name, pc.host_ip, pc.port, pc.token_id, pc.ssl_fingerprint,
              pc.status, pc.last_tested, pc.created_at,
              COUNT(DISTINCT v.vmid)::int AS vm_count,
              COUNT(DISTINCT v.vmid) FILTER (WHERE LOWER(COALESCE(v.status, '')) IN ('running', 'online', 'up'))::int AS running_vm_count,
              COUNT(DISTINCT NULLIF(v.node, ''))::int AS node_count,
              MAX(v.updated_at) AS last_inventory_at
       FROM proxmox_connections pc
       LEFT JOIN vms v ON v.proxmox_connection_id = pc.id
       GROUP BY pc.id
       ORDER BY pc.name ASC, pc.last_tested DESC`
    );
    return res.rows.map(row => ({
      id: row.id,
      name: row.name,
      host_ip: row.host_ip,
      port: Number(row.port),
      token_id: row.token_id,
      ssl_fingerprint: row.ssl_fingerprint || '',
      status: row.status || 'unknown',
      last_tested: row.last_tested || null,
      created_at: row.created_at || null,
      vmCount: Number(row.vm_count || 0),
      runningVmCount: Number(row.running_vm_count || 0),
      nodeCount: Number(row.node_count || 0),
      lastInventoryAt: row.last_inventory_at || null,
    }));
  }

  async getProxmoxConnectionCredentials(): Promise<ProxmoxConnectionStored[]>;
  async getProxmoxConnectionCredentials(id: string): Promise<ProxmoxConnectionStored | null>;
  async getProxmoxConnectionCredentials(id?: string): Promise<ProxmoxConnectionStored[] | ProxmoxConnectionStored | null> {
    if (!isProviderCredentialKeyConfigured()) throw new ProxmoxProviderUnavailableError();
    if (id) {
      const res = await pgPool.query<ProxmoxConnectionStored>(`SELECT ${PROXMOX_SECRET_COLUMNS} FROM proxmox_connections WHERE id = $1`, [id]);
      return res.rows[0] ? decryptProxmoxCredentials(res.rows[0]) : null;
    }
    const res = await pgPool.query<ProxmoxConnectionStored>(`SELECT ${PROXMOX_SECRET_COLUMNS} FROM proxmox_connections ORDER BY last_tested DESC`);
    return res.rows.map(decryptProxmoxCredentials);
  }

  async recordProxmoxConnectionTest(id: string, status: string) {
    const res = await pgPool.query(
      `UPDATE proxmox_connections SET status = $1, last_tested = NOW(), updated_at = NOW() WHERE id = $2 RETURNING id, status, last_tested`,
      [status, id],
    );
    return res.rows[0] || null;
  }

  async getProxmoxVmIdentityConflicts() {
    const res = await pgPool.query(
      `SELECT c.vmid,
              c.existing_proxmox_connection_id,
              existing_connection.name AS existing_connection_name,
              c.incoming_proxmox_connection_id,
              incoming_connection.name AS incoming_connection_name,
              c.existing_vm_name,
              c.incoming_vm_name,
              c.raw_node_name,
              c.detected_at
       FROM vm_identity_conflicts c
       LEFT JOIN proxmox_connections existing_connection ON existing_connection.id = c.existing_proxmox_connection_id
       LEFT JOIN proxmox_connections incoming_connection ON incoming_connection.id = c.incoming_proxmox_connection_id
       ORDER BY c.detected_at DESC`
    );
    return res.rows.map(row => ({
      vmid: Number(row.vmid),
      existingConnectionId: row.existing_proxmox_connection_id,
      existingConnectionName: row.existing_connection_name || null,
      incomingConnectionId: row.incoming_proxmox_connection_id,
      incomingConnectionName: row.incoming_connection_name || null,
      existingVmName: row.existing_vm_name || null,
      incomingVmName: row.incoming_vm_name || null,
      rawNodeName: row.raw_node_name || null,
      detectedAt: row.detected_at,
    }));
  }

  async addProxmoxConnection(name: string, host_ip: string, port: number, username: string, password: string, token_id: string, token_secret: string, ssl_fingerprint: string) {
    const connId = `pve-conn-${Date.now()}`;
    const res = await pgPool.query<ProxmoxConnectionStored>(
      `INSERT INTO proxmox_connections (id, name, host_ip, port, username, password, token_id, token_secret, ssl_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${PROXMOX_SECRET_COLUMNS}`,
      [connId, name, host_ip, port, username || 'root@pam', encryptCredential(password), token_id, encryptCredential(token_secret), ssl_fingerprint],
    );
    return res.rows[0] ? toProxmoxPublic(decryptProxmoxCredentials(res.rows[0])) : null;
  }

  async deleteProxmoxConnection(id: string) {
    const res = await pgPool.query('DELETE FROM proxmox_connections WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

    // SYSTEM SETTINGS

    async getMailTemplates() {
    const res = await pgPool.query('SELECT * FROM mail_templates ORDER BY id ASC');
    return res.rows;
  }

  async getMailTemplate(templateKey: string) {
    const res = await pgPool.query('SELECT * FROM mail_templates WHERE template_key = $1 LIMIT 1', [templateKey]);
    return res.rows[0] || null;
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

  private mapPricingPlan(row: any) {
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      monthlyPriceCents: Number(row.monthly_price_cents),
      vcpuLimit: Number(row.vcpu_limit),
      ramGb: Number(row.ram_gb),
      diskGb: Number(row.disk_gb),
      bandwidthGb: row.bandwidth_gb === null ? null : Number(row.bandwidth_gb),
      isActive: Boolean(row.is_active),
      sortOrder: Number(row.sort_order),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapBillingInvoice(row: any) {
    return {
      id: row.id,
      accountEmail: row.account_email,
      vmid: Number(row.vmid),
      vmName: row.vm_name,
      planId: row.plan_id,
      planName: row.plan_name,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      issuedAt: row.issued_at,
      dueAt: row.due_at,
      subtotalCents: Number(row.subtotal_cents),
      taxCents: Number(row.tax_cents),
      totalCents: Number(row.total_cents),
      paidCents: Number(row.paid_cents),
      outstandingCents: Math.max(0, Number(row.total_cents) - Number(row.paid_cents)),
      currency: row.currency,
      status: row.status,
      paidAt: row.paid_at,
      lastReminderAt: row.last_reminder_at,
      suspensionEligibleAt: row.suspension_eligible_at,
      notes: row.notes,
      createdAt: row.created_at,
    };
  }

  async getBillingConfig() {
    return (await this.getSystemSetting('billing_config')) || {
      automationEnabled: false,
      reminderEmailsEnabled: false,
      suspensionExecutionEnabled: false,
      daysBeforeDue: 7,
      gracePeriodDays: 7,
      suspendAfterDaysOverdue: 1,
      taxRatePercent: 0,
      currency: 'USD',
    };
  }

  async updateBillingConfig(patch: any) {
    const current = await this.getBillingConfig();
    const next = { ...current, ...patch };
    const integerFields = ['daysBeforeDue', 'gracePeriodDays', 'suspendAfterDaysOverdue'];
    for (const field of integerFields) {
      const value = Number(next[field]);
      if (!Number.isInteger(value) || value < 0 || value > 365) throw new Error(`${field} must be an integer from 0 to 365.`);
      next[field] = value;
    }
    const tax = Number(next.taxRatePercent);
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) throw new Error('taxRatePercent must be between 0 and 100.');
    next.taxRatePercent = tax;
    next.automationEnabled = next.automationEnabled === true;
    next.reminderEmailsEnabled = next.reminderEmailsEnabled === true;
    next.suspensionExecutionEnabled = next.suspensionExecutionEnabled === true;
    next.currency = String(next.currency || 'USD').toUpperCase().slice(0, 3);
    if (!['INR', 'USD', 'EUR'].includes(next.currency)) throw new Error('Billing currency must be INR, USD, or EUR.');
    return await this.updateSystemSetting('billing_config', next);
  }

  async getPricingPlans(activeOnly = false) {
    const res = await pgPool.query(`SELECT * FROM pricing_plans ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY sort_order ASC, name ASC`);
    return res.rows.map(row => this.mapPricingPlan(row));
  }

  async upsertPricingPlan(plan: any) {
    const id = String(plan.id || `plan-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`).trim().toLowerCase();
    const name = String(plan.name || '').trim().slice(0, 150);
    const currency = String(plan.currency || 'USD').trim().toUpperCase().slice(0, 3);
    const monthlyPriceCents = Math.round(Number(plan.monthlyPriceCents));
    const vcpuLimit = Math.round(Number(plan.vcpuLimit));
    const ramGb = Number(plan.ramGb);
    const diskGb = Number(plan.diskGb);
    const bandwidthGb = plan.bandwidthGb === null || plan.bandwidthGb === '' || plan.bandwidthGb === undefined ? null : Number(plan.bandwidthGb);
    if (!id || !name || !['INR', 'USD', 'EUR'].includes(currency) || !Number.isInteger(monthlyPriceCents) || monthlyPriceCents < 0 || !Number.isInteger(vcpuLimit) || vcpuLimit < 1 || !Number.isFinite(ramGb) || ramGb <= 0 || !Number.isFinite(diskGb) || diskGb <= 0 || (bandwidthGb !== null && (!Number.isFinite(bandwidthGb) || bandwidthGb < 0))) {
      throw new Error('Pricing plan values are invalid. Currency must be INR, USD, or EUR.');
    }
    const res = await pgPool.query(
      `INSERT INTO pricing_plans (id, name, currency, monthly_price_cents, vcpu_limit, ram_gb, disk_gb, bandwidth_gb, is_active, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, currency = $3, monthly_price_cents = $4, vcpu_limit = $5, ram_gb = $6, disk_gb = $7, bandwidth_gb = $8, is_active = $9, sort_order = $10, updated_at = NOW()
       RETURNING *`,
      [id, name, currency, monthlyPriceCents, vcpuLimit, ramGb, diskGb, bandwidthGb, plan.isActive !== false, Math.max(0, Math.round(Number(plan.sortOrder) || 0))]
    );
    return this.mapPricingPlan(res.rows[0]);
  }

  async setPricingPlanActive(id: string, active: boolean) {
    const res = await pgPool.query('UPDATE pricing_plans SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [active, id]);
    return res.rows[0] ? this.mapPricingPlan(res.rows[0]) : null;
  }

  async getBillingCostBases(activeOnly = false) {
    const res = await pgPool.query(`SELECT * FROM billing_cost_bases ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY name ASC`);
    return res.rows.map(row => ({ id: row.id, name: row.name, monthlyCostCents: Number(row.monthly_cost_cents), allocationMethod: row.allocation_method, currency: row.currency || 'INR', isActive: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async upsertBillingCostBase(cost: any) {
    const id = String(cost.id || `cost-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`).trim().toLowerCase();
    const name = String(cost.name || '').trim().slice(0, 150);
    const monthlyCostCents = Math.round(Number(cost.monthlyCostCents));
    const allocationMethod = ['fixed', 'per_vm', 'per_vcpu', 'per_gb_ram', 'per_gb_disk'].includes(cost.allocationMethod) ? cost.allocationMethod : 'fixed';
    const currency = String(cost.currency || 'INR').trim().toUpperCase().slice(0, 3);
    if (!id || !name || !['INR', 'USD', 'EUR'].includes(currency) || !Number.isInteger(monthlyCostCents) || monthlyCostCents < 0) throw new Error('Cost basis values are invalid. Currency must be INR, USD, or EUR.');
    const res = await pgPool.query(
      `INSERT INTO billing_cost_bases (id, name, monthly_cost_cents, allocation_method, currency, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, monthly_cost_cents = $3, allocation_method = $4, currency = $5, is_active = $6, updated_at = NOW()
       RETURNING *`,
      [id, name, monthlyCostCents, allocationMethod, currency, cost.isActive !== false]
    );
    const row = res.rows[0];
    return { id: row.id, name: row.name, monthlyCostCents: Number(row.monthly_cost_cents), allocationMethod: row.allocation_method, currency: row.currency || 'INR', isActive: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async getBillingServerCosts(activeOnly = false) {
    const res = await pgPool.query(
      `SELECT s.*, pc.name AS connection_name,
              COUNT(DISTINCT v.vmid) FILTER (WHERE v.owner_email NOT LIKE 'unassigned@%')::int AS assigned_vm_count,
              COUNT(DISTINCT v.vmid) FILTER (WHERE LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up'))::int AS running_vm_count,
              COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up') THEN GREATEST(COALESCE(p.ip_count, 1), 1) ELSE 0 END), 0)::int AS running_ip_count,
              COALESCE(SUM(CASE WHEN v.owner_email NOT LIKE 'unassigned@%' THEN COALESCE(p.ip_count, 1) ELSE 0 END), 0)::int AS assigned_ip_count
       FROM billing_server_costs s
       LEFT JOIN proxmox_connections pc ON pc.id = s.proxmox_connection_id
       LEFT JOIN vms v ON v.proxmox_connection_id = s.proxmox_connection_id
       LEFT JOIN vm_billing_profiles p ON p.vmid = v.vmid
       ${activeOnly ? 'WHERE s.is_active = true' : ''}
       GROUP BY s.id, pc.name
       ORDER BY pc.name ASC NULLS LAST, s.node_name ASC NULLS LAST, s.name ASC`
    );
    return res.rows.map(row => ({
      id: row.id,
      name: row.name,
      nodeName: row.node_name || null,
      rawNodeName: row.node_name || null,
      proxmoxConnectionId: row.proxmox_connection_id || null,
      connectionName: row.connection_name || null,
      legacyNeedsAssignment: !row.proxmox_connection_id,
      monthlyCostPaise: Number(row.monthly_cost_paise),
      ipCostPaise: Number(row.ip_cost_paise),
      plannedVmCapacity: Number(row.planned_vm_capacity),
      includedIpCount: Number(row.included_ip_count),
      assignedVmCount: Number(row.assigned_vm_count),
      runningVmCount: Number(row.running_vm_count),
      runningIpCount: Number(row.running_ip_count),
      assignedIpCount: Number(row.assigned_ip_count),
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getBillingServerProfitability() {
    const serverCosts = await this.getBillingServerCosts(true);
    const mappedServerCosts = serverCosts.filter(profile => profile.proxmoxConnectionId);
    const [resources, revenue, projectedRevenue, sharedCosts] = await Promise.all([
      pgPool.query(`SELECT v.proxmox_connection_id, pc.name AS connection_name,
               STRING_AGG(DISTINCT v.node, ', ' ORDER BY v.node) AS raw_node_name,
               COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up'))::int AS running_vm_count,
               COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up') THEN GREATEST(COALESCE(p.ip_count, 1), 1) ELSE 0 END), 0)::int AS running_ip_count,
               COALESCE(SUM(v.cpus) FILTER (WHERE LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up')), 0)::numeric AS running_vcpu,
               COALESCE(SUM(COALESCE(v.maxmem, v.memory, v.ram_mb * 1048576, 0)) FILTER (WHERE LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up')), 0)::numeric AS running_ram_bytes,
               COALESCE(SUM(COALESCE(v.maxdisk, v.disk, 0)) FILTER (WHERE LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up')), 0)::numeric AS running_disk_bytes
        FROM vms v LEFT JOIN proxmox_connections pc ON pc.id = v.proxmox_connection_id
        LEFT JOIN vm_billing_profiles p ON p.vmid = v.vmid
        GROUP BY v.proxmox_connection_id, pc.name`),
      pgPool.query(`SELECT v.proxmox_connection_id,
               COUNT(i.id) FILTER (WHERE i.currency = 'INR')::int AS invoice_count,
               COALESCE(SUM(i.total_cents) FILTER (WHERE i.currency = 'INR'), 0)::bigint AS billed_paise,
               COALESCE(SUM(i.paid_cents) FILTER (WHERE i.currency = 'INR'), 0)::bigint AS collected_paise,
               COALESCE(SUM(GREATEST(i.total_cents - i.paid_cents, 0)) FILTER (WHERE i.currency = 'INR'), 0)::bigint AS outstanding_paise
        FROM vms v LEFT JOIN billing_invoices i ON i.vmid = v.vmid
        GROUP BY v.proxmox_connection_id`),
      pgPool.query(`WITH billing_currency AS (
          SELECT COALESCE(MAX(setting_value->>'currency'), 'INR') AS currency
          FROM system_settings
          WHERE setting_key = 'billing_config'
        )
        SELECT v.proxmox_connection_id,
               billing_currency.currency AS default_currency,
               pl.currency AS plan_currency,
               p.custom_monthly_price_cents,
               COUNT(*)::int AS assignment_count,
               COALESCE(SUM(COALESCE(p.custom_monthly_price_cents, pl.monthly_price_cents, 0)), 0)::bigint AS projected_revenue_cents
        FROM vms v
        LEFT JOIN vm_billing_profiles p ON p.vmid = v.vmid
        LEFT JOIN pricing_plans pl ON pl.id = p.plan_id
        CROSS JOIN billing_currency
        WHERE v.owner_email NOT LIKE '%unassigned@%'
          AND COALESCE(p.billing_status, 'active') NOT IN ('closed', 'waived')
          AND COALESCE(p.custom_monthly_price_cents, pl.monthly_price_cents) IS NOT NULL
        GROUP BY v.proxmox_connection_id, billing_currency.currency, pl.currency, p.custom_monthly_price_cents`),
      pgPool.query(`SELECT name, monthly_cost_cents, allocation_method FROM billing_cost_bases WHERE is_active = true AND currency = 'INR'`),
    ]);
    const profileByConnection = new Map(mappedServerCosts.map(profile => [profile.proxmoxConnectionId, profile]));
    const projectedRevenueByConnection = new Map<string, Record<string, { cents: number; assignmentCount: number }>>();
    for (const row of projectedRevenue.rows) {
      if (!row.proxmox_connection_id) continue;
      const currency = row.custom_monthly_price_cents !== null && row.custom_monthly_price_cents !== undefined
        ? String(row.default_currency || 'INR')
        : String(row.plan_currency || row.default_currency || 'INR');
      const byCurrency = projectedRevenueByConnection.get(row.proxmox_connection_id) || {};
      const current = byCurrency[currency] || { cents: 0, assignmentCount: 0 };
      byCurrency[currency] = { cents: current.cents + Number(row.projected_revenue_cents || 0), assignmentCount: current.assignmentCount + Number(row.assignment_count || 0) };
      projectedRevenueByConnection.set(row.proxmox_connection_id, byCurrency);
    }
    const resourcesByConnection = new Map(resources.rows.filter(row => row.proxmox_connection_id).map(row => [row.proxmox_connection_id, row]));
    const revenueByConnection = new Map(revenue.rows.filter(row => row.proxmox_connection_id).map(row => [row.proxmox_connection_id, row]));
    const connectionIds = Array.from(new Set([...mappedServerCosts.map(profile => profile.proxmoxConnectionId!), ...resources.rows.filter(row => row.proxmox_connection_id).map(row => row.proxmox_connection_id), ...revenue.rows.filter(row => row.proxmox_connection_id).map(row => row.proxmox_connection_id)])).sort();
    const configuredServerCount = Math.max(1, mappedServerCosts.length);
    const rows = connectionIds.map(proxmoxConnectionId => {
      const profile = profileByConnection.get(proxmoxConnectionId);
      const resource = resourcesByConnection.get(proxmoxConnectionId) || {};
      const nodeRevenue = revenueByConnection.get(proxmoxConnectionId) || {};
      const projectedNodeRevenue = projectedRevenueByConnection.get(proxmoxConnectionId) || {};
      const projectedRevenueByCurrency = Object.fromEntries(Object.entries(projectedNodeRevenue).map(([currency, value]) => [currency, { cents: value.cents, assignmentCount: value.assignmentCount }]));
      const projectedRevenuePaise = Number(projectedNodeRevenue.INR?.cents || 0);
      const runningVmCount = Number(resource.running_vm_count || 0);
      const runningIpCount = Number(resource.running_ip_count || 0);
      const runningVcpu = Number(resource.running_vcpu || 0);
      const runningRamGb = Number(resource.running_ram_bytes || 0) / 1073741824;
      const runningDiskGb = Number(resource.running_disk_bytes || 0) / 1073741824;
      const sharedCostPaise = sharedCosts.rows.reduce((sum, cost) => {
        const amount = Number(cost.monthly_cost_cents || 0);
        if (cost.allocation_method === 'per_vm') return sum + amount * runningVmCount;
        if (cost.allocation_method === 'per_vcpu') return sum + amount * runningVcpu;
        if (cost.allocation_method === 'per_gb_ram') return sum + amount * runningRamGb;
        if (cost.allocation_method === 'per_gb_disk') return sum + amount * runningDiskGb;
        return sum + amount / configuredServerCount;
      }, 0);
      const serverCostPaise = Number(profile?.monthlyCostPaise || 0);
      const includedIpCount = Number(profile?.includedIpCount || 0);
      const billableIpCount = Math.max(0, runningIpCount - includedIpCount);
      const ipCostPaise = billableIpCount * Number(profile?.ipCostPaise || 0);
      const billedPaise = Number(nodeRevenue.billed_paise || 0);
      const collectedPaise = Number(nodeRevenue.collected_paise || 0);
      const outstandingPaise = Number(nodeRevenue.outstanding_paise || 0);
      const totalCostPaise = Math.round(serverCostPaise + ipCostPaise + sharedCostPaise);
      const grossProfitPaise = billedPaise - totalCostPaise;
      const projectedGrossProfitPaise = projectedRevenuePaise - totalCostPaise;
      const marginRevenuePaise = projectedRevenuePaise > 0 ? projectedRevenuePaise : billedPaise;
      const marginPercent = marginRevenuePaise > 0 ? Math.round(((projectedRevenuePaise > 0 ? projectedGrossProfitPaise : grossProfitPaise) / marginRevenuePaise) * 10000) / 100 : null;
      const plannedVmCapacity = Number(profile?.plannedVmCapacity || 0);
      return {
        serverId: profile?.id || `connection:${proxmoxConnectionId}`,
        serverName: profile?.name || resource.connection_name || `Unconfigured connection`,
        nodeName: resource.raw_node_name || profile?.rawNodeName || null,
        rawNodeName: resource.raw_node_name || profile?.rawNodeName || null,
        proxmoxConnectionId,
        connectionName: resource.connection_name || profile?.connectionName || null,
        legacyNeedsAssignment: false,
        hasCostProfile: Boolean(profile),
        invoiceCount: Number(nodeRevenue.invoice_count || 0), billedPaise, collectedPaise, outstandingPaise, projectedRevenuePaise, projectedGrossProfitPaise, projectedRevenueByCurrency,
        serverCostPaise, ipCostPaise: Math.round(ipCostPaise), sharedCostPaise: Math.round(sharedCostPaise), totalCostPaise, grossProfitPaise,
        marginPercent,
        runningVmCount, assignedVmCount: Number(profile?.assignedVmCount || 0), plannedVmCapacity, availableVmCapacity: Math.max(0, plannedVmCapacity - runningVmCount),
        runningIpCount, assignedIpCount: Number(profile?.assignedIpCount || 0), includedIpCount, billableIpCount,
        breakEvenStatus: !profile ? 'configure_costs' : billedPaise <= 0 ? 'no_revenue' : grossProfitPaise >= 0 ? 'profitable' : 'loss',
      };
    });
    const legacyRows = serverCosts.filter(profile => profile.legacyNeedsAssignment).map(profile => ({
      serverId: profile.id, serverName: profile.name, nodeName: profile.rawNodeName, rawNodeName: profile.rawNodeName,
      proxmoxConnectionId: null, connectionName: null, legacyNeedsAssignment: true, hasCostProfile: false,
      invoiceCount: 0, billedPaise: 0, collectedPaise: 0, outstandingPaise: 0, projectedRevenuePaise: 0, projectedGrossProfitPaise: 0, serverCostPaise: 0, ipCostPaise: 0,
      sharedCostPaise: 0, totalCostPaise: 0, grossProfitPaise: 0, marginPercent: 0, runningVmCount: 0, assignedVmCount: 0,
      plannedVmCapacity: profile.plannedVmCapacity, availableVmCapacity: profile.plannedVmCapacity, runningIpCount: 0,
      assignedIpCount: 0, includedIpCount: profile.includedIpCount, billableIpCount: 0, projectedRevenueByCurrency: {}, breakEvenStatus: 'configure_costs',
    }));
    return [...rows, ...legacyRows];
  }

  async upsertBillingServerCost(cost: any) {
    const id = String(cost.id || `server-cost-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`).trim().toLowerCase();
    const name = String(cost.name || '').trim().slice(0, 150);
    const nodeName = String(cost.nodeName || '').trim().slice(0, 100) || null;
    const proxmoxConnectionId = String(cost.proxmoxConnectionId || '').trim() || null;
    const monthlyCostPaise = Math.round(Number(cost.monthlyCostPaise));
    const ipCostPaise = Math.round(Number(cost.ipCostPaise));
    const plannedVmCapacity = Math.max(0, Math.round(Number(cost.plannedVmCapacity) || 0));
    const includedIpCount = Math.max(0, Math.round(Number(cost.includedIpCount) || 0));
    if (!id || !name || !proxmoxConnectionId || !Number.isInteger(monthlyCostPaise) || monthlyCostPaise < 0 || !Number.isInteger(ipCostPaise) || ipCostPaise < 0) throw new Error('Dedicated server cost values are invalid. Select a Proxmox connection before saving.');
    const connection = await pgPool.query('SELECT id FROM proxmox_connections WHERE id = $1', [proxmoxConnectionId]);
    if (!connection.rows[0]) throw new Error('Selected Proxmox connection was not found.');
    const res = await pgPool.query(
      `INSERT INTO billing_server_costs (id, name, node_name, proxmox_connection_id, monthly_cost_paise, ip_cost_paise, planned_vm_capacity, included_ip_count, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, node_name = $3, proxmox_connection_id = $4, monthly_cost_paise = $5, ip_cost_paise = $6, planned_vm_capacity = $7, included_ip_count = $8, is_active = $9, updated_at = NOW()
       RETURNING *`,
      [id, name, nodeName, proxmoxConnectionId, monthlyCostPaise, ipCostPaise, plannedVmCapacity, includedIpCount, cost.isActive !== false]
    );
    const profiles = await this.getBillingServerCosts();
    return profiles.find(item => item.id === res.rows[0].id) || null;
  }

  async deleteBillingServerCost(id: string) {
    const res = await pgPool.query('DELETE FROM billing_server_costs WHERE id = $1 RETURNING id, name, node_name', [String(id || '').trim()]);
    return res.rows[0] || null;
  }

  async getVmBillingProfiles(vmid?: number, ownerEmail?: string) {
    const params: any[] = [];
    const conditions = ["v.owner_email NOT LIKE 'unassigned@%'"];
    if (vmid !== undefined) {
      params.push(vmid);
      conditions.push(`v.vmid = $${params.length}`);
    }
    if (ownerEmail) {
      params.push(ownerEmail.toLowerCase().trim());
      conditions.push(`v.owner_email = $${params.length}`);
    }
    const res = await pgPool.query(
      `SELECT v.vmid, v.vm_name, v.owner_email, v.expiry_date,
              p.plan_id, p.custom_monthly_price_cents, p.billing_status,
              p.billing_cycle_day, p.grace_period_days, p.next_due_at, p.ip_count, p.updated_at,
              pl.name AS plan_name,
              CASE WHEN p.custom_monthly_price_cents IS NOT NULL THEN COALESCE((SELECT setting_value->>'currency' FROM system_settings WHERE setting_key = 'billing_config'), 'INR') ELSE COALESCE(pl.currency, (SELECT setting_value->>'currency' FROM system_settings WHERE setting_key = 'billing_config'), 'INR') END AS effective_currency,
              pl.monthly_price_cents
       FROM vms v
       LEFT JOIN vm_billing_profiles p ON p.vmid = v.vmid
       LEFT JOIN pricing_plans pl ON pl.id = p.plan_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY v.vmid ASC`,
      params
    );
    return res.rows.map(row => ({ vmid: Number(row.vmid), vmName: row.vm_name, ownerEmail: row.owner_email, planId: row.plan_id, planName: row.plan_name,       customMonthlyPriceCents: row.custom_monthly_price_cents === null ? null : Number(row.custom_monthly_price_cents), monthlyPriceCents: row.custom_monthly_price_cents === null ? Number(row.monthly_price_cents || 0) : Number(row.custom_monthly_price_cents), currency: row.effective_currency || 'INR', billingStatus: row.billing_status || 'active',

      billingCycleDay: Number(row.billing_cycle_day || 1),
      gracePeriodDays: row.grace_period_days === null || row.grace_period_days === undefined ? null : Number(row.grace_period_days),
      nextDueAt: row.next_due_at || row.expiry_date, ipCount: Number(row.ip_count || 1), updatedAt: row.updated_at }));
  }

  async upsertVmBillingProfile(vmid: number, profile: any, actorEmail: string) {
    const vm = await this.getVMByVMID(vmid);
    if (!vm) return null;
    const planId = profile.planId ? String(profile.planId) : null;
    if (planId) {
      const plan = await pgPool.query('SELECT id FROM pricing_plans WHERE id = $1', [planId]);
      if (!plan.rows[0]) throw new Error('Pricing plan not found.');
    }
    const customPrice = profile.customMonthlyPriceCents === null || profile.customMonthlyPriceCents === '' || profile.customMonthlyPriceCents === undefined ? null : Math.round(Number(profile.customMonthlyPriceCents));
    if (customPrice !== null && (!Number.isInteger(customPrice) || customPrice < 0)) throw new Error('Custom monthly price is invalid.');
    const billingStatus = ['active', 'grace', 'suspended', 'waived', 'closed'].includes(profile.billingStatus) ? profile.billingStatus : 'active';
    const cycleDay = Math.min(28, Math.max(1, Math.round(Number(profile.billingCycleDay) || 1)));
    const grace = profile.gracePeriodDays === null || profile.gracePeriodDays === '' || profile.gracePeriodDays === undefined ? null : Math.min(365, Math.max(0, Math.round(Number(profile.gracePeriodDays))));
    const nextDueAt = profile.nextDueAt || vm.expiryDate || null;
    const ipCount = Math.min(256, Math.max(1, Math.round(Number(profile.ipCount) || 1)));
    const res = await pgPool.query(
      `INSERT INTO vm_billing_profiles (vmid, plan_id, custom_monthly_price_cents, billing_status, billing_cycle_day, grace_period_days, next_due_at, ip_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (vmid) DO UPDATE SET plan_id = $2, custom_monthly_price_cents = $3, billing_status = $4, billing_cycle_day = $5, grace_period_days = $6, next_due_at = $7, ip_count = $8, updated_at = NOW()
       RETURNING *`,
      [vmid, planId, customPrice, billingStatus, cycleDay, grace, nextDueAt, ipCount]
    );
    await this.logAudit(actorEmail, 'UPDATE_VM_BILLING_PROFILE', `VMID ${vmid}`, `Updated plan ${planId || 'custom'} and billing status ${billingStatus}`);
    return (await this.getVmBillingProfiles(vmid))[0] || res.rows[0];
  }

  async getBillingInvoices(accountEmail?: string, status?: string, limit = 100) {
    const conditions: string[] = [];
    const params: any[] = [];
    if (accountEmail) { params.push(accountEmail.toLowerCase().trim()); conditions.push(`i.account_email = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`i.status = $${params.length}`); }
    params.push(Math.min(500, Math.max(1, limit)));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pgPool.query(
      `SELECT i.*, v.vm_name, p.name AS plan_name FROM billing_invoices i JOIN vms v ON v.vmid = i.vmid LEFT JOIN pricing_plans p ON p.id = i.plan_id ${where} ORDER BY i.due_at ASC, i.created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows.map(row => this.mapBillingInvoice(row));
  }

  async getBillingSummary(accountEmail?: string) {
    const where = accountEmail ? 'WHERE account_email = $1' : '';
    const params = accountEmail ? [accountEmail.toLowerCase().trim()] : [];
    const invoice = await pgPool.query(
      `SELECT COUNT(*)::int AS invoice_count,
              COALESCE(SUM(total_cents), 0)::bigint AS billed_cents,
              COALESCE(SUM(paid_cents), 0)::bigint AS collected_cents,
              COALESCE(SUM(GREATEST(total_cents - paid_cents, 0)), 0)::bigint AS outstanding_cents,
              COUNT(*) FILTER (WHERE status = 'overdue')::int AS overdue_count,
              COALESCE(SUM(GREATEST(total_cents - paid_cents, 0)) FILTER (WHERE status = 'overdue'), 0)::bigint AS overdue_cents,
              COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_invoice_count
       FROM billing_invoices ${where}`,
      params,
    );
    const revenueByCurrency = await pgPool.query(
      `SELECT currency, COUNT(*)::int AS invoice_count,
              COALESCE(SUM(total_cents), 0)::bigint AS billed_cents,
              COALESCE(SUM(paid_cents), 0)::bigint AS collected_cents,
              COALESCE(SUM(GREATEST(total_cents - paid_cents, 0)), 0)::bigint AS outstanding_cents
       FROM billing_invoices ${where}
       GROUP BY currency ORDER BY currency ASC`,
      params,
    );
    const vmWhere = accountEmail ? 'WHERE owner_email = $1 AND owner_email NOT LIKE \'unassigned@%\'' : "WHERE owner_email NOT LIKE 'unassigned@%'";
    const vm = await pgPool.query(`SELECT COUNT(*)::int AS vm_count FROM vms ${vmWhere}`, params);
    const runningVmWhere = accountEmail ? 'WHERE owner_email = $1' : '';
    const runningVms = await pgPool.query(`SELECT COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('running', 'online', 'up'))::int AS running_vm_count FROM vms ${runningVmWhere}`, params);
    const sharedCosts = await pgPool.query("SELECT currency, COALESCE(SUM(monthly_cost_cents), 0)::bigint AS monthly_cost_cents FROM billing_cost_bases WHERE is_active = true GROUP BY currency");
    const serverCosts = await this.getBillingServerCosts(true);
    const mappedServerCosts = serverCosts.filter(item => item.proxmoxConnectionId);
    const serverProfitability = accountEmail ? [] : await this.getBillingServerProfitability();
    const row = invoice.rows[0];
    const billed = Number(row.billed_cents);
    const collected = Number(row.collected_cents);
    const monthlyCost = Number(sharedCosts.rows.reduce((sum, item) => sum + (item.currency === 'INR' ? Number(item.monthly_cost_cents) : 0), 0));
    const monthlyServerCostPaise = serverProfitability.length > 0
      ? serverProfitability.reduce((sum, item) => sum + item.serverCostPaise, 0)
      : mappedServerCosts.reduce((sum, item) => sum + item.monthlyCostPaise, 0);
    const monthlyIpCostPaise = serverProfitability.length > 0
      ? serverProfitability.reduce((sum, item) => sum + item.ipCostPaise, 0)
      : mappedServerCosts.reduce((sum, item) => sum + Math.max(0, item.runningIpCount - item.includedIpCount) * item.ipCostPaise, 0);
    const totalInrCostPaise = monthlyCost + monthlyServerCostPaise + monthlyIpCostPaise;
    const projectedRevenueByCurrency: Record<string, { cents: number; assignmentCount: number }> = {};
    for (const item of serverProfitability) {
      const revenueByCurrency = item.projectedRevenueByCurrency as Record<string, { cents?: number; assignmentCount?: number }> | undefined;
      for (const [currency, value] of Object.entries(revenueByCurrency || {})) {
        const current = projectedRevenueByCurrency[currency] || { cents: 0, assignmentCount: 0 };
        projectedRevenueByCurrency[currency] = { cents: current.cents + Number(value.cents || 0), assignmentCount: current.assignmentCount + Number(value.assignmentCount || 0) };
      }
    }
    const projectedInrRevenuePaise = Number(projectedRevenueByCurrency.INR?.cents || 0);
    const projectedInrGrossProfitPaise = projectedInrRevenuePaise - totalInrCostPaise;
    const projectedInrMarginPercent = projectedInrRevenuePaise > 0 ? Math.round((projectedInrGrossProfitPaise / projectedInrRevenuePaise) * 10000) / 100 : null;
    const inrRevenue = revenueByCurrency.rows.find(item => item.currency === 'INR');
    const inrBilledPaise = Number(inrRevenue?.billed_cents || 0);
    const inrCollectedPaise = Number(inrRevenue?.collected_cents || 0);
    const inrOutstandingPaise = Number(inrRevenue?.outstanding_cents || 0);
    const inrGrossProfitPaise = inrBilledPaise - totalInrCostPaise;
    const inrCollectedGrossProfitPaise = inrCollectedPaise - totalInrCostPaise;
    const totalServerCapacityVms = mappedServerCosts.reduce((sum, item) => sum + item.plannedVmCapacity, 0);
    const totalAssignedServerVms = mappedServerCosts.reduce((sum, item) => sum + item.assignedVmCount, 0);
    const totalRunningServerVms = Number(runningVms.rows[0]?.running_vm_count || 0);
    const runningIpTotals = await pgPool.query(`SELECT COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(v.status, ''))) IN ('running', 'online', 'up') THEN GREATEST(COALESCE(p.ip_count, 1), 1) ELSE 0 END), 0)::int AS running_ip_count FROM vms v LEFT JOIN vm_billing_profiles p ON p.vmid = v.vmid`);
    const totalRunningIpCount = Number(runningIpTotals.rows[0]?.running_ip_count || 0);
    const totalAssignedIpCount = mappedServerCosts.reduce((sum, item) => sum + item.assignedIpCount, 0);
    const totalIncludedIpCount = mappedServerCosts.reduce((sum, item) => sum + item.includedIpCount, 0);
    return {
      invoiceCount: Number(row.invoice_count), vmCount: Number(vm.rows[0].vm_count), billedCents: billed, collectedCents: collected, outstandingCents: Number(row.outstanding_cents), overdueCount: Number(row.overdue_count), overdueCents: Number(row.overdue_cents), suspendedInvoiceCount: Number(row.suspended_invoice_count), monthlyCostCents: totalInrCostPaise,
      estimatedGrossProfitCents: inrGrossProfitPaise, collectedGrossProfitCents: inrCollectedGrossProfitPaise, estimatedMarginPercent: inrBilledPaise > 0 ? Math.round((inrGrossProfitPaise / inrBilledPaise) * 10000) / 100 : 0,
      reportingCurrency: 'INR', inrBilledPaise, inrCollectedPaise, inrOutstandingPaise, inrGrossProfitPaise, inrCollectedGrossProfitPaise, projectedInrRevenuePaise, projectedInrGrossProfitPaise, projectedInrMarginPercent, projectedRevenueByCurrency, monthlySharedCostPaise: monthlyCost, monthlyServerCostPaise, monthlyIpCostPaise, totalInrCostPaise,
      totalServerCapacityVms, totalAssignedServerVms, totalRunningServerVms, availableServerCapacityVms: Math.max(0, totalServerCapacityVms - totalRunningServerVms), totalRunningIpCount, totalAssignedIpCount, totalIncludedIpCount, unmappedServerCostProfileCount: serverCosts.filter(item => item.legacyNeedsAssignment).length, billableIpCount: Math.max(0, totalRunningIpCount - totalIncludedIpCount), billableRunningIpCount: Math.max(0, totalRunningIpCount - totalIncludedIpCount), revenueByCurrency: revenueByCurrency.rows.map(item => ({ currency: item.currency, invoiceCount: Number(item.invoice_count), billedCents: Number(item.billed_cents), collectedCents: Number(item.collected_cents), outstandingCents: Number(item.outstanding_cents) })),
    };
  }

  async createInvoiceForVm(vmid: number, issuedAt = new Date()) {
    const profiles = await this.getVmBillingProfiles(vmid);
    const profile = profiles[0];
    if (!profile || profile.billingStatus === 'closed' || profile.billingStatus === 'waived') return null;
    const periodStart = new Date(issuedAt.getFullYear(), issuedAt.getMonth(), 1);
    const periodEnd = new Date(issuedAt.getFullYear(), issuedAt.getMonth() + 1, 1);
    const config = await this.getBillingConfig();
    const subtotal = Math.max(0, Math.round(Number(profile.monthlyPriceCents) || 0));
    const tax = Math.round(subtotal * (Number(config.taxRatePercent) / 100));
    const dueAt = profile.nextDueAt ? new Date(profile.nextDueAt) : new Date(issuedAt.getTime() + Number(config.daysBeforeDue || 7) * 86400000);
    const invoiceId = `inv-${issuedAt.getTime()}-${vmid}-${crypto.randomBytes(3).toString('hex')}`;
    const res = await pgPool.query(
      `INSERT INTO billing_invoices (id, account_email, vmid, plan_id, period_start, period_end, issued_at, due_at, subtotal_cents, tax_cents, total_cents, paid_cents, currency, status, suspension_eligible_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, 'open', $13)
       ON CONFLICT (vmid, period_start, period_end) DO UPDATE SET due_at = EXCLUDED.due_at, suspension_eligible_at = EXCLUDED.suspension_eligible_at
       RETURNING *`,
      [invoiceId, profile.ownerEmail, vmid, profile.planId, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10), issuedAt, dueAt, subtotal, tax, subtotal + tax, profile.currency || config.currency || 'INR', new Date(dueAt.getTime() + Number(profile.gracePeriodDays ?? config.gracePeriodDays ?? 7) * 86400000)]
    );
    return this.mapBillingInvoice((await pgPool.query('SELECT i.*, v.vm_name, p.name AS plan_name FROM billing_invoices i JOIN vms v ON v.vmid = i.vmid LEFT JOIN pricing_plans p ON p.id = i.plan_id WHERE i.id = $1', [res.rows[0].id])).rows[0]);
  }

  async markOverdueInvoices() {
    const res = await pgPool.query(`UPDATE billing_invoices SET status = CASE WHEN paid_cents > 0 THEN 'partially_paid' ELSE 'overdue' END WHERE status IN ('open', 'partially_paid') AND due_at < NOW() AND paid_cents < total_cents RETURNING id`);
    return res.rowCount;
  }

  async recordBillingEvent(event: { invoiceId?: string; vmid?: number; eventKey: string; periodKey: string; payload?: any }) {
    const id = `be-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const res = await pgPool.query(
      `INSERT INTO billing_events (id, invoice_id, vmid, event_key, period_key, payload) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (invoice_id, event_key, period_key) DO NOTHING RETURNING id`,
      [id, event.invoiceId || null, event.vmid || null, event.eventKey, event.periodKey, JSON.stringify(event.payload || {})]
    );
    return Boolean(res.rows[0]);
  }

  async recordBillingPayment(invoiceId: string, amountCents: number, method: string, externalReference: string | undefined, notes: string | undefined, recordedBy: string) {
    const amount = Math.round(Number(amountCents));
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Payment amount must be a positive integer number of cents.');
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await client.query('SELECT * FROM billing_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      if (!invoice.rows[0]) throw new Error('Invoice not found.');
      const row = invoice.rows[0];
      const outstanding = Math.max(0, Number(row.total_cents) - Number(row.paid_cents));
      if (amount > outstanding) throw new Error('Payment cannot exceed the invoice outstanding balance.');
      const paymentId = `pay-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      await client.query('INSERT INTO billing_payments (id, invoice_id, account_email, amount_cents, currency, method, external_reference, recorded_by, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [paymentId, invoiceId, row.account_email, amount, row.currency, String(method || 'manual').slice(0, 50), externalReference || null, recordedBy, notes || null]);
      const paid = Number(row.paid_cents) + amount;
      const status = paid >= Number(row.total_cents) ? 'paid' : 'partially_paid';
      await client.query('UPDATE billing_invoices SET paid_cents = $1, status = $2, paid_at = CASE WHEN $2 = \'paid\' THEN NOW() ELSE paid_at END WHERE id = $3', [paid, status, invoiceId]);
      await client.query('COMMIT');
      await this.logAudit(recordedBy, 'RECORD_BILLING_PAYMENT', invoiceId, `Recorded ${amount} cents by ${method || 'manual'}`);
      const rows = await this.getBillingInvoices(undefined, undefined, 500);
      return rows.find(item => item.id === invoiceId) || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  async getBillableVmBillingProfiles() {
    const res = await pgPool.query(
      `SELECT p.*, v.vm_name, v.owner_email, v.expiry_date, v.node, v.type,
              pl.name AS plan_name, pl.currency, pl.monthly_price_cents
       FROM vm_billing_profiles p
       JOIN vms v ON v.vmid = p.vmid
       LEFT JOIN pricing_plans pl ON pl.id = p.plan_id
       WHERE v.owner_email NOT LIKE 'unassigned@%'
         AND p.billing_status NOT IN ('closed', 'waived')
       ORDER BY p.vmid ASC`
    );
    return res.rows.map(row => ({
      vmid: Number(row.vmid),
      vmName: row.vm_name,
      ownerEmail: row.owner_email,
      node: row.node,
      type: row.type,
      planId: row.plan_id,
      planName: row.plan_name,
      customMonthlyPriceCents: row.custom_monthly_price_cents === null ? null : Number(row.custom_monthly_price_cents),
      monthlyPriceCents: row.custom_monthly_price_cents === null ? Number(row.monthly_price_cents || 0) : Number(row.custom_monthly_price_cents),
      billingStatus: row.billing_status,
      nextDueAt: row.next_due_at || row.expiry_date,
    }));
  }

  async getBillingInvoiceById(invoiceId: string) {
    const rows = await this.getBillingInvoices(undefined, undefined, 500);
    return rows.find(invoice => invoice.id === invoiceId) || null;
  }

  async createBillingSuspensionAction(invoiceId: string, vmid: number, reason: string) {
    const id = `susp-${Date.now()}-${vmid}-${crypto.randomBytes(3).toString('hex')}`;
    const res = await pgPool.query(
      `INSERT INTO billing_suspension_actions (id, invoice_id, vmid, status, reason)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (vmid, invoice_id, status) DO NOTHING
       RETURNING *`,
      [id, invoiceId, vmid, reason.slice(0, 1000)]
    );
    if (res.rows[0]) return res.rows[0];
    const existing = await pgPool.query('SELECT * FROM billing_suspension_actions WHERE vmid = $1 AND invoice_id = $2 AND status = \'pending\' LIMIT 1', [vmid, invoiceId]);
    return existing.rows[0] || null;
  }

  async updateBillingSuspensionAction(id: string, status: 'pending' | 'executed' | 'reversed' | 'failed', actorEmail?: string, errorMessage?: string) {
    const timestampColumn = status === 'executed' ? 'executed_at' : status === 'reversed' ? 'reversed_at' : 'NULL';
    const res = await pgPool.query(
      `UPDATE billing_suspension_actions
       SET status = $1,
           actor_email = COALESCE($2, actor_email),
           error_message = $3,
           ${timestampColumn === 'NULL' ? 'executed_at = executed_at' : `${timestampColumn} = NOW()`}
       WHERE id = $4
       RETURNING *`,
      [status, actorEmail || null, errorMessage || null, id]
    );
    return res.rows[0] || null;
  }

  async setBillingInvoiceStatus(invoiceId: string, status: 'open' | 'partially_paid' | 'overdue' | 'suspended' | 'paid' | 'void') {
    const res = await pgPool.query('UPDATE billing_invoices SET status = $1 WHERE id = $2 RETURNING id, status', [status, invoiceId]);
    return res.rows[0] || null;
  }

  async setVmBillingStatus(vmid: number, billingStatus: 'active' | 'grace' | 'suspended' | 'waived' | 'closed') {
    const res = await pgPool.query('UPDATE vm_billing_profiles SET billing_status = $1, updated_at = NOW() WHERE vmid = $2 RETURNING vmid, billing_status', [billingStatus, vmid]);
    return res.rows[0] || null;
  }

  async getBillingSuspensionActionById(id: string) {
    const rows = await this.getBillingSuspensionActions();
    return rows.find(action => action.id === id) || null;
  }

  async getBillingSuspensionActions(status?: string) {
    const params: any[] = [];
    let where = '';
    if (status) { params.push(status); where = 'WHERE a.status = $1'; }
    const res = await pgPool.query(
      `SELECT a.*, i.account_email, i.total_cents, i.paid_cents, v.vm_name
       FROM billing_suspension_actions a
       LEFT JOIN billing_invoices i ON i.id = a.invoice_id
       JOIN vms v ON v.vmid = a.vmid
       ${where}
       ORDER BY a.requested_at DESC LIMIT 500`,
      params
    );
    return res.rows;
  }

  async getApiKeyByHash(hash: string): Promise<{ id: number; user_email: string; name: string; scope: string } | null> {
    const result = await pgPool.query<{ id: number; user_email: string; name: string; scope: string }>(
      'SELECT id, user_email, name, scope FROM stellar_api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hash],
    );
    return result.rows[0] || null;
  }

  async touchApiKey(id: number): Promise<void> {
    await pgPool.query('UPDATE stellar_api_keys SET last_used_at = NOW() WHERE id = $1', [id]);
  }

  async createApiKey(email: string, name: string, keyHash: string, prefix: string, scope: string) {
    const result = await pgPool.query(
      `INSERT INTO stellar_api_keys (user_email, name, key_hash, key_prefix, scope)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_email, name, key_prefix, scope, created_at`,
      [email.toLowerCase().trim(), name, keyHash, prefix, scope],
    );
    return result.rows[0];
  }

  async getUserApiKeys(email: string) {
    const result = await pgPool.query(
      `SELECT id, name, key_prefix, scope, created_at, last_used_at, revoked_at
       FROM stellar_api_keys WHERE user_email = $1 ORDER BY created_at DESC`,
      [email.toLowerCase().trim()],
    );
    return result.rows;
  }

  async deleteApiKey(id: number, email: string): Promise<boolean> {
    const result = await pgPool.query(
      'UPDATE stellar_api_keys SET revoked_at = NOW() WHERE id = $1 AND user_email = $2 AND revoked_at IS NULL RETURNING id',
      [id, email.toLowerCase().trim()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async queueBackup(vmid: number, providerTaskId: string | null, userEmail: string) {
    const result = await pgPool.query(
      `INSERT INTO vm_backup_queue (vmid, provider_task_id, requested_by, status)
       VALUES ($1, $2, $3, 'running') RETURNING id, vmid, provider_task_id, status, created_at`,
      [vmid, providerTaskId, userEmail.toLowerCase().trim()],
    );
    return result.rows[0];
  }

  async markBackupStatus(id: number, status: string, errorMessage?: string) {
    const result = await pgPool.query(
      `UPDATE vm_backup_queue SET status = $1, error_message = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, vmid, status, error_message, updated_at`,
      [status, errorMessage || null, id],
    );
    return result.rows[0] || null;
  }

  async getBackupQueue(vmid?: number) {
    const params: number[] = [];
    const where = vmid !== undefined ? 'WHERE vmid = $1' : '';
    if (vmid !== undefined) params.push(vmid);
    const result = await pgPool.query(
      `SELECT id, vmid, provider_task_id, requested_by, status, error_message, created_at, updated_at
       FROM vm_backup_queue ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    return result.rows;
  }

  async createProviderOperation(input: {
    id: string;
    vmid: number;
    action: string;
    idempotencyKey: string;
    requestedBy: string;
    payload?: Record<string, unknown>;
  }) {
    const result = await pgPool.query(
      `INSERT INTO provider_operations (id, vmid, action, idempotency_key, requested_by, request_payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (vmid, action, idempotency_key) DO UPDATE SET updated_at = provider_operations.updated_at
       RETURNING id, vmid, action, state, idempotency_key, provider_task_id, result_payload, error_code, error_message, created_at, updated_at`,
      [input.id, input.vmid, input.action, input.idempotencyKey, input.requestedBy.toLowerCase().trim(), JSON.stringify(input.payload || {})],
    );
    return result.rows[0];
  }

  async transitionProviderOperation(
    id: string,
    fromStates: string[],
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
    details: { providerTaskId?: string | null; result?: Record<string, unknown>; errorCode?: string; errorMessage?: string } = {},
  ) {
    const result = await pgPool.query(
      `UPDATE provider_operations
       SET state = $1,
           provider_task_id = COALESCE($2, provider_task_id),
           result_payload = COALESCE($3::jsonb, result_payload),
           error_code = $4,
           error_message = $5,
           started_at = CASE WHEN $1 = 'running' AND started_at IS NULL THEN NOW() ELSE started_at END,
           completed_at = CASE WHEN $1 IN ('succeeded', 'failed', 'cancelled') THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE id = $6 AND state = ANY($7::text[])
       RETURNING id, vmid, action, state, provider_task_id, result_payload, error_code, error_message, updated_at`,
      [state, details.providerTaskId ?? null, details.result ? JSON.stringify(details.result) : null, details.errorCode || null, details.errorMessage || null, id, fromStates],
    );
    return result.rows[0] || null;
  }

  async getProviderOperation(id: string) {
    const result = await pgPool.query(
      `SELECT id, vmid, action, state, idempotency_key, provider_task_id, requested_by, result_payload, error_code, error_message, created_at, started_at, completed_at, updated_at
       FROM provider_operations WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  }

  async getVmBandwidthQuota(vmid: number): Promise<number> {
    const result = await pgPool.query<{ bandwidth_quota_gb: string | number | null }>(
      'SELECT bandwidth_quota_gb FROM vm_billing_profiles WHERE vmid = $1',
      [vmid],
    );
    return Number(result.rows[0]?.bandwidth_quota_gb || 0);
  }

  async setVmBandwidthQuota(vmid: number, bandwidthGb: number) {
    const result = await pgPool.query(
      `INSERT INTO vm_billing_profiles (vmid, bandwidth_quota_gb)
       VALUES ($1, $2)
       ON CONFLICT (vmid) DO UPDATE SET bandwidth_quota_gb = EXCLUDED.bandwidth_quota_gb, updated_at = NOW()
       RETURNING vmid, bandwidth_quota_gb`,
      [vmid, bandwidthGb],
    );
    return result.rows[0] || null;
  }

  async pushRdnsRequest(vmid: number, ip: string, ptr: string, userEmail: string) {
    const result = await pgPool.query(
      `INSERT INTO rdns_requests (vmid, ip_address, ptr_record, requested_by, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id, vmid, ip_address AS ip, ptr_record AS ptr, status, created_at`,
      [vmid, ip, ptr, userEmail.toLowerCase().trim()],
    );
    return result.rows[0];
  }

  async getRdnsQueue() {
    const result = await pgPool.query(
      `SELECT id, vmid, ip_address AS ip, ptr_record AS ptr, requested_by, status, error_message, created_at, updated_at
       FROM rdns_requests WHERE status IN ('pending', 'processing') ORDER BY created_at ASC LIMIT 500`,
    );
    return result.rows;
  }

  async markRdnsProcessed(id: number, status: string, errorMessage?: string) {
    const result = await pgPool.query(
      `UPDATE rdns_requests SET status = $1, error_message = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, status, error_message, updated_at`,
      [status, errorMessage || null, id],
    );
    return result.rows[0] || null;
  }

  async getAppCatalogAll() {
    const result = await pgPool.query(
      `SELECT id, name, description, category, icon, template_name, enabled
       FROM app_catalog ORDER BY category ASC, name ASC`,
    );
    return result.rows;
  }

  async getAppCatalog() {
    const result = await pgPool.query(
      `SELECT id, name, description, category, icon, template_name, enabled
       FROM app_catalog WHERE enabled = true ORDER BY category ASC, name ASC`,
    );
    return result.rows;
  }

  async createAppInstance(vmid: number, appId: string) {
    const result = await pgPool.query(
      `INSERT INTO app_instances (vmid, app_id, status) VALUES ($1, $2, 'provisioning')
       ON CONFLICT (vmid, app_id) DO UPDATE SET status = 'provisioning', updated_at = NOW()
       RETURNING id, vmid, app_id, status, created_at, updated_at`,
      [vmid, appId],
    );
    return result.rows[0];
  }

  async setAppInstanceStatus(vmid: number, appId: string, status: string) {
    const result = await pgPool.query(
      `UPDATE app_instances SET status = $1, updated_at = NOW() WHERE vmid = $2 AND app_id = $3
       RETURNING id, vmid, app_id, status, created_at, updated_at`,
      [status, vmid, appId],
    );
    return result.rows[0] || null;
  }

  async getAppInstances(vmid?: number) {
    const params: number[] = [];
    const where = vmid !== undefined ? 'WHERE vmid = $1' : '';
    if (vmid !== undefined) params.push(vmid);
    const result = await pgPool.query(
      `SELECT id, vmid, app_id, status, created_at, updated_at FROM app_instances ${where} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return result.rows;
  }

  async ensureScheduledTasksTable(): Promise<void> {
    const result = await pgPool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.scheduled_tasks') IS NOT NULL AS exists",
    );
    if (!result.rows[0]?.exists) {
      throw new Error('scheduled_tasks table is not available; run the database migrations');
    }
  }

  async runTask<T>(
    userEmail: string,
    title: string,
    description: string,
    priority: string,
    work: (updateProgress: (progressPct: number, detail?: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const task = await this.addTask(userEmail, title, description, 'running', priority, 0);
    const vmidMatch = title.match(/VMID\s+(\d+)/i);
    const operationId = vmidMatch ? `op-${task.id}` : null;
    if (operationId && vmidMatch) {
      const vmid = Number(vmidMatch[1]);
      const action = title.replace(/\s*[—-].*$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      await this.createProviderOperation({
        id: operationId,
        vmid,
        action,
        idempotencyKey: task.id,
        requestedBy: userEmail,
        payload: { taskId: task.id, title },
      });
      await this.transitionProviderOperation(operationId, ['queued'], 'running');
    }
    const updateProgress = async (progressPct: number, _detail?: string): Promise<void> => {
      await this.updateTaskStatus(task.id, 'running', Math.max(0, Math.min(100, Math.round(progressPct))));
    };
    try {
      const result = await work(updateProgress);
      await this.updateTaskStatus(task.id, 'completed', 100);
      if (operationId) await this.transitionProviderOperation(operationId, ['running'], 'succeeded');
      return result;
    } catch (error) {
      await this.updateTaskStatus(task.id, 'failed', 0);
      if (operationId) await this.transitionProviderOperation(operationId, ['running'], 'failed', {
        errorMessage: error instanceof Error ? error.message : 'Provider operation failed',
      });
      throw error;
    }
  }

  async getSubUsers(vmid: number) {
    const result = await pgPool.query(
      `SELECT su.id, su.vmid, su.user_email, su.scope, su.invited_by, su.accepted_at, su.created_at, su.updated_at,
              a.name AS user_name
       FROM vm_sub_users su
       LEFT JOIN accounts a ON a.email = su.user_email
       WHERE su.vmid = $1
       ORDER BY su.created_at ASC`,
      [vmid],
    );
    return result.rows;
  }

  async getSubUserAccess(vmid: number, email: string) {
    const result = await pgPool.query(
      `SELECT id, vmid, user_email, scope, invited_by, accepted_at, created_at, updated_at
       FROM vm_sub_users
       WHERE vmid = $1 AND user_email = $2
       LIMIT 1`,
      [vmid, email.toLowerCase().trim()],
    );
    return result.rows[0] || null;
  }

  async addSubUser(vmid: number, email: string, scope: string, invitedBy?: string) {
    const result = await pgPool.query(
      `INSERT INTO vm_sub_users (vmid, user_email, scope, invited_by, accepted_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (vmid, user_email) DO UPDATE
         SET scope = EXCLUDED.scope,
             invited_by = COALESCE(EXCLUDED.invited_by, vm_sub_users.invited_by),
             accepted_at = COALESCE(vm_sub_users.accepted_at, NOW()),
             updated_at = NOW()
       RETURNING id, vmid, user_email, scope, invited_by, accepted_at, created_at, updated_at`,
      [vmid, email.toLowerCase().trim(), scope, invitedBy?.toLowerCase().trim() || null],
    );
    return result.rows[0];
  }

  async updateSubUser(id: number, vmid: number, scope: string) {
    const result = await pgPool.query(
      `UPDATE vm_sub_users SET scope = $1, updated_at = NOW()
       WHERE id = $2 AND vmid = $3
       RETURNING id, vmid, user_email, scope, invited_by, accepted_at, created_at, updated_at`,
      [scope, id, vmid],
    );
    return result.rows[0] || null;
  }

  async removeSubUser(id: number, vmid: number): Promise<boolean> {
    const result = await pgPool.query(
      'DELETE FROM vm_sub_users WHERE id = $1 AND vmid = $2 RETURNING id',
      [id, vmid],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getTeamAccessOverview(ownerEmail: string) {
    const cleanOwnerEmail = ownerEmail.toLowerCase().trim();
    const vms = await this.getVMs(cleanOwnerEmail);
    const vmids = vms.map((vm) => vm.vmid);
    if (vmids.length === 0) return { vms, members: [], invitations: [] };

    const [members, invitations] = await Promise.all([
      pgPool.query(
        `SELECT su.id, su.vmid, su.user_email, su.scope, su.invited_by, su.accepted_at, su.created_at, su.updated_at,
                a.name AS user_name
         FROM vm_sub_users su
         LEFT JOIN accounts a ON a.email = su.user_email
         WHERE su.vmid = ANY($1::int[])
         ORDER BY su.created_at DESC`,
        [vmids],
      ),
      pgPool.query(
        `SELECT id, vmid, invitee_email, scope, invited_by, expires_at, created_at, sent_at, accepted_at, revoked_at
         FROM vm_sub_user_invitations
         WHERE invited_by = $1 AND vmid = ANY($2::int[])
         ORDER BY created_at DESC`,
        [cleanOwnerEmail, vmids],
      ),
    ]);

    return {
      vms,
      members: members.rows.map((row) => ({
        id: Number(row.id),
        vmid: Number(row.vmid),
        userEmail: row.user_email,
        userName: row.user_name || null,
        scope: row.scope,
        invitedBy: row.invited_by || null,
        acceptedAt: row.accepted_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      invitations: invitations.rows.map((row) => ({
        id: row.id,
        vmid: Number(row.vmid),
        inviteeEmail: row.invitee_email,
        scope: row.scope,
        invitedBy: row.invited_by,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        sentAt: row.sent_at || null,
        acceptedAt: row.accepted_at || null,
        revokedAt: row.revoked_at || null,
        isActive: isPendingTeamInvitationActive({
          expiresAt: row.expires_at,
          acceptedAt: row.accepted_at || null,
          revokedAt: row.revoked_at || null,
        }),
      })),
    };
  }

  async getAccessibleClientVMs(email: string) {
    const cleanEmail = email.toLowerCase().trim();
    const owned = await this.getVMs(cleanEmail);
    const delegated = await pgPool.query<{ vmid: number }>(
      `SELECT vmid FROM vm_sub_users WHERE user_email = $1 ORDER BY vmid ASC`,
      [cleanEmail],
    );
    const ownedIds = new Set(owned.map((vm) => vm.vmid));
    const additional = await Promise.all(
      delegated.rows
        .map((row) => Number(row.vmid))
        .filter((vmid) => !ownedIds.has(vmid))
        .map((vmid) => this.getVMByVMID(vmid)),
    );
    return [...owned, ...additional.filter((vm): vm is NonNullable<typeof vm> => Boolean(vm))];
  }

  async createTeamInvitation(vmid: number, inviteeEmail: string, scope: string, invitedBy: string) {
    const cleanInvitee = inviteeEmail.toLowerCase().trim();
    const cleanInviter = invitedBy.toLowerCase().trim();
    const id = `team-invite-${crypto.randomBytes(12).toString('hex')}`;
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE vm_sub_user_invitations
         SET revoked_at = NOW()
         WHERE vmid = $1 AND invitee_email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [vmid, cleanInvitee],
      );
      const result = await client.query(
        `INSERT INTO vm_sub_user_invitations (id, vmid, invitee_email, scope, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
         RETURNING id, vmid, invitee_email, scope, invited_by, expires_at, created_at, sent_at, accepted_at, revoked_at`,
        [id, vmid, cleanInvitee, scope, cleanInviter],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markTeamInvitationSent(id: string) {
    await pgPool.query('UPDATE vm_sub_user_invitations SET sent_at = NOW() WHERE id = $1', [id]);
  }

  async revokeTeamInvitation(id: string, ownerEmail: string): Promise<boolean> {
    const result = await pgPool.query(
      `UPDATE vm_sub_user_invitations
       SET revoked_at = NOW()
       WHERE id = $1 AND invited_by = $2 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [id, ownerEmail.toLowerCase().trim()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async acceptPendingTeamInvitations(client: pg.PoolClient, email: string) {
    const cleanEmail = email.toLowerCase().trim();
    const pending = await client.query(
      `SELECT id, vmid, scope, invited_by
       FROM vm_sub_user_invitations
       WHERE invitee_email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [cleanEmail],
    );

    for (const invitation of pending.rows) {
      await client.query(
        `INSERT INTO vm_sub_users (vmid, user_email, scope, invited_by, accepted_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (vmid, user_email) DO UPDATE
           SET scope = EXCLUDED.scope, invited_by = EXCLUDED.invited_by, accepted_at = NOW(), updated_at = NOW()`,
        [invitation.vmid, cleanEmail, invitation.scope, invitation.invited_by],
      );
      await client.query('UPDATE vm_sub_user_invitations SET accepted_at = NOW() WHERE id = $1', [invitation.id]);
    }

    return pending.rows.length;
  }

  async acceptPendingTeamInvitationsForEmail(email: string) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const acceptedCount = await this.acceptPendingTeamInvitations(client, email);
      await client.query('COMMIT');
      return acceptedCount;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

}

export const dbService = new DatabaseService();
