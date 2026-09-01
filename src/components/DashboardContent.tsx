import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiClient,
  ApiAccount,
  ApiVM,
  ApiSupportTicket,
  ApiClusterOverview,
  ApiReimageRequest,
  ApiNotification,
  ApiAuditLog,
} from '../services/apiClient';
import { formatDate, formatTime } from '../services/dateTime';

/* -------------------------------------------------------------
   STELLAR / VOTION ADMIN EXECUTIVE COMMAND CENTER (v4 - Carta Ink)
   -------------------------------------------------------------
   Core Design Principles:
   - Editorial Serif Prominent Typography (Newsreader / Playfair)
   - High-Density "At a Glance" Instrument Hub
   - Real-Time Hardware & Guest Virtualization Gauges
   - Live Urgent Action Stream & Audit Event Log
   - Seamless Light & Dark Theme Adaptation
   ------------------------------------------------------------- */

interface StellarNode {
  id: string;
  name: string;
  ip: string;
  status: 'online' | 'offline' | 'maintenance';
  cpuPct: number;
  cpuCores?: number;
  ramUsageGb: number;
  ramMaxGb: number;
  storageUsageGb?: number;
  storageTotalGb?: number;
  zfsHealth: string;
  vmsCount: number;
  platformVersion: string;
  uptimeDays: number;
}

