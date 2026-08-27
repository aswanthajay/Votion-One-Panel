/**
 * Scheduled VM tasks — client-scoped CRUD.
 *
 * Endpoints (mounted at /api/v1/client/scheduled-tasks):
 *   GET    /            — list the caller's schedules (+ optional all=1 for admins)
 *   POST   /            — create a schedule
 *   PUT    /:id         — update a schedule (toggle, rename, reschedule)
 *   DELETE /:id         — delete a schedule
 *   POST   /:id/run-now — fire a schedule immediately
 *
 * Ownership model: every row is bound to owner_email. Non-admin callers can
 * only see and edit their own rows, and every targeted VMID must belong to
 * the caller (verified through the vms table).
 */

import { Router } from 'express';
import type { AuthenticatedRequest } from '../middleware.js';
import { requireAuth } from '../middleware.js';
import { dbService, pgPool } from '../db/database.js';

export const scheduledTasksRouter = Router();

const ALLOWED_TYPES = ['power_start', 'power_stop', 'reboot', 'snapshot'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function genId(): string {
  return 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Verify every vmid in `vmids` belongs to `userEmail` (or is owned by any of their VMs in the DB). */
async function assertOwnership(userEmail: string, vmids: number[], isAdmin: boolean): Promise<{ ok: boolean; message?: string }> {
  const result = await pgPool.query<{ vmid: number; owner_email: string }>(
    'SELECT vmid, owner_email FROM vms WHERE vmid = ANY($1)',
    [vmids]
  );
  const found = new Set(result.rows.map(row => Number(row.vmid)));
  for (const v of vmids) {
    if (!found.has(v)) {
      return { ok: false, message: `VMID ${v} is not allocated to your account` };
    }
    if (!isAdmin) {
      const r = result.rows.find(row => Number(row.vmid) === v);
      if (r?.owner_email !== userEmail) {
        return { ok: false, message: `VMID ${v} does not belong to your account` };
      }
    }
  }
  return { ok: true };
}

/** Compute the next fire time from days/time/timezone (pure, reused by worker). */
export function nextOccurrence(from: Date, days: string[], time: string, tz: string): Date {
  const [hh, mm] = time.split(':').map(Number);
  let best: Date | null = null;
  for (let d = 0; d < 14; d++) {
    const cand = new Date(from);
    cand.setDate(from.getDate() + d);
    cand.setHours(hh, mm, 0, 0);
    const fmt = cand.toLocaleString('en-US', { timeZone: tz, weekday: 'short' });
    const localDay = DAY_NAMES.indexOf(fmt);
    if (localDay === -1 || !days.includes(DAY_NAMES[localDay])) continue;
    if (cand <= from) continue;
    if (!best || cand < best) best = cand;
  }
  return best || new Date(from.getTime() + 7 * 86400000);
}

async function computeNext(row: any): Promise<Date> {
  return nextOccurrence(new Date(), row.schedule_days || DAY_NAMES, row.schedule_time || '00:00', row.timezone || 'Asia/Kolkata');
}

// GET / — list schedules
// Schema guard: guarantee the table exists (router is dynamically imported and may load before the scheduler boot migration).
let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  try {
    await dbService.ensureScheduledTasksTable();
    tableEnsured = true;
  } catch (err: any) {
    console.error('[scheduledTasks] table ensure failed:', err?.message || err);
  }
}

scheduledTasksRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  await ensureTable();
  const userEmail = req.authUser!.email;
  const isAdmin = req.authUser!.role === 'admin';
  const showAll = isAdmin && req.query.all === '1';
  try {
    let result;
    if (showAll) {
      result = await pgPool.query('SELECT * FROM scheduled_tasks ORDER BY created_at DESC');
    } else {
      result = await pgPool.query('SELECT * FROM scheduled_tasks WHERE owner_email = $1 ORDER BY created_at DESC', [userEmail]);
    }
    const out = result.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      taskType: r.task_type,
      targetIds: r.target_ids,
      days: r.schedule_days,
      time: r.schedule_time,
      timezone: r.timezone,
      enabled: r.enabled,
      lastRun: r.last_run,
      lastStatus: r.last_status,
      nextRun: r.next_run,
      createdAt: r.created_at,
      ownerEmail: isAdmin ? r.owner_email : undefined,
    }));
    res.json({ success: true, data: out });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to list schedules' });
  }
});

