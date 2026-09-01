import crypto from 'crypto';
import { dbService } from '../db/database.js';
import { proxmoxFetch } from './proxmoxHttp.js';

// OS changes are intentionally manual: administrators perform them in Proxmox
// and record completion in the approval queue. The former automated execution
// path remains available only for historical state inspection and is disabled.
export const reimageExecutionEnabled = false;

export class ReimageExecutionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ReimageExecutionError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function hashReimagePlan(plan: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(plan))).digest('hex');
}

async function readProxmoxJson(url: string, tokenId: string, tokenSecret: string, fingerprint: string, timeoutMs = 10000): Promise<any> {
  let response: Response;
  try {
    response = await proxmoxFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
      },
      sslFingerprint: fingerprint,
      timeoutMs,
    });
  } catch {
    throw new ReimageExecutionError('PROXMOX_READ_FAILED', 'The read-only Proxmox preflight request failed.');
  }
  const payload = await response.json().catch(() => null) as { data?: unknown } | null;
  if (!response.ok) throw new ReimageExecutionError('PROXMOX_READ_FAILED', `Proxmox preflight returned HTTP ${response.status}.`);
  return payload?.data ?? null;
}

function safeDiskReferences(config: Record<string, unknown>): string[] {
  return Object.entries(config)
    .filter(([key, value]) => /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/.test(key) && typeof value === 'string')
    .map(([key, value]) => `${key}=${String(value).slice(0, 240)}`)
    .sort();
}

export class ReimageExecutionService {
  isEnabled() {
    return reimageExecutionEnabled;
  }

  async listApprovedRequests() {
    return dbService.getReimageRequests({ status: 'approved' });
  }

  async listExecutions(operatorEmail: string, state?: string) {
    return dbService.getReimageExecutions({ operatorEmail, state });
  }

  async createExecution(_requestId: string, _operatorEmail: string) {
    throw new ReimageExecutionError('MANUAL_WORKFLOW_ONLY', 'OS reimage is manual in this deployment. Perform the approved change in Proxmox, then mark the request completed in the administrator queue.');
  }