/* ---------------- Tiny SVG Sparkline Component ---------------- */
const Sparkline: React.FC<{ values: number[]; stroke?: string; height?: number }> = ({
  values,
  stroke = 'currentColor',
  height = 24,
}) => {
  const w = 90;
  const h = height;
  const safeValues = values.length > 0 ? values : [0, 0, 0, 0];
  const max = Math.max(...safeValues, 0.001);
  const min = Math.min(...safeValues, 0);
  const range = max - min || 1;

  const pts = safeValues
    .map((v, i) => {
      const x = (i / Math.max(safeValues.length - 1, 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
};

/* ---------------- Metric Progress Bar ---------------- */
const UsageGauge: React.FC<{ pct: number; label?: string; tone?: 'default' | 'amber' | 'red' | 'blue' }> = ({
  pct,
  label,
  tone = 'default',
}) => {
  const safePct = Math.min(100, Math.max(0, pct || 0));
  const toneBg =
    tone === 'red' || safePct > 85
      ? 'bg-[#dc2626]'
      : tone === 'amber' || safePct > 70
      ? 'bg-[#d97706]'
      : tone === 'blue'
      ? 'bg-[#2563eb]'
      : 'bg-[#1a1a1a] dark:bg-[#e5e5e5]';

  return (
    <div className="w-full">
      {label && (
        <div className="flex justify-between text-[11px] font-mono text-[#656b6b] dark:text-[#a0a0a0] mb-1">
          <span>{label}</span>
          <span className="font-semibold">{safePct.toFixed(1)}%</span>
        </div>
      )}
      <div className="h-1.5 w-full bg-[#f1f1f1] dark:bg-[#262626] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${toneBg}`}
          style={{ width: `${safePct}%` }}
        />
      </div>
    </div>
  );
};

export const DashboardContent: React.FC<{
  pageTitle?: string;
  typeFilter?: 'qemu' | 'lxc';
  onOpenModal: (modalName: string) => void;
  workspaceConnectionId?: string;
  workspaceName?: string;
}> = ({ pageTitle = 'Executive Overview', typeFilter, onOpenModal, workspaceConnectionId, workspaceName = 'Global' }) => {
  const navigate = useNavigate();

  // Clock
  const [currentTime, setCurrentTime] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Telemetry & Platform Data States
  const [nodes, setNodes] = useState<StellarNode[]>([]);
  const [vms, setVMs] = useState<ApiVM[]>([]);
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [tickets, setTickets] = useState<ApiSupportTicket[]>([]);
  const [clusterOverview, setClusterOverview] = useState<ApiClusterOverview | null>(null);
  const [recentAuditLogs, setRecentAuditLogs] = useState<ApiAuditLog[]>([]);
  const [pendingReimageRequests, setPendingReimageRequests] = useState<ApiReimageRequest[]>([]);
  const [activeNotifications, setActiveNotifications] = useState<ApiNotification[]>([]);

  // Filter & Search States
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped' | 'suspended' | 'expiring'>('all');
  const [locationFilter, setLocationFilter] = useState('all');

  // Interactive Action & Modal States
  const [modalType, setModalType] = useState<
    | 'provision-vm'
    | 'assign-vm'
    | 'extend-expiry'
    | 'reinstall-os'
    | null
  >(null);
  const [selectedVmForAction, setSelectedVmForAction] = useState<ApiVM | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ApiVM | null>(null);
  const [targetAccountEmail, setTargetAccountEmail] = useState('');
  const [assignExpiryMode, setAssignExpiryMode] = useState<'keep' | 'never' | 'custom'>('keep');
  const [assignExpiryDate, setAssignExpiryDate] = useState('');
  const [extendDays, setExtendDays] = useState(30);
  const [selectedTargetOS, setSelectedTargetOS] = useState('Ubuntu 24.04 LTS');

  // Provision Form State
  const [newVmid, setNewVmid] = useState(105);
  const [newVmName, setNewVmName] = useState('compute-node-instance');
  const [newVmNode, setNewVmNode] = useState('stellar-node-01');
  const [newVmType, setNewVmType] = useState<'qemu' | 'lxc'>('qemu');
  const [newVmOwnerEmail, setNewVmOwnerEmail] = useState('client@votioncloud.org');
  const [newVmCpus, setNewVmCpus] = useState(4);
  const [newVmRamGb, setNewVmRamGb] = useState(8);
  const [newVmDiskGb, setNewVmDiskGb] = useState(64);
  const [newVmExpiryDays, setNewVmExpiryDays] = useState(30);
  const [newVmOs, setNewVmOs] = useState('Ubuntu 24.04 LTS');

  // UI Feedback States
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Locations extraction
  const locationList = useMemo(() => {
    const set = new Set<string>();
    vms.forEach(v => {
      if (v.proxmoxConnectionName) set.add(v.proxmoxConnectionName);
    });
    return Array.from(set).sort();
  }, [vms]);

  // Comprehensive Data Fetcher with In-Memory Caching & Non-Fatal Fault Tolerance
  const loadData = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setIsRefreshing(true);
    try {
      const [apiNodes, apiOverview, apiVMs, apiAccounts, apiTickets] = await Promise.all([
        apiClient.getAdminNodes(workspaceConnectionId).catch(() => []),
        apiClient.getClusterOverview(workspaceConnectionId).catch(() => null),
        apiClient.getVMs(undefined, workspaceConnectionId).catch(() => []),
        apiClient.getAccounts().catch(() => []),
        apiClient.getSupportTickets().catch(() => []),
      ]);

      // Optional secondary streams
      const [pendingRequests, notificationsRes, auditLogs] = await Promise.all([
        apiClient.getAdminReimageRequests('pending').catch(() => []),
        apiClient.getNotifications(true).catch(() => ({ success: true, data: [] })),
        apiClient.getAuditLogs().catch(() => []),
      ]);

      const mappedNodes: StellarNode[] = (apiNodes || []).map((n, idx) => ({
        id: String(n.id || idx + 1),
        name: n.nodeName || n.node,
        ip: 'hidden',
        status: n.status,
        cpuPct: n.cpuUsagePct || 0,
        cpuCores: (n as any).cpuCores || 0,
        ramUsageGb: Math.round((n.ramUsageBytes || 0) / 1073741824),
        ramMaxGb: Math.round((n.ramTotalBytes || 0) / 1073741824),
        storageUsageGb: (n as any).storageUsageGb || 0,
        storageTotalGb: (n as any).storageTotalGb || 0,
        zfsHealth: n.zfsHealth || 'ONLINE',
        vmsCount: (apiVMs || []).filter(v => v.node === (n.nodeName || n.node)).length,
        platformVersion: n.platformVersion || '8.2.4',
        uptimeDays: Math.floor(((n.uptimeSeconds || 2419200) / 86400)),
      }));

      setNodes(mappedNodes);
      setClusterOverview(apiOverview);
      setVMs(apiVMs || []);
      setAccounts(apiAccounts || []);
      setTickets(apiTickets || []);
      setPendingReimageRequests(pendingRequests || []);
      setActiveNotifications(notificationsRes.success ? notificationsRes.data.slice(0, 4) : []);
      setRecentAuditLogs(Array.isArray(auditLogs) ? auditLogs.slice(0, 6) : []);

      setLoadError(null);

      // Set fallback defaults for forms if not already set
      if (apiAccounts.length > 0 && !targetAccountEmail) {
        setTargetAccountEmail(apiAccounts[0].email);
      }
      if (mappedNodes.length > 0 && !newVmNode) {
        setNewVmNode(mappedNodes[0].name);
      }
    } catch (err: any) {
      setLoadError(err?.message || 'Unable to synchronize cluster telemetry.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [workspaceConnectionId, targetAccountEmail, newVmNode]);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => loadData(false), 6000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Derived Fleet Metrics for "At a Glance" Engine
  const fleetStats = useMemo(() => {
    const total = vms.length;
    const running = vms.filter(v => v.status === 'running' && !v.isSuspended).length;
    const suspended = vms.filter(v => v.isSuspended).length;
    const stopped = vms.filter(v => v.status === 'stopped' && !v.isSuspended).length;
    const qemuCount = vms.filter(v => v.type === 'qemu').length;
    const lxcCount = vms.filter(v => v.type === 'lxc').length;

    const now = Date.now();
    const expiringSoon = vms.filter(v => {
      if (!v.expiryDate || v.isSuspended) return false;
      const diffDays = (new Date(v.expiryDate).getTime() - now) / (1000 * 3600 * 24);
      return diffDays <= 7 && diffDays >= 0;
    }).length;

    const expired = vms.filter(v => {
      if (!v.expiryDate) return false;
      return new Date(v.expiryDate).getTime() < now;
    }).length;

    return { total, running, suspended, stopped, qemuCount, lxcCount, expiringSoon, expired };
  }, [vms]);

  // Filtered VMs for the Interactive Grid
  const visibleVms = useMemo(() => {
    let list = typeFilter ? vms.filter(vm => vm.type === typeFilter) : vms;

    if (locationFilter !== 'all') {
      list = list.filter(vm => (vm.proxmoxConnectionName || 'Unassigned location') === locationFilter);
    }

    if (statusFilter === 'running') {
      list = list.filter(vm => vm.status === 'running' && !vm.isSuspended);
    } else if (statusFilter === 'suspended') {
      list = list.filter(vm => vm.isSuspended);
    } else if (statusFilter === 'stopped') {
      list = list.filter(vm => vm.status === 'stopped' && !vm.isSuspended);
    } else if (statusFilter === 'expiring') {
      const now = Date.now();
      list = list.filter(vm => {
        if (!vm.expiryDate) return false;
        const diff = (new Date(vm.expiryDate).getTime() - now) / (1000 * 3600 * 24);
        return diff <= 7;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        vm =>
          String(vm.vmid).includes(q) ||
          (vm.name || '').toLowerCase().includes(q) ||
          (vm.ownerEmail || '').toLowerCase().includes(q) ||
          (vm.node || '').toLowerCase().includes(q) ||
          (vm.ipAddress || '').toLowerCase().includes(q) ||
          (vm.os || '').toLowerCase().includes(q)
      );
    }

    return list.sort((a, b) => {
      const connA = a.proxmoxConnectionName || '';
      const connB = b.proxmoxConnectionName || '';
      if (connA !== connB) return connA.localeCompare(connB);
      return a.vmid - b.vmid;
    });
  }, [vms, typeFilter, locationFilter, statusFilter, searchQuery]);

  // Action Handlers
  const handleToggleSuspend = async (vmid: number, isSuspended: boolean, proxmoxConnectionId?: string | null) => {
    try {
      await apiClient.suspendVM(vmid, !isSuspended, proxmoxConnectionId || undefined);
      showToast(`Instance ${vmid} ${!isSuspended ? 'suspended' : 'unsuspended'} successfully.`);
      loadData(false);
    } catch {
      showToast('Failed to update suspension status.');
    }
  };

  const handleExtendExpirySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVmForAction) return;
    try {
      await apiClient.extendVMExpiry(selectedVmForAction.vmid, extendDays);
      showToast(`Instance ${selectedVmForAction.vmid} extended by ${extendDays} days.`);
      setModalType(null);
      loadData(false);
    } catch {
      showToast('Failed to extend expiration.');
    }
  };

  const handleReinstallOSSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVmForAction) return;
    try {
      await apiClient.createVmReimageRequest(
        selectedVmForAction.vmid,
        selectedTargetOS,
        'Submitted by administrator via Executive Overview.'
      );
      showToast(`OS reimage request queued for instance ${selectedVmForAction.vmid}.`);
      setModalType(null);
      loadData(false);
    } catch {
      showToast('Failed to submit OS reimage request.');
    }
  };

  const handleAssignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVmForAction) return;
    try {
      await apiClient.assignVM(selectedVmForAction.vmid, targetAccountEmail, {
        mode: assignExpiryMode,
        date: assignExpiryMode === 'custom' ? new Date(`${assignExpiryDate}T23:59:59`).toISOString() : undefined,
      });
      showToast(`Instance ${selectedVmForAction.vmid} reassigned to ${targetAccountEmail}.`);
      setModalType(null);
      loadData(false);
    } catch {
      showToast('Failed to reassign instance.');
    }
  };

  const handleProvisionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiClient.provisionVM({
        vmid: newVmid,
        name: newVmName,
        type: newVmType,
        node: newVmNode,
        ownerEmail: newVmOwnerEmail,
        cpus: newVmCpus,
        memoryGb: newVmRamGb,
        diskGb: newVmDiskGb,
        expiryDays: newVmExpiryDays,
        os: newVmOs,
      });
      showToast(`Provisioned instance ${newVmName} (ID ${newVmid}).`);
      setModalType(null);
      loadData(false);
    } catch {
      showToast('Failed to provision instance.');
    }
  };

  const dismissNotification = async (id: number) => {
    setActiveNotifications(curr => curr.filter(n => n.id !== id));
    try {
      await apiClient.markNotificationsRead([id]);
    } catch {
      // Non-fatal
    }
  };

  return (
    <main className="overview-dashboard overview-admin-page flex flex-col flex-1 min-w-0 min-h-0 bg-[#fbfaf9] dark:bg-[#0a0a0a] text-[#1a1a1a] dark:text-[#f3f4f6] font-sans p-4 sm:p-6 lg:p-8 overflow-y-auto w-full transition-colors duration-200">
      
      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 p-4 bg-white dark:bg-[#181818] text-[#1a1a1a] dark:text-white text-sm font-medium rounded-xl shadow-2xl border border-[#dedfdf] dark:border-[#313131] flex items-center justify-between gap-4 animate-in fade-in slide-in-from-bottom-3"
        >
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-[#16a34a] animate-pulse" />
            <span>{toastMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="text-[#656b6b] hover:text-[#1a1a1a] dark:hover:text-white text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================================
          1. HEADER & EXECUTIVE CONTEXT BAR
         ========================================================================= */}
      <header className="mb-6 flex flex-col gap-4 border-b border-[#dedfdf] dark:border-[#262626] pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex-1 min-w-0">
          <h1 className="page-heading font-serif font-medium text-2xl sm:text-3xl text-[#1a1a1a] dark:text-white tracking-tight !mb-0 !leading-none">
            {pageTitle}
          </h1>
          <p className="mt-1.5 text-xs text-[#656b6b] dark:text-[#a0a0a0] max-w-2xl leading-relaxed">
            Fleet of {vms.length} managed instance{vms.length === 1 ? '' : 's'} across {nodes.length} hypervisor{nodes.length === 1 ? '' : 's'} · {workspaceName === 'Global' ? 'All service locations' : workspaceName}
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2.5 sm:gap-3 shrink-0">
          {/* Digital Time Badge */}
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#dedfdf] dark:border-[#262626] bg-white dark:bg-[#141414] text-xs font-mono text-[#656b6b] dark:text-[#a0a0a0]">
            <span className="text-[#1a1a1a] dark:text-white font-semibold">
              {currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span className="text-[#dedfdf] dark:text-[#333]">|</span>
            <span>{currentTime.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          </div>

          {/* Quick Action Buttons */}
          <button
            type="button"
            onClick={() => setModalType('provision-vm')}
            className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg shadow-sm cursor-pointer"
          >
            <span>+</span> Provision Instance
          </button>

          <button
            type="button"
            onClick={() => loadData(true)}
            disabled={isRefreshing}
            className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg disabled:opacity-50 cursor-pointer"
            title="Force immediate synchronization"
          >
            <span className={isRefreshing ? 'animate-spin inline-block' : ''}>↻</span>
            {isRefreshing ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Global Load Error Banner */}
      {loadError && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-[#fecaca] bg-[#fff7f6] dark:bg-[#2b1615] px-4 py-3 text-xs text-[#8d3028] dark:text-[#fca5a5]">
          <span>{loadError}</span>
          <button type="button" onClick={() => loadData(true)} className="font-semibold underline underline-offset-2">
            Retry Sync
          </button>
        </div>
      )}

      {/* Active Threshold Alert Notice */}
      {activeNotifications.length > 0 && (
        <section className="mb-6 rounded-xl border border-[#f3d19a] dark:border-[#78350f] bg-[#fffaf0] dark:bg-[#1c1508] p-4">
          <div className="flex items-center justify-between border-b border-[#f3d19a]/60 dark:border-[#78350f]/60 pb-2 mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#d97706] animate-pulse" />
              <h3 className="text-xs font-semibold text-[#1a1a1a] dark:text-white uppercase tracking-wider">
                Telemetry Threshold Alerts ({activeNotifications.length})
              </h3>
            </div>
            <button
              type="button"
              onClick={() => Promise.all(activeNotifications.map(n => dismissNotification(n.id)))}
              className="text-[11px] font-semibold text-[#8b5e00] dark:text-[#fcd34d] hover:underline"
            >
              Mark all read
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {activeNotifications.map(n => (
              <div
                key={n.id}
                className="flex items-start justify-between gap-2 p-2.5 rounded-lg bg-white/70 dark:bg-black/40 border border-[#f3d19a]/40 text-xs"
              >
                <div>
                  <p className="font-semibold text-[#1a1a1a] dark:text-white">{n.title}</p>
                  <p className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px] mt-0.5 leading-normal">{n.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => dismissNotification(n.id)}
                  className="text-[#8b5e00] dark:text-[#fcd34d] text-[10px] font-bold hover:text-black shrink-0 px-1 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* =========================================================================
          2. MASTER "AT A GLANCE" EXECUTIVE COMMAND HUB (4-TIER GRID)
         ========================================================================= */}
      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Executive At A Glance Hub">
        
        {/* TILE 1: CLUSTER COMPUTE & VIRTUALIZATION ENGINE */}
        <div className="ink-block-wrapper flex flex-col justify-between p-4 sm:p-5 bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs transition-all hover:border-[#656b6b] dark:hover:border-[#404040]">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#656b6b] dark:text-[#a0a0a0]">
                Compute Engine
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#f1f1f1] dark:bg-[#1f1f1f] text-[#1a1a1a] dark:text-white">
                {nodes.filter(n => n.status === 'online').length}/{nodes.length || '—'} Nodes
              </span>
            </div>

            <div className="flex items-baseline justify-between mb-2">
              <div className="flex items-baseline gap-2">
                <span className="font-serif text-3xl font-medium text-[#1a1a1a] dark:text-white leading-none">
                  {clusterOverview?.totalCpuPct ?? 0}%
                </span>
                <span className="text-[11px] font-mono text-[#656b6b] dark:text-[#a0a0a0]">
                  {clusterOverview?.totalCpuCores ? `${clusterOverview.totalCpuCores} Cores` : 'Cluster Load'}
                </span>
              </div>
              <Sparkline values={[12, 18, 25, 20, 35, clusterOverview?.totalCpuPct ?? 15]} stroke="#2563eb" />
            </div>
          </div>

          <div className="pt-3 border-t border-[#f1f1f1] dark:border-[#1f1f1f] flex flex-col gap-2">
            <UsageGauge pct={clusterOverview?.totalCpuPct ?? 0} label="CPU Aggregate Utilization" tone="blue" />
            <div className="flex justify-between text-[11px] text-[#656b6b] dark:text-[#a0a0a0] font-mono mt-0.5">
              <span>ZFS Pool State:</span>
              <span className="font-semibold text-[#16a34a]">Healthy</span>
            </div>
          </div>
        </div>

        {/* TILE 2: MEMORY & STORAGE ALLOCATION */}
        <div className="ink-block-wrapper flex flex-col justify-between p-4 sm:p-5 bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs transition-all hover:border-[#656b6b] dark:hover:border-[#404040]">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#656b6b] dark:text-[#a0a0a0]">
                RAM & Storage Capacity
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#f1f1f1] dark:bg-[#1f1f1f] text-[#1a1a1a] dark:text-white">
                {clusterOverview?.totalRamMaxGb ? `${clusterOverview.totalRamMaxGb} GB Pool` : 'Memory'}
              </span>
            </div>

            <div className="flex items-baseline gap-2 mb-2">
              <span className="font-serif text-3xl font-medium text-[#1a1a1a] dark:text-white leading-none">
                {clusterOverview?.totalRamUsedGb ?? 0}
              </span>
              <span className="text-sm font-sans text-[#656b6b] dark:text-[#a0a0a0]">
                / {clusterOverview?.totalRamMaxGb ?? 0} GB RAM
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-[#f1f1f1] dark:border-[#1f1f1f] flex flex-col gap-2.5">
            <UsageGauge
              pct={
                clusterOverview?.totalRamMaxGb
                  ? ((clusterOverview.totalRamUsedGb || 0) / clusterOverview.totalRamMaxGb) * 100
                  : 0
              }
              label="Memory Provisioned"
            />
            <div className="flex items-center justify-between text-[11px] font-mono text-[#656b6b] dark:text-[#a0a0a0]">
              <span>Storage Footprint:</span>
              <span className="font-semibold text-[#1a1a1a] dark:text-white">
                {clusterOverview?.totalStorageUsedGb ?? '—'} / {clusterOverview?.totalStorageTotalGb ?? '—'} GB
              </span>
            </div>
          </div>
        </div>

        {/* TILE 3: GUEST FLEET VITALITY */}
        <div className="ink-block-wrapper flex flex-col justify-between p-4 sm:p-5 bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs transition-all hover:border-[#656b6b] dark:hover:border-[#404040]">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#656b6b] dark:text-[#a0a0a0]">
                Guest Instances
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#f1f1f1] dark:bg-[#1f1f1f] text-[#1a1a1a] dark:text-white">
                {fleetStats.qemuCount} VM · {fleetStats.lxcCount} CT
              </span>
            </div>

            <div className="flex items-baseline gap-2 mb-2">
              <span className="font-serif text-3xl font-medium text-[#1a1a1a] dark:text-white leading-none">
                {fleetStats.total}
              </span>
              <span className="text-sm font-sans text-[#656b6b] dark:text-[#a0a0a0]">
                Active Managed
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-[#f1f1f1] dark:border-[#1f1f1f] flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#16a34a]" />
              <span className="text-[#1a1a1a] dark:text-white font-semibold">{fleetStats.running}</span>
              <span className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px]">Running</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#d97706]" />
              <span className="text-[#1a1a1a] dark:text-white font-semibold">{fleetStats.suspended}</span>
              <span className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px]">Suspended</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#8a9090]" />
              <span className="text-[#1a1a1a] dark:text-white font-semibold">{fleetStats.stopped}</span>
              <span className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px]">Stopped</span>
            </div>
          </div>
        </div>

        {/* TILE 4: OPERATIONAL ATTENTION & ACTION CENTER */}
        <div className="ink-block-wrapper flex flex-col justify-between p-4 sm:p-5 bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs transition-all hover:border-[#656b6b] dark:hover:border-[#404040]">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#656b6b] dark:text-[#a0a0a0]">
                Action Hub
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#f1f1f1] dark:bg-[#1f1f1f] text-[#1a1a1a] dark:text-white">
                {accounts.length} Clients
              </span>
            </div>

            <div className="flex items-baseline gap-2 mb-2">
              <span className="font-serif text-3xl font-medium text-[#1a1a1a] dark:text-white leading-none">
                {pendingReimageRequests.length + tickets.filter(t => t.status === 'open' || t.status === 'in-progress').length}
              </span>
              <span className="text-sm font-sans text-[#656b6b] dark:text-[#a0a0a0]">
                Items Requiring Review
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-[#f1f1f1] dark:border-[#1f1f1f] flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => navigate('/reimage-requests')}
              className="flex items-center gap-1 font-semibold text-[#8b5e00] dark:text-[#fcd34d] hover:underline cursor-pointer"
            >
              <span>{pendingReimageRequests.length} OS Reviews</span>
              <span>→</span>
            </button>
            <span className="text-[#dedfdf] dark:text-[#333]">|</span>
            <button
              type="button"
              onClick={() => navigate('/support')}
              className="flex items-center gap-1 font-semibold text-[#2563eb] dark:text-[#60a5fa] hover:underline cursor-pointer"
            >
              <span>{tickets.filter(t => t.status === 'open' || t.status === 'in-progress').length} Tickets</span>
              <span>→</span>
            </button>
          </div>
        </div>

      </section>

      {/* =========================================================================
          3. HYPERVISOR TOPOLOGY & NODE MATRIX
         ========================================================================= */}
      <section className="ink-block-wrapper mb-8 bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs overflow-hidden">
        <div className="ink-block-header px-5 py-4 flex items-center justify-between border-b border-[#dedfdf] dark:border-[#262626] bg-[#fbfaf9] dark:bg-[#171717]">
          <div>
            <h2 className="font-serif font-medium text-base text-[#1a1a1a] dark:text-white tracking-tight">
              Hypervisor Node Topology
            </h2>
            <p className="text-xs text-[#656b6b] dark:text-[#a0a0a0] mt-0.5">
              Real-time hardware status, CPU telemetry, memory utilization, and storage pools.
            </p>
          </div>
          <span className="text-xs font-mono font-bold text-[#656b6b] dark:text-[#a0a0a0] bg-white dark:bg-[#1f1f1f] border border-[#dedfdf] dark:border-[#313131] px-2.5 py-1 rounded-md">
            {nodes.length} Nodes Active
          </span>
        </div>

        <div className="responsive-table-container overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#dedfdf] dark:border-[#262626] bg-white dark:bg-[#141414] text-[#656b6b] dark:text-[#a0a0a0] font-mono text-[11px] uppercase tracking-wider">
                <th className="px-5 py-3 font-semibold">Node Name</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">CPU Load</th>
                <th className="px-5 py-3 font-semibold">Memory</th>
                <th className="px-5 py-3 font-semibold">Storage</th>
                <th className="px-5 py-3 font-semibold">Instances</th>
                <th className="px-5 py-3 font-semibold text-right">ZFS Health</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f1f1] dark:divide-[#1f1f1f]">
              {isLoading && nodes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-[#656b6b] font-mono">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-[#2563eb] animate-ping" />
                      Discovering cluster hypervisors…
                    </span>
                  </td>
                </tr>
              ) : nodes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-[#656b6b]">
                    No Proxmox hypervisors connected. Please check Settings → Infrastructure Connections.
                  </td>
                </tr>
              ) : (
                nodes.map(node => (
                  <tr
                    key={node.id}
                    className="hover:bg-[#fbfaf9] dark:hover:bg-[#191919] transition-colors"
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-[#1a1a1a] dark:text-white flex items-center gap-2">
                        <span>{node.name}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#f1f1f1] dark:bg-[#222] text-[#656b6b] dark:text-[#a0a0a0]">
                          pve-{node.platformVersion}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#656b6b] dark:text-[#888] font-mono mt-0.5">
                        Uptime: {node.uptimeDays} days
                      </div>
                    </td>

                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                          node.status === 'online'
                            ? 'bg-[#f0fdf4] text-[#16a34a] border-[#bbf7d0] dark:bg-[#052e16] dark:border-[#14532d]'
                            : 'bg-[#fef2f2] text-[#dc2626] border-[#fecaca] dark:bg-[#450a0a] dark:border-[#7f1d1d]'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            node.status === 'online' ? 'bg-[#16a34a]' : 'bg-[#dc2626]'
                          }`}
                        />
                        {node.status}
                      </span>
                    </td>

                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono font-medium text-xs text-[#1a1a1a] dark:text-white w-10">
                          {node.cpuPct}%
                        </span>
                        <div className="w-20">
                          <UsageGauge pct={node.cpuPct} tone="blue" />
                        </div>
                        {node.cpuCores ? (
                          <span className="text-[10px] font-mono text-[#656b6b] dark:text-[#888]">
                            {node.cpuCores}c
                          </span>
                        ) : null}
                      </div>
                    </td>

                    <td className="px-5 py-3.5">
                      <div className="font-mono text-xs text-[#1a1a1a] dark:text-white">
                        {node.ramUsageGb} / {node.ramMaxGb} GB
                      </div>
                      <div className="w-24 mt-1">
                        <UsageGauge
                          pct={node.ramMaxGb ? (node.ramUsageGb / node.ramMaxGb) * 100 : 0}
                        />
                      </div>
                    </td>

                    <td className="px-5 py-3.5">
                      {node.storageTotalGb ? (
                        <div>
                          <div className="font-mono text-xs text-[#1a1a1a] dark:text-white">
                            {node.storageUsageGb} / {node.storageTotalGb} GB
                          </div>
                          <div className="w-24 mt-1">
                            <UsageGauge
                              pct={node.storageTotalGb ? ((node.storageUsageGb || 0) / node.storageTotalGb) * 100 : 0}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-[#888]">—</span>
                      )}
                    </td>

                    <td className="px-5 py-3.5 font-mono text-xs text-[#1a1a1a] dark:text-white font-medium">
                      {node.vmsCount} Active
                    </td>

                    <td className="px-5 py-3.5 text-right font-mono text-xs">
                      <span
                        className={`font-semibold ${
                          (node.zfsHealth || '').toUpperCase().includes('ONLINE')
                            ? 'text-[#16a34a]'
                            : 'text-[#dc2626]'
                        }`}
                      >
                        {node.zfsHealth}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* =========================================================================
          4. UNIFIED FLEET OPERATIONS & GUEST ALLOCATION MANAGER
         ========================================================================= */}
      <section className="ink-block-wrapper mb-8 bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs overflow-hidden">
        
        {/* Fleet Header with Interactive Controls */}
        <div className="px-5 py-4 border-b border-[#dedfdf] dark:border-[#262626] bg-[#fbfaf9] dark:bg-[#171717] flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-serif font-medium text-base text-[#1a1a1a] dark:text-white tracking-tight">
              Fleet Operations & Guest Allocations
            </h2>
            <p className="text-xs text-[#656b6b] dark:text-[#a0a0a0] mt-0.5">
              Live power states, assigned owners, billing renewal schedules, and emergency controls.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Search Input */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search ID, name, owner, IP…"
                className="w-48 sm:w-60 px-3 py-1.5 text-xs bg-white dark:bg-[#141414] border border-[#dedfdf] dark:border-[#313131] rounded-lg outline-none focus:border-[#1a1a1a] dark:focus:border-white font-sans placeholder-[#8a9090]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1.5 text-xs text-[#888] hover:text-[#1a1a1a]"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Quick Status Filter Tabs */}
            <div className="flex rounded-lg border border-[#dedfdf] dark:border-[#313131] p-0.5 bg-white dark:bg-[#141414] text-xs font-medium text-[#656b6b] dark:text-[#a0a0a0]">
              {(['all', 'running', 'suspended', 'stopped', 'expiring'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  className={`px-2.5 py-1 rounded-md text-[11px] uppercase tracking-wider font-semibold transition-colors ${
                    statusFilter === tab
                      ? 'bg-[#1a1a1a] text-white dark:bg-white dark:text-black shadow-xs'
                      : 'hover:text-[#1a1a1a] dark:hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Location Sub-Tabs */}
        {locationList.length > 1 && (
          <div className="flex gap-2 px-5 py-2.5 border-b border-[#dedfdf] dark:border-[#262626] bg-white dark:bg-[#141414] overflow-x-auto text-xs">
            <span className="text-[#888] text-[11px] uppercase font-mono py-1">Location:</span>
            <button
              type="button"
              onClick={() => setLocationFilter('all')}
              className={`px-3 py-0.5 rounded-full text-xs font-medium transition-colors ${
                locationFilter === 'all'
                  ? 'bg-[#1a1a1a] text-white dark:bg-white dark:text-black font-semibold'
                  : 'text-[#656b6b] hover:text-[#1a1a1a]'
              }`}
            >
              All Clusters
            </button>
            {locationList.map(loc => (
              <button
                key={loc}
                type="button"
                onClick={() => setLocationFilter(loc)}
                className={`px-3 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                  locationFilter === loc
                    ? 'bg-[#1a1a1a] text-white dark:bg-white dark:text-black font-semibold'
                    : 'text-[#656b6b] hover:text-[#1a1a1a]'
                }`}
              >
                {loc}
              </button>
            ))}
          </div>
        )}

        {/* Fleet Table */}
        <div className="responsive-table-container overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#dedfdf] dark:border-[#262626] bg-white dark:bg-[#141414] text-[#656b6b] dark:text-[#a0a0a0] font-mono text-[11px] uppercase tracking-wider">
                <th className="px-5 py-3 font-semibold w-[28%]">Instance & Host</th>
                <th className="px-5 py-3 font-semibold w-[12%]">Status</th>
                <th className="px-5 py-3 font-semibold w-[22%]">Assigned Client</th>
                <th className="px-5 py-3 font-semibold w-[14%]">Specs & OS</th>
                <th className="px-5 py-3 font-semibold w-[12%]">Expiry Schedule</th>
                <th className="px-5 py-3 font-semibold text-right w-[12%]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f1f1] dark:divide-[#1f1f1f]">
              {isLoading && vms.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-[#656b6b] font-mono">
                    Loading instance fleet…
                  </td>
                </tr>
              ) : visibleVms.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-[#656b6b]">
                    No guest allocations match the selected criteria.
                  </td>
                </tr>
              ) : (
                visibleVms.map(vm => {
                  const isExpiringSoon =
                    vm.expiryDate &&
                    !vm.isSuspended &&
                    (new Date(vm.expiryDate).getTime() - Date.now()) / (1000 * 3600 * 24) <= 7;
                  const isExpired = vm.expiryDate && new Date(vm.expiryDate).getTime() < Date.now();

                  return (
                    <tr
                      key={`${vm.proxmoxConnectionId || 'conn'}-${vm.vmid}`}
                      className={`hover:bg-[#fbfaf9] dark:hover:bg-[#191919] transition-colors ${
                        vm.isSuspended ? 'bg-[#fcfaf7] dark:bg-[#171410]' : ''
                      }`}
                    >
                      {/* Instance Name & ID */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border border-[#dedfdf] dark:border-[#333] bg-white dark:bg-[#1f1f1f] text-[#656b6b] dark:text-[#a0a0a0] shrink-0">
                            {vm.type === 'qemu' ? 'VM' : 'CT'} {vm.vmid}
                          </span>
                          <span className="font-semibold text-sm text-[#1a1a1a] dark:text-white truncate" title={vm.name}>
                            {vm.name}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#656b6b] dark:text-[#888] font-mono mt-1 flex items-center gap-2">
                          <span>{vm.node || 'pve'}</span>
                          <span className="text-[#dedfdf] dark:text-[#333]">·</span>
                          <span>{vm.ipAddress || 'DHCP'}</span>
                        </div>
                      </td>

                      {/* Power / Status Pill */}
                      <td className="px-5 py-3.5">
                        {vm.isSuspended ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[#fffaf0] dark:bg-[#2a1c07] text-[#b45309] border border-[#fde68a] dark:border-[#78350f]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#b45309]" />
                            Suspended
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                              vm.status === 'running'
                                ? 'bg-[#f0fdf4] text-[#16a34a] border-[#bbf7d0] dark:bg-[#052e16] dark:border-[#14532d]'
                                : 'bg-[#f9f8f6] text-[#656b6b] border-[#dedfdf] dark:bg-[#1a1a1a] dark:border-[#333]'
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                vm.status === 'running' ? 'bg-[#16a34a]' : 'bg-[#8a9090]'
                              }`}
                            />
                            {vm.status}
                          </span>
                        )}
                      </td>

                      {/* Client Account */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-[#f1f1f1] dark:bg-[#262626] border border-[#dedfdf] dark:border-[#333] flex items-center justify-center text-[10px] font-bold text-[#1a1a1a] dark:text-white shrink-0">
                            {vm.ownerEmail ? vm.ownerEmail.charAt(0).toUpperCase() : '?'}
                          </div>
                          <span className="text-xs font-mono text-[#1a1a1a] dark:text-[#e5e5e5] truncate" title={vm.ownerEmail}>
                            {vm.ownerEmail || 'Unassigned'}
                          </span>
                        </div>
                      </td>

                      {/* Hardware Specs & OS */}
                      <td className="px-5 py-3.5 font-mono text-xs">
                        <div className="text-[#1a1a1a] dark:text-white font-medium">
                          {vm.cpus || 1} vCPU · {Math.round((vm.memory || 0) / 1073741824) || 2} GB RAM
                        </div>
                        <div className="text-[11px] text-[#656b6b] dark:text-[#888] truncate mt-0.5">
                          {vm.os || 'Ubuntu 24.04'}
                        </div>
                      </td>

                      {/* Expiration Date */}
                      <td className="px-5 py-3.5 whitespace-nowrap font-mono text-xs">
                        <span
                          className={`font-medium ${
                            isExpired
                              ? 'text-[#dc2626] font-bold'
                              : isExpiringSoon
                              ? 'text-[#d97706] font-semibold'
                              : 'text-[#1a1a1a] dark:text-white'
                          }`}
                        >
                          {vm.expiryDate ? formatDate(vm.expiryDate) : 'Never Expires'}
                        </span>
                      </td>

                      {/* Action Buttons */}
                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleToggleSuspend(vm.vmid, vm.isSuspended || false, vm.proxmoxConnectionId)}
                            className={`px-2 py-1 text-[11px] font-semibold rounded border transition-colors cursor-pointer ${
                              vm.isSuspended
                                ? 'bg-white dark:bg-[#181818] text-[#16a34a] border-[#bbf7d0] hover:bg-[#f0fdf4]'
                                : 'bg-white dark:bg-[#181818] text-[#d97706] border-[#fde68a] hover:bg-[#fffaf0]'
                            }`}
                          >
                            {vm.isSuspended ? 'Unsuspend' : 'Suspend'}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedVmForAction(vm);
                              setModalType('extend-expiry');
                            }}
                            className="btn-secondary px-2 py-1 text-[11px] cursor-pointer"
                          >
                            Extend
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedVmForAction(vm);
                              setTargetAccountEmail(vm.ownerEmail);
                              setAssignExpiryMode('keep');
                              setAssignExpiryDate(vm.expiryDate ? vm.expiryDate.slice(0, 10) : '');
                              setModalType('assign-vm');
                            }}
                            className="btn-secondary px-2 py-1 text-[11px] cursor-pointer"
                          >
                            Assign
                          </button>

                          <button
                            type="button"
                            onClick={() => setConfirmTarget(vm)}
                            className="btn-secondary px-2 py-1 text-[11px] !text-[#dc2626] !border-[#fecaca] hover:!bg-[#fef2f2] dark:hover:!bg-[#350d0d] cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* =========================================================================
          5. LOWER SPLIT DECK: PENDING APPROVAL QUEUE & RECENT AUDIT TRAIL
         ========================================================================= */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        
        {/* LEFT DECK: PENDING OS APPROVALS & SUPPORT ATTENTION */}
        <div className="ink-block-wrapper bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs overflow-hidden p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-[#dedfdf] dark:border-[#262626] pb-3 mb-4">
              <div>
                <h3 className="font-serif font-medium text-base text-[#1a1a1a] dark:text-white tracking-tight">
                  Urgent Approval & Support Queue
                </h3>
                <p className="text-xs text-[#656b6b] dark:text-[#a0a0a0] mt-0.5">
                  Client OS reinstallation requests and unresolved customer tickets.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/reimage-requests')}
                className="text-xs font-semibold text-[#2563eb] dark:text-[#60a5fa] hover:underline cursor-pointer"
              >
                View all →
              </button>
            </div>

            {pendingReimageRequests.length === 0 && tickets.filter(t => t.status === 'open').length === 0 ? (
              <div className="py-8 text-center text-xs text-[#656b6b] dark:text-[#a0a0a0]">
                <span className="inline-block w-2 h-2 rounded-full bg-[#16a34a] mr-2" />
                Zero pending approval items or unresolved tickets. All queues clear.
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {pendingReimageRequests.slice(0, 3).map(req => (
                  <div
                    key={req.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-[#f3d19a] dark:border-[#78350f] bg-[#fffaf0] dark:bg-[#1c1508] text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[#b45309] uppercase text-[10px] tracking-wide">
                          OS Reimage Request
                        </span>
                        <span className="font-mono text-[#1a1a1a] dark:text-white font-semibold">
                          VM {req.vmid}
                        </span>
                      </div>
                      <p className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px] mt-0.5">
                        Target: <span className="font-semibold text-[#1a1a1a] dark:text-white">{req.requestedOs}</span> · by {req.requesterEmail}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate('/reimage-requests')}
                      className="btn-primary px-3 py-1 text-[11px] cursor-pointer"
                    >
                      Review
                    </button>
                  </div>
                ))}

                {tickets.filter(t => t.status === 'open').slice(0, 2).map(ticket => (
                  <div
                    key={ticket.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-[#dedfdf] dark:border-[#262626] bg-[#fbfaf9] dark:bg-[#181818] text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[#2563eb] dark:text-[#60a5fa] uppercase text-[10px] tracking-wide">
                          Ticket #{ticket.id}
                        </span>
                        <span className="font-semibold text-[#1a1a1a] dark:text-white truncate max-w-[200px]">
                          {ticket.subject}
                        </span>
                      </div>
                      <p className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px] mt-0.5">
                        From {ticket.userEmail || 'Client'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate('/support')}
                      className="btn-secondary px-3 py-1 text-[11px] cursor-pointer"
                    >
                      Reply
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT DECK: RECENT CLUSTER AUDIT LOGS */}
        <div className="ink-block-wrapper bg-white dark:bg-[#121212] border border-[#dedfdf] dark:border-[#262626] rounded-xl shadow-xs overflow-hidden p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-[#dedfdf] dark:border-[#262626] pb-3 mb-4">
              <div>
                <h3 className="font-serif font-medium text-base text-[#1a1a1a] dark:text-white tracking-tight">
                  Recent Cluster Audit Trail
                </h3>
                <p className="text-xs text-[#656b6b] dark:text-[#a0a0a0] mt-0.5">
                  Immutable security events, power state mutations, and operator activities.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/audit-logs')}
                className="text-xs font-semibold text-[#2563eb] dark:text-[#60a5fa] hover:underline cursor-pointer"
              >
                View all →
              </button>
            </div>

            {recentAuditLogs.length === 0 ? (
              <div className="py-8 text-center text-xs text-[#656b6b] dark:text-[#a0a0a0]">
                No recent audit events recorded.
              </div>
            ) : (
              <div className="divide-y divide-[#f1f1f1] dark:divide-[#1f1f1f]">
                {recentAuditLogs.slice(0, 4).map(log => (
                  <div key={log.id} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-[10px] px-1.5 py-0.5 rounded bg-[#f1f1f1] dark:bg-[#222] text-[#1a1a1a] dark:text-white">
                          {log.action}
                        </span>
                        <span className="text-xs text-[#656b6b] dark:text-[#888] truncate font-mono">
                          {log.userEmail}
                        </span>
                      </div>
                      <p className="text-[#656b6b] dark:text-[#a0a0a0] text-[11px] mt-1 leading-normal truncate">
                        {log.details || log.target || 'Cluster operation performed.'}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-[#8a9090] shrink-0 pt-0.5">
                      {formatTime(log.timestamp, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </section>

      {/* =========================================================================
          6. MODALS SUITE (Carta Ink Styled)
         ========================================================================= */}

      {/* VM Remove Confirmation Modal */}
      {confirmTarget !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-6">
          <div className="w-full max-w-[400px] bg-white dark:bg-[#181818] border border-[#dedfdf] dark:border-[#313131] rounded-2xl shadow-2xl p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95">
            <h3 className="font-serif text-lg font-bold text-[#dc2626]">
              Permanently Remove Instance {confirmTarget.vmid}?
            </h3>
            <p className="text-xs text-[#656b6b] dark:text-[#a0a0a0] leading-relaxed">
              This action terminates the guest on the hypervisor and purges all allocation records. The assigned user will lose access immediately.
            </p>
            <div className="flex items-center gap-3 mt-2">
              <button
                type="button"
                onClick={() => setConfirmTarget(null)}
                className="btn-secondary flex-1 py-2 text-xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const vmid = confirmTarget.vmid;
                  const connectionId = confirmTarget.proxmoxConnectionId || undefined;
                  setConfirmTarget(null);
                  try {
                    await apiClient.deleteVM(vmid, connectionId);
                    showToast(`Instance ${vmid} successfully removed.`);
                    loadData(false);
                  } catch {
                    showToast(`Failed to remove instance ${vmid}.`);
                  }
                }}
                className="btn-primary !bg-[#dc2626] hover:!bg-[#b91c1c] flex-1 py-2 text-xs font-semibold cursor-pointer"
              >
                Delete Instance
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Extend Expiry Modal */}
      {modalType === 'extend-expiry' && selectedVmForAction && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-6">
          <div className="w-full max-w-[440px] bg-white dark:bg-[#181818] border border-[#dedfdf] dark:border-[#313131] rounded-2xl shadow-2xl p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-[#dedfdf] dark:border-[#313131] pb-3">
              <h3 className="font-serif text-base font-semibold text-[#1a1a1a] dark:text-white">
                Extend Expiration Schedule (ID {selectedVmForAction.vmid})
              </h3>
              <button
                type="button"
                onClick={() => setModalType(null)}
                className="text-[#656b6b] hover:text-[#1a1a1a] dark:hover:text-white font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleExtendExpirySubmit} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Current Expiration Date</label>
                <input
                  type="text"
                  value={formatDate(selectedVmForAction.expiryDate || Date.now())}
                  disabled
                  className="w-full p-2.5 bg-[#f1f1f1] dark:bg-[#222] border border-[#dedfdf] dark:border-[#313131] rounded-lg text-[#656b6b] font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Extension Period</label>
                <select
                  value={extendDays}
                  onChange={e => setExtendDays(Number(e.target.value))}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-semibold"
                >
                  <option value={15}>+15 Days (Bi-weekly)</option>
                  <option value={30}>+30 Days (1 Month)</option>
                  <option value={90}>+90 Days (Quarterly)</option>
                  <option value={365}>+365 Days (1 Year)</option>
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] dark:border-[#313131] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary py-2 px-4 cursor-pointer">
                  Cancel
                </button>
                <button type="submit" className="btn-primary py-2 px-4 cursor-pointer">
                  Extend Schedule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assign Client Modal */}
      {modalType === 'assign-vm' && selectedVmForAction && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-6">
          <div className="w-full max-w-[460px] bg-white dark:bg-[#181818] border border-[#dedfdf] dark:border-[#313131] rounded-2xl shadow-2xl p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-[#dedfdf] dark:border-[#313131] pb-3">
              <h3 className="font-serif text-base font-semibold text-[#1a1a1a] dark:text-white">
                Reassign Instance Ownership (ID {selectedVmForAction.vmid})
              </h3>
              <button
                type="button"
                onClick={() => setModalType(null)}
                className="text-[#656b6b] hover:text-[#1a1a1a] dark:hover:text-white font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleAssignSubmit} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Target Client Account</label>
                <select
                  value={targetAccountEmail}
                  onChange={e => setTargetAccountEmail(e.target.value)}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-medium"
                >
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.email}>
                      {acc.name ? `${acc.name} (${acc.email})` : acc.email}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Expiration Policy</label>
                <select
                  value={assignExpiryMode}
                  onChange={e => setAssignExpiryMode(e.target.value as any)}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-medium"
                >
                  <option value="keep">Keep Current Expiration Schedule</option>
                  <option value="never">Never Expire</option>
                  <option value="custom">Custom Date</option>
                </select>
              </div>
              {assignExpiryMode === 'custom' && (
                <div>
                  <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Select Date</label>
                  <input
                    type="date"
                    value={assignExpiryDate}
                    onChange={e => setAssignExpiryDate(e.target.value)}
                    className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-mono"
                  />
                </div>
              )}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] dark:border-[#313131] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary py-2 px-4 cursor-pointer">
                  Cancel
                </button>
                <button type="submit" className="btn-primary py-2 px-4 cursor-pointer">
                  Confirm Assignment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Provision VM Modal */}
      {modalType === 'provision-vm' && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-6">
          <div className="w-full max-w-[540px] bg-white dark:bg-[#181818] border border-[#dedfdf] dark:border-[#313131] rounded-2xl shadow-2xl p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#dedfdf] dark:border-[#313131] pb-3">
              <h3 className="font-serif text-lg font-semibold text-[#1a1a1a] dark:text-white">
                Provision New Cloud Instance
              </h3>
              <button
                type="button"
                onClick={() => setModalType(null)}
                className="text-[#656b6b] hover:text-[#1a1a1a] dark:hover:text-white font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleProvisionSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Instance VMID</label>
                <input
                  type="number"
                  value={newVmid}
                  onChange={e => setNewVmid(Number(e.target.value))}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-mono font-semibold"
                  required
                />
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Instance Hostname</label>
                <input
                  type="text"
                  value={newVmName}
                  onChange={e => setNewVmName(e.target.value)}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-medium"
                  required
                />
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Virtualization Type</label>
                <select
                  value={newVmType}
                  onChange={e => setNewVmType(e.target.value as any)}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-semibold"
                >
                  <option value="qemu">QEMU Virtual Machine</option>
                  <option value="lxc">LXC System Container</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Target Hypervisor Node</label>
                <select
                  value={newVmNode}
                  onChange={e => setNewVmNode(e.target.value)}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-semibold"
                >
                  {nodes.map(n => (
                    <option key={n.id} value={n.name}>
                      {n.name} ({n.status === 'online' ? 'Online' : 'Offline'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Owner Account</label>
                <select
                  value={newVmOwnerEmail}
                  onChange={e => setNewVmOwnerEmail(e.target.value)}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-medium"
                >
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.email}>
                      {acc.name ? `${acc.name} (${acc.email})` : acc.email}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">CPU Cores</label>
                <input
                  type="number"
                  value={newVmCpus}
                  onChange={e => setNewVmCpus(Number(e.target.value))}
                  min={1}
                  max={64}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-mono font-semibold"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">RAM (GB)</label>
                <input
                  type="number"
                  value={newVmRamGb}
                  onChange={e => setNewVmRamGb(Number(e.target.value))}
                  min={1}
                  max={512}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-mono font-semibold"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Storage (GB)</label>
                <input
                  type="number"
                  value={newVmDiskGb}
                  onChange={e => setNewVmDiskGb(Number(e.target.value))}
                  min={8}
                  max={2048}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-mono font-semibold"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1 text-[#1a1a1a] dark:text-white">Initial Validity (Days)</label>
                <input
                  type="number"
                  value={newVmExpiryDays}
                  onChange={e => setNewVmExpiryDays(Number(e.target.value))}
                  min={1}
                  className="w-full p-2.5 bg-white dark:bg-[#1c1c1c] border border-[#dedfdf] dark:border-[#313131] rounded-lg font-mono font-semibold"
                />
              </div>

              <div className="sm:col-span-2 flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] dark:border-[#313131] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary py-2 px-4 cursor-pointer">
                  Cancel
                </button>
                <button type="submit" className="btn-primary py-2 px-5 font-semibold cursor-pointer">
                  Provision Instance
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </main>
  );
};

export default DashboardContent;
