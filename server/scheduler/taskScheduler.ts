/**
 * Stellar Engine — Scheduled VM Task Runner
 *
 * Executes recurring batch VM tasks (power start/stop/reboot, scheduled
 * snapshots) for client accounts. Jobs are stored in the `scheduled_tasks`
 * table with per-day weekly schedules in a chosen IANA timezone. A 60-second
 * tick evaluates every enabled job against the current time in its timezone
 * and fires due jobs exactly once (same-minute window guard).
 *
 * Actions are executed against the real Proxmox API using the panel's
 * configured cluster connection (freshly re-read on every tick, so changes
 * in Admin → Connections apply without a restart).
 */

import https from 'https';
import { dbService, pgPool } from '../db/database.js';

// Thin wrapper around pgPool.query so callers can pass plain SQL strings.
async function query(text: string, params?: any[]) {
  const res = await pgPool.query(text, params);
  return res.rows;
}

const ALLOWED_TYPES = new Set(['power_start', 'power_stop', 'reboot', 'snapshot']);

type SchedRow = {
  id: string;
  owner_email: string;
  name: string;
  task_type: string;
  target_ids: string[];
  schedule_days: string[];
  schedule_time: string;
  timezone: string;
  enabled: boolean;
  last_run: Date | null;
};

// Next occurrence of a day-of-week + time schedule from `from`, in the job's
// IANA timezone. Returns a JS Date (local) that is strictly > from.
export function nextOccurrence(from: Date, days: string[], time: string, tz: string): Date {
  const [hh, mm] = time.split(':').map(Number);
  const dayOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let best: Date | null = null;
  for (let d = 0; d < 14; d++) {
    const cand = new Date(from);
    cand.setDate(from.getDate() + d);
    cand.setHours(hh, mm, 0, 0);
    const fmt = cand.toLocaleString('en-US', { timeZone: tz, weekday: 'short' });
    const localDay = dayOrder.indexOf(fmt);
    if (localDay === -1 || !days.includes(dayOrder[localDay])) continue;
    if (cand <= from) continue;
    if (!best || cand < best) best = cand;
  }
  return best || new Date(from.getTime() + 7 * 86400000);
}

function inTz(now: Date, tz: string): { day: string; time: string } {
  const day = now.toLocaleString('en-US', { timeZone: tz, weekday: 'short' });
  const h = now.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).replace(/^24/, '00');
  const m = now.toLocaleString('en-US', { timeZone: tz, minute: '2-digit' });
  return { day, time: `${h}:${m}` };
}

async function getCachedConnection(): Promise<{ host: string; port: number; auth: string } | null> {
  try {
    const conns: any[] = await dbService.getProxmoxConnectionCredentials();
    if (!conns || conns.length === 0) return null;
    const c = conns[0];
    const host = c.host_ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return { host, port: c.port || 8006, auth: `PVEAPIToken=${c.token_id}=${c.token_secret}` };
  } catch (e) {
    return null;
  }
}

function pvePost(conn: { host: string; port: number; auth: string }, path: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: conn.host,
      port: conn.port,
      path,
      method: 'POST',
      rejectUnauthorized: true,
      timeout: 15000,
      headers: { Authorization: conn.auth, 'Content-Length': 0 }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, status: res.statusCode, json: JSON.parse(data) }); }
        catch (_e) { resolve({ ok: res.statusCode === 200, status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, json: null }); });
    req.on('error', () => resolve({ ok: false, status: 0, json: null }));
    req.end();
  });
}

async function executeOne(conn: { host: string; port: number; auth: string }, task: SchedRow, vmid: number): Promise<string> {
  try {
    const vm = await dbService.getVMByVMID(vmid);
    if (!vm) return `VMID ${vmid}: not found`;
    if (vm.isSuspended) return `VMID ${vmid}: skipped (suspended)`;
    const node = vm.node && !/^(info|cluster)$/i.test(vm.node) ? vm.node : 'info';
    if (task.task_type === 'snapshot') {
      const snapName = `stellar-sched-${Date.now().toString(36)}`;
      const res = await pvePost(conn, `/api2/json/nodes/${node}/${vm.type === 'lxc' ? 'lxc' : 'qemu'}/${vmid}/snapshot`);
      if (!res.ok) return `VMID ${vmid}: snapshot failed (HTTP ${res.status})`;
      return `VMID ${vmid}: snapshot '${snapName}' created`;
    }
    const actionMap: Record<string, string> = { power_start: 'start', power_stop: 'stop', reboot: 'reboot' };
    const action = actionMap[task.task_type] || 'start';
    // Skip no-ops that Proxmox rejects: don't start an already-running VM or stop a stopped one.
    const running = vm.status === 'running';
    if (action === 'start' && running) return `VMID ${vmid}: already running (skipped)`;
    if ((action === 'stop') && !running) return `VMID ${vmid}: already stopped (skipped)`;
    const res = await pvePost(conn, `/api2/json/nodes/${node}/${vm.type === 'lxc' ? 'lxc' : 'qemu'}/${vmid}/status/${action}`);
    if (!res.ok) return `VMID ${vmid}: ${action} failed (HTTP ${res.status})`;
    // Mirror the action in the panel's own DB so the UI reflects it immediately
    await dbService.executeVMAction(vmid, action, task.owner_email);
    return `VMID ${vmid}: ${action} executed`;
  } catch (err: any) {
    return `VMID ${vmid}: failed (${(err?.message || 'error').slice(0, 80)})`;
  }
}