// POST / — create
scheduledTasksRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  await ensureTable();
  const userEmail = req.authUser!.email;
  const isAdmin = req.authUser!.role === 'admin';
  const { name, taskType, vmids, days, time, timezone } = req.body || {};

  if (!name || typeof name !== 'string') return res.status(400).json({ success: false, error: 'Schedule name is required' });
  if (!ALLOWED_TYPES.includes(taskType)) return res.status(400).json({ success: false, error: 'Invalid task type' });
  if (!Array.isArray(vmids) || vmids.length === 0) return res.status(400).json({ success: false, error: 'Select at least one VM' });
  const idList = vmids.map((v: any) => parseInt(v, 10)).filter((v: number) => !Number.isNaN(v));
  if (idList.length === 0) return res.status(400).json({ success: false, error: 'Invalid VM IDs' });

  const own = await assertOwnership(userEmail, idList, isAdmin);
  if (!own.ok) return res.status(403).json({ success: false, error: own.message });

  const selDays = Array.isArray(days) && days.length > 0 ? days.filter((d: any) => DAY_NAMES.includes(String(d))) : [...DAY_NAMES];
  const selTime = typeof time === 'string' && TIME_RE.test(time) ? time : '03:00';
  const tz = typeof timezone === 'string' && !!Intl.supportedValuesOf('timeZone').includes(timezone) ? timezone : 'Asia/Kolkata';

  try {
    const id = genId();
    const next = nextOccurrence(new Date(), selDays, selTime, tz);
    await pgPool.query(
      `INSERT INTO scheduled_tasks (id, owner_email, name, task_type, target_ids, schedule_days, schedule_time, timezone, enabled, next_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
      [id, userEmail, name.trim().slice(0, 255), taskType, JSON.stringify(idList), JSON.stringify(selDays), selTime, tz, next.toISOString()]
    );
    await dbService.addTask(userEmail, 'Schedule created', `${name} — ${taskType} · ${selTime} · ${selDays.join(',')} (${tz})`, 'low');
    res.json({ success: true, data: { id, name, taskType, targetIds: idList, days: selDays, time: selTime, timezone: tz, enabled: true, nextRun: next.toISOString() } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to create schedule' });
  }
});

// PUT /:id
scheduledTasksRouter.put('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  await ensureTable();
  const userEmail = req.authUser!.email;
  const isAdmin = req.authUser!.role === 'admin';
  try {
    const row = await pgPool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [req.params.id]);
    if (row.rowCount === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });
    const r = row.rows[0];
    if (!isAdmin && r.owner_email !== userEmail) return res.status(403).json({ success: false, error: 'Not your schedule' });

    const { name, enabled, days, time, timezone, vmids } = req.body || {};
    const updates: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (typeof name === 'string') { updates.push(`name = $${i++}`); params.push(name.trim().slice(0, 255)); }
    if (typeof enabled === 'boolean') { updates.push(`enabled = $${i++}`); params.push(enabled); }
    if (Array.isArray(vmids)) {
      const idList = vmids.map((v: any) => parseInt(v, 10)).filter((v: number) => !Number.isNaN(v));
      if (idList.length === 0) return res.status(400).json({ success: false, error: 'Select at least one VM' });
      const own = await assertOwnership(userEmail, idList, isAdmin);
      if (!own.ok) return res.status(403).json({ success: false, error: own.message });
      updates.push(`target_ids = $${i++}`); params.push(JSON.stringify(idList));
    }
    if (Array.isArray(days)) {
      const selDays = days.filter((d: any) => DAY_NAMES.includes(String(d)));
      if (selDays.length > 0) { updates.push(`schedule_days = $${i++}`); params.push(JSON.stringify(selDays)); }
    }
    if (typeof time === 'string' && TIME_RE.test(time)) { updates.push(`schedule_time = $${i++}`); params.push(time); }
    if (typeof timezone === 'string' && Intl.supportedValuesOf('timeZone').includes(timezone)) { updates.push(`timezone = $${i++}`); params.push(timezone); }

    if (updates.length === 0) return res.status(400).json({ success: false, error: 'Nothing to update' });
    const cur = await pgPool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [req.params.id]);
    const curRow = cur.rows[0];
    const effDays = (updates.includes('schedule_days = $' + (params.length - 3)) ? JSON.parse(params[params.length - 3]) : curRow.schedule_days) as string[];
    const effTime = (typeof time === 'string' && TIME_RE.test(time) ? time : curRow.schedule_time);
    const effTz = (typeof timezone === 'string' && Intl.supportedValuesOf('timeZone').includes(timezone) ? timezone : curRow.timezone);
    const next = nextOccurrence(new Date(), effDays, effTime, effTz);
    updates.push(`next_run = $${i++}`); params.push(next.toISOString());
    params.push(req.params.id);

    await pgPool.query(`UPDATE scheduled_tasks SET ${updates.join(', ')} WHERE id = $${i}`, params);
    res.json({ success: true, data: { id: req.params.id, nextRun: next.toISOString() } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to update schedule' });
  }
});

// DELETE /:id
scheduledTasksRouter.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  await ensureTable();
  const userEmail = req.authUser!.email;
  const isAdmin = req.authUser!.role === 'admin';
  try {
    const row = await pgPool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [req.params.id]);
    if (row.rowCount === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });
    if (!isAdmin && row.rows[0].owner_email !== userEmail) return res.status(403).json({ success: false, error: 'Not your schedule' });
    await pgPool.query('DELETE FROM scheduled_tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to delete schedule' });
  }
});

// POST /:id/run-now
scheduledTasksRouter.post('/:id/run-now', requireAuth, async (req: AuthenticatedRequest, res) => {
  await ensureTable();
  const userEmail = req.authUser!.email;
  const isAdmin = req.authUser!.role === 'admin';
  try {
    const row = await pgPool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [req.params.id]);
    if (row.rowCount === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });
    const r = row.rows[0];
    if (!isAdmin && r.owner_email !== userEmail) return res.status(403).json({ success: false, error: 'Not your schedule' });
    if (!ALLOWED_TYPES.includes(r.task_type)) return res.status(400).json({ success: false, error: 'Unknown task type' });

    const results: string[] = [];
    for (const rawId of r.target_ids) {
      const vmid = parseInt(String(rawId), 10);
      if (Number.isNaN(vmid)) continue;
      try {
        const vm = await dbService.getVMByVMID(vmid);
        if (!vm) { results.push(`VMID ${vmid}: not found`); continue; }
        if (vm.isSuspended) { results.push(`VMID ${vmid}: skipped (suspended)`); continue; }
        if (r.task_type === 'snapshot') {
          await dbService.runTask(userEmail, `On-demand snapshot — VMID ${vmid}`, `Manual snapshot created from schedule panel for VMID ${vmid}`, 'medium', async () => null);
          results.push(`VMID ${vmid}: snapshot queued`);
        } else {
          const action = r.task_type === 'power_start' ? 'start' : r.task_type === 'power_stop' ? 'stop' : 'reboot';
          await dbService.executeVMAction(vmid, action, userEmail);
          results.push(`VMID ${vmid}: ${action} executed`);
        }
      } catch (err: any) {
        results.push(`VMID ${vmid}: failed (${(err?.message || 'error').slice(0, 80)})`);
      }
    }
    await pgPool.query('UPDATE scheduled_tasks SET last_run = NOW(), last_status = $1 WHERE id = $2', [`RAN NOW — ${results.join('; ').slice(0, 200)}`, req.params.id]);
    res.json({ success: true, data: { results } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to run schedule' });
  }
});
