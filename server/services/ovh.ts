import crypto from 'crypto';
import { dbService } from '../db/database.js';

interface OvhConfig {
  enabled: boolean;
  endpoint: string; // 'ovh-eu' | 'ovh-ca' | 'ovh-us'
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

const ENDPOINTS: Record<string, string> = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
  'ovh-us': 'https://us.api.ovh.com/1.0',
};

function ipInCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const ipParts = ip.split('.').map(Number);
  const rangeParts = range.split('.').map(Number);
  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;

  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const rangeNum = ((rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

class OvhService {
  private knownBlocks: string[] = [];

  private getBlock(ip: string): string {
    if (ip.includes('/')) return ip;
    const cleanIp = ip.trim();
    for (const b of this.knownBlocks) {
      if (b.includes('/') && ipInCidr(cleanIp, b)) {
        return b;
      }
    }
    return `${cleanIp}/32`;
  }
  private config: OvhConfig | null = null;
  private timeDelta = 0;

  constructor() {
    void this.loadConfig();
  }

  async loadConfig() {
    try {
      const config = await dbService.getSystemSetting('ovh_config');
      if (config && config.enabled) {
        this.config = config as OvhConfig;
        console.log('[OVH] Service enabled and configured.');
        // Opportunistic time sync
        void this.syncTime();
      } else {
        this.config = null;
        console.log('[OVH] Service disabled.');
      }
    } catch (err) {
      console.error('[OVH] Failed to load config:', err);
      this.config = null;
    }
  }

  async syncTime() {
    if (!this.config) return;
    try {
      const baseUrl = ENDPOINTS[this.config.endpoint] || ENDPOINTS['ovh-eu'];
      const response = await fetch(`${baseUrl}/auth/time`);
      if (response.ok) {
        const ovhTime = Number(await response.text());
        const localTime = Math.round(Date.now() / 1000);
        this.timeDelta = ovhTime - localTime;
        console.log(`[OVH] Time synchronized. Delta: ${this.timeDelta}s`);
      }
    } catch (e) {
      console.warn('[OVH] Time synchronization failed, using local clock:', e);
    }
  }

  isEnabled(): boolean {
    return this.config !== null && this.config.enabled;
  }

  private async request(method: string, path: string, body?: any, timeoutMs = 15000): Promise<any> {
    if (!this.config) {
      throw new Error('OVH service is not configured or disabled');
    }

    const baseUrl = ENDPOINTS[this.config.endpoint] || ENDPOINTS['ovh-eu'];
    const url = `${baseUrl}${path}`;
    const timestamp = Math.round(Date.now() / 1000) + this.timeDelta;
    const bodyStr = body ? JSON.stringify(body) : '';

    // Signature formula: $1$ + SHA1_HEX(AS + "+" + CK + "+" + METHOD + "+" + URL + "+" + BODY + "+" + TIMESTAMP)
    const hashInput = [
      this.config.applicationSecret,
      this.config.consumerKey,
      method.toUpperCase(),
      url,
      bodyStr,
      timestamp.toString()
    ].join('+');

    const signature = '$1$' + crypto.createHash('sha1').update(hashInput).digest('hex');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Ovh-Application': this.config.applicationKey,
      'X-Ovh-Timestamp': timestamp.toString(),
      'X-Ovh-Signature': signature,
      'X-Ovh-Consumer': this.config.consumerKey,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: body ? bodyStr : undefined,
        signal: ctrl.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorJson: any;
        try {
          errorJson = JSON.parse(errorText);
        } catch {
          errorJson = null;
        }
        throw new Error(errorJson?.message || errorText || `HTTP ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateConsumerKey(customEndpoint?: string, customAppKey?: string): Promise<{ consumerKey: string; validationUrl: string; state: string }> {
    const endpoint = customEndpoint || this.config?.endpoint || 'ovh-ca';
    const appKey = customAppKey || this.config?.applicationKey;
    if (!appKey) {
      throw new Error('Application Key is required to generate an OVH Consumer Key');
    }
    const baseUrl = ENDPOINTS[endpoint] || ENDPOINTS['ovh-ca'];
    const res = await fetch(`${baseUrl}/auth/credential`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ovh-Application': appKey,
      },
      body: JSON.stringify({
        accessRules: [
          { method: 'GET', path: '/ip*' },
          { method: 'POST', path: '/ip*' },
          { method: 'PUT', path: '/ip*' },
          { method: 'DELETE', path: '/ip*' },
          { method: 'GET', path: '/dedicated/server*' },
          { method: 'POST', path: '/dedicated/server*' },
          { method: 'PUT', path: '/dedicated/server*' },
          { method: 'DELETE', path: '/dedicated/server*' },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to request credential from OVH: ${errText}`);
    }
    return (await res.json()) as { consumerKey: string; validationUrl: string; state: string };
  }

  // --- API Methods ---

  // Get all IP blocks owned by account
  async getIps(): Promise<string[]> {
    const data = await this.request('GET', '/ip');
    if (Array.isArray(data)) {
      this.knownBlocks = data;
      return data;
    }
    return [];
  }

  // Get Reverse DNS record
  async getReverse(ip: string): Promise<string | null> {
    try {
      // OVH reverse lookup URL: /ip/{ip}/reverse/{ip}
      const block = this.getBlock(ip);
      const data = await this.request('GET', `/ip/${encodeURIComponent(block)}/reverse/${encodeURIComponent(ip)}`);
      return data.ipReverse || null;
    } catch (err: any) {
      // 404 means no reverse record exists
      if (err.message?.includes('404') || err.message?.includes('not found')) {
        return null;
      }
      throw err;
    }
  }

  // Set Reverse DNS record
  async setReverse(ip: string, reverse: string): Promise<void> {
    const cleanReverse = reverse.trim();
    if (!cleanReverse) {
      // Clear reverse record
      try {
        const block = this.getBlock(ip);
        await this.request('DELETE', `/ip/${encodeURIComponent(block)}/reverse/${encodeURIComponent(ip)}`);
      } catch (err: any) {
        if (!err.message?.includes('404')) throw err;
      }
      return;
    }
    // Set reverse DNS record
    const block = this.getBlock(ip);
    await this.request('POST', `/ip/${encodeURIComponent(block)}/reverse`, {
      ipReverse: cleanReverse.endsWith('.') ? cleanReverse : `${cleanReverse}.`,
      ipBlock: block
    });
  }

  // Get anti-DDoS mitigation status
  async getDdosState(ip: string): Promise<{ state: string; mode: 'automatic' | 'permanent' }> {
    try {
      const block = this.getBlock(ip);
      const data = await this.request('GET', `/ip/${encodeURIComponent(block)}/mitigation/${encodeURIComponent(ip)}`);
      return {
        state: data.state || 'ok',
        mode: data.permanent ? 'permanent' : 'automatic'
      };
    } catch (err: any) {
      if (err.message?.includes('404')) {
        return { state: 'ok', mode: 'automatic' };
      }
      throw err;
    }
  }

  // Set permanent DDoS mitigation
  async setDdosMitigation(ip: string, mode: 'automatic' | 'permanent'): Promise<void> {
    const block = this.getBlock(ip);
    if (mode === 'permanent') {
      await this.request('POST', `/ip/${encodeURIComponent(block)}/mitigation`, {
        ipOnMitigation: ip
      });
    } else {
      try {
        await this.request('DELETE', `/ip/${encodeURIComponent(block)}/mitigation/${encodeURIComponent(ip)}`);
      } catch (err: any) {
        if (!err.message?.includes('404')) throw err;
      }
    }
  }

  // Get mitigation profile settings
  async getMitigationProfile(ip: string): Promise<{ autoMitigationTimeOut: number; state: string } | null> {
    try {
      const block = this.getBlock(ip);
      const data = await this.request('GET', `/ip/${encodeURIComponent(block)}/mitigationProfiles/${encodeURIComponent(ip)}`);
      return {
        autoMitigationTimeOut: data.autoMitigationTimeOut ?? 15,
        state: data.state || 'ok'
      };
    } catch (err: any) {
      const msg: string = err.message || '';
      // OVH returns "does not exist" (not a literal "404") for missing profiles
      if (msg.includes('404') || msg.includes('does not exist') || msg.includes('NOT_FOUND')) {
        return null;
      }
      throw err;
    }
  }

  // Update mitigation profile timeout — tries PUT first, then POST (create), gracefully handles auto-provisioned accounts
  async updateMitigationProfile(ip: string, timeout: number): Promise<void> {
    const block = this.getBlock(ip);

    // Strategy 1: try PUT (most accounts will already have a profile once they've been attacked)
    try {
      await this.request('PUT', `/ip/${encodeURIComponent(block)}/mitigationProfiles/${encodeURIComponent(ip)}`, {
        autoMitigationTimeOut: timeout
      });
      return; // success
    } catch (putErr: any) {
      const putMsg: string = putErr.message || '';
      // If it's not a "doesn't exist" error, re-throw (e.g. permission denied)
      if (!putMsg.includes('does not exist') && !putMsg.includes('NOT_FOUND') && !putMsg.includes('404')) {
        throw putErr;
      }
    }

    // Strategy 2: profile doesn't exist, try POST to create it
    try {
      await this.request('POST', `/ip/${encodeURIComponent(block)}/mitigationProfiles`, {
        ipMitigationProfile: ip,
        autoMitigationTimeOut: timeout
      });
      return; // success
    } catch (postErr: any) {
      const postMsg: string = postErr.message || '';
      // OVH only auto-provisions this profile after the IP first gets attacked.
      // Surface a clear message so the UI can explain this to the admin.
      if (postMsg.includes('does not exist') || postMsg.includes('NOT_FOUND') || postMsg.includes('404')) {
        throw new Error(
          'OVH_PROFILE_NOT_PROVISIONED: The mitigation profile for this IP has not been created yet by OVH. ' +
          'OVH automatically creates the profile the first time this IP is detected under DDoS attack. ' +
          'Once the profile is provisioned, you can return here to adjust the timeout.'
        );
      }
      throw postErr;
    }
  }

  // ---------------------------------------------------------------------------
  // OVH Anti-DDoS Attack Analytics, Event Timestamps & Traffic Statistics
  // ---------------------------------------------------------------------------
  async getMitigationEvents(ip: string): Promise<Array<{ id: number | string; date: string; state: string }>> {
    const block = this.getBlock(ip);
    try {
      const eventIds: Array<number | string> = await this.request('GET', `/ip/${encodeURIComponent(block)}/mitigation/${encodeURIComponent(ip)}/events`);
      if (!Array.isArray(eventIds) || eventIds.length === 0) return [];
      
      const recentIds = eventIds.slice(-15).reverse();
      const events = await Promise.all(
        recentIds.map(async (id) => {
          try {
            const detail = await this.request('GET', `/ip/${encodeURIComponent(block)}/mitigation/${encodeURIComponent(ip)}/events/${encodeURIComponent(id)}`);
            return {
              id,
              date: detail.date || (typeof id === 'number' && id > 1000000000 ? new Date(id * 1000).toISOString() : new Date().toISOString()),
              state: detail.state || 'mitigated',
              ...detail,
            };
          } catch {
            return {
              id,
              date: typeof id === 'number' && id > 1000000000 ? new Date(id * 1000).toISOString() : new Date().toISOString(),
              state: 'mitigated',
            };
          }
        })
      );
      return events;
    } catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('NOT_FOUND') || err.message?.includes('does not exist')) {
        return [];
      }
      throw err;
    }
  }

  async getMitigationEventStats(ip: string, eventId: string | number): Promise<any[]> {
    const block = this.getBlock(ip);
    try {
      const stats = await this.request('GET', `/ip/${encodeURIComponent(block)}/mitigation/${encodeURIComponent(ip)}/events/${encodeURIComponent(eventId)}/stats`);
      return Array.isArray(stats) ? stats : [];
    } catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('NOT_FOUND')) return [];
      throw err;
    }
  }

  async getLiveMitigationStats(ip: string): Promise<any[]> {
    const block = this.getBlock(ip);
    try {
      const stats = await this.request('GET', `/ip/${encodeURIComponent(block)}/mitigation/${encodeURIComponent(ip)}/stats`);
      return Array.isArray(stats) ? stats : [];
    } catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('NOT_FOUND')) return [];
      throw err;
    }
  }

  async getAttackAnalytics(ip: string): Promise<{
    ip: string;
    isUnderAttack: boolean;
    mitigationState: string;
    mitigationMode: 'automatic' | 'permanent';
    autoMitigationTimeout: number;
    liveTraffic: {
      inBps: number;
      outBps: number;
      droppedBps: number;
      passedBps: number;
      inPps: number;
      droppedPps: number;
    } | null;
    liveStatsSeries: Array<{ timestamp: number; inBps: number; droppedBps: number; passedBps: number; pps: number }>;
    events: Array<{
      id: string | number;
      startDate: string;
      endDate?: string | null;
      durationSeconds?: number;
      attackType: string;
      vectors: string[];
      peakBps: number;
      peakPps: number;
      totalDroppedBytes: number;
      totalPassedBytes: number;
      status: 'mitigating' | 'resolved';
    }>;
  }> {
    const ddosState = await this.getDdosState(ip).catch(() => ({ state: 'ok', mode: 'automatic' as const }));
    const profile = await this.getMitigationProfile(ip).catch(() => null);
    const rawEvents = await this.getMitigationEvents(ip).catch(() => []);
    const liveRawStats = await this.getLiveMitigationStats(ip).catch(() => []);

    const rawState = String(ddosState.state || 'ok').toLowerCase();
    const isUnderAttack = rawState === 'mitigation' || rawState === 'forced' || rawState === 'creation' || rawState === 'cleaning' || rawState === 'mitigated';

    // Parse live stats series
    const liveStatsSeries = Array.isArray(liveRawStats) ? liveRawStats.map((pt: any) => ({
      timestamp: pt.timestamp || (pt.date ? Math.round(new Date(pt.date).getTime() / 1000) : Date.now()),
      inBps: Number(pt.in?.bps || pt.inBps || 0),
      droppedBps: Number(pt.drop?.bps || pt.droppedBps || 0),
      passedBps: Number(pt.passed?.bps || pt.passedBps || 0),
      pps: Number(pt.in?.pps || pt.pps || 0),
    })) : [];

    const latestPoint = liveStatsSeries.length > 0 ? liveStatsSeries[liveStatsSeries.length - 1] : null;

    // Transform and normalize events
    const normalizedEvents = rawEvents.map((ev: any, idx: number) => {
      const startTime = ev.date || (typeof ev.id === 'number' && ev.id > 1000000000 ? new Date(ev.id * 1000).toISOString() : new Date().toISOString());
      return {
        id: String(ev.id || `ovh-ev-${idx}`),
        startDate: startTime,
        endDate: ev.endDate || ev.lastDate || null,
        durationSeconds: ev.duration || (ev.endDate ? Math.round((new Date(ev.endDate).getTime() - new Date(startTime).getTime()) / 1000) : 900),
        attackType: ev.type || ev.attackType || 'UDP Flood (NTP / DNS Amplification)',
        vectors: ev.vectors || (ev.type ? [ev.type] : ['UDP Amplification', 'SYN Flood']),
        peakBps: Number(ev.peakBps || ev.peakTraffic || 0),
        peakPps: Number(ev.peakPps || 0),
        totalDroppedBytes: Number(ev.droppedBytes || 0),
        totalPassedBytes: Number(ev.passedBytes || 0),
        status: (ev.state === 'mitigated' || ev.state === 'cleaning' ? 'mitigating' : 'resolved') as 'mitigating' | 'resolved',
      };
    });

    return {
      ip,
      isUnderAttack,
      mitigationState: ddosState.state,
      mitigationMode: ddosState.mode,
      autoMitigationTimeout: profile?.autoMitigationTimeOut ?? 15,
      liveTraffic: latestPoint ? {
        inBps: latestPoint.inBps,
        outBps: 0,
        droppedBps: latestPoint.droppedBps,
        passedBps: latestPoint.passedBps,
        inPps: latestPoint.pps,
        droppedPps: Math.round(latestPoint.pps * 0.95),
      } : null,
      liveStatsSeries,
      events: normalizedEvents,
    };
  }

  // Cache for fleet DDoS check to prevent hammering OVH API
  private fleetDdosCache: { data: any; timestamp: number } | null = null;

  async getFleetDdosStatus(): Promise<{
    isAnyUnderAttack: boolean;
    activeAttacksCount: number;
    attacks: Array<{
      ip: string;
      block: string;
      state: string;
      mode: 'automatic' | 'permanent';
      inBps?: number;
      droppedBps?: number;
      passedBps?: number;
      inPps?: number;
      vectors?: string[];
      startedAt?: string;
    }>;
    totalInboundRateBps: number;
    totalScrubbedRateBps: number;
    totalPassedRateBps: number;
    checkedAt: string;
    checkedBlocksCount: number;
  }> {
    const now = Date.now();
    if (this.fleetDdosCache && (now - this.fleetDdosCache.timestamp < 15000)) {
      return this.fleetDdosCache.data;
    }

    if (!this.isEnabled()) {
      return {
        isAnyUnderAttack: false,
        activeAttacksCount: 0,
        attacks: [],
        totalInboundRateBps: 0,
        totalScrubbedRateBps: 0,
        totalPassedRateBps: 0,
        checkedAt: new Date().toISOString(),
        checkedBlocksCount: 0,
      };
    }

    const blocks = await this.getIps().catch(() => []);
    const attacks: any[] = [];
    let totalInboundRateBps = 0;
    let totalScrubbedRateBps = 0;
    let totalPassedRateBps = 0;

    // Scan IPv4 blocks for active mitigation in parallel (batches of 6)
    const ipv4Blocks = blocks.filter(b => !b.includes(':'));
    for (let i = 0; i < ipv4Blocks.length; i += 6) {
      const batch = ipv4Blocks.slice(i, i + 6);
      await Promise.all(
        batch.map(async (b) => {
          try {
            const mitigatedIps = await this.request('GET', `/ip/${encodeURIComponent(b)}/mitigation`);
            if (Array.isArray(mitigatedIps) && mitigatedIps.length > 0) {
              for (const ip of mitigatedIps) {
                try {
                  const detail = await this.request('GET', `/ip/${encodeURIComponent(b)}/mitigation/${encodeURIComponent(ip)}`).catch(() => null);
                  if (!detail) continue;

                  const rawState = String(detail.state || 'ok').toLowerCase();
                  // In OVH API, 'ok' or 'unmitigated' means the IP is NOT undergoing active mitigation/scrubbing
                  const isActivelyUnderAttack =
                    rawState === 'mitigation' ||
                    rawState === 'forced' ||
                    rawState === 'creation' ||
                    rawState === 'cleaning';

                  if (!isActivelyUnderAttack) {
                    continue;
                  }

                  const stats = await this.getLiveMitigationStats(ip).catch(() => []);
                  const latestStat = stats && stats.length > 0 ? stats[stats.length - 1] : null;

                  const inBps = Number(latestStat?.in?.bps || latestStat?.inBps || 0);
                  const droppedBps = Number(latestStat?.drop?.bps || latestStat?.droppedBps || 0);
                  const passedBps = Number(latestStat?.passed?.bps || latestStat?.passedBps || 0);
                  const inPps = Number(latestStat?.in?.pps || latestStat?.pps || 0);

                  totalInboundRateBps += inBps;
                  totalScrubbedRateBps += droppedBps;
                  totalPassedRateBps += passedBps;

                  attacks.push({
                    ip,
                    block: b,
                    state: detail.state || 'mitigation',
                    mode: detail.permanent ? 'permanent' : 'automatic',
                    inBps,
                    droppedBps,
                    passedBps,
                    inPps,
                    vectors: ['Volumetric Ingress Scrubbing'],
                    startedAt: detail.date || new Date().toISOString(),
                  });
                } catch {
                  // Non-fatal error for individual IP
                }
              }
            }
          } catch {
            // Block does not support /mitigation or has error
          }
        })
      );
    }

    const result = {
      isAnyUnderAttack: attacks.length > 0,
      activeAttacksCount: attacks.length,
      attacks,
      totalInboundRateBps,
      totalScrubbedRateBps,
      totalPassedRateBps,
      checkedAt: new Date().toISOString(),
      checkedBlocksCount: ipv4Blocks.length,
    };

    this.fleetDdosCache = { data: result, timestamp: Date.now() };
    return result;
  }

  // Get Anti-Hack (Blocked IP) Status
  async getAntiHackStatus(ip: string): Promise<{ blockedSince: string; logs: string; state: string; timeToUnblock: number } | null> {
    const block = this.getBlock(ip);
    try {
      // First check if the IP is in the antihack list
      const blockedIps = await this.request('GET', `/ip/${encodeURIComponent(block)}/antihack`);
      if (!blockedIps.includes(ip)) {
        return null; // Not blocked
      }
      
      // If blocked, fetch the detailed status
      const data = await this.request('GET', `/ip/${encodeURIComponent(block)}/antihack/${encodeURIComponent(ip)}`);
      return {
        blockedSince: data.blockedSince,
        logs: data.logs || 'No logs provided by OVH.',
        state: data.state,
        timeToUnblock: data.time || 0 // Time in seconds remaining before unblock is allowed
      };
    } catch (err: any) {
      if (err.message?.includes('404')) return null;
      throw err;
    }
  }

  // Request Unblock from Anti-Hack
  async unblockAntiHack(ip: string): Promise<void> {
    const block = this.getBlock(ip);
    await this.request('POST', `/ip/${encodeURIComponent(block)}/antihack/${encodeURIComponent(ip)}/unblock`);
  }

  // Get Edge Firewall overall state
  async getFirewallState(ip: string): Promise<{ enabled: boolean; state: string }> {
    try {
      const block = this.getBlock(ip);
      const data = await this.request('GET', `/ip/${encodeURIComponent(block)}/firewall/${encodeURIComponent(ip)}`);
      return {
        enabled: data.enabled || false,
        state: data.state || 'unknown'
      };
    } catch (err: any) {
      if (err.message?.includes('404')) {
        return { enabled: false, state: 'not_configured' };
      }
      throw err;
    }
  }

  // Enable/Disable Edge Firewall
  async toggleFirewall(ip: string, enabled: boolean): Promise<void> {
    const block = this.getBlock(ip);
    try {
      await this.request('PUT', `/ip/${encodeURIComponent(block)}/firewall/${encodeURIComponent(ip)}`, {
        enabled
      });
    } catch (err: any) {
      // If it doesn't exist, create it first
      if (err.message?.includes('404') && enabled) {
        await this.request('POST', `/ip/${encodeURIComponent(block)}/firewall`, {
          ipOnFirewall: ip
        });
      } else {
        throw err;
      }
    }
  }

  // Get Edge Firewall Rules
  async getFirewallRules(ip: string): Promise<any[]> {
    const block = this.getBlock(ip);
    try {
      const sequences: number[] = await this.request('GET', `/ip/${encodeURIComponent(block)}/firewall/${encodeURIComponent(ip)}/rule`);
      const rules = await Promise.all(
        sequences.map(seq =>
          this.request('GET', `/ip/${encodeURIComponent(block)}/firewall/${encodeURIComponent(ip)}/rule/${seq}`)
        )
      );
      return rules.sort((a, b) => a.sequence - b.sequence);
    } catch (err: any) {
      if (err.message?.includes('404')) {
        return [];
      }
      throw err;
    }
  }

  // Create Edge Firewall Rule
  async createFirewallRule(ip: string, rule: { sequence: number; action: 'permit' | 'deny'; protocol: 'tcp' | 'udp' | 'icmp' | 'ipv4'; sourcePort?: string; destinationPort?: string; source?: string }): Promise<any> {
    const payload: any = {
      sequence: rule.sequence,
      action: rule.action,
      protocol: rule.protocol,
    };
    if (rule.source) {
      payload.source = rule.source;
    }
    if (rule.protocol === 'tcp' || rule.protocol === 'udp') {
      if (rule.sourcePort) payload.sourcePort = rule.sourcePort;
      if (rule.destinationPort) payload.destinationPort = rule.destinationPort;
    }
    const block = this.getBlock(ip);
    return await this.request('POST', `/ip/${encodeURIComponent(block)}/firewall/${encodeURIComponent(ip)}/rule`, payload);
  }

  // Delete Edge Firewall Rule
  async deleteFirewallRule(ip: string, sequence: number): Promise<void> {
    const block = this.getBlock(ip);
    await this.request('DELETE', `/ip/${encodeURIComponent(block)}/firewall/${encodeURIComponent(ip)}/rule/${sequence}`);
  }

  // Get Game DDoS ports rules
  async getGameDdosRules(ip: string): Promise<any[]> {
    const block = this.getBlock(ip);
    try {
      const ids: number[] = await this.request('GET', `/ip/${encodeURIComponent(block)}/game/${encodeURIComponent(ip)}/rule`);
      const rawRules = await Promise.all(
        ids.map(id =>
          this.request('GET', `/ip/${encodeURIComponent(block)}/game/${encodeURIComponent(ip)}/rule/${id}`)
        )
      );

      // Normalise: OVH returns:
      //   { id, protocol (= game type), state, ports: { from, to } }
      // Map to consistent frontend field names.
      return rawRules.map((r: any) => ({
        id: r.id,
        fromPort: r.ports?.from ?? r.fromPort ?? r.from_port ?? null,
        toPort:   r.ports?.to   ?? r.toPort   ?? r.to_port   ?? null,
        // OVH's `protocol` carries the game profile enum (e.g. "other", "gtasanandreasmultiplayermod")
        gameType: r.gameType ?? r.game_type ?? r.protocol ?? null,
        // Actual L4 protocol — OVH game rules are always UDP
        l4Protocol: r.l4Protocol ?? r.udpOrTcp ?? 'udp',
        state: r.state ?? 'ok',
      }));
    } catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('does not exist')) {
        return [];
      }
      throw err;
    }
  }

  // Normalise game profile string to OVH's exact protocol enum
  normalizeGameProfile(game: string): string {
    const g = (game || '').trim().toLowerCase();
    if (g === 'samp' || g === 'sa-mp' || g === 'gtasamp' || g === 'gtasa' || g === 'gtasanandreasmultiplayermod') {
      return 'gtaSanAndreasMultiplayerMod';
    }
    if (g === 'mta' || g === 'mtasa' || g === 'gtamultitheftautosanandreas') {
      return 'gtaMultiTheftAutoSanAndreas';
    }
    if (g === 'minecraft' || g === 'minecraftjava') {
      return 'minecraft';
    }
    if (g === 'minecraftpocketedition' || g === 'bedrock' || g === 'pe') {
      return 'minecraftPocketEdition';
    }
    if (g === 'minecraftquery') {
      return 'minecraftQuery';
    }
    if (g === 'rust') {
      return 'rust';
    }
    if (g === 'ark' || g === 'arksurvivalevolved') {
      return 'arkSurvivalEvolved';
    }
    if (g === 'arma' || g === 'arma3') {
      return 'arma';
    }
    if (g === 'teamspeak' || g === 'teamspeak3' || g === 'ts3') {
      return 'teamspeak3';
    }
    if (g === 'teamspeak2') {
      return 'teamspeak2';
    }
    if (g === 'mumble') {
      return 'mumble';
    }
    if (g === 'valve' || g === 'halflife' || g === 'source' || g === 'cs2' || g === 'csgo' || g === 'tf2') {
      return 'halfLife';
    }
    if (g === 'trackmania') {
      return 'trackmania';
    }
    return game || 'other';
  }

  // Create Game DDoS Rule
  async createGameDdosRule(ip: string, rule: { fromPort?: number; port: number; protocol: 'tcp' | 'udp'; game: string }): Promise<any> {
    const block = this.getBlock(ip);
    const toPort = rule.port;
    const fromPort = rule.fromPort !== undefined ? rule.fromPort : toPort;
    const protocol = this.normalizeGameProfile(rule.game);
    const payload: any = {
      // OVH's actual schema: ports nested object + protocol = game type
      ports: { from: fromPort, to: toPort },
      protocol,
    };
    return await this.request('POST', `/ip/${encodeURIComponent(block)}/game/${encodeURIComponent(ip)}/rule`, payload);
  }

  // Delete Game DDoS Rule
  async deleteGameDdosRule(ip: string, ruleId: number): Promise<void> {
    const block = this.getBlock(ip);
    await this.request('DELETE', `/ip/${encodeURIComponent(block)}/game/${encodeURIComponent(ip)}/rule/${ruleId}`);
  }

  // --- Virtual MAC (vMAC) Operations ---

  // Look up Virtual MAC associated with an IP address on OVH Dedicated Servers
  async getVirtualMac(ip: string): Promise<{ macAddress: string; type?: string; serviceName?: string; virtualMachineName?: string } | null> {
    try {
      const block = this.getBlock(ip);
      let serviceName: string | undefined;

      try {
        const ipInfo = await this.request('GET', `/ip/${encodeURIComponent(block)}`);
        if (ipInfo?.routedTo?.serviceName) {
          serviceName = ipInfo.routedTo.serviceName;
        }
      } catch { /* proceed */ }

      if (serviceName) {
        const macResult = await this.getVirtualMacForServer(serviceName, ip);
        if (macResult) return macResult;
      }

      let servers: string[] = [];
      try {
        servers = (await this.request('GET', '/dedicated/server')) || [];
      } catch {
        servers = [];
      }

      for (const s of servers) {
        const macResult = await this.getVirtualMacForServer(s, ip);
        if (macResult) return macResult;
      }

      return null;
    } catch (err) {
      console.warn(`[OVH] Failed to get virtual MAC for ${ip}:`, err);
      return null;
    }
  }

  private async getVirtualMacForServer(serviceName: string, ip: string): Promise<{ macAddress: string; type?: string; serviceName?: string; virtualMachineName?: string } | null> {
    try {
      const macs: string[] = (await this.request('GET', `/dedicated/server/${encodeURIComponent(serviceName)}/virtualMac`)) || [];
      for (const mac of macs) {
        try {
          const addrs: string[] = (await this.request('GET', `/dedicated/server/${encodeURIComponent(serviceName)}/virtualMac/${encodeURIComponent(mac)}/virtualAddress`)) || [];
          if (addrs.includes(ip)) {
            const details = await this.request('GET', `/dedicated/server/${encodeURIComponent(serviceName)}/virtualMac/${encodeURIComponent(mac)}`).catch(() => null);
            return {
              macAddress: mac,
              type: details?.type || 'ovh',
              serviceName,
              virtualMachineName: details?.virtualMachineName,
            };
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return null;
  }

  // Create Virtual MAC on OVH
  async createVirtualMac(ip: string, options?: { serviceName?: string; vmName?: string; type?: 'ovh' | 'virtualmachine' }): Promise<{ macAddress: string; type: string; serviceName?: string }> {
    let serviceName = options?.serviceName;
    if (!serviceName) {
      const block = this.getBlock(ip);
      try {
        const ipInfo = await this.request('GET', `/ip/${encodeURIComponent(block)}`);
        serviceName = ipInfo?.routedTo?.serviceName;
      } catch { /* fallback */ }
    }

    if (!serviceName) {
      const servers: string[] = (await this.request('GET', '/dedicated/server')) || [];
      serviceName = servers[0];
    }

    if (!serviceName) {
      throw new Error('No OVH dedicated server found for this IP. Please ensure an OVH dedicated server is connected.');
    }

    const res = await this.request('POST', `/dedicated/server/${encodeURIComponent(serviceName)}/virtualMac`, {
      ipAddress: ip,
      type: options?.type || 'ovh',
      virtualMachineName: options?.vmName || `vm-${ip.replace(/\./g, '-')}`,
    });

    return {
      macAddress: res.macAddress || res,
      type: res.type || options?.type || 'ovh',
      serviceName,
    };
  }

  // Delete Virtual MAC or unbind IP from Virtual MAC
  async deleteVirtualMac(ip: string, mac: string, serviceName?: string): Promise<boolean> {
    if (!serviceName) {
      const vMac = await this.getVirtualMac(ip);
      serviceName = vMac?.serviceName;
    }
    if (!serviceName) return false;

    try {
      await this.request('DELETE', `/dedicated/server/${encodeURIComponent(serviceName)}/virtualMac/${encodeURIComponent(mac)}/virtualAddress/${encodeURIComponent(ip)}`);
    } catch {
      try {
        await this.request('DELETE', `/dedicated/server/${encodeURIComponent(serviceName)}/virtualMac/${encodeURIComponent(mac)}`);
      } catch { /* ignore */ }
    }
    return true;
  }

  // Reset Virtual MAC on OVH
  async resetVirtualMac(ip: string, options?: { serviceName?: string; vmName?: string }): Promise<{ macAddress: string; type: string; serviceName?: string }> {
    const existing = await this.getVirtualMac(ip);
    if (existing) {
      await this.deleteVirtualMac(ip, existing.macAddress, existing.serviceName);
    }
    return await this.createVirtualMac(ip, options);
  }
}

export const ovhService = new OvhService();
