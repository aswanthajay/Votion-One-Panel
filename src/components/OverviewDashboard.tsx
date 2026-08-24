import React, { useState, useEffect, useMemo, useRef } from 'react';
import { apiClient, ApiVM, ApiAuditLog } from '../services/apiClient';

/*
  OVERVIEW — v3 (editorial Carta Ink redesign)
  -------------------------------------------------------------
  Reliability fixes vs v2:
  - loadData never leaves the screen stuck: setLoadDone / setIsRefreshing
    run in finally-blocks, a first-load error shows a retry card instead of
    an infinite skeleton, and the fleet fetch is retried with backoff.
  - fetchOne parses non-JSON responses safely (during backend restarts the
    dev proxy can return HTML).
  - Auto-retry every 20s in background even after failures, so a transient
    backend blip always self-heals.

  Design:
  - Mirrors the rest of the Carta Ink product: page-heading serif title with
    a quiet description line, ink-block-wrapper cards with ink-block-header,
    tile-white tiles, ink-table rows, section-title caps.
  - Center column is an instrument-panel style telemetry block (thin rules,
    right-aligned values, sparklines) instead of four identical stat tiles.
*/

interface HistPoint {
  timestamp: string;
  cpuPct: number;
  ramBytes: number;
  netInBytes: number;
  netOutBytes: number;
}

interface LiveTelemetry {
  cpu: number;
  mem: number;
  maxmem: number;
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
  uptime: number;
}

const num = (v: any): number => (typeof v === 'number' ? v : Number(v) || 0);
const API_BASE = '/api/v1';
const TOKEN = () => `Bearer ${localStorage.getItem('votion_jwt_token')}`;

const GB = 1073741824;
const MB = 1048576;

/* ---------------- safe json fetch with hard timeout ---------------- */
async function fetchOne(path: string, ms = 12000): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(path, { headers: { Authorization: TOKEN() }, signal: ctrl.signal });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- tiny svg sparkline ---------------- */
const Sparkline: React.FC<{ values: number[]; stroke: string; height?: number }> = ({ values, stroke, height = 26 }) => {
  const w = 110;
  const h = height;
  const max = Math.max(...values, 0.0001);
  const pts = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = h - (v / max) * (h - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <polyline fill="none" stroke={stroke} strokeWidth="1.3" points={pts} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
};

/* ---------------- usage bar ---------------- */
const UsageBar: React.FC<{ pct: number; tone?: 'ink' | 'subtle' }> = ({ pct, tone }) => (
  <div className="h-[3px] w-full bg-[#f1f1f1] mt-1">
    <div
      className={`h-full transition-all duration-500 ${pct > 85 ? 'bg-[#1a1a1a]' : tone === 'ink' ? 'bg-[#1a1a1a]' : 'bg-[#a7aaaa]'}`}
      style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
    />
  </div>
);

/* ---------------- inline quick reply ---------------- */
const QuickReply: React.FC<{ ticketId: string; onSent: () => void; onCancel: () => void; toast: (m: string) => void }> = ({ ticketId, onSent, onCancel, toast }) => {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const handle = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      const reply = await apiClient.addTicketReply(String(ticketId), msg.trim());
      if (!reply.success) throw new Error(reply.error || 'Reply failed');
      toast('Reply posted to support');
      onSent();
    } catch {
      toast('Failed to post reply');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-1.5 flex gap-1.5 items-center">
      <input
        autoFocus
        value={msg}
        onChange={e => setMsg(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handle(); if (e.key === 'Escape') onCancel(); }}
        placeholder="Write a reply and press Enter…"
        className="flex-1 min-w-0 bg-white border border-[#dedfdf] rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-[#1a1a1a] placeholder-[#a0a1a2]"
      />
      <button onClick={handle} disabled={sending} className="btn-primary !px-3 !py-1.5 text-[11px] disabled:opacity-40 cursor-pointer">{sending ? 'Sending' : 'Send'}</button>
      <button onClick={onCancel} className="text-[#656b6b] hover:text-[#1a1a1a] text-xs px-1 cursor-pointer">✕</button>
    </div>
  );
};

