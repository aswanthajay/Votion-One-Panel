import React, { useState, useEffect, useMemo } from 'react';
import { apiClient } from '../services/apiClient';

interface OvhStatus {
  ip: string;
  reverse: string | null;
  ddos: {
    state: string;
    mode: 'automatic' | 'permanent';
  };
  firewall: {
    enabled: boolean;
    state: string;
  };
  mitigationProfile?: {
    autoMitigationTimeOut: number;
    state: string;
  } | null;
}

interface FirewallRule {
  sequence: number;
  action: 'permit' | 'deny';
  protocol: 'tcp' | 'udp' | 'icmp' | 'ipv4';
  sourcePort?: string;
  destinationPort?: string;
  source?: string;
  state: string;
}

interface GameRule {
  id: number;
  fromPort?: number | null;
  toPort?: number | null;
  gameType?: string | null;
  l4Protocol?: string;
}

export const OvhManager: React.FC = () => {
  const [ipInput, setIpInput] = useState('');
  const [activeIp, setActiveIp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OVH Account IPs list
  const [ovhIps, setOvhIps] = useState<string[]>([]);
  const [loadingIps, setLoadingIps] = useState(false);

  // Status & Tab state
  const [status, setStatus] = useState<OvhStatus | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'firewall' | 'game'>('general');

  // rDNS state
  const [rdnsValue, setRdnsValue] = useState('');
  const [rdnsUpdating, setRdnsUpdating] = useState(false);

  // DDoS Mitigation state
  const [ddosUpdating, setDdosUpdating] = useState(false);

  // VAC Auto Mitigation Timeout state
  const [mitigationTimeout, setMitigationTimeout] = useState<number>(15);
  const [mitigationUpdating, setMitigationUpdating] = useState(false);
  const [mitigationProfileNotProvisioned, setMitigationProfileNotProvisioned] = useState(false);

  // Edge Firewall state
  const [fwToggling, setFwToggling] = useState(false);
  const [fwRules, setFwRules] = useState<FirewallRule[]>([]);
  const [loadingFwRules, setLoadingFwRules] = useState(false);
  const [fwRulesSupported, setFwRulesSupported] = useState(true);

  // Edge Firewall form
  const [newSeq, setNewSeq] = useState<number>(0);
  const [newAction, setNewAction] = useState<'permit' | 'deny'>('permit');
  const [newProto, setNewProto] = useState<'tcp' | 'udp' | 'icmp' | 'ipv4'>('tcp');
  const [newSrcPort, setNewSrcPort] = useState('');
  const [newDstPort, setNewDstPort] = useState('');
  const [newSrcIp, setNewSrcIp] = useState('');
  const [ruleSubmitting, setRuleSubmitting] = useState(false);

  // Game DDoS state
  const [gameRules, setGameRules] = useState<GameRule[]>([]);
  const [loadingGameRules, setLoadingGameRules] = useState(false);
  const [gameDdosSupported, setGameDdosSupported] = useState(true);

  // Game DDoS form
  const [gameFromPort, setGameFromPort] = useState<number | ''>('');
  const [gameToPort, setGameToPort] = useState<number>(25565);
  const [gameProto, setGameProto] = useState<'tcp' | 'udp'>('udp');
  const [gameProfile, setGameProfile] = useState('minecraft');
  const [gameSubmitting, setGameSubmitting] = useState(false);

  // Permission error state
  const [permissionError, setPermissionError] = useState(false);

  // Toast / notification message
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showToast = (type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 5000);
  };

  // Helper to format Game Profile name nicely (with safe null/undefined check)
  const formatGameProfile = (profile?: string | null): string => {
    if (!profile) return 'Standard UDP Filter';
    const mapping: Record<string, string> = {
      // Exact OVH API-returned strings (already lowercased + stripped)
      'minecraft': 'Minecraft Pocket / Java',
      'minecraftpocketedition': 'Minecraft Pocket Edition',
      'minecraftjava': 'Minecraft Java Edition',
      'minecraftquery': 'Minecraft Query',
      'rust': 'Rust Server',
      'gta5': 'GTA V / FiveM / RageMP',
      'gtav': 'GTA V / FiveM',
      'valve': 'Valve Source Engine (CS, GMod, TF2)',
      'teamspeak': 'Teamspeak Voice Server',
      'teamspeak2': 'Teamspeak 2',
      'teamspeak3': 'Teamspeak 3',
      'ark': 'ARK: Survival Evolved',
      'arma': 'Arma / DayZ',
      'dayz': 'DayZ Standalone',
      'other': 'Other (Standard UDP Filter)',
      'none': 'No Game Profile',
      // OVH legacy GTA SA strings
      'gtamultitheftautosanandreas': 'GTA Multi Theft Auto: San Andreas',
      'gtasanandreasmultiplayermod': 'GTA: SA-MP (San Andreas Multiplayer)',
      'gtamultitheftauto': 'GTA Multi Theft Auto',
      // Generic fallback patterns
      'fivem': 'FiveM / GTA V',
      'ragemp': 'RageMP / GTA V',
      'csgo': 'CS:GO / Counter-Strike',
      'cs2': 'Counter-Strike 2',
      'tf2': 'Team Fortress 2',
      'gmod': 'Garry\'s Mod',
      'satisfactory': 'Satisfactory',
      'palworld': 'Palworld',
      'enshrouded': 'Enshrouded',
      'vrising': 'V Rising',
    };
    const key = profile.toLowerCase().replace(/[^a-z0-9]/g, '');
    return mapping[key] || profile;
  };


  // Load IPs owned by OVH account
  const fetchOvhIps = async () => {
    setLoadingIps(true);
    setPermissionError(false);
    try {
      const list = await apiClient.getAdminOvhIps();
      setOvhIps(list || []);
    } catch (err: any) {
      console.error('Failed to load OVH account IPs:', err);
      if (err.message?.includes('not been granted') || err.message?.includes('granted')) {
        setPermissionError(true);
      }
    } finally {
      setLoadingIps(false);
    }
  };

  useEffect(() => {
    void fetchOvhIps();
  }, []);

  // Helper to expand CIDR block into individual IPs
  const expandCidr = (cidr: string): string[] => {
    const [ip, prefixStr] = cidr.split('/');
    if (!ip) return [];
    const prefix = prefixStr ? parseInt(prefixStr, 10) : 32;
    
    if (isNaN(prefix) || prefix < 0 || prefix > 32) {
      return [ip];
    }
    
    if (prefix === 32) {
      return [ip];
    }
    
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) {
      return [ip];
    }
    
    const ipInt = parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3];
    const count = Math.pow(2, 32 - prefix);
    const limit = Math.min(count, 256); // Limit expansion to 256 IPs
    
    const result: string[] = [];
    for (let i = 0; i < limit; i++) {
      const currentInt = ipInt + i;
      const p1 = Math.floor(currentInt / 16777216) % 256;
      const p2 = Math.floor(currentInt / 65536) % 256;
      const p3 = Math.floor(currentInt / 256) % 256;
      const p4 = currentInt % 256;
      result.push(`${p1}.${p2}.${p3}.${p4}`);
    }
    
    return result;
  };

  // Format and group list of IPs
  const discoveredIpList = useMemo(() => {
    return ovhIps.map(block => {
      return {
        block,
        ips: expandCidr(block)
      };
    }).sort((a, b) => a.block.localeCompare(b.block));
  }, [ovhIps]);

  const handleQueryIp = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanIp = ipInput.trim();
    const targetIp = cleanIp.split('/')[0] || cleanIp;
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(targetIp)) {
      setError('Please enter a valid IPv4 address.');
      setStatus(null);
      return;
    }

    setLoading(true);
    setError(null);
    setFwRulesSupported(true);
    setGameDdosSupported(true);
    try {
      const res = await apiClient.getAdminOvhStatus(targetIp);
      setStatus({
        ip: targetIp,
        reverse: res.reverse,
        ddos: res.ddos || { state: 'unknown', mode: 'automatic' },
        firewall: res.firewall || { enabled: false, state: 'unknown' },
        mitigationProfile: res.mitigationProfile,
      });
      setRdnsValue(res.reverse || '');
      setMitigationTimeout(res.mitigationProfile?.autoMitigationTimeOut ?? 15);
      setMitigationProfileNotProvisioned(false);
      setActiveIp(targetIp);

      if (res.firewall?.enabled) {
        void fetchFirewallRules(targetIp);
      } else {
        setFwRules([]);
      }

      void fetchGameRules(targetIp);
    } catch (err: any) {
      setError(err.message || 'Failed to query OVH router status. Make sure OVH integration is enabled and credentials are correct.');
      setStatus(null);
      if (err.message?.includes('not been granted') || err.message?.includes('granted')) {
        setPermissionError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleQuickSelect = async (ip: string) => {
    setIpInput(ip);
    setLoading(true);
    setError(null);
    setFwRulesSupported(true);
    setGameDdosSupported(true);
    try {
      const res = await apiClient.getAdminOvhStatus(ip);
      setStatus({
        ip,
        reverse: res.reverse,
        ddos: res.ddos || { state: 'unknown', mode: 'automatic' },
        firewall: res.firewall || { enabled: false, state: 'unknown' },
        mitigationProfile: res.mitigationProfile,
      });
      setRdnsValue(res.reverse || '');
      setMitigationTimeout(res.mitigationProfile?.autoMitigationTimeOut ?? 15);
      setActiveIp(ip);

      if (res.firewall?.enabled) {
        void fetchFirewallRules(ip);
      } else {
        setFwRules([]);
      }

      void fetchGameRules(ip);
    } catch (err: any) {
      setError(err.message || 'Failed to query OVH router status. Make sure OVH integration is enabled and credentials are correct.');
      setStatus(null);
      if (err.message?.includes('not been granted') || err.message?.includes('granted')) {
        setPermissionError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const refreshStatus = async () => {
    if (!activeIp) return;
    try {
      const res = await apiClient.getAdminOvhStatus(activeIp);
      setStatus({
        ip: activeIp,
        reverse: res.reverse,
        ddos: res.ddos || { state: 'unknown', mode: 'automatic' },
        firewall: res.firewall || { enabled: false, state: 'unknown' },
        mitigationProfile: res.mitigationProfile,
      });
      setRdnsValue(res.reverse || '');
      setMitigationTimeout(res.mitigationProfile?.autoMitigationTimeOut ?? 15);

      if (res.firewall?.enabled) {
        void fetchFirewallRules(activeIp);
      } else {
        setFwRules([]);
      }
      void fetchGameRules(activeIp);
    } catch (err: any) {
      showToast('error', 'Status refresh failed: ' + err.message);
    }
  };

  // rDNS Updates
  const handleUpdateRdns = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeIp) return;
    setRdnsUpdating(true);
    try {
      const res = await apiClient.setAdminOvhRdns(activeIp, rdnsValue);
      if (res.success) {
        showToast('success', res.message || 'rDNS record update queued at OVH.');
        await refreshStatus();
      } else {
        showToast('error', res.error || 'Failed to update rDNS.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setRdnsUpdating(false);
    }
  };

  // DDoS Toggling
  const handleToggleDdos = async () => {
    if (!activeIp || !status) return;
    setDdosUpdating(true);
    const targetMode = status.ddos.mode === 'permanent' ? 'automatic' : 'permanent';
    try {
      const res = await apiClient.setAdminOvhDdos(activeIp, targetMode);
      if (res.success) {
        showToast('success', res.message || `DDoS mode set to ${targetMode}.`);
        await refreshStatus();
      } else {
        showToast('error', res.error || 'Failed to update DDoS mode.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setDdosUpdating(false);
    }
  };

  // Mitigation Profile Timeout Updates
  const handleUpdateMitigationTimeout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeIp) return;
    setMitigationUpdating(true);
    try {
      const res = await apiClient.setAdminOvhMitigationProfile(activeIp, mitigationTimeout);
      if (res.success) {
        showToast('success', res.message || 'VAC auto mitigation timeout updated.');
        await refreshStatus();
      } else if (res.error?.includes('OVH_PROFILE_NOT_PROVISIONED') || res.error?.includes('not been created')) {
        setMitigationProfileNotProvisioned(true);
      } else {
        showToast('error', res.error || 'Failed to update mitigation profile.');
      }
    } catch (err: any) {
      if (err.message?.includes('OVH_PROFILE_NOT_PROVISIONED')) {
        setMitigationProfileNotProvisioned(true);
      } else {
        showToast('error', err.message);
      }
    } finally {
      setMitigationUpdating(false);
    }
  };

  // Edge Firewall
  const fetchFirewallRules = async (ip: string) => {
    setLoadingFwRules(true);
    setFwRulesSupported(true);
    try {
      const rules = await apiClient.getAdminOvhFirewallRules(ip);
      setFwRules(rules);
    } catch (err: any) {
      console.warn('Failed to load firewall rules:', err.message || err);
      setFwRules([]);
      setFwRulesSupported(false);
      if (err.message?.includes('not been granted') || err.message?.includes('granted')) {
        setPermissionError(true);
      }
    } finally {
      setLoadingFwRules(false);
    }
  };

  const handleToggleFirewall = async () => {
    if (!activeIp || !status) return;
    setFwToggling(true);
    const nextState = !status.firewall.enabled;
    try {
      const res = await apiClient.toggleAdminOvhFirewall(activeIp, nextState);
      if (res.success) {
        showToast('success', res.message || `Edge Firewall ${nextState ? 'enabled' : 'disabled'}.`);
        await refreshStatus();
        if (nextState) {
          void fetchFirewallRules(activeIp);
        } else {
          setFwRules([]);
        }
      } else {
        showToast('error', res.error || 'Failed to toggle Edge Firewall.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setFwToggling(false);
    }
  };

  const handleAddFwRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeIp) return;
    setRuleSubmitting(true);
    try {
      const rule = {
        sequence: newSeq,
        action: newAction,
        protocol: newProto,
        sourcePort: newSrcPort || undefined,
        destinationPort: newDstPort || undefined,
        source: newSrcIp || undefined,
      };
      const res = await apiClient.addAdminOvhFirewallRule(activeIp, rule);
      if (res.success) {
        showToast('success', 'Firewall rule created.');
        await fetchFirewallRules(activeIp);
        setNewSeq(prev => (prev < 99 ? prev + 1 : 0));
        setNewSrcPort('');
        setNewDstPort('');
        setNewSrcIp('');
      } else {
        showToast('error', res.error || 'Failed to create firewall rule.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setRuleSubmitting(false);
    }
  };

  const handleDeleteFwRule = async (sequence: number) => {
    if (!activeIp) return;
    if (!window.confirm(`Are you sure you want to delete Edge Firewall rule sequence ${sequence}?`)) return;
    try {
      const res = await apiClient.deleteAdminOvhFirewallRule(activeIp, sequence);
      if (res.success) {
        showToast('success', 'Firewall rule deleted.');
        await fetchFirewallRules(activeIp);
      } else {
        showToast('error', res.error || 'Failed to delete firewall rule.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    }
  };

  // Game DDoS
  const fetchGameRules = async (ip: string) => {
    setLoadingGameRules(true);
    setGameDdosSupported(true);
    try {
      const rules = await apiClient.getAdminOvhGameRules(ip);
      setGameRules(rules);
    } catch (err: any) {
      console.warn('Failed to load game rules:', err.message || err);
      setGameRules([]);
      setGameDdosSupported(false);
      if (err.message?.includes('not been granted') || err.message?.includes('granted')) {
        setPermissionError(true);
      }
    } finally {
      setLoadingGameRules(false);
    }
  };

  const handleAddGameRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeIp) return;
    setGameSubmitting(true);
    try {
      const rule = {
        fromPort: gameFromPort !== '' ? Number(gameFromPort) : undefined,
        port: gameToPort,
        protocol: gameProto,
        game: gameProfile,
      };
      const res = await apiClient.addAdminOvhGameRule(activeIp, rule);
      if (res.success) {
        showToast('success', 'Game protection rule added.');
        await fetchGameRules(activeIp);
        setGameFromPort('');
        setGameToPort(25565);
      } else {
        showToast('error', res.error || 'Failed to add game rule.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setGameSubmitting(false);
    }
  };

  const handleDeleteGameRule = async (ruleId: number) => {
    if (!activeIp) return;
    if (!window.confirm('Are you sure you want to remove this Game DDoS filter?')) return;
    try {
      const res = await apiClient.deleteAdminOvhGameRule(activeIp, ruleId);
      if (res.success) {
        showToast('success', 'Game protection rule deleted.');
        await fetchGameRules(activeIp);
      } else {
        showToast('error', res.error || 'Failed to delete game rule.');
      }
    } catch (err: any) {
      showToast('error', err.message);
    }
  };

  return (
    <div className="p-8 max-w-[1280px]">
      <div className="mb-8">
        <h1 className="page-heading font-bold text-2xl text-inherit">OVH Router Manager</h1>
        <p className="text-sm text-[var(--theme-text-muted)] mt-1 ">Manage Hardware Firewalls, DDoS Mitigation profiles, and rDNS entries for any OVH IP address.</p>
      </div>

      {permissionError && (
        <div className="bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)] border border-[var(--theme-warning)]/30 text-[var(--theme-warning)] rounded-xl p-5 text-xs font-semibold leading-relaxed mb-6 max-w-[1200px]">
          <h4 className="font-bold text-sm mb-1 text-[var(--theme-warning)]">🔑 OVH API Permissions Incomplete</h4>
          <p className="mb-2">Your current OVH API Consumer Key does not have permissions to query or modify IP address features. To resolve this:</p>
          <ol className="list-decimal pl-5 flex flex-col gap-1.5 font-medium text-amber-800 ">
            <li>
              Go to the{' '}
              <a
                href="https://ca.api.ovh.com/createToken/?GET=/ip&GET=/ip/*&POST=/ip/*&PUT=/ip/*&DELETE=/ip/*"
                target="_blank"
                rel="noreferrer"
                className="underline font-bold text-[var(--theme-warning)] hover:text-[var(--theme-warning)] "
              >
                OVH Canada API Token Generator
              </a>{' '}
              (or{' '}
              <a
                href="https://eu.api.ovh.com/createToken/?GET=/ip&GET=/ip/*&POST=/ip/*&PUT=/ip/*&DELETE=/ip/*"
                target="_blank"
                rel="noreferrer"
                className="underline font-bold text-[var(--theme-warning)] hover:text-[var(--theme-warning)] "
              >
                OVH Europe API Token Generator
              </a>
              ).
            </li>
            <li>Login to your OVH account and create a key with these exact rules:</li>
            <ul className="list-disc pl-5 mt-1 font-mono text-[10px] text-[var(--theme-warning)] flex flex-col gap-0.5">
              <li>GET /ip</li>
              <li>GET /ip/*</li>
              <li>POST /ip/*</li>
              <li>PUT /ip/*</li>
              <li>DELETE /ip/*</li>
            </ul>
            <li>Save, copy the keys, and update them inside <strong>Admin Panel → System Settings → OVH API Credentials</strong>.</li>
          </ol>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Main Content Area */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          {/* Query Form */}
          <form onSubmit={handleQueryIp} className="flex gap-3">
            <input
              type="text"
              value={ipInput}
              onChange={(e) => setIpInput(e.target.value)}
              placeholder="e.g. 15.235.169.62"
              className="w-full max-w-[320px] p-3 bg-[var(--theme-surface-muted)] border border-[var(--theme-border)] rounded-lg text-[var(--theme-text)] text-sm focus:border-[var(--theme-accent)] focus:ring-1 focus:ring-[var(--theme-accent)] outline-none transition-all font-mono font-medium placeholder-[var(--theme-text-muted)]/50"
            />
            <button
              type="submit"
              disabled={loading}
              className="btn-primary py-1.5 px-4 text-xs"
            >
              {loading ? 'Querying...' : 'Query IP Status'}
            </button>
          </form>

          {/* Toast Alert */}
          {toast && (
            <div className={`p-4 text-xs font-semibold border rounded-lg ${toast.type === 'success' ? 'bg-[color-mix(in_srgb,var(--theme-success)_10%,transparent)] text-[var(--theme-success)] border-[var(--theme-border)] ' : 'bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] text-[var(--theme-danger)] border-[var(--theme-border)] '}`}>
              {toast.type === 'success' ? '✓ ' : '⚠ '}{toast.text}
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] border border-[var(--theme-danger)]/30 text-[var(--theme-danger)] rounded-xl p-4 text-xs font-medium leading-5">
              ⚠ {error}
            </div>
          )}

          {/* Loading indicator */}
          {loading && (
            <div className="h-48 w-full animate-pulse rounded-xl bg-[var(--theme-surface-muted)] flex items-center justify-center text-xs font-bold text-[var(--theme-text-muted)] ">
              Querying OVH Router API...
            </div>
          )}

          {/* Panel Body */}
          {status && !loading && (
            <div className="ink-block-wrapper shadow-sm border border-[var(--theme-border)] overflow-hidden">
              {/* Header */}
              <div className="px-6 py-5 ink-block-header bg-[var(--theme-surface-muted)] flex items-center justify-between flex-wrap gap-4 border-b border-[var(--theme-border)]">
                <div>
                  <span className="text-[10px] font-bold text-[#2563eb] bg-[#dbeafe] px-2 py-0.5 rounded uppercase font-mono">{status.ip}</span>
                  <h2 className="text-base font-bold text-inherit mt-1.5">OVH Cloud Routing Protection</h2>
                </div>
                <button
                  type="button"
                  onClick={refreshStatus}
                  className="text-xs font-semibold text-[var(--theme-text-muted)] hover:text-inherit underline cursor-pointer"
                >
                  Refresh Status
                </button>
              </div>

              {/* Sub-tab selection */}
              <div className="flex ovh-tabs-bar px-6">
                <button
                  type="button"
                  onClick={() => setActiveSubTab('general')}
                  className={`py-3 text-xs font-bold tracking-wide border-b-2 -mb-px mr-6 transition-all cursor-pointer ${activeSubTab === 'general' ? 'border-[var(--theme-border)] text-[#2563eb] ' : 'border-transparent text-[var(--theme-text-muted)] hover:text-inherit'}`}
                >
                  General & rDNS
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSubTab('firewall')}
                  className={`py-3 text-xs font-bold tracking-wide border-b-2 -mb-px mr-6 transition-all cursor-pointer ${activeSubTab === 'firewall' ? 'border-[var(--theme-border)] text-[#2563eb] ' : 'border-transparent text-[var(--theme-text-muted)] hover:text-inherit'}`}
                >
                  Edge Firewall
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSubTab('game')}
                  className={`py-3 text-xs font-bold tracking-wide border-b-2 -mb-px transition-all cursor-pointer ${activeSubTab === 'game' ? 'border-[var(--theme-border)] text-[#2563eb] ' : 'border-transparent text-[var(--theme-text-muted)] hover:text-inherit'}`}
                >
                  Game DDoS Controls
                </button>
              </div>

              {/* SUBTAB 1: GENERAL & RDNS */}
              {activeSubTab === 'general' && (
                <div className="p-6 text-xs flex flex-col gap-6">
                  {/* DDoS Permanent Mitigation Toggle */}
                  <div className="flex items-center justify-between border-b border-[var(--theme-border)] pb-5 flex-wrap gap-4">
                    <div>
                      <h4 className="text-sm font-bold text-inherit">Permanent DDoS Mitigation</h4>
                      <p className="text-[var(--theme-text-muted)] mt-1 text-[11px] leading-relaxed">Force traffic scrubbing on the OVH routers at all times. Toggling this bypasses the standard automatic detection delay.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${status.ddos.mode === 'permanent' ? 'bg-[#fee2e2] text-[var(--theme-danger)] ' : 'bg-[#e2e8f0] text-[var(--theme-text-muted)] '}`}>
                        {status.ddos.mode === 'permanent' ? 'PERMANENT ACTIVE' : 'AUTOMATIC'}
                      </span>
                      <button
                        type="button"
                        onClick={handleToggleDdos}
                        disabled={ddosUpdating}
                        className={`py-2 px-5 font-bold rounded-lg text-xs border transition-all cursor-pointer whitespace-nowrap ${
                          status.ddos.mode === 'permanent'
                            ? 'bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] border-[var(--theme-danger)]/30 text-[var(--theme-danger)] hover:bg-[#fee2e2] '
                            : 'ovh-card-inner-btn'
                        }`}
                      >
                        {ddosUpdating ? 'Toggling...' : status.ddos.mode === 'permanent' ? 'Disable Permanent' : 'Enable Permanent'}
                      </button>
                    </div>
                  </div>

                  {/* Reverse DNS (PTR) Record Management */}
                  <div className="border-b border-[var(--theme-border)] pb-5">
                    <h4 className="text-sm font-bold text-inherit">Reverse DNS (PTR Record)</h4>
                    <p className="text-[var(--theme-text-muted)] mt-1 mb-3 text-[11px] leading-relaxed">Update the reverse DNS lookup record. Set to blank to clear and delete the PTR record.</p>
                    <form onSubmit={handleUpdateRdns} className="flex gap-2 items-center">
                      <input
                        type="text"
                        placeholder="e.g. mail.yourdomain.com"
                        value={rdnsValue}
                        onChange={e => setRdnsValue(e.target.value)}
                        className="flex-1 max-w-[320px] ovh-field-input rounded-lg px-3 py-2 text-xs outline-none font-mono"
                      />
                      <button
                        type="submit"
                        disabled={rdnsUpdating}
                        className="btn-primary py-1.5 px-4 text-xs"
                      >
                        {rdnsUpdating ? 'Updating...' : 'Update rDNS'}
                      </button>
                    </form>
                  </div>

                  {/* Auto Mitigation Timeout */}
                  <div>
                    <h4 className="text-sm font-bold text-inherit">VAC Auto Mitigation Timeout</h4>
                    <p className="text-[var(--theme-text-muted)] mt-1 mb-3 text-[11px] leading-relaxed">
                      Choose how long the IP address remains protected inside the VAC scrubbing centers after an attack ends.
                      If you experience lag spikes during frequent attack cycles, setting this to a larger value (like 360 or 1560) is highly recommended.
                    </p>

                    {mitigationProfileNotProvisioned ? (
                      <div className="bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)] border border-[var(--theme-border)] rounded-xl p-4 text-xs leading-relaxed">
                        <p className="font-bold text-[var(--theme-warning)] mb-1">⏳ Mitigation Profile Not Yet Provisioned</p>
                        <p className="text-[var(--theme-warning)]">
                          OVH has not yet created a mitigation profile for <strong className="font-mono">{status?.ip}</strong>. 
                          This profile is <strong>automatically provisioned by OVH the first time this IP is detected under a DDoS attack</strong>.
                        </p>
                        <p className="text-[var(--theme-warning)] mt-2">
                          Once the IP has been through mitigation at least once, return here and you will be able to set the timeout. 
                          In the meantime, OVH's default timeout of <strong>15 minutes</strong> applies.
                        </p>
                      </div>
                    ) : (
                      <form onSubmit={handleUpdateMitigationTimeout} className="flex gap-2 items-center">
                        <select
                          value={mitigationTimeout}
                          onChange={e => setMitigationTimeout(parseInt(e.target.value, 10))}
                          className="flex-1 max-w-[320px] ovh-field-select rounded-lg p-2 text-xs"
                        >
                          <option value={0}>0 Minutes (Scrubbing ends immediately)</option>
                          <option value={15}>15 Minutes (Default)</option>
                          <option value={60}>60 Minutes (1 Hour)</option>
                          <option value={360}>360 Minutes (6 Hours)</option>
                          <option value={1560}>1560 Minutes (26 Hours - Maximum)</option>
                        </select>
                        <button
                          type="submit"
                          disabled={mitigationUpdating}
                          className="btn-primary py-1.5 px-4 text-xs"
                        >
                          {mitigationUpdating ? 'Updating...' : 'Update Timeout'}
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              )}

              {/* SUBTAB 2: EDGE FIREWALL */}
              {activeSubTab === 'firewall' && (
                <div className="p-6 text-xs flex flex-col gap-6">
                  {/* Firewall Toggle */}
                  <div className="flex items-center justify-between border-b border-[var(--theme-border)] pb-5 flex-wrap gap-4">
                    <div>
                      <h4 className="text-sm font-bold text-inherit">Hardware Edge Firewall</h4>
                      <p className="text-[var(--theme-text-muted)] mt-1 text-[11px] leading-relaxed">Enable router-level packet filtering. Malicious packets are dropped at OVH routers before reaching your Proxmox server.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${status.firewall.enabled ? 'bg-[#dcfce7] text-[#15803d] ' : 'bg-[#e2e8f0] text-[var(--theme-text-muted)] '}`}>
                        {status.firewall.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                      <button
                        type="button"
                        onClick={handleToggleFirewall}
                        disabled={fwToggling}
                        className={`px-5 py-2 rounded-lg text-xs font-bold border transition-all cursor-pointer whitespace-nowrap ${
                          status.firewall.enabled
                            ? 'bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] border-[var(--theme-danger)]/30 text-[var(--theme-danger)] hover:bg-[#fee2e2] '
                            : 'ovh-card-inner-btn'
                        }`}
                      >
                        {fwToggling ? 'Toggling...' : status.firewall.enabled ? 'Disable Firewall' : 'Enable Firewall'}
                      </button>
                    </div>
                  </div>

                  {/* Firewall Rules List */}
                  {status.firewall.enabled ? (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-bold text-inherit">Edge Firewall Rules</h4>
                      </div>
                      
                      {!fwRulesSupported ? (
                        <div className="bg-[#fffaf0] border border-[var(--theme-border)] text-[#c05621] rounded-xl p-4 text-xs font-semibold leading-relaxed">
                          ⚠️ Edge Firewall Rules configuration is not granted by your OVH API key, or this IP block does not support sequence rule customization. You can still toggle the overall Firewall status above.
                        </div>
                      ) : loadingFwRules ? (
                        <div className="p-6 text-center text-[var(--theme-text-muted)] ">Loading rules...</div>
                      ) : fwRules.length === 0 ? (
                        <div className="p-6 text-center text-[var(--theme-text-muted)] ">No custom firewall rules configured.</div>
                      ) : (
                        <div className="overflow-x-auto ovh-table-wrap">
                          <table className="w-full text-left border-collapse text-xs ovh-custom-table">
                            <thead>
                              <tr className="text-[var(--theme-text-muted)] ">
                                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Seq</th>
                                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Action</th>
                                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Protocol</th>
                                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Source IP</th>
                                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Ports (Src / Dst)</th>
                                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)] text-right">Options</th>
                              </tr>
                            </thead>
                            <tbody className="font-mono text-inherit">
                              {fwRules.map(rule => (
                                <tr key={rule.sequence} className="hover:bg-[var(--theme-surface-muted)]">
                                  <td className="px-4 py-2.5 font-bold text-inherit">{rule.sequence}</td>
                                  <td className="px-4 py-2.5">
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${rule.action === 'permit' ? 'bg-[#dcfce7] text-[#15803d] ' : 'bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] text-[var(--theme-danger)] '}`}>
                                      {rule.action.toUpperCase()}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 uppercase font-bold text-inherit opacity-90">{rule.protocol}</td>
                                  <td className="px-4 py-2.5 text-inherit">{rule.source || 'Any IP'}</td>
                                  <td className="px-4 py-2.5 text-inherit">
                                    {rule.protocol === 'tcp' || rule.protocol === 'udp' 
                                      ? `${rule.sourcePort || 'any'} → ${rule.destinationPort || 'any'}` 
                                      : 'N/A'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right">
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteFwRule(rule.sequence)}
                                      className="text-[var(--theme-danger)] font-semibold hover:underline cursor-pointer"
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Add Rule Form */}
                      {fwRulesSupported && (
                        <div className="mt-6 border-t border-[var(--theme-border)] pt-6">
                          <h5 className="font-bold text-inherit mb-3">Add Custom Edge Rule</h5>
                          <form onSubmit={handleAddFwRule} className="grid grid-cols-2 md:grid-cols-6 gap-3">
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1">SEQUENCE (0-99)</label>
                              <input
                                type="number"
                                min="0"
                                max="99"
                                required
                                value={newSeq}
                                onChange={e => setNewSeq(parseInt(e.target.value, 10))}
                                className="w-full ovh-field-input rounded-lg p-2 text-xs"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1">ACTION</label>
                              <select
                                value={newAction}
                                onChange={e => setNewAction(e.target.value as any)}
                                className="w-full ovh-field-select rounded-lg p-2 text-xs"
                              >
                                <option value="permit">PERMIT</option>
                                <option value="deny">DENY</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1">PROTOCOL</label>
                              <select
                                value={newProto}
                                onChange={e => setNewProto(e.target.value as any)}
                                className="w-full ovh-field-select rounded-lg p-2 text-xs"
                              >
                                <option value="tcp">TCP</option>
                                <option value="udp">UDP</option>
                                <option value="icmp">ICMP</option>
                                <option value="ipv4">IPv4 (ALL)</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1">SRC IP (CIDR)</label>
                              <input
                                type="text"
                                placeholder="e.g. 192.0.2.0/24"
                                value={newSrcIp}
                                onChange={e => setNewSrcIp(e.target.value)}
                                className="w-full ovh-field-input rounded-lg p-2 text-xs font-mono"
                              />
                            </div>
                            {(newProto === 'tcp' || newProto === 'udp') && (
                              <>
                                <div>
                                  <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1">SRC PORT</label>
                                  <input
                                    type="text"
                                    placeholder="e.g. 80"
                                    value={newSrcPort}
                                    onChange={e => setNewSrcPort(e.target.value)}
                                    className="w-full ovh-field-input rounded-lg p-2 text-xs font-mono"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1">DST PORT</label>
                                  <input
                                    type="text"
                                    placeholder="e.g. 80"
                                    value={newDstPort}
                                    onChange={e => setNewDstPort(e.target.value)}
                                    className="w-full ovh-field-input rounded-lg p-2 text-xs font-mono"
                                  />
                                </div>
                              </>
                            )}
                            <div className="col-span-2 md:col-span-6 flex justify-end">
                              <button
                                type="submit"
                                disabled={ruleSubmitting}
                                className="btn-primary py-1.5 px-4 text-xs"
                              >
                                {ruleSubmitting ? 'Adding...' : 'Add Rule'}
                              </button>
                            </div>
                          </form>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center p-6 text-[var(--theme-text-muted)] bg-[var(--theme-surface-muted)] rounded-lg">
                      Edge Firewall is currently disabled. Enable the firewall above to configure custom router rules.
                    </div>
                  )}
                </div>
              )}

              {/* SUBTAB 3: GAME DDOS PROTECTION */}
              {activeSubTab === 'game' && (
                <div className="p-6 text-xs flex flex-col gap-6">
                  <div>
                    <h4 className="text-sm font-bold text-inherit">Dedicated Game Server DDoS Filters</h4>
                    <p className="text-[var(--theme-text-muted)] mt-1 mb-4 text-[11px] leading-relaxed">Assign deep UDP/TCP packet validation filters tailored to specific multiplayer game engines. Bypasses game crash exploits at the router level.</p>

                    {!gameDdosSupported ? (
                      <div className="bg-[#fffaf0] border border-[var(--theme-border)] text-[#c05621] rounded-xl p-4 text-xs font-semibold leading-relaxed">
                        ⚠️ Game DDoS mitigation is not supported on this IP address, or your OVH API key does not have permissions to query game rules.
                      </div>
                    ) : (
                      <>
                        {/* List rules */}
                        {loadingGameRules ? (
                          <div className="p-6 text-center text-[var(--theme-text-muted)] ">Loading game rules...</div>
                        ) : gameRules.length === 0 ? (
                          <div className="p-6 text-center text-[var(--theme-text-muted)] ">No game specific port filters enabled.</div>
                        ) : (
                          <div className="overflow-x-auto ovh-table-wrap">
                            <table className="w-full text-left border-collapse text-xs ovh-custom-table">
                              <thead>
                                <tr className="text-[var(--theme-text-muted)] ">
                                  <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Rule ID</th>
                                  <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Port / Range</th>
                                  <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Protocol</th>
                                  <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Game Profile</th>
                                  <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)]">Mitigation Status</th>
                                  <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--theme-text-muted)] text-right">Options</th>
                                </tr>
                              </thead>
                              <tbody className="font-mono text-inherit">
                                {gameRules.map(rule => (
                                  <tr key={rule.id} className="hover:bg-[var(--theme-surface-muted)]">
                                    <td className="px-4 py-2.5 text-[var(--theme-text-muted)]">#{rule.id}</td>
                                    <td className="px-4 py-2.5 font-bold text-inherit font-mono">
                                      {(() => {
                                        const from = rule.fromPort;
                                        const to = rule.toPort;
                                        if (!to && !from) return <span className="opacity-50 text-[10px] font-sans font-normal">All Ports</span>;
                                        if (from && to && from !== to) return <span>{from}<span className="font-normal opacity-50 mx-1">–</span>{to}</span>;
                                        return <span>{to ?? from}</span>;
                                      })()}
                                    </td>
                                    <td className="px-4 py-2.5 uppercase font-bold text-inherit text-[10px]">{(rule.l4Protocol || 'udp').toUpperCase()}</td>
                                    <td className="px-4 py-2.5 text-inherit font-semibold opacity-90">{formatGameProfile(rule.gameType)}</td>
                                    <td className="px-4 py-2.5">
                                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-[#dcfce7] text-[#15803d] ">
                                        <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] animate-pulse"></span>
                                        Mitigated
                                      </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteGameRule(rule.id)}
                                        className="text-[var(--theme-danger)] font-semibold hover:underline cursor-pointer"
                                      >
                                        Delete
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Add Game Rule Form */}
                        <div className="mt-6 border-t border-[var(--theme-border)] pt-6">
                          <h5 className="font-bold text-inherit mb-1">Enable Game DDoS Port Protection</h5>
                          <p className="text-[11px] text-[var(--theme-text-muted)] mb-3">Leave "From Port" empty to protect a single port only. Set both to protect a port range.</p>
                          <form onSubmit={handleAddGameRule} className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1 font-sans">FROM PORT <span className="font-normal opacity-60">(optional)</span></label>
                              <input
                                type="number"
                                min="1"
                                max="65535"
                                placeholder="e.g. 7777"
                                value={gameFromPort}
                                onChange={e => setGameFromPort(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                                className="w-full ovh-field-input rounded-lg p-2 text-xs font-mono"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1 font-sans">TO PORT <span className="font-normal opacity-60">(required)</span></label>
                              <input
                                type="number"
                                min="1"
                                max="65535"
                                required
                                placeholder="e.g. 25565"
                                value={gameToPort}
                                onChange={e => setGameToPort(parseInt(e.target.value, 10))}
                                className="w-full ovh-field-input rounded-lg p-2 text-xs font-mono"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1 font-sans">PROTOCOL</label>
                              <select
                                value={gameProto}
                                onChange={e => setGameProto(e.target.value as any)}
                                className="w-full ovh-field-select rounded-lg p-2 text-xs"
                              >
                                <option value="udp">UDP</option>
                                <option value="tcp">TCP</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-[var(--theme-text-muted)] mb-1 font-sans">GAME PROFILE</label>
                              <select
                                value={gameProfile}
                                onChange={e => setGameProfile(e.target.value)}
                                className="w-full ovh-field-select rounded-lg p-2 text-xs"
                              >
                                <option value="minecraft">Minecraft Java Edition</option>
                                <option value="minecraftPocketEdition">Minecraft Pocket Edition</option>
                                <option value="minecraftQuery">Minecraft Query</option>
                                <option value="rust">Rust Server</option>
                                <option value="arkSurvivalEvolved">ARK: Survival Evolved</option>
                                <option value="arma">Arma</option>
                                <option value="dayz">DayZ</option>
                                <option value="hl2Source">Valve Source (CS:GO, TF2, GMod)</option>
                                <option value="teamspeak3">Teamspeak 3</option>
                                <option value="gtaSanAndreasMultiplayerMod">GTA: SA-MP</option>
                                <option value="gtaMultiTheftAutoSanAndreas">GTA: MTA</option>
                                <option value="other">Other / FiveM (Standard UDP Filter)</option>
                              </select>
                            </div>
                            <div className="flex items-end col-span-2 sm:col-span-1">
                              <button
                                type="submit"
                                disabled={gameSubmitting}
                                className="btn-primary py-1.5 px-4 text-xs"
                              >
                                {gameSubmitting ? 'Enabling...' : 'Add Protection'}
                              </button>
                            </div>
                          </form>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Side Panel: Discovered Server IPs */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div className="ovh-container-card rounded-xl p-5 shadow-sm self-start w-full">
            <h3 className="text-sm font-bold text-inherit mb-1">OVH Account IPs</h3>
            <p className="text-[11px] text-[var(--theme-text-muted)] mb-4 leading-relaxed font-medium">Click any IP address below to quick-select and query its OVH status.</p>
            {loadingIps ? (
              <div className="text-xs text-[var(--theme-text-muted)] animate-pulse py-4 text-center">Loading OVH IPs...</div>
            ) : discoveredIpList.length === 0 ? (
              <div className="text-xs text-[var(--theme-text-muted)] italic py-4 text-center">No active IPs found in this OVH account.</div>
            ) : (
              <div className="flex flex-col gap-4 max-h-[580px] overflow-y-auto pr-1">
                {discoveredIpList.map(group => (
                  <div key={group.block} className="ovh-block-group rounded-lg overflow-hidden">
                    <div className="ovh-block-group-header px-3 py-2 text-[10px] font-bold flex justify-between items-center">
                      <span>BLOCK: {group.block}</span>
                      <span className="bg-[var(--theme-bg)] px-1.5 py-0.2 rounded text-[9px]">
                        {group.ips.length} {group.ips.length === 1 ? 'IP' : 'IPs'}
                      </span>
                    </div>
                    <div className="flex flex-col divide-y divide-[#dedfdf] ">
                      {group.ips.map(ip => (
                        <button
                          key={ip}
                          type="button"
                          onClick={() => handleQuickSelect(ip)}
                          className={`w-full text-left px-3 py-2.5 text-xs transition-all font-mono ovh-block-group-btn flex items-center justify-between cursor-pointer ${
                            activeIp === ip ? 'is-active' : ''
                          }`}
                        >
                          <span>{ip}</span>
                          {activeIp === ip && <span className="text-[10px]">●</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