let tickTimer: NodeJS.Timeout | null = null;
let firedWindow = '';

export async function startTaskScheduler() {
  if (tickTimer) return;
  // Lazily create the table on first boot so the schema migration is part of the service, not a loose script fragment.
  try {
    await dbService.ensureScheduledTasksTable();
  } catch (err: any) {
    console.error('[scheduler] failed to ensure scheduled_tasks table:', err?.message || err);
  }
  console.log('[scheduler] Scheduled task runner started (60s tick)');
  tickTimer = setInterval(async () => {
    try {
      const rows: SchedRow[] = await query(
        'SELECT id, owner_email, name, task_type, target_ids, schedule_days, schedule_time, timezone, enabled, last_run FROM scheduled_tasks WHERE enabled = true'
      );
      if (rows.length === 0) return;
      const conn = await getCachedConnection();
      if (!conn) {
        console.warn('[scheduler] No cluster connection — schedules paused until one is configured');
        return;
      }
      const now = new Date();
      for (const row of rows) {
        try {
          if (!ALLOWED_TYPES.has(row.task_type)) continue;
          const { day, time } = inTz(now, row.timezone);
          const [hh, mm] = row.schedule_time.split(':').map(Number);
          if (row.schedule_days.includes(day) && parseInt(time.split(':')[0], 10) === hh && parseInt(time.split(':')[1], 10) === mm) {
            // same-minute guard: remember the last (day+hh:mm+tz) window we fired for
            const windowKey = `${row.id}:${row.timezone}:${day}:${hh}:${mm}`;
            if (firedWindow === windowKey) continue;
            const results: string[] = [];
            for (const rawId of row.target_ids) {
              const vmid = parseInt(String(rawId), 10);
              if (Number.isNaN(vmid)) continue;
              results.push(await executeOne(conn, row, vmid));
            }
            firedWindow = windowKey;
            const ok = results.some(r => r.includes('executed') || r.includes('created') || r.includes('skipped'));
            const next = nextOccurrence(now, row.schedule_days, row.schedule_time, row.timezone);
            await query(
              `UPDATE scheduled_tasks SET last_run = NOW(), last_status = $1, next_run = $2 WHERE id = $3`,
              [ok ? `OK — ${results.join('; ').slice(0, 200)}` : `FAILED — ${results.join('; ').slice(0, 200)}`, next.toISOString(), row.id]
            );
            await dbService.addTask(row.owner_email, `Schedule fired: ${row.name}`, results.join('; ').slice(0, 400), ok ? 'medium' : 'high');
            console.log(`[scheduler] ${row.name} → ${results.join('; ')}`);
          }
        } catch (err: any) {
          console.error(`[scheduler] error on job ${row.id}:`, err?.message || err);
        }
      }
    } catch (err: any) {
      console.error('[scheduler] tick error:', err?.message || err);
    }
  }, 60000);
  warmNextRuns();
}

async function warmNextRuns() {
  try {
    const rows: SchedRow[] = await query(
      'SELECT id, task_type, schedule_days, schedule_time, timezone, enabled FROM scheduled_tasks'
    );
    const now = new Date();
    for (const row of rows) {
      if (!row.enabled || !ALLOWED_TYPES.has(row.task_type)) continue;
      const next = nextOccurrence(now, row.schedule_days, row.schedule_time, row.timezone);
      await query('UPDATE scheduled_tasks SET next_run = $1 WHERE id = $2 AND next_run IS NULL', [next.toISOString(), row.id]);
    }
  } catch (err: any) {
    console.error('[scheduler] warm next_run error:', err?.message || err);
  }
}
