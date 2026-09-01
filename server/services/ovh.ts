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

class OvhService {
  private getBlock(ip: string): string {
    return ip.includes('/') ? ip : `${ip}/32`;
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

  private async request(method: string, path: string, body?: any): Promise<any> {
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

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: body ? bodyStr : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson;
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        errorJson = null;
      }
      throw new Error(errorJson?.message || errorText || `HTTP ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
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
    return Array.isArray(data) ? data : [];
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

  // Create Game DDoS Rule
  async createGameDdosRule(ip: string, rule: { fromPort?: number; port: number; protocol: 'tcp' | 'udp'; game: string }): Promise<any> {
    const block = this.getBlock(ip);
    const toPort = rule.port;
    const fromPort = rule.fromPort !== undefined ? rule.fromPort : toPort;
    const payload: any = {
      // OVH's actual schema: ports nested object + protocol = game type
      ports: { from: fromPort, to: toPort },
      protocol: rule.game, // e.g. 'other', 'minecraft', 'gtasanandreasmultiplayermod'
    };
    return await this.request('POST', `/ip/${encodeURIComponent(block)}/game/${encodeURIComponent(ip)}/rule`, payload);
  }

  // Delete Game DDoS Rule
  async deleteGameDdosRule(ip: string, ruleId: number): Promise<void> {
    const block = this.getBlock(ip);
    await this.request('DELETE', `/ip/${encodeURIComponent(block)}/game/${encodeURIComponent(ip)}/rule/${ruleId}`);
  }
}

export const ovhService = new OvhService();
