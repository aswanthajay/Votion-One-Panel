import { dbService } from '../db/database.js';

export interface HetznerConfig {
  enabled: boolean;
  user: string;
  password: string;
}

export interface HetznerIp {
  ip: string;
  serverIp?: string;
  serverNumber?: number;
  locked?: boolean;
  separateMac?: string | null;
  trafficWarnings?: boolean;
}

export interface HetznerSubnet {
  ip: string;
  mask: number;
  serverIp?: string;
  serverNumber?: number;
  failover?: boolean;
  locked?: boolean;
}

export class HetznerService {
  private config: HetznerConfig | null = null;
  private baseUrl = 'https://robot-ws.your-server.de';
  private cachedIps: string[] = [];
  private lastIpsFetch = 0;

  constructor() {
    void this.loadConfig();
  }

  async loadConfig() {
    try {
      const config = await dbService.getSystemSetting('hetzner_config');
      if (config && config.enabled && config.user && config.password) {
        this.config = config as HetznerConfig;
        console.log('[HETZNER] Service enabled and configured.');
      } else {
        this.config = null;
        console.log('[HETZNER] Service disabled.');
      }
    } catch (err) {
      console.error('[HETZNER] Failed to load config:', err);
      this.config = null;
    }
  }

  isEnabled(): boolean {
    return this.config !== null && Boolean(this.config.enabled);
  }

  private async request(method: string, path: string, body?: Record<string, string>): Promise<any> {
    if (!this.config || !this.config.user || !this.config.password) {
      throw new Error('Hetzner Robot service is not configured or disabled');
    }

    const url = `${this.baseUrl}${path}`;
    const authHeader = 'Basic ' + Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64');
    const headers: Record<string, string> = {
      'Authorization': authHeader,
      'Accept': 'application/json',
    };

    let bodyStr: string | undefined;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      bodyStr = new URLSearchParams(body).toString();
    }

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      const errText = await response.text();
      let errJson;
      try {
        errJson = JSON.parse(errText);
      } catch {
        errJson = null;
      }
      const errMsg = errJson?.error?.message || errJson?.message || errText || `HTTP ${response.status} ${response.statusText}`;
      throw new Error(errMsg);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // --- IP & Subnet Operations ---

  // List all assigned single IPs
  async getIps(): Promise<HetznerIp[]> {
    const data = await this.request('GET', '/ip');
    if (!Array.isArray(data)) return [];
    return data.map((item: any) => ({
      ip: item.ip?.ip || item.ip,
      serverIp: item.ip?.server_ip,
      serverNumber: item.ip?.server_number,
      locked: item.ip?.locked,
      separateMac: item.ip?.separate_mac || null,
      trafficWarnings: item.ip?.traffic_warnings,
    }));
  }

  // List all assigned subnets
  async getSubnets(): Promise<HetznerSubnet[]> {
    const data = await this.request('GET', '/subnet');
    if (!Array.isArray(data)) return [];
    return data.map((item: any) => ({
      ip: item.subnet?.ip || item.ip,
      mask: item.subnet?.mask || item.mask,
      serverIp: item.subnet?.server_ip,
      serverNumber: item.subnet?.server_number,
      failover: item.subnet?.failover,
      locked: item.subnet?.locked,
    }));
  }

  // Get specific single IP info
  async getIpDetails(ip: string): Promise<HetznerIp | null> {
    try {
      const data = await this.request('GET', `/ip/${encodeURIComponent(ip)}`);
      const raw = data.ip || data;
      return {
        ip: raw.ip,
        serverIp: raw.server_ip,
        serverNumber: raw.server_number,
        locked: raw.locked,
        separateMac: raw.separate_mac || null,
        trafficWarnings: raw.traffic_warnings,
      };
    } catch (err: any) {
      if (err.message?.includes('NOT_FOUND') || err.message?.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  // List all IP strings and CIDRs for subnet matching
  async getAllSubnetStrings(): Promise<string[]> {
    if (Date.now() - this.lastIpsFetch < 300000 && this.cachedIps.length > 0) {
      return this.cachedIps;
    }
    try {
      const [ips, subnets] = await Promise.all([
        this.getIps().catch(() => []),
        this.getSubnets().catch(() => []),
      ]);
      const list: string[] = [];
      for (const item of ips) {
        if (item.ip) list.push(`${item.ip}/32`);
      }
      for (const item of subnets) {
        if (item.ip && item.mask) list.push(`${item.ip}/${item.mask}`);
      }
      this.cachedIps = Array.from(new Set(list));
      this.lastIpsFetch = Date.now();
      return this.cachedIps;
    } catch {
      return this.cachedIps;
    }
  }

  // --- Virtual MAC Operations ---

  // Query separate virtual MAC for an IP
  async getVirtualMac(ip: string): Promise<string | null> {
    try {
      const data = await this.request('GET', `/ip/${encodeURIComponent(ip)}/mac`);
      return data?.mac?.mac || data?.mac || null;
    } catch (err: any) {
      if (err.message?.includes('NOT_FOUND') || err.message?.includes('404') || err.message?.includes('MAC_NOT_FOUND')) {
        return null;
      }
      throw err;
    }
  }

  // Generate / allocate separate virtual MAC for an IP
  async generateVirtualMac(ip: string): Promise<string> {
    const data = await this.request('PUT', `/ip/${encodeURIComponent(ip)}/mac`);
    const mac = data?.mac?.mac || data?.mac;
    if (!mac) {
      throw new Error('Hetzner Robot did not return a valid virtual MAC address');
    }
    return String(mac).toLowerCase();
  }

  // Delete separate virtual MAC for an IP
  async deleteVirtualMac(ip: string): Promise<void> {
    try {
      await this.request('DELETE', `/ip/${encodeURIComponent(ip)}/mac`);
    } catch (err: any) {
      if (err.message?.includes('NOT_FOUND') || err.message?.includes('404')) {
        return; // already gone
      }
      throw err;
    }
  }

  // --- Reverse DNS (PTR) Operations ---

  // Get Reverse DNS record
  async getReverse(ip: string): Promise<string | null> {
    try {
      const data = await this.request('GET', `/rdns/${encodeURIComponent(ip)}`);
      return data?.rdns?.ptr || data?.ptr || null;
    } catch (err: any) {
      if (err.message?.includes('NOT_FOUND') || err.message?.includes('404') || err.message?.includes('RDNS_NOT_FOUND')) {
        return null;
      }
      throw err;
    }
  }

  // Set / update Reverse DNS record
  async setReverse(ip: string, ptr: string): Promise<void> {
    const cleanPtr = ptr.trim();
    if (!cleanPtr) {
      return await this.deleteReverse(ip);
    }
    await this.request('POST', `/rdns/${encodeURIComponent(ip)}`, { ptr: cleanPtr });
  }

  // Delete Reverse DNS record
  async deleteReverse(ip: string): Promise<void> {
    try {
      await this.request('DELETE', `/rdns/${encodeURIComponent(ip)}`);
    } catch (err: any) {
      if (err.message?.includes('NOT_FOUND') || err.message?.includes('404')) {
        return;
      }
      throw err;
    }
  }
}

export const hetznerService = new HetznerService();