  async preflight(executionId: string, operatorEmail: string) {
    const execution = await dbService.getReimageExecution(executionId);
    if (!execution) throw new ReimageExecutionError('EXECUTION_NOT_FOUND', 'Execution record not found.');
    if (execution.operatorEmail && execution.operatorEmail.toLowerCase() !== operatorEmail.toLowerCase()) {
      throw new ReimageExecutionError('OPERATOR_MISMATCH', 'This execution is assigned to another operator.');
    }
    if (!['created', 'preflight_passed'].includes(execution.state)) {
      throw new ReimageExecutionError('INVALID_EXECUTION_STATE', `Preflight is not available from state '${execution.state}'.`);
    }
    if (execution.requestStatus !== 'approved') {
      throw new ReimageExecutionError('APPROVAL_NOT_ACTIVE', 'The linked request is no longer approved.');
    }

    const vm = await dbService.getVMByVMID(execution.vmid);
    if (!vm) throw new ReimageExecutionError('VM_NOT_FOUND', 'The target VM no longer exists in the local allocation database.');
    if (vm.isSuspended) throw new ReimageExecutionError('VM_SUSPENDED', 'The target VM is suspended.');
    if (vm.type !== execution.vmType || vm.ownerEmail.toLowerCase() !== String(execution.ownerEmail || '').toLowerCase()) {
      throw new ReimageExecutionError('VM_IDENTITY_CHANGED', 'The VM identity no longer matches the approved execution plan.');
    }

    if (!execution.backupReference) {
      throw new ReimageExecutionError('BACKUP_REQUIRED', 'A verified backup reference is required before preflight.');
    }

    const connections = await dbService.getProxmoxConnectionCredentials();
    const connection = vm.proxmoxConnectionId
      ? connections.find(candidate => String(candidate.id) === String(vm.proxmoxConnectionId))
      : null;
    if (!connection) {
      throw new ReimageExecutionError('PROXMOX_CONNECTION_REQUIRED', 'The target VM is not associated with an available Proxmox connection.');
    }
    if (!connection.ssl_fingerprint) {
      throw new ReimageExecutionError('PROXMOX_FINGERPRINT_REQUIRED', 'A pinned Proxmox SHA-256 fingerprint is required before preflight.');
    }

    const host = String(connection.host_ip || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const port = Number(connection.port) || 8006;
    const base = `https://${host}:${port}/api2/json/nodes/${encodeURIComponent(vm.node)}/${vm.type}/${vm.vmid}`;
    const status = await readProxmoxJson(`${base}/status/current`, connection.token_id, connection.token_secret || '', connection.ssl_fingerprint);
    const config = await readProxmoxJson(`${base}/config`, connection.token_id, connection.token_secret || '', connection.ssl_fingerprint) as Record<string, unknown>;
    const safeConfig = {
      node: vm.node,
      vmid: vm.vmid,
      type: vm.type,
      status: typeof status?.status === 'string' ? status.status : 'unknown',
      lock: typeof config?.lock === 'string' ? config.lock : null,
      protection: config?.protection === 1 || config?.protection === true,
      diskReferences: safeDiskReferences(config || {}),
    };

    const preflightSnapshot = {
      checkedAt: new Date().toISOString(),
      fingerprintVerified: true,
      vm: safeConfig,
      planHashBeforePreflight: execution.planHash,
      checks: {
        vmExists: true,
        ownerUnchanged: true,
        typeUnchanged: true,
        suspended: false,
        pveLockClear: !safeConfig.lock,
        protectedVm: safeConfig.protection,
        backupReferencePresent: Boolean(execution.backupReference),
        executionEnabled: reimageExecutionEnabled,
      },
    };

    if (safeConfig.lock) throw new ReimageExecutionError('PVE_TASK_ACTIVE', 'The VM has an active Proxmox lock and cannot be prepared safely.');
    if (safeConfig.protection) throw new ReimageExecutionError('VM_PROTECTION_ENABLED', 'The VM is protected from disk-destructive operations.');
    const passedPlan = {
      requestId: execution.requestId,
      vmid: execution.vmid,
      vmType: execution.vmType,
      ownerEmail: execution.ownerEmail,
      requestedOs: execution.requestedOs,
      imageProfileId: execution.imageProfileId,
      imageProfileVersion: execution.imageProfileVersion,
      backupReference: execution.backupReference,
      currentVm: safeConfig,
    };
    const planHash = hashReimagePlan(passedPlan);
    const updated = await dbService.markReimagePreflightPassed(executionId, operatorEmail, { ...preflightSnapshot, backupReference: execution.backupReference }, planHash);
    if (!updated) throw new ReimageExecutionError('PREFLIGHT_STATE_RACE', 'The execution changed while preflight was running.');
    return { execution: updated, planHash, preflight: preflightSnapshot, executionEnabled: reimageExecutionEnabled };
  }

  async confirm(executionId: string, operatorEmail: string, input: { planHash: string; confirmationPhrase: string; expectedVmid: number; expectedImageProfileVersion: string }) {
    const execution = await dbService.getReimageExecution(executionId);
    if (!execution) throw new ReimageExecutionError('EXECUTION_NOT_FOUND', 'Execution record not found.');
    if (execution.operatorEmail?.toLowerCase() !== operatorEmail.toLowerCase()) throw new ReimageExecutionError('OPERATOR_MISMATCH', 'This execution is assigned to another operator.');
    if (execution.state !== 'awaiting_confirmation') throw new ReimageExecutionError('PREFLIGHT_REQUIRED', 'A successful preflight is required before confirmation.');
    if (execution.planHash !== input.planHash || execution.vmid !== Number(input.expectedVmid) || execution.imageProfileVersion !== input.expectedImageProfileVersion) {
      throw new ReimageExecutionError('PLAN_CHANGED', 'The execution plan changed. Run preflight again before confirming.');
    }
    if (input.confirmationPhrase !== `EXECUTE VM-${execution.vmid} REIMAGE`) {
      throw new ReimageExecutionError('CONFIRMATION_PHRASE_INVALID', 'The confirmation phrase does not match the displayed VMID.');
    }

    if (!reimageExecutionEnabled) {
      const blocked = await dbService.blockReimageExecution(executionId, operatorEmail, 'EXECUTION_DISABLED', 'Execution is disabled by environment policy. No Proxmox mutation was attempted.');
      return { execution: blocked, executionEnabled: false, message: 'Execution disabled by environment policy. No Proxmox mutation was attempted.' };
    }

    const queued = await dbService.queueReimageExecution(executionId, operatorEmail, input.planHash);
    if (!queued) throw new ReimageExecutionError('CONFIRMATION_STATE_RACE', 'The execution could not be queued because its state or plan hash changed.');
    return { execution: queued, executionEnabled: true, message: 'Execution queued for the dedicated worker.' };
  }

  async getStatus(executionId: string, operatorEmail: string) {
    const execution = await dbService.getReimageExecution(executionId);
    if (!execution) throw new ReimageExecutionError('EXECUTION_NOT_FOUND', 'Execution record not found.');
    if (execution.operatorEmail && execution.operatorEmail.toLowerCase() !== operatorEmail.toLowerCase()) throw new ReimageExecutionError('OPERATOR_MISMATCH', 'This execution is assigned to another operator.');
    return { execution, executionEnabled: reimageExecutionEnabled };
  }

  async cancel(executionId: string, operatorEmail: string) {
    const execution = await dbService.getReimageExecution(executionId);
    if (!execution) throw new ReimageExecutionError('EXECUTION_NOT_FOUND', 'Execution record not found.');
    if (execution.operatorEmail?.toLowerCase() !== operatorEmail.toLowerCase()) throw new ReimageExecutionError('OPERATOR_MISMATCH', 'This execution is assigned to another operator.');
    if (!['created', 'preflight_passed', 'awaiting_confirmation', 'queued'].includes(execution.state)) throw new ReimageExecutionError('CANNOT_CANCEL', 'This execution cannot be cancelled after processing begins.');
    const cancelled = await dbService.cancelReimageExecution(executionId, operatorEmail);
    return { execution: cancelled, message: 'Execution cancelled. No Proxmox mutation was attempted.' };
  }
}

export const reimageExecutionService = new ReimageExecutionService();
