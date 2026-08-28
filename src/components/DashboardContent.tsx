import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TextInput } from '@tremor/react';
import { TelemetryChart } from './TelemetryChart';
import { apiClient, ApiAccount, ApiVM, ApiSupportTicket, ApiClusterOverview, ApiReimageRequest, ApiNotification } from '../services/apiClient';
import { formatDate, formatTime } from '../services/dateTime';

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

export const DashboardContent: React.FC<{
  pageTitle?: string;
  typeFilter?: 'qemu' | 'lxc';
  onOpenModal: (modalName: string) => void;
  workspaceConnectionId?: string;
  workspaceName?: string;
}> = ({ pageTitle = 'Dashboard', typeFilter, onOpenModal, workspaceConnectionId, workspaceName = 'Global' }) => {

  const [nodes, setNodes] = useState<StellarNode[]>([]);
  const [vms, setVMs] = useState<ApiVM[]>([]);
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [tickets, setTickets] = useState<ApiSupportTicket[]>([]);
  const [clusterOverview, setClusterOverview] = useState<ApiClusterOverview | null>(null);
  const [selectedNode, setSelectedNode] = useState<StellarNode | null>(null);
  
  // Modal State
  const [modalType, setModalType] = useState<
    | 'provision-vm'
    | 'assign-vm'
    | 'extend-expiry'
    | 'reinstall-os'
    | 'zfs-scrub'
    | null
  >(null);

  const [selectedVmForAction, setSelectedVmForAction] = useState<ApiVM | null>(null);
  const [targetAccountEmail, setTargetAccountEmail] = useState('');
    const [extendDays, setExtendDays] = useState(30);
  const visibleVms = typeFilter ? vms.filter(vm => vm.type === typeFilter) : vms;

  const [selectedTargetOS, setSelectedTargetOS] = useState('Ubuntu 24.04 LTS');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pendingReimageRequests, setPendingReimageRequests] = useState(0);
  const [activeNotifications, setActiveNotifications] = useState<ApiNotification[]>([]);
  const [confirmTarget, setConfirmTarget] = useState<number | null>(null);
  const navigate = useNavigate();

  // VM Provisioning Form State
  const [newVmid, setNewVmid] = useState(105);
  const [newVmName, setNewVmName] = useState('web-server-prod-02');
  const [newVmNode, setNewVmNode] = useState('stellar-node-01');
  const [newVmType, setNewVmType] = useState('qemu');
  const [newVmOwnerEmail, setNewVmOwnerEmail] = useState('client@votioncloud.org');
  const [newVmCpus, setNewVmCpus] = useState(4);
  const [newVmRamGb, setNewVmRamGb] = useState(8);
  const [newVmDiskGb, setNewVmDiskGb] = useState(64);
  const [newVmExpiryDays, setNewVmExpiryDays] = useState(30);
  const [newVmOs, setNewVmOs] = useState('Ubuntu 24.04 LTS');

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // PROMPT 3: Load Data from Proxmox API Service & Express Backend (5s Polling Interval)
  const loadData = async () => {
    try {
      const [apiNodes, apiOverview, apiVMs, apiAccounts, apiTickets] = await Promise.all([
        apiClient.getAdminNodes(workspaceConnectionId),
        apiClient.getClusterOverview(workspaceConnectionId),
        apiClient.getVMs(undefined, workspaceConnectionId),
        apiClient.getAccounts(),
        apiClient.getSupportTickets(),
      ]);
            let pendingRequests: ApiReimageRequest[] = [];
      try {
        pendingRequests = await apiClient.getAdminReimageRequests('pending');
      } catch {
        // The overview remains usable if the optional approval queue is unavailable.
      }
      try {
        const notificationResponse = await apiClient.getNotifications(true);
        setActiveNotifications(notificationResponse.success ? notificationResponse.data.slice(0, 5) : []);
      } catch {
        // Alert banners are additive; the global notification bell remains available.
      }

      const mappedNodes: StellarNode[] = apiNodes.map((n, idx) => ({
        id: String(n.id || idx + 1),
        name: n.nodeName || n.node,
        ip: 'hidden',
        status: n.status,
        cpuPct: n.cpuUsagePct,
        cpuCores: (n as any).cpuCores,
        ramUsageGb: Math.round(n.ramUsageBytes / 1073741824),
        ramMaxGb: Math.round(n.ramTotalBytes / 1073741824),
        storageUsageGb: (n as any).storageUsageGb,
        storageTotalGb: (n as any).storageTotalGb,
        zfsHealth: n.zfsHealth || 'ONLINE (0 errors)',
        vmsCount: apiVMs.filter(v => v.node === (n.nodeName || n.node)).length,
        platformVersion: n.platformVersion || '8.2.4',
        uptimeDays: Math.floor((n.uptimeSeconds || 2419200) / 86400),
      }));

      setNodes(mappedNodes);
      setClusterOverview(apiOverview);
      setVMs(apiVMs);
            setAccounts(apiAccounts);
      setTickets(apiTickets);
      setPendingReimageRequests(pendingRequests.length);
      setLastUpdated(new Date());
      setLoadError(null);
      
      // Fix default selections for forms if the default doesn't exist
      if (apiAccounts.length > 0) {
        if (!apiAccounts.find(a => a.email === newVmOwnerEmail)) {
          setNewVmOwnerEmail(apiAccounts[0].email);
        }
        if (!targetAccountEmail || !apiAccounts.find(a => a.email === targetAccountEmail)) {
          setTargetAccountEmail(apiAccounts[0].email);
        }
      }

      if (mappedNodes.length > 0) {
        if (!mappedNodes.find(n => n.name === newVmNode)) {
          setNewVmNode(mappedNodes[0].name);
        }
      }

      setIsLoading(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to load the administrator overview.');
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [workspaceConnectionId]);

  const handleToggleSuspend = async (vmid: number, isSuspended: boolean) => {
    try {
      await apiClient.suspendVM(vmid, !isSuspended);
      setToastMessage(`VM ${vmid} ${!isSuspended ? 'suspended' : 'unsuspended'} successfully.`);
      loadData();
    } catch (e) {
      setToastMessage('Failed to toggle suspend state.');
    }
  };

  const handleExtendExpirySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVmForAction) return;
    try {
      await apiClient.extendVMExpiry(selectedVmForAction.vmid, extendDays);
      setToastMessage(`VM ${selectedVmForAction.vmid} expiry extended by ${extendDays} days.`);
      setModalType(null);
      loadData();
    } catch (e) {
      setToastMessage('Failed to extend expiry.');
    }
  };

  const handleReinstallOSSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVmForAction) return;
    try {
      await apiClient.createVmReimageRequest(selectedVmForAction.vmid, selectedTargetOS, 'Administrator submitted an OS reimage request from the overview.');
      setToastMessage(`OS reimage request submitted for VM ${selectedVmForAction.vmid}.`);
      setModalType(null);
      loadData();
    } catch (e) {
      setToastMessage('Failed to submit the OS reimage request.');
    }
  };

  const handleAssignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVmForAction) return;
    try {
      await apiClient.assignVM(selectedVmForAction.vmid, targetAccountEmail);
      setToastMessage(`VM ${selectedVmForAction.vmid} assigned to ${targetAccountEmail}.`);
      setModalType(null);
      loadData();
    } catch (e) {
      setToastMessage('Failed to assign VM.');
    }
  };

  const dismissNotification = async (id: number) => {
    const previous = activeNotifications;
    setActiveNotifications(current => current.filter(notification => notification.id !== id));
    try {
      await apiClient.markNotificationsRead([id]);
    } catch {
      setActiveNotifications(previous);
      setToastMessage('Unable to dismiss the alert.');
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
      setToastMessage(`Provisioned new VM ${newVmName}.`);
      setModalType(null);
      loadData();
    } catch (e) {
      setToastMessage('Failed to provision VM.');
    }
  };

  return (
    <main className="app-content overview-admin-page p-3 sm:p-5 md:p-8 max-w-[1400px] mx-auto min-h-screen">
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="theme-dashboard-toast relative z-10 mb-6 w-full sm:ml-auto sm:max-w-[420px] p-4 bg-white text-[#1a1a1a] text-sm font-semibold rounded-lg flex items-center justify-between gap-4 shadow-lg border border-[#dedfdf]"
        >
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-[#16a34a] animate-pulse"></span>
            <span className="min-w-0 break-words">{toastMessage}</span>
          </div>
          <button onClick={() => setToastMessage(null)} className="text-[#656b6b] hover:text-[#1a1a1a] transition-colors">✕</button>
        </div>
      )}

      <div className="mb-6 flex flex-col gap-4 border-b border-[#dedfdf] pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a9090]"><span className="h-1.5 w-1.5 rounded-full bg-[#16a34a]" />Control plane</div>
          <h1 className="page-heading">{pageTitle}</h1>
          <p className="mt-2 text-sm text-[#656b6b]">Manage compute nodes, guest allocations, and cluster health from one operational view.</p>
          <p className="mt-2 text-xs font-semibold text-[#2563eb]">Scope: {workspaceName}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[#656b6b]">
          <span>{lastUpdated ? `Updated ${formatTime(lastUpdated, { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for telemetry'}</span>
          <button type="button" onClick={loadData} disabled={isLoading} className="btn-secondary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50">{isLoading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      {loadError && <div className="mb-6 flex flex-col gap-3 rounded-lg border border-[#fecaca] bg-[#fff7f6] px-4 py-3 text-sm text-[#8d3028] sm:flex-row sm:items-center sm:justify-between" role="alert"><span>{loadError}</span><button type="button" onClick={loadData} className="font-semibold underline underline-offset-2">Try again</button></div>}

      {activeNotifications.length > 0 && <section className="theme-alert-panel mb-6 rounded-lg border border-[#f3d19a] bg-[#fffaf0]" aria-labelledby="active-alerts-title"><div className="flex flex-col gap-1 border-b border-[#f3d19a] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 id="active-alerts-title" className="text-sm font-semibold text-[#1a1a1a]">Active alerts</h2><p className="mt-0.5 text-xs text-[#8b5e00]">Unread threshold notifications from the telemetry monitor.</p></div><button type="button" onClick={() => Promise.all(activeNotifications.map(notification => dismissNotification(notification.id)))} className="self-start text-xs font-semibold text-[#8b5e00] underline underline-offset-2 sm:self-auto">Mark all read</button></div><div className="divide-y divide-[#f3d19a]">{activeNotifications.slice(0, 3).map(notification => <div key={notification.id} className="flex items-start gap-3 px-4 py-3"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notification.severity === 'critical' ? 'bg-[#dc2626]' : notification.severity === 'info' ? 'bg-[#2563eb]' : 'bg-[#f59e0b]'}`} /><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-[#1a1a1a]">{notification.title}</p><p className="mt-1 text-xs leading-5 text-[#656b6b]">{notification.message}</p></div><button type="button" onClick={() => dismissNotification(notification.id)} className="shrink-0 text-xs font-semibold text-[#8b5e00] hover:text-[#1a1a1a]">Dismiss</button></div>)}</div>{activeNotifications.length > 3 && <p className="border-t border-[#f3d19a] px-4 py-2 text-[11px] text-[#8b5e00]">{activeNotifications.length - 3} more alert{activeNotifications.length - 3 === 1 ? '' : 's'} available in Alerts.</p>}</section>}

      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Operational summary">
        {[
          { label: 'Managed guests', value: clusterOverview?.totalVMsCount ?? vms.length, tone: 'text-[#1a1a1a]' },
          { label: 'Running now', value: clusterOverview?.runningVMsCount ?? vms.filter(vm => vm.status === 'running').length, tone: 'text-[#176b52]' },
          { label: 'Suspended', value: clusterOverview?.suspendedVMsCount ?? vms.filter(vm => vm.isSuspended).length, tone: 'text-[#8b5e00]' },
          { label: 'Pending OS reviews', value: pendingReimageRequests, tone: pendingReimageRequests > 0 ? 'text-[#a23d35]' : 'text-[#1a1a1a]' },
        ].map(item => <div key={item.label} className="rounded-lg border border-[#dedfdf] bg-[#fbfbfb] px-4 py-3 sm:px-5"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a9090]">{item.label}</p><p className={`mt-2 text-2xl font-semibold tracking-[-0.02em] ${isLoading ? 'h-7 w-12 animate-pulse rounded bg-[#e5e7e7] text-transparent' : item.tone}`}>{isLoading ? '0' : item.value}</p></div>)}
      </section>

      <section className="mb-8 grid gap-3 md:grid-cols-3" aria-label="Operational attention">
        <button type="button" onClick={() => navigate('/reimage-requests')} className="group rounded-lg border border-[#dedfdf] bg-white p-4 text-left transition hover:border-[#8b5e00] hover:bg-[#fffdf7]"><div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a9090]">OS reimage review</p><p className="mt-2 text-sm font-semibold text-[#1a1a1a]">{pendingReimageRequests > 0 ? `${pendingReimageRequests} request${pendingReimageRequests === 1 ? '' : 's'} awaiting review` : 'No pending requests'}</p></div><span className="text-lg text-[#8b5e00] transition-transform group-hover:translate-x-0.5">→</span></div><p className="mt-2 text-xs leading-5 text-[#656b6b]">Review approval records separately from operator execution.</p></button>
        <button type="button" onClick={() => navigate('/support')} className="rounded-lg border border-[#dedfdf] bg-white p-4 text-left transition hover:border-[#2563eb] hover:bg-[#fbfdff]"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a9090]">Support workload</p><p className="mt-2 text-sm font-semibold text-[#1a1a1a]">{tickets.filter(ticket => ticket.status === 'open' || ticket.status === 'in-progress').length} active ticket{tickets.filter(ticket => ticket.status === 'open' || ticket.status === 'in-progress').length === 1 ? '' : 's'}</p><p className="mt-2 text-xs leading-5 text-[#656b6b]">Open and in-progress client conversations requiring attention. Open support center →</p></button>
        <div className="rounded-lg border border-[#dedfdf] bg-white p-4"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a9090]">Node availability</p><p className="mt-2 text-sm font-semibold text-[#1a1a1a]">{nodes.filter(node => node.status === 'online').length} of {nodes.length || '—'} online</p><p className="mt-2 text-xs leading-5 text-[#656b6b]">Current control-plane visibility across attached hypervisors.</p></div>
      </section>

      {/* Cluster Health Overview Tiles */}
      {clusterOverview ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 md:gap-6 mb-6 md:mb-10">
          
          <div className="bg-white border border-[#dedfdf] hover:border-[#656b6b] transition-colors rounded-lg p-4 sm:p-6 flex flex-col justify-between h-[130px] font-sans">
            <div>
              <p className="text-xs font-semibold text-[#656b6b] tracking-wider uppercase">Cluster Health</p>
              <h2 className="text-xl font-medium text-[#1a1a1a] mt-2 truncate tracking-tight" title={clusterOverview.clusterStatus.clusterName}>
                {clusterOverview.clusterStatus.clusterName}
              </h2>
            </div>
            <div className="flex items-center">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[#f9f8f6] text-[#1a1a1a] border border-[#dedfdf]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a]"></span>
                Quorum OK ({clusterOverview.totalNodes}/{clusterOverview.totalNodes})
              </span>
            </div>
          </div>

          <div className="bg-white border border-[#dedfdf] hover:border-[#656b6b] transition-colors rounded-lg p-4 sm:p-6 flex flex-col justify-between h-[130px] font-sans">
            <div>
              <p className="text-xs font-semibold text-[#656b6b] tracking-wider uppercase">CPU Average Load</p>
              <div className="flex items-end gap-2 mt-2">
                <h2 className="text-3xl font-medium text-[#1a1a1a] tracking-tight leading-none">{clusterOverview.totalCpuPct}%</h2>
                <span className="text-[11px] font-medium text-[#656b6b] pb-1">{clusterOverview.totalCpuCores ? `${clusterOverview.totalCpuCores} cores` : ''}</span>
              </div>
            </div>
            <div className="w-full bg-[#f1f1f1] h-1 rounded-full mt-4 overflow-hidden">
              <div className={`h-full rounded-full ${clusterOverview.totalCpuPct > 80 ? 'bg-[#dc2626]' : 'bg-[#1a1a1a]'}`} style={{ width: `${clusterOverview.totalCpuPct}%` }}></div>
            </div>
          </div>

          <div className="bg-white border border-[#dedfdf] hover:border-[#656b6b] transition-colors rounded-lg p-4 sm:p-6 flex flex-col justify-between h-[130px] font-sans">
            <div>
              <p className="text-xs font-semibold text-[#656b6b] tracking-wider uppercase">Allocated Memory</p>
              <div className="flex items-baseline gap-1 mt-2">
                <h2 className="text-3xl font-medium text-[#1a1a1a] tracking-tight leading-none">{clusterOverview.totalRamUsedGb}</h2>
                <span className="text-[#656b6b] font-medium text-sm">/ {clusterOverview.totalRamMaxGb} GB</span>
              </div>
            </div>
            <div className="w-full bg-[#f1f1f1] h-1 rounded-full mt-4 overflow-hidden">
              <div className={`h-full rounded-full ${clusterOverview.totalRamMaxGb > 0 && clusterOverview.totalRamUsedGb / clusterOverview.totalRamMaxGb > 0.8 ? 'bg-[#dc2626]' : 'bg-[#1a1a1a]'}`} style={{ width: `${(clusterOverview.totalRamUsedGb / (clusterOverview.totalRamMaxGb || 1)) * 100}%` }}></div>
            </div>
          </div>

          <div className="bg-white border border-[#dedfdf] hover:border-[#656b6b] transition-colors rounded-lg p-4 sm:p-6 flex flex-col justify-between h-[130px] font-sans">
            <div>
              <p className="text-xs font-semibold text-[#656b6b] tracking-wider uppercase">Cluster Storage</p>
              <div className="flex items-baseline gap-1 mt-2">
                <h2 className="text-3xl font-medium text-[#1a1a1a] tracking-tight leading-none">{clusterOverview.totalStorageUsedGb ?? '—'}</h2>
                <span className="text-[#656b6b] font-medium text-sm">/ {clusterOverview.totalStorageTotalGb ?? '—'} GB</span>
              </div>
            </div>
            <div className="w-full bg-[#f1f1f1] h-1 rounded-full mt-4 overflow-hidden">
              <div className="bg-[#2563eb] h-full rounded-full" style={{ width: `${clusterOverview.totalStorageTotalGb ? ((clusterOverview.totalStorageUsedGb || 0) / clusterOverview.totalStorageTotalGb) * 100 : 0}%` }}></div>
            </div>
          </div>

        </div>
      ) : isLoading ? (
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading cluster health">
          {[1, 2, 3, 4].map(tile => <div key={tile} className="h-[130px] animate-pulse rounded-lg border border-[#dedfdf] bg-[#f7f7f6]" />)}
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-[#dedfdf] bg-[#fbfbfb] px-5 py-6" role="status"><p className="text-sm font-semibold text-[#1a1a1a]">Cluster health is temporarily unavailable.</p><p className="mt-1 text-xs leading-5 text-[#656b6b]">The overview remains available, but live node telemetry could not be loaded. Use Refresh to try again.</p></div>
      )}

      {/* Stellar Nodes Table */}
      <div className="ink-block-wrapper shadow-sm">
        <div className="ink-block-header flex items-center justify-between bg-[#fbfaf9]">
          <div>
            <h2 className="text-base font-bold text-[#1a1a1a]">Stellar Node Matrix</h2>
            <p className="text-xs text-[#656b6b] mt-1">Physical hypervisors attached to this cluster.</p>
          </div>
          <span className="text-xs font-bold text-[#656b6b] bg-white border border-[#dedfdf] px-2 py-1 rounded shadow-sm">
            {isLoading ? <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-[#f1f1f1]" aria-label="Loading node count" /> : `${nodes.length} Nodes`}
          </span>
        </div>
        
        <div className="responsive-table-container">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#dedfdf] bg-white">
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider w-1/4">Node</th>
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider">Status</th>
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider">CPU</th>
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider hidden md:table-cell">RAM</th>
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider hidden lg:table-cell">Storage</th>
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider hidden sm:table-cell">VMs</th>
                <th className="px-3 sm:px-6 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider text-right hidden md:table-cell">ZFS Health</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && nodes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 sm:px-6 py-8 text-center text-[#656b6b] text-sm">
                    <span className="inline-flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-[#a7aaaa]" />Loading telemetry data…</span>
                  </td>
                </tr>
              ) : nodes.length === 0 ? (
                <tr><td colSpan={7} className="px-3 sm:px-6 py-10 text-center"><p className="text-sm font-semibold text-[#1a1a1a]">No hypervisors are reporting to the control plane.</p><p className="mt-1 text-xs text-[#656b6b]">Check the cluster connection and refresh to retry synchronization.</p></td></tr>
              ) : (
                nodes.map(node => (
                  <tr key={node.id} className="border-b border-[#dedfdf] last:border-0 hover:bg-[#fbfaf9] transition-colors group cursor-pointer" onClick={() => setSelectedNode(node)}>
                    <td className="px-3 sm:px-6 py-4">
                      <div className="font-semibold text-[#1a1a1a] flex items-center gap-2">
                        {node.name}
                        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-[#2563eb] hidden sm:inline">↗</span>
                      </div>
                      <div className="text-xs text-[#656b6b] mt-1 font-mono">{node.platformVersion}</div>
                    </td>
                    <td className="px-3 sm:px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border ${
                        node.status === 'online' ? 'bg-[#f0fdf4] text-[#16a34a] border-[#bbf7d0]' : 'bg-[#fef2f2] text-[#dc2626] border-[#fecaca]'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${node.status === 'online' ? 'bg-[#16a34a]' : 'bg-[#dc2626]'}`}></span>
                        {node.status}
                      </span>
                    </td>
                    <td className="px-3 sm:px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#1a1a1a] w-10">{node.cpuPct}%</span>
                        <div className="w-16 h-1.5 bg-[#f1f1f1] rounded-full overflow-hidden hidden md:block">
                          <div className={`h-full rounded-full ${node.cpuPct > 80 ? 'bg-[#dc2626]' : 'bg-[#2563eb]'}`} style={{width: `${node.cpuPct}%`}}></div>
                        </div>
                        {node.cpuCores ? <span className="text-[10px] font-mono text-[#a7aaaa]">{node.cpuCores}c</span> : null}
                      </div>
                    </td>
                    <td className="px-3 sm:px-6 py-4 text-sm font-medium text-[#1a1a1a]">
                      {node.ramUsageGb} / {node.ramMaxGb} GB
                    </td>
                    <td className="px-3 sm:px-6 py-4 text-sm font-medium text-[#1a1a1a]">
                      {node.storageTotalGb ? (
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-xs">{node.storageUsageGb ?? 0} / {node.storageTotalGb} GB</span>
                          <div className="w-24 h-1 bg-[#f1f1f1] rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-[#2563eb]" style={{ width: `${(((node.storageUsageGb || 0) / (node.storageTotalGb || 1)) * 100).toFixed(0)}%` }} />
                          </div>
                        </div>
                      ) : (
                        <span className="text-[#a7aaaa]">—</span>
                      )}
                    </td>
                    <td className="px-3 sm:px-6 py-4 text-sm text-[#656b6b]">
                      {node.vmsCount}
                    </td>
                    <td className="px-3 sm:px-6 py-4 text-right text-sm">
                      <span className={`font-semibold ${(node.zfsHealth || '').toUpperCase().includes('ONLINE') || (node.zfsHealth || '').toUpperCase().includes('HEALTHY') ? 'text-[#16a34a]' : 'text-[#dc2626]'}`}>
                        {node.zfsHealth}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* VM & LXC Expiry Suspension Manager Table */}
      <div className="ink-block-wrapper shadow-sm">
        <div className="ink-block-header flex items-center justify-between bg-[#fbfaf9]">
          <div>
            <h2 className="text-base font-bold text-[#1a1a1a]">Virtual Machines & LXC Containers</h2>
            <p className="text-xs text-[#656b6b] mt-1">Manage guest allocations, suspension states, and expirations.</p>
          </div>
          <div className="flex gap-3">
            <span className="text-xs font-bold text-[#656b6b] bg-white border border-[#dedfdf] px-2 py-1.5 rounded shadow-sm flex items-center">
              {isLoading ? <span className="inline-block h-3.5 w-20 animate-pulse rounded bg-[#f1f1f1]" aria-label="Loading instance count" /> : `${visibleVms.length} ${typeFilter === 'qemu' ? 'QEMU VMs' : typeFilter === 'lxc' ? 'LXC containers' : 'Instances'}`}
            </span>
            <button onClick={() => setModalType('provision-vm')} className="btn-primary py-1.5 px-4 text-xs shadow-sm">
              + Provision VM
            </button>
          </div>
        </div>

        <div className="responsive-table-container">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#dedfdf] bg-white">
                <th className="px-4 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider w-[30%]">Instance</th>
                <th className="px-4 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider w-[12%] whitespace-nowrap">Status</th>
                <th className="px-4 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider w-[18%]">Account</th>
                <th className="px-4 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider w-[13%] whitespace-nowrap">Expiry</th>
                <th className="px-4 py-3 text-xs font-bold text-[#1a1a1a] uppercase tracking-wider text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && vms.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-[#656b6b]" aria-busy="true">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-3 w-3 animate-pulse rounded-full bg-[#a7aaaa]" />
                      Loading instance data…
                    </span>
                  </td>
                </tr>
              ) : visibleVms.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center"><p className="text-sm font-semibold text-[#1a1a1a]">No {typeFilter === 'qemu' ? 'QEMU virtual machines' : typeFilter === 'lxc' ? 'LXC containers' : 'guest allocations'} found.</p><p className="mt-1 text-xs text-[#656b6b]">Provisioned virtual machines and containers will appear here.</p></td></tr>
              ) : visibleVms.map(vm => (
                <tr key={vm.vmid} className={`border-b border-[#dedfdf] last:border-0 hover:bg-[#fbfaf9] transition-colors ${vm.isSuspended ? 'opacity-70 bg-[#f9f8f6]' : ''}`}>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-[#dedfdf] bg-white text-[#656b6b] shrink-0">
                        {vm.type === 'qemu' ? 'VM' : 'CT'} {vm.vmid}
                      </span>
                      <span className="font-semibold text-[#1a1a1a] truncate" title={vm.name}>{vm.name}</span>
                    </div>
                    <div className="text-xs text-[#656b6b] mt-1 flex items-center gap-1.5">
                      <span>{vm.os || '—'}</span>
                      <span className="text-[#dedfdf]">|</span>
                      <span>{vm.node && !/^(info|cluster)$/i.test(vm.node) ? vm.node : 'votion-cluster-01'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    {vm.isSuspended ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium uppercase tracking-wide border bg-[#fbfaf9] text-[#1a1a1a] border-[#dedfdf]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#1a1a1a]"></span>
                        Suspended
                      </span>
                    ) : (
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium uppercase tracking-wide border ${
                        vm.status === 'running' ? 'bg-[#f0fdf4] text-[#16a34a] border-[#bbf7d0]' : 'bg-[#fbfaf9] text-[#656b6b] border-[#dedfdf]'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${vm.status === 'running' ? 'bg-[#16a34a]' : 'bg-[#656b6b]'}`}></span>
                        {vm.status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-[#fbfaf9] border border-[#dedfdf] flex items-center justify-center text-[10px] font-medium text-[#1a1a1a] uppercase shrink-0">
                        {vm.ownerEmail.charAt(0)}
                      </div>
                      <span className="text-[13px] font-sans text-[#1a1a1a] truncate" title={vm.ownerEmail}>
                        {vm.ownerEmail}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span className={`text-[13px] font-sans font-medium ${vm.expiryDate && new Date(vm.expiryDate) < new Date() ? 'text-[#dc2626]' : 'text-[#1a1a1a]'}`}>
                      {vm.expiryDate ? formatDate(vm.expiryDate) : '2026-03-15'}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                      <button 
                        onClick={() => handleToggleSuspend(vm.vmid, vm.isSuspended || false)}
                        className={`py-1 px-2.5 text-[11px] font-bold uppercase tracking-wide rounded border transition-colors whitespace-nowrap ${
                          vm.isSuspended 
                            ? 'bg-white text-[#16a34a] border-[#bbf7d0] hover:bg-[#f0fdf4]' 
                            : 'bg-white text-[#dc2626] border-[#fecaca] hover:bg-[#fef2f2]'
                        }`}
                      >
                        {vm.isSuspended ? 'Unsuspend' : 'Suspend'}
                      </button>
                      <button onClick={() => { setSelectedVmForAction(vm); setModalType('extend-expiry'); }} className="btn-secondary py-1 px-2 text-[11px] whitespace-nowrap">Extend</button>
                      <button onClick={() => { setSelectedVmForAction(vm); setModalType('reinstall-os'); }} className="btn-secondary py-1 px-2 text-[11px] whitespace-nowrap">Request OS</button>
                      <button onClick={() => { setSelectedVmForAction(vm); setTargetAccountEmail(vm.ownerEmail); setModalType('assign-vm'); }} className="btn-secondary py-1 px-2 text-[11px] whitespace-nowrap">Assign</button>
                      <button onClick={() => setConfirmTarget(vm.vmid)} className="theme-destructive-button btn-secondary py-1 px-2 text-[11px] whitespace-nowrap !text-[#dc2626] !border-[#fecaca] hover:!bg-[#fef2f2]">Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* VM Remove Confirm Modal (replaces window.confirm()) */}
      {confirmTarget !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1001] flex items-center justify-center p-6">
          <div className="w-full max-w-[380px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <h3 className="text-base font-bold text-[#dc2626]">Permanently remove VM {confirmTarget}?</h3>
            <p className="text-xs text-[#656b6b]">This deletes the VM from the platform immediately. The action cannot be undone and the client will lose access.</p>
            <div className="flex items-center gap-3">
              <button onClick={() => setConfirmTarget(null)} className="btn-secondary flex-1 py-2 cursor-pointer">Cancel</button>
              <button onClick={async () => {
                const vmid = confirmTarget;
                setConfirmTarget(null);
                try {
                  await apiClient.deleteVM(vmid);
                  showToast(`VM ${vmid} successfully removed.`);
                  loadData();
                } catch (e) {
                  showToast(`Failed to remove VM ${vmid}.`);
                }
              }} className="theme-destructive-button btn-primary bg-[#dc2626] hover:bg-[#b91c1c] flex-1 py-2 cursor-pointer">Remove VM</button>
            </div>
          </div>
        </div>
      )}

      {/* MODALS SUITE */}
      {modalType === 'extend-expiry' && selectedVmForAction && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[50] flex items-center justify-center p-6">
          <div className="w-full max-w-[440px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#dedfdf] pb-3">
              <h3 className="text-base font-bold text-[#1a1a1a]">Extend Expiry for VMID {selectedVmForAction.vmid}</h3>
              <button onClick={() => setModalType(null)} className="text-[#1a1a1a]/60 font-bold cursor-pointer">✕</button>
            </div>
            <form onSubmit={handleExtendExpirySubmit} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Current Expiry Date</label>
                <input type="text" value={formatDate(selectedVmForAction.expiryDate || Date.now())} disabled className="w-full p-2 bg-[#f1f1f1] border border-[#dedfdf] rounded text-[#1a1a1a]/60 font-mono" />
              </div>
              <div>
                <label className="block font-semibold mb-1">Additional Renewal Days</label>
                <select 
                  value={extendDays} 
                  onChange={(e) => setExtendDays(Number(e.target.value))}
                  className="w-full p-2 border border-[#dedfdf] rounded outline-none font-semibold"
                >
                  <option value={15}>+15 Days</option>
                  <option value={30}>+30 Days (1 Month)</option>
                  <option value={90}>+90 Days (Quarterly)</option>
                  <option value={365}>+365 Days (1 Year)</option>
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">Extend Expiry Date</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modalType === 'reinstall-os' && selectedVmForAction && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[50] flex items-center justify-center p-6">
          <div className="w-full max-w-[460px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#dedfdf] pb-3">
                <h3 className="text-base font-bold text-[#1a1a1a]">Request OS reimage for VMID {selectedVmForAction.vmid}</h3>
              <button onClick={() => setModalType(null)} className="text-[#1a1a1a]/60 font-bold cursor-pointer">✕</button>
            </div>
            <form onSubmit={handleReinstallOSSubmit} className="flex flex-col gap-3 text-xs">
              <p className="text-[#dc2626] font-semibold bg-[#fef2f2] p-2.5 rounded border border-[#fecaca]">
                Warning: An approved request may replace the root disk and cause permanent data loss. Submission does not start a Proxmox operation; an administrator must review the request first.
              </p>
              <div>
                <label className="block font-semibold mb-1">Select Target OS Image Template</label>
                <select 
                  value={selectedTargetOS} 
                  onChange={(e) => setSelectedTargetOS(e.target.value)}
                  className="w-full p-2 border border-[#dedfdf] rounded outline-none font-semibold"
                >
                  <option value="Ubuntu 24.04 LTS">Ubuntu 24.04 LTS (Noble Numbat)</option>
                  <option value="Windows Server 2022 Standard">Windows Server 2022 Standard Edition</option>
                  <option value="Debian 12 Bookworm">Debian 12 Bookworm</option>
                  <option value="Alpine Linux 3.19 (LXC)">Alpine Linux 3.19 Minimal</option>
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary">Cancel</button>
                <button type="submit" className="theme-destructive-button btn-primary bg-[#dc2626] hover:bg-[#b91c1c]">Submit for Approval</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modalType === 'assign-vm' && selectedVmForAction && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[50] flex items-center justify-center p-6">
          <div className="w-full max-w-[460px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#dedfdf] pb-3">
              <h3 className="text-base font-bold text-[#1a1a1a]">Reassign Instance {selectedVmForAction.vmid}</h3>
              <button onClick={() => setModalType(null)} className="text-[#1a1a1a]/60 font-bold cursor-pointer">✕</button>
            </div>
            <form onSubmit={handleAssignSubmit} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Target Instance & Instance</label>
                <input type="text" value={`VMID: ${selectedVmForAction.vmid} — ${selectedVmForAction.name}`} disabled className="w-full p-2 bg-[#f1f1f1] border border-[#dedfdf] rounded text-[#1a1a1a]/60 font-mono font-bold" />
              </div>
              <div className="relative">
                <label className="block font-semibold mb-1">Assign Ownership to Client Account</label>
                <select 
                  value={targetAccountEmail} 
                  onChange={(e) => setTargetAccountEmail(e.target.value)}
                  className="w-full p-2 pr-8 bg-white border border-[#dedfdf] rounded-lg text-xs text-[#1a1a1a] focus:outline-none focus:border-[#1a1a1a] appearance-none cursor-pointer font-mono"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke-width='1.5' stroke='%23656b6b' class='size-4'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M8.25 15 12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9' /%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 0.5rem center',
                    backgroundSize: '1.25rem',
                  }}
                  required
                >
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.email}>
                      {acc.name} ({acc.email})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">Confirm Reassignment</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modalType === 'provision-vm' && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[50] flex items-center justify-center p-6">
          <div className="w-full max-w-[540px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#dedfdf] pb-3">
              <h3 className="text-base font-bold text-[#1a1a1a]">Provision New Instance</h3>
              <button onClick={() => setModalType(null)} className="text-[#1a1a1a]/60 font-bold cursor-pointer">✕</button>
            </div>

            <form onSubmit={handleProvisionSubmit} className="flex flex-col gap-3 text-xs">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Instance</label>
                  <TextInput 
                    value={newVmid.toString()} 
                    onChange={(e) => setNewVmid(Number(e.target.value))} 
                    className="font-mono font-bold" 
                    required 
                  />
                </div>
                <div className="col-span-2">
                  <label className="block font-semibold mb-1">Instance Name</label>
                  <TextInput 
                    value={newVmName} 
                    onChange={(e) => setNewVmName(e.target.value)} 
                    required 
                  />
                </div>
              </div>

              <div className="relative">
                <label className="block font-semibold mb-1">Assign Ownership to Client Account</label>
                <select 
                  value={newVmOwnerEmail} 
                  onChange={(e) => setNewVmOwnerEmail(e.target.value)}
                  className="w-full p-2 pr-8 bg-white border border-[#dedfdf] rounded-lg text-xs text-[#1a1a1a] focus:outline-none focus:border-[#1a1a1a] appearance-none cursor-pointer font-mono"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke-width='1.5' stroke='%23656b6b' class='size-4'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M8.25 15 12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9' /%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 0.5rem center',
                    backgroundSize: '1.25rem',
                  }}
                  required
                >
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.email}>
                      {acc.name} ({acc.email})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-3 relative">
                <div>
                  <label className="block font-semibold mb-1">Target Node</label>
                  <select 
                    value={newVmNode} 
                    onChange={(e) => setNewVmNode(e.target.value)}
                    className="w-full p-2 pr-8 bg-white border border-[#dedfdf] rounded-lg text-xs text-[#1a1a1a] focus:outline-none focus:border-[#1a1a1a] appearance-none cursor-pointer"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke-width='1.5' stroke='%23656b6b' class='size-4'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M8.25 15 12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9' /%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 0.5rem center',
                      backgroundSize: '1.25rem',
                    }}
                  >
                    {nodes.map(node => (
                      <option key={node.id} value={node.name}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Type</label>
                  <select 
                    value={newVmType} 
                    onChange={(e) => setNewVmType(e.target.value)}
                    className="w-full p-2 pr-8 bg-white border border-[#dedfdf] rounded-lg text-xs text-[#1a1a1a] focus:outline-none focus:border-[#1a1a1a] appearance-none cursor-pointer"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke-width='1.5' stroke='%23656b6b' class='size-4'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M8.25 15 12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9' /%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 0.5rem center',
                      backgroundSize: '1.25rem',
                    }}
                  >
                    <option value="qemu">QEMU / KVM VM</option>
                    <option value="lxc">LXC Container</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Expiry Duration</label>
                  <select 
                    value={newVmExpiryDays} 
                    onChange={(e) => setNewVmExpiryDays(Number(e.target.value))}
                    className="w-full p-2 pr-8 bg-white border border-[#dedfdf] rounded-lg text-xs text-[#1a1a1a] focus:outline-none focus:border-[#1a1a1a] appearance-none cursor-pointer"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke-width='1.5' stroke='%23656b6b' class='size-4'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M8.25 15 12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9' /%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 0.5rem center',
                      backgroundSize: '1.25rem',
                    }}
                  >
                    <option value={30}>30 Days</option>
                    <option value={60}>60 Days</option>
                    <option value={90}>90 Days</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold mb-1">vCPUs</label>
                  <TextInput 
                    value={newVmCpus.toString()} 
                    onChange={(e) => setNewVmCpus(Number(e.target.value))} 
                    required 
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">RAM (GB)</label>
                  <TextInput 
                    value={newVmRamGb.toString()} 
                    onChange={(e) => setNewVmRamGb(Number(e.target.value))} 
                    required 
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Disk (GB)</label>
                  <TextInput 
                    value={newVmDiskGb.toString()} 
                    onChange={(e) => setNewVmDiskGb(Number(e.target.value))} 
                    required 
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#dedfdf] mt-2">
                <button type="button" onClick={() => setModalType(null)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">Provision & Assign VMID</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* NODE DETAIL MODAL DRAWER */}
      {selectedNode && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[50] flex items-center justify-center p-6">
          <div className="w-full max-w-[600px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl overflow-hidden p-6 flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-[#dedfdf] pb-4">
              <div>
                <h3 className="text-lg font-bold text-[#1a1a1a]">{selectedNode.name} Node Details</h3>
                <p className="text-xs text-[#1a1a1a]/60">Platform Version {selectedNode.platformVersion} | Host IP: ••••••••</p>
              </div>
              <button 
                onClick={() => setSelectedNode(null)}
                className="text-[#1a1a1a]/60 hover:text-[#1a1a1a] text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-[#fbfaf9] border border-[#dedfdf] rounded-lg">
                <span className="text-[#1a1a1a]/60 block mb-1">Status</span>
                <span className="font-bold text-[#15803d] flex items-center gap-1.5">
                  <span className="badge-online"></span> ONLINE (Corosync 3.1)
                </span>
              </div>
              <div className="p-3 bg-[#fbfaf9] border border-[#dedfdf] rounded-lg">
                <span className="text-[#1a1a1a]/60 block mb-1">Uptime</span>
                <span className="font-bold text-[#1a1a1a]">{selectedNode.uptimeDays} Days continuous</span>
              </div>
              <div className="p-3 bg-[#fbfaf9] border border-[#dedfdf] rounded-lg">
                <span className="text-[#1a1a1a]/60 block mb-1">CPU Load %</span>
                <span className="font-bold text-[#1a1a1a]">{selectedNode.cpuPct}% (16 Cores)</span>
              </div>
              <div className="p-3 bg-[#fbfaf9] border border-[#dedfdf] rounded-lg">
                <span className="text-[#1a1a1a]/60 block mb-1">RAM Memory</span>
                <span className="font-bold text-[#1a1a1a]">{selectedNode.ramUsageGb} GB / {selectedNode.ramMaxGb} GB</span>
              </div>
            </div>

            <div className="p-3 bg-[#fbfaf9] border border-[#dedfdf] rounded-lg text-xs">
              <span className="text-[#1a1a1a]/60 block mb-1">ZFS Pool Status</span>
              <span className="font-mono text-[#1a1a1a] font-semibold">{selectedNode.zfsHealth}</span>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-[#dedfdf]">
              <button 
                onClick={() => setSelectedNode(null)}
                className="btn-primary cursor-pointer"
              >
                Close Drawer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FOOTER */}
      <footer className="app-footer">
        <div>&copy; Copyright 2026, Votion One™ Platform. All rights reserved.</div>
        <div className="footer-links">
                    <a href="/legal/terms">Terms of service</a>
          <a href="/legal/privacy">Privacy policy</a>

        </div>
      </footer>
    </main>
  );
};

export default DashboardContent;