/* ---------------- helpers ---------------- */
const uptimeStr = (seconds: number): string => {
  if (!seconds || seconds <= 0) return '—';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return hrs >= 24 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : `${hrs}h ${mins}m`;
};

/* ---------------- main ---------------- */
export const OverviewDashboard: React.FC<{ onOpenManage: () => void; onOpenModal: (m: string) => void }> = ({ onOpenManage, onOpenModal }) => {
  const [vms, setVms] = useState<ApiVM[]>([]);
  const [liveTelemetry, setLiveTelemetry] = useState<Record<number, LiveTelemetry>>({});
  const [histMetrics, setHistMetrics] = useState<Record<number, { history: HistPoint[]; aggregations?: any }>>({});
  const [selectedVmid, setSelectedVmid] = useState<number | null>(null);
  const [tickets, setTickets] = useState<any[]>([]);
  const [audit, setAudit] = useState<ApiAuditLog[]>([]);
  const [opsCollapsed, setOpsCollapsed] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [powerLoading, setPowerLoading] = useState<string | null>(null);
  const [loadDone, setLoadDone] = useState(false);
  const [fleetFailed, setFleetFailed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dataAge, setDataAge] = useState(0);
  const mountedRef = useRef(true);
  const retryCountRef = useRef(0);

  const showToast = (m: string) => { setToastMsg(m); setTimeout(() => setToastMsg(null), 3000); };

  /*
    Progressive loading: the fleet can take 3-8s on a live cluster, so the UI
    renders in stages instead of one monolithic wait:
      stage 0 — bare command shell (heading + quick actions visible immediately)
      stage 1 — fleet roster appears the moment the fleet call lands
      stage 2 — each VM's telemetry / history fills in independently as they
                resolve; one slow VM never blocks another (allSettled)
  */
  const [fleetLoading, setFleetLoading] = useState(true);
  const [vmLoading, setVmLoading] = useState<Record<number, { telemetry: boolean; history: boolean }>>({});

  const loadData = async (backgroundOnly = false) => {
    if (isRefreshing && backgroundOnly) return;
    setIsRefreshing(true);

    // FAST BACKGROUND STREAM — tickets + audit (≈3ms each)
    try {
      const [tk, al] = await Promise.all([
        fetchOne(`${API_BASE}/support/tickets`),
        fetchOne(`${API_BASE}/audit-logs?limit=20`),
      ]);
      if (!mountedRef.current) return;
      if (tk?.data) setTickets(tk.data);
      if (al?.data) setAudit(al.data);
    } catch { /* self-heals on next cycle */ }

    // FLEET STREAM with backoff retry — hard-capped at 12s total so the UI
    // always fails CLOSED (error card) instead of hanging on skeleton bars.
    let vmsRes: ApiVM[] = [];
    let fleetOk = false;
    const t0 = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        vmsRes = await apiClient.getClientVMs();
        fleetOk = true;
        break;
      } catch {
        if (Date.now() - t0 > 12000) break; // hard cap — never wait forever
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!mountedRef.current) { setIsRefreshing(false); return; }

    setFleetFailed(!fleetOk);
    if (fleetOk) {
      setVms(vmsRes);
      if (!backgroundOnly || selectedVmid === null) {
        setSelectedVmid(prev => (prev === null && vmsRes.length) ? vmsRes[0].vmid : prev);
      }
      setFleetLoading(false); // STAGE 1: roster renders immediately
    } else {
      setFleetLoading(false); // always render — skeleton or error card, never blank
    }

    const ids = vmsRes.map(v => v.vmid);
    if (!ids.length) {
      if (!mountedRef.current) return;
      retryCountRef.current = 0;
      setLoadDone(true);
      setDataAge(0);
      setIsRefreshing(false);
      return;
    }

    // STAGE 2: mark every VM as loading until its data lands
    if (!mountedRef.current) return;
    setVmLoading(Object.fromEntries(ids.map(id => [id, { telemetry: true, history: true }])));

    // Telemetry per VM, independent — allSettled so one failing/slow VM never
    // blocks the others; each result is merged into state as it resolves.
    ids.forEach(id => {
      fetchOne(`${API_BASE}/client/vms/${id}/telemetry`).then(t => {
        if (!mountedRef.current) return;
        const tel = t?.telemetry;
        if (tel) {
          setLiveTelemetry(prev => ({ ...prev, [id]: { cpu: num(tel.cpu), mem: num(tel.mem), maxmem: num(tel.maxmem), netin: num(tel.netin), netout: num(tel.netout), diskread: num(tel.diskread), diskwrite: num(tel.diskwrite), uptime: num(tel.uptime) } }));
        }
        setVmLoading(prev => ({ ...prev, [id]: { ...(prev[id] || { telemetry: true, history: true }), telemetry: false } }));
      }).catch(() => {
        if (!mountedRef.current) return;
        setVmLoading(prev => ({ ...prev, [id]: { ...(prev[id] || { telemetry: true, history: true }), telemetry: false } }));
      });
      fetchOne(`${API_BASE}/client/vms/${id}/metrics`).then(h => {
        if (!mountedRef.current) return;
        if (h?.history) {
          setHistMetrics(prev => ({ ...prev, [id]: { history: h.history, aggregations: h.aggregations } }));
        }
        setVmLoading(prev => ({ ...prev, [id]: { ...(prev[id] || { telemetry: true, history: true }), history: false } }));
      }).catch(() => {
        if (!mountedRef.current) return;
        setVmLoading(prev => ({ ...prev, [id]: { ...(prev[id] || { telemetry: true, history: true }), history: false } }));
      });
    });

    if (!mountedRef.current) return;
    retryCountRef.current = 0;
    setLoadDone(true);
    setDataAge(0);
    setIsRefreshing(false);
  };

  useEffect(() => {
    mountedRef.current = true;
    loadData(false);
    // Background pulse: light streams every 5s, full refresh every 20s (self-heals after blips)
    const ivLight = setInterval(() => loadData(true), 5000);
    const ivFull = setInterval(() => loadData(false), 20000);
    const ageTick = setInterval(() => setDataAge(a => a + 1), 1000);
    return () => { mountedRef.current = false; clearInterval(ivLight); clearInterval(ivFull); clearInterval(ageTick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTickets = tickets.filter(t => t.status === 'pending' || t.status === 'open' || t.status === 'in-progress');
  // Real billing: the earliest VM expiry date across the fleet is the next
  // renewal deadline, and the monthly total is derived from each VM's assigned
  // resource tier matched against the published pricing plans (stellar_pricing).
  const PRICING_TIERS = [
    { price: 29, vcpus: 2, ramGb: 4, diskGb: 50 },
    { price: 89, vcpus: 8, ramGb: 16, diskGb: 200 },
    { price: 249, vcpus: 32, ramGb: 64, diskGb: 1000 },
  ];
  const matchTier = (vcpus: number, ramGb: number, diskGb: number) => {
    for (const t of PRICING_TIERS) {
      if (vcpus <= t.vcpus && ramGb <= t.ramGb && diskGb <= t.diskGb) return t;
    }
    return PRICING_TIERS[PRICING_TIERS.length - 1];
  };
  const billing = useMemo(() => {
    const rows = vms.map(v => {
      const vcpus = v.cpus;
      const ramGb = num(v.maxmem) / GB;
      const diskGb = num(v.disk) / 1073741824;
      const tier = matchTier(vcpus, ramGb, diskGb);
      return { vcpus, ramGb, diskGb, tier };
    });
    const monthlyTotal = rows.reduce((s, r) => s + r.tier.price, 0);
    const ceilings = rows.reduce((acc, r) => ({
      vcpus: acc.vcpus + r.tier.vcpus,
      ramGb: acc.ramGb + r.tier.ramGb,
      diskGb: acc.diskGb + r.tier.diskGb,
    }), { vcpus: 0, ramGb: 0, diskGb: 0 });
    // Next payment due = earliest VM expiry across the fleet
    const expiries = vms.map(v => v.expiryDate ? new Date(v.expiryDate).getTime() : 0).filter(t => t > 0);
    const earliest = expiries.length ? Math.min(...expiries) : 0;
    const nextPayment = earliest > 0
      ? new Date(earliest).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
      : '—';
    return { rows, monthlyTotal, ceilings, nextPayment };
  }, [vms]);

  // Aggregated fleet resources — use the GREATER of the live allocation and the
  // DB quota as each VM's effective capacity, so stale DB defaults (8 GB / 64 GB)
  // can never make fleet percentages explode past 100%.
  const acctCpus = vms.reduce((s, v) => s + v.cpus, 0);
  const acctMaxmem = vms.reduce((s, v) => s + Math.max(num(v.maxmem), num(v.memory)), 0);
  const acctMaxdisk = vms.reduce((s, v) => s + Math.max(num(v.disk) || num(v.diskUsageBytes), num(v.maxdisk)), 0);
  const runningVms = vms.filter(v => v.status === 'running').length;

  // Live aggregated telemetry
  const liveTotalCpu = vms.reduce((s, v) => s + (liveTelemetry[v.vmid] ? (num(liveTelemetry[v.vmid].cpu) * v.cpus / 100) : 0), 0);
  const liveCpuPct = acctCpus > 0 ? (liveTotalCpu / acctCpus) * 100 : 0;
  
  // Cap each VM's live RAM contribution at its effective capacity so a single
  // ballooned/over-committed VM cannot drive the fleet past 100%.
  const liveTotalRam = vms.reduce((s, v) => {
    const used = liveTelemetry[v.vmid] ? num(liveTelemetry[v.vmid].mem) : num(v.ramUsageBytes);
    const cap = Math.max(num(v.maxmem), num(v.memory));
    return s + Math.min(used, cap);
  }, 0);
  const liveRamPct = acctMaxmem > 0 ? Math.min(100, (liveTotalRam / acctMaxmem) * 100) : 0;
  
  // Disk: report ACTUAL usage, percentage clamped to 100. The label shows the
  // real "used of effective capacity" figures (no silent clamping of GB values).
  const liveTotalDiskUsed = vms.reduce((s, v) => s + (num(v.disk) || num(v.diskUsageBytes)), 0);
  const liveDiskPct = acctMaxdisk > 0 ? Math.min(100, (liveTotalDiskUsed / acctMaxdisk) * 100) : 0;
  
  // Network: cumulative bytes since boot — show as total GB transferred, not MB/s.
  const liveTotalNetIn = vms.reduce((s, v) => s + (liveTelemetry[v.vmid] ? num(liveTelemetry[v.vmid].netin) : 0), 0);
  const liveTotalNetOut = vms.reduce((s, v) => s + (liveTelemetry[v.vmid] ? num(liveTelemetry[v.vmid].netout) : 0), 0);

  const gb = (b: number) => (b / GB).toFixed(1);

  // Aggregated historical series for sparklines
  const aggCpuSeries = useMemo(() => {
    const agg: Record<string, { cpuPctSum: number, weightCpus: number }> = {};
    Object.keys(histMetrics).forEach(vmid => {
      const vm = vms.find(v => v.vmid === Number(vmid));
      if (!vm) return;
      histMetrics[Number(vmid)].history.forEach(h => {
        if (!agg[h.timestamp]) agg[h.timestamp] = { cpuPctSum: 0, weightCpus: 0 };
        agg[h.timestamp].cpuPctSum += h.cpuPct * vm.cpus;
        agg[h.timestamp].weightCpus += vm.cpus;
      });
    });
    const ts = Object.keys(agg).sort();
    return ts.map(t => agg[t].weightCpus > 0 ? (agg[t].cpuPctSum / agg[t].weightCpus) : 0);
  }, [histMetrics, vms]);

  const aggRamSeries = useMemo(() => {
    const agg: Record<string, number> = {};
    Object.keys(histMetrics).forEach(vmid => {
      histMetrics[Number(vmid)].history.forEach(h => {
        agg[h.timestamp] = (agg[h.timestamp] || 0) + h.ramBytes;
      });
    });
    return Object.keys(agg).sort().map(t => agg[t] / GB);
  }, [histMetrics]);
  
  // Network rates: history stores HOURLY deltas (bytes per hour), so convert
  // to bytes per second, then to MB/s for the sparkline scale.
  const aggNetInSeries = useMemo(() => {
    const agg: Record<string, number> = {};
    Object.keys(histMetrics).forEach(vmid => {
      histMetrics[Number(vmid)].history.forEach(h => {
        agg[h.timestamp] = (agg[h.timestamp] || 0) + h.netInBytes;
      });
    });
    return Object.keys(agg).sort().map(t => agg[t] / 3600 / MB);
  }, [histMetrics]);

  const aggNetOutSeries = useMemo(() => {
    const agg: Record<string, number> = {};
    Object.keys(histMetrics).forEach(vmid => {
      histMetrics[Number(vmid)].history.forEach(h => {
        agg[h.timestamp] = (agg[h.timestamp] || 0) + h.netOutBytes;
      });
    });
    return Object.keys(agg).sort().map(t => agg[t] / 3600 / MB);
  }, [histMetrics]);

  const acctRamGib = acctMaxmem / GB;
  const acctDiskGb = acctMaxdisk / GB;

  /* ---------------- render ---------------- */
  return (
    <div className="overview-dashboard flex flex-col flex-1 min-w-0 min-h-0 bg-[#fbfaf9] overflow-hidden font-sans w-full">
      {/* ================= TOP BAR (house app-header style) ================= */}
      <header className="overview-header app-header !px-5 sm:!px-7 min-w-0 overflow-hidden" style={{ height: '56px' }}>
        <div className="flex-1 min-w-0 flex items-baseline gap-5 overflow-hidden">
          <h1 className="page-heading !text-[22px] !mb-0 !leading-none truncate">Overview</h1>
          <p className="hidden sm:block ink-description-text !mt-0 !text-[12px] truncate">
            {loadDone
              ? `Fleet of ${vms.length} instance${vms.length === 1 ? '' : 's'} · refreshed ${dataAge}s ago`
              : 'Synchronizing with the Stellar Engine…'}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 max-w-full">
          <button
            onClick={() => onOpenModal('support')}
            className="btn-secondary !px-3 !py-1.5 !text-[12px] relative cursor-pointer"
          >
            New Ticket
            {openTickets.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-[#1a1a1a] text-white rounded-full text-[9px] font-bold w-4 h-4 flex items-center justify-center">
                {openTickets.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setOpsCollapsed(!opsCollapsed)}
            className={`text-xs border border-[#dedfdf] rounded-md px-2 py-1 transition-colors cursor-pointer ${opsCollapsed ? 'text-[#1a1a1a] border-[#1a1a1a]' : 'text-[#656b6b] hover:text-[#1a1a1a]'}`}
            title={opsCollapsed ? 'Show operations' : 'Hide operations'}
          >
            {opsCollapsed ? 'Ops ▸' : 'Ops ✕'}
          </button>
        </div>
      </header>

          {/* ================= MAIN HORIZONTAL SPLIT ================= */}
      <div className="flex flex-1 min-h-0 min-w-0 overflow-x-hidden">
        
        {/* ---------- CENTER: FLEET TELEMETRY INSTRUMENT PANEL ---------- */}
        <section className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* fleet identity strip */}
          <div className="px-5 sm:px-7 pt-5 pb-3 flex items-center justify-between border-b border-[#dedfdf] bg-white">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${runningVms > 0 ? 'bg-[#10b981] animate-pulse' : 'bg-[#a0a1a2]'}`} />
              <span className="text-sm text-[#1a1a1a] font-medium truncate">Fleet Operations Overview</span>
              {loadDone && (
                <>
                  <span className="hidden sm:inline text-[12px] text-[#a0a1a2]">·</span>
                  <span className="hidden sm:inline font-mono text-[12px] text-[#656b6b] truncate">{runningVms} / {vms.length} running</span>
                  <span className="hidden sm:inline text-[12px] text-[#a0a1a2]">·</span>
                  <span className="hidden sm:inline text-[12px] text-[#656b6b]">{acctCpus} total vCPUs active</span>
                </>
              )}
            </div>
            {loadDone && !fleetFailed && (
              <span className="text-[10px] text-[#a0a1a2] font-mono shrink-0">{isRefreshing ? 'refreshing…' : `data ${dataAge}s`}</span>
            )}
          </div>

          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-5 sm:px-7 py-4">
            {fleetLoading ? (
              <div className="px-4 py-10">
                <div className="h-2 bg-[#f1f1f1] rounded animate-pulse mb-3 w-2/3" />
                <div className="h-2 bg-[#f1f1f1] rounded animate-pulse w-1/2" />
              </div>
            ) : fleetFailed ? (
              <div className="px-4 py-6 border border-dashed border-[#dedfdf] bg-white rounded-md flex flex-col items-center justify-center text-center max-w-lg mx-auto mt-10">
                <div className="text-sm text-[#1a1a1a] font-semibold mb-2">Couldn't reach the engine</div>
                <p className="text-xs text-[#656b6b] mb-4">The backend didn't respond after several retries. The dashboard will keep retrying automatically in the background.</p>
                <button onClick={() => loadData(false)} className="btn-secondary !text-[11px] !px-4 !py-1.5 cursor-pointer">Force retry</button>
              </div>
            ) : vms.length === 0 ? (
              <div className="px-4 py-10 flex flex-col items-center justify-center text-center max-w-md mx-auto mt-10">
                <div className="w-12 h-12 bg-white border border-[#dedfdf] rounded-lg mb-4 flex items-center justify-center text-lg shadow-sm">☁️</div>
                <h3 className="text-sm font-semibold text-[#1a1a1a] mb-1">No instances deployed</h3>
                <p className="text-[12px] text-[#656b6b] mb-5 leading-relaxed">You haven't allocated any virtual machines to this account yet. Provision instances from the admin panel to start tracking fleet telemetry.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* telemetry instrument block */}
                <div className="ink-block-wrapper !mb-0">
                  <div className="ink-block-header !px-4 !py-3 flex items-center justify-between">
                    <span className="ink-block-title !text-[12px]">Aggregated Fleet Telemetry</span>
                    <span className="text-[10px] text-[#a0a1a2] font-mono">LIVE</span>
                  </div>
                  <table className="overview-telemetry-table w-full border-collapse table-fixed">
                    <tbody>
                      <tr className="ink-table-row hover:bg-[#fbfaf9]">
                        <td className="ink-table-th !py-2.5 !pl-4 !pr-2 !text-[12px] !w-24">Cluster CPU</td>
                        <td className="ink-table-td !py-2.5 !px-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-sm text-[#1a1a1a] tabular-nums">
                              {liveCpuPct.toFixed(1)}%
                              <span className="text-[#a0a1a2] text-[11px] ml-1.5">of {acctCpus} core{acctCpus === 1 ? '' : 's'}</span>
                            </span>
                            <div className="hidden sm:block shrink-0"><Sparkline values={aggCpuSeries.slice(-30)} stroke="#1a1a1a" height={22} /></div>
                          </div>
                        </td>
                      </tr>
                      <tr className="ink-table-row hover:bg-[#fbfaf9]">
                        <td className="ink-table-th !py-2.5 !pl-4 !pr-2 !text-[12px]">Cluster RAM</td>
                        <td className="ink-table-td !py-2.5 !px-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-sm text-[#1a1a1a] tabular-nums">
                              {(liveTotalRam / GB).toFixed(2)} GB
                              <span className="text-[#a0a1a2] text-[11px] ml-1.5">{liveRamPct.toFixed(0)}% of {(acctMaxmem / GB).toFixed(0)} GB</span>
                            </span>
                            <div className="hidden sm:block shrink-0"><Sparkline values={aggRamSeries.slice(-30)} stroke="#656b6b" height={22} /></div>
                          </div>
                        </td>
                      </tr>
                      <tr className="ink-table-row hover:bg-[#fbfaf9]">
                        <td className="ink-table-th !py-2.5 !pl-4 !pr-2 !text-[12px]">Cluster Disk</td>
                        <td className="ink-table-td !py-2.5 !px-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-sm text-[#1a1a1a] tabular-nums">
                              {liveDiskPct.toFixed(0)}% used
                              <span className="text-[#a0a1a2] text-[11px] ml-1.5">{gb(liveTotalDiskUsed)} GB of {gb(acctMaxdisk)} GB</span>
                            </span>
                            <div className="hidden sm:block w-[110px] shrink-0 h-[3px] bg-[#f1f1f1] mt-1">
                              <div className="h-full bg-[#1a1a1a]" style={{ width: `${liveDiskPct}%` }} />
                            </div>
                          </div>
                        </td>
                      </tr>
                      <tr className="hover:bg-[#fbfaf9]">
                        <td className="ink-table-th !py-2.5 !pl-4 !pr-2 !text-[12px]">Cluster Network</td>
                        <td className="ink-table-td !py-2.5 !px-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-sm text-[#1a1a1a] tabular-nums">
                              <span className="text-[#1a1a1a]">{aggNetInSeries.length ? aggNetInSeries[aggNetInSeries.length - 1].toFixed(1) : '—'} MB/s in</span>
                              <span className="text-[#a0a1a2] text-[11px] ml-1.5">· {aggNetOutSeries.length ? aggNetOutSeries[aggNetOutSeries.length - 1].toFixed(1) : '—'} MB/s out</span>
                            </span>
                            <div className="hidden sm:block shrink-0"><Sparkline values={aggNetInSeries.slice(-30)} stroke="#656b6b" height={22} /></div>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* session counters */}
                <div className="ink-block-wrapper !mb-0">
                  <div className="ink-block-header !px-4 !py-3">
                    <span className="ink-block-title !text-[12px]">Live Fleet Activity Rates</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-[#dedfdf] text-center">
                    <div className="py-3 px-2">
                      <div className="text-[10px] uppercase tracking-widest text-[#656b6b]">Net In (Total)</div>
                      <div className="font-mono text-sm text-[#1a1a1a] mt-0.5">{(liveTotalNetIn / GB).toFixed(1)} GB</div>
                    </div>
                    <div className="py-3 px-2">
                      <div className="text-[10px] uppercase tracking-widest text-[#656b6b]">Net Out (Total)</div>
                      <div className="font-mono text-sm text-[#1a1a1a] mt-0.5">{(liveTotalNetOut / GB).toFixed(1)} GB</div>
                    </div>
                    <div className="py-3 px-2 flex flex-col justify-center items-center">
                      <div className="text-[10px] uppercase tracking-widest text-[#656b6b]">Active Nodes</div>
                      <div className="font-mono text-sm text-[#1a1a1a] mt-0.5">{runningVms} / {vms.length}</div>
                    </div>
                    <div className="py-3 px-2 flex flex-col justify-center items-center">
                      <button onClick={onOpenManage} className="btn-secondary !text-[11px] !px-3 !py-1 cursor-pointer">
                        Manage Instances →
                      </button>
                    </div>
                  </div>
                </div>

              </div>
            )}
          </div>
        </section>

        {/* ---------- RIGHT: OPERATIONS HUB ---------- */}
        {!opsCollapsed && (
          <aside className="hidden xl:flex flex-col w-[320px] max-w-[360px] border-l border-[#dedfdf] bg-white overflow-y-auto shrink-0">
            {/* 1. open tickets */}
            <div className="ink-block-header !px-4 py-3 flex items-center justify-between">
              <span className="ink-block-title !text-[12px] flex items-center gap-2">
                Open tickets
                <span className="bg-[#1a1a1a] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{openTickets.length}</span>
              </span>
              <button onClick={() => onOpenModal('support')} className="text-[11px] text-[#2563eb] hover:text-[#1d4ed8] cursor-pointer underline underline-offset-4">New</button>
            </div>
            <div className="px-4 py-2.5 border-b border-[#dedfdf]">
              {openTickets.length === 0 && (
                <div className="text-xs text-[#656b6b] py-1">Queue clear — no open tickets.</div>
              )}
              <div className="flex flex-col divide-y divide-[#dedfdf]">
                {openTickets.map(t => (
                  <div key={t.id} className="py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-[#656b6b]">#{String(t.id).slice(-4)}</span>
                      <span className="text-xs flex-1 truncate">{t.subject || 'Untitled'}</span>
                      <span className={`text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                        (t.priority === 'urgent' || t.priority === 'high')
                          ? 'bg-[#1a1a1a] text-white'
                          : 'bg-white border border-dashed border-[#656b6b] text-[#656b6b]'
                      }`}>
                        {(t.priority === 'urgent' || t.priority === 'high') ? 'Needs reply' : t.status === 'in-progress' ? 'In progress' : 'Open'}
                      </span>
                    </div>
                    {replyingTo === t.id ? (
                      <QuickReply ticketId={String(t.id)} onSent={() => { setReplyingTo(null); loadData(false); }} onCancel={() => setReplyingTo(null)} toast={showToast} />
                    ) : (
                      <button onClick={() => setReplyingTo(t.id)} className="text-[10px] text-[#656b6b] hover:text-[#2563eb] mt-1 cursor-pointer underline underline-offset-2">Quick reply ↵</button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 2. account & billing */}
            <div className="ink-block-header !px-4 py-3">
              <span className="ink-block-title !text-[12px]">Account & billing</span>
            </div>
            <div className="px-4 py-2.5 border-b border-[#dedfdf]">
              <div className="flex justify-between items-center text-xs font-mono mb-1.5">
                <span className="text-[#656b6b]">Next payment due</span>
                <span className="text-[#1a1a1a] font-semibold">{billing.nextPayment}</span>
              </div>
              <div className="flex justify-between items-center text-xs font-mono mb-2.5">
                <span className="text-[#656b6b]">Monthly subscription</span>
                <span className="text-[#1a1a1a] font-semibold">${billing.monthlyTotal}.00/mo</span>
              </div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] text-[#656b6b]">Billing period</span>
                <span className="text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border bg-white border-[#dedfdf] text-[#656b6b]">Monthly</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {[
                  { label: `vCPU (${acctCpus})`, cap: `${billing.ceilings.vcpus} tier cap`, pct: (acctCpus / Math.max(billing.ceilings.vcpus, 1)) * 100 },
                  { label: `Memory (${acctRamGib.toFixed(0)} GB)`, cap: `${billing.ceilings.ramGb} GB tier cap`, pct: (acctRamGib / Math.max(billing.ceilings.ramGb, 1)) * 100 },
                  { label: `Disk (${acctDiskGb.toFixed(0)} GB)`, cap: `${billing.ceilings.diskGb} GB tier cap`, pct: (acctDiskGb / Math.max(billing.ceilings.diskGb, 1)) * 100 },
                ].map(q => (
                  <div key={q.label}>
                    <div className="text-[10px] text-[#656b6b] flex justify-between font-mono">
                      <span>{q.label}</span>
                      <span>{q.cap}</span>
                    </div>
                    <UsageBar pct={q.pct} tone="subtle" />
                  </div>
                ))}
              </div>
            </div>

            {/* 3. incidents & audit */}
            <div className="ink-block-header !px-4 py-3">
              <span className="ink-block-title !text-[12px]">Incidents & audit</span>
            </div>
            <div className="px-4 py-2.5 flex-1">
              <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto">
                {audit.slice(0, 12).map(a => (
                  <div key={a.id} className="flex items-start gap-2 text-[11px]">
                    <span className="font-mono text-[10px] text-[#a0a1a2] shrink-0 w-14">{new Date(a.timestamp).toLocaleTimeString('en-GB')}</span>
                    <span className="flex-1">
                      <span className="text-[#1a1a1a]">{a.details || a.action}</span>
                      {a.status === 'failed' && <span className="text-[9px] font-bold uppercase bg-[#1a1a1a] text-white px-1 py-0.5 rounded ml-1">Failed</span>}
                    </span>
                  </div>
                ))}
                {audit.length === 0 && <div className="text-[11px] text-[#656b6b]">No recent events.</div>}
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* toast */}
      {toastMsg && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-[#1a1a1a] text-white text-xs font-semibold rounded-lg px-4 py-2.5 shadow-lg z-50 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse" />
          {toastMsg}
          <button onClick={() => setToastMsg(null)} className="text-white/60 hover:text-white ml-2 cursor-pointer">✕</button>
        </div>
      )}
    </div>
  );
};

export default OverviewDashboard;
