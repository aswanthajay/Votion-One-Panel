/**
 * Production API Client for Stellar Panel
 * Connects Vite React Frontend directly to Express Backend Server (http://localhost:5000/api/v1)
 * with automated retries, JWT authorization header injection, and persistent database store.
 */

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
export const API_ORIGIN = API_BASE_URL.replace(/\/api\/v1\/?$/, '');

export interface ApiNode {
  id?: string;
  node: string;
  nodeName?: string;
  ip?: string;
  ipAddress?: string;
  status: 'online' | 'offline' | 'maintenance';
  cpuUsagePct: number;
  cpuCores?: number;
  ramUsageBytes: number;
  ramTotalBytes: number;
  storageUsageGb?: number;
  storageTotalGb?: number;
  rootUsedGb?: number;
  rootTotalGb?: number;
  uptimeSeconds: number;
  platformVersion: string;
  zfsHealth?: string;
  zfsPoolStatus?: string;
}

export interface ApiClusterOverview {
  clusterStatus: {
    clusterName: string;
    totalNodes: number;
    onlineNodes: number;
    status: string;
  };
  totalNodes: number;
  totalCpuPct: number;
  totalCpuCores?: number;
  totalRamUsedGb: number;
  totalRamMaxGb: number;
  totalStorageUsedGb?: number;
  totalStorageTotalGb?: number;
  totalVMsCount: number;
  runningVMsCount: number;
  suspendedVMsCount: number;
  zfsPoolStatus: string;
}

export interface ApiVM {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  node: string;
  ownerEmail: string;
  status: 'running' | 'stopped' | 'paused';
  cpus: number;
  memory: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  ipAddress?: string;
  cpuUsagePct?: number;
  ramUsageBytes?: number;
  diskUsageBytes?: number;
  os?: string;
  expiryDate?: string;
  isSuspended?: boolean;
  createdAt?: string;
}

export interface ApiAccount {
  id: number;
  email: string;
  name: string;
  role: 'administrator' | 'moderator' | 'user' | 'admin' | 'client';
  phone?: string;
  supportPin?: string;
  twoFactorActive?: boolean;
  created_at?: string;
}

export interface ApiProxmoxConnection {
  id: string;
  name: string;
  host_ip: string;
  port: number;
  token_id: string;
  ssl_fingerprint: string;
  status: string;
  last_tested: string;
}

export interface ApiAuditLog {
  id: string;
  timestamp: string;
  userEmail: string;
  action: string;
  target: string;
  details: string;
  status: 'success' | 'warning' | 'failed';
}

export interface ApiTask {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  progressPct: number;
  node: string;
  startTime: string;
}

export interface ApiSupportTicket {
  id: string;
  subject: string;
  category: string;
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  vmid?: number;
  userEmail?: string;
  createdAt: string;
}

export interface ApiTicketReply {
  id: string;
  ticketId: string;
  senderEmail: string;
  senderRole: 'admin' | 'client';
  message: string;
  timestamp: string;
}

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem('votion_jwt_token');
  }

  public getUserEmail(): string {
    return localStorage.getItem('votion_user_email') || 'client@votioncloud.org';
  }

  public getUserRole(): string {
    return localStorage.getItem('votion_user_role') || 'client';
  }

  private getHeaders(extra: Record<string, string> = {}): HeadersInit {
    const token = this.getToken();
    return {
      'Content-Type': 'application/json',
      'x-user-email': this.getUserEmail(),
      'x-user-role': this.getUserRole(),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  /**
   * PROMPT 5: Client Portal Specific Methods
   */
  async getClientVMs(): Promise<ApiVM[]> {
    const res = await fetch(`${API_BASE_URL}/client/vms`, {
      headers: this.getHeaders(),
    });
    const data = await res.json();
    return data.data || [];
  }

  async getVMTelemetry(vmid: number) {
    const res = await fetch(`${API_BASE_URL}/client/vms/${vmid}/telemetry`, {
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async executeClientPowerAction(vmid: number, action: 'start' | 'stop' | 'reboot' | 'shutdown') {
    const res = await fetch(`${API_BASE_URL}/client/vms/${vmid}/power`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ action }),
    });
    return await res.json();
  }

  /**
   * PROMPT 4: Admin Allocation, Expiry & Suspension Methods
   */
  async assignServerToUser(assignData: { vmid?: number; name?: string; targetEmail: string; cpus?: number; memoryGb?: number; diskGb?: number; expiryDays?: number; os?: string }) {
    const res = await fetch(`${API_BASE_URL}/admin/vms/assign`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(assignData),
    });
    return await res.json();
  }

  async updateServerExpiry(vmid: number, additionalDays: number) {
    const res = await fetch(`${API_BASE_URL}/admin/vms/${vmid}/expiry`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ additionalDays }),
    });
    return await res.json();
  }

  async toggleServerSuspend(vmid: number, suspend: boolean) {
    const res = await fetch(`${API_BASE_URL}/admin/vms/${vmid}/suspend`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ suspend }),
    });
    return await res.json();
  }

  /**
   * PROMPT 3: Admin Node Monitoring & Cluster Overview APIs
   */
  async getAdminNodes(): Promise<ApiNode[]> {
    const res = await fetch(`${API_BASE_URL}/admin/nodes`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  async getClusterOverview(): Promise<ApiClusterOverview | null> {
    const res = await fetch(`${API_BASE_URL}/admin/cluster/overview`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || null;
  }

  /**
   * Strict Login Authentication Endpoint
   */
  async login(email: string, password: string): Promise<{ success: boolean; token?: string; user?: any; error?: string }> {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('votion_jwt_token', data.token);
        localStorage.setItem('votion_user_email', data.user.email);
        localStorage.setItem('votion_user_role', data.user.role);
        return data;
      }
      return { success: false, error: data.error || 'Invalid credentials' };
    } catch (err) {
      return {
        success: false,
        error: 'Invalid email address or password. Please verify your credentials or use Account Recovery.',
      };
    }
  }

  /**
   * User Registration Endpoint
   */
  async register(name: string, email: string, password: string) {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('votion_jwt_token', data.token);
        localStorage.setItem('votion_user_email', data.user.email);
        localStorage.setItem('votion_user_role', data.user.role);
        return data;
      }
      return { success: false, error: data.error || 'Registration failed' };
    } catch (err) {
      return { success: false, error: 'Network error. Please check your connection and try again.' };
    }
  }

  /**
   * Fetch Live User Profile from PostgreSQL
   */
  async getUserProfile(email?: string): Promise<ApiAccount | null> {
    const targetEmail = email || this.getUserEmail();
    const res = await fetch(`${API_BASE_URL}/user/profile?email=${encodeURIComponent(targetEmail)}`, {
      headers: this.getHeaders(),
    });
    const data = await res.json();
    return data.data || null;
  }

  /**
   * Update User Profile & Name/Phone in PostgreSQL
   */
  async updateUserProfile(profileData: { email?: string; name?: string; phone?: string; supportPin?: string; twoFactorActive?: boolean }) {
    const email = profileData.email || this.getUserEmail();
    const res = await fetch(`${API_BASE_URL}/user/profile`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ ...profileData, email }),
    });
    return await res.json();
  }

  /**
   * Change Password Endpoint with PBKDF2 Hashing
   */
  async changePassword(currentPassword: string, newPassword: string) {
    const res = await fetch(`${API_BASE_URL}/user/change-password`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail(), currentPassword, newPassword }),
    });
    return await res.json();
  }

  /**
   * Regenerate Support PIN in PostgreSQL
   */
  async regenerateSupportPin() {
    const res = await fetch(`${API_BASE_URL}/user/regenerate-pin`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail() }),
    });
    return await res.json();
  }

  /**
   * Toggle 2FA State in PostgreSQL
   */
  async toggle2FA(active: boolean) {
    const res = await fetch(`${API_BASE_URL}/user/2fa/toggle`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail(), active }),
    });
    return await res.json();
  }

  /**
   * SUPPORT TICKET SYSTEM METHODS
   */
  async getSupportTickets(): Promise<ApiSupportTicket[]> {
    const res = await fetch(`${API_BASE_URL}/support/tickets`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  async getTicketDetails(ticketId: string): Promise<{ ticket: ApiSupportTicket; replies: ApiTicketReply[] } | null> {
    const res = await fetch(`${API_BASE_URL}/support/tickets/${ticketId}`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || null;
  }

  async createSupportTicket(subject: string, category: string, priority: 'low' | 'medium' | 'high' | 'urgent', vmid?: number) {
    const res = await fetch(`${API_BASE_URL}/support/tickets`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ subject, category, priority, vmid }),
    });
    return await res.json();
  }

  async addTicketReply(ticketId: string, message: string) {
    const res = await fetch(`${API_BASE_URL}/support/tickets/${ticketId}/replies`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ message }),
    });
    return await res.json();
  }

  async updateTicketStatus(ticketId: string, status: 'open' | 'in-progress' | 'resolved' | 'closed') {
    const res = await fetch(`${API_BASE_URL}/support/tickets/${ticketId}/status`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ status }),
    });
    return await res.json();
  }

  /**
   * VM & EXPIRY SUSPENSION METHODS
   */
  async suspendVM(vmid: number, suspend: boolean) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/suspend`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ suspend }),
    });
    return await res.json();
  }

  async extendVMExpiry(vmid: number, additionalDays: number) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/extend`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ additionalDays }),
    });
    return await res.json();
  }

  async reinstallVMOS(vmid: number, targetOS: string) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/reinstall`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ targetOS }),
    });
    return await res.json();
  }

  /**
   * Fetch Registered Accounts
   */
  async getAccounts(): Promise<ApiAccount[]> {
    const res = await fetch(`${API_BASE_URL}/accounts`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch PVE Nodes Matrix from Express API
   */
  async getNodes(): Promise<ApiNode[]> {
    const res = await fetch(`${API_BASE_URL}/nodes`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Reboot Node Signal
   */
  async rebootNode(nodeId: string) {
    const res = await fetch(`${API_BASE_URL}/nodes/${nodeId}/reboot`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  /**
   * Fetch VM Allocations from Express API
   */
  async getVMs(ownerEmail?: string): Promise<ApiVM[]> {
    const url = ownerEmail 
      ? `${API_BASE_URL}/vms?ownerEmail=${encodeURIComponent(ownerEmail)}` 
      : `${API_BASE_URL}/vms`;
    const res = await fetch(url, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Admin Reassign VM Ownership by VMID
   */
  async assignVM(vmid: number, targetEmail: string) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/assign`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ targetEmail }),
    });
    return await res.json();
  }

  /**
   * Admin Delete VM Allocation by VMID
   */
  async deleteVM(vmid: number) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  /**
   * Provision New VM/LXC Container & Assign to Account by VMID
   */
  async provisionVM(vmData: { vmid?: number; name: string; type: string; node: string; ownerEmail?: string; cpus: number; memoryGb: number; diskGb: number; expiryDays?: number; os?: string }) {
    const res = await fetch(`${API_BASE_URL}/vms`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(vmData),
    });
    return await res.json();
  }

  /**
   * Trigger VM Lifecycle Action via Express Backend
   */
  async executeVMAction(node: string, vmid: number, type: 'qemu' | 'lxc', action: 'start' | 'stop' | 'reboot' | 'shutdown') {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/action`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ node, type, action }),
    });
    return await res.json();
  }

  /**
   * Execute Command in VNC Terminal Console
   */
  async executeVncCommand(vmid: number, command: string) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/vnc/cmd`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ command }),
    });
    return await res.json();
  }

  /**
   * Fetch ISO & Software Downloads
   */
  async getDownloads() {
    const res = await fetch(`${API_BASE_URL}/downloads`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch Data Room Verification Documents
   */
  async getDataRoom() {
    const res = await fetch(`${API_BASE_URL}/dataroom`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch Cluster Pricing & Tier Plans
   */
  async getPricing() {
    const res = await fetch(`${API_BASE_URL}/pricing`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch Engine Release Notes
   */
  async getReleaseNotes() {
    const res = await fetch(`${API_BASE_URL}/release-notes`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch Terms & Privacy SLA
   */
  async getTerms() {
    const res = await fetch(`${API_BASE_URL}/terms`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || { title: 'VOTION Terms', sections: [] };
  }

  /**
   * Trigger ZFS Scrub via Express Backend
   */
  async triggerZfsScrub() {
    const res = await fetch(`${API_BASE_URL}/storage/zfs/scrub`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  /**
   * Fetch TimescaleDB Telemetry History
   */
  async getTelemetryHistory() {
    const res = await fetch(`${API_BASE_URL}/telemetry/history`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch Tasks List
   */
  async getTasks(): Promise<ApiTask[]> {
    const res = await fetch(`${API_BASE_URL}/tasks`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Fetch Cluster Audit Logs
   */
  async getAuditLogs(): Promise<ApiAuditLog[]> {
    const res = await fetch(`${API_BASE_URL}/audit-logs`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  // ==========================================
  // ADVANCED USER MANAGEMENT
  // ==========================================
  async getAdminUsers(): Promise<ApiAccount[]> {
    const res = await fetch(`${API_BASE_URL}/admin/users`, { headers: this.getHeaders() });
    return await res.json();
  }

  async createAdminUser(payload: any) {
    const res = await fetch(`${API_BASE_URL}/admin/users`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  async updateAdminUserRole(userId: number, role: string) {
    const res = await fetch(`${API_BASE_URL}/admin/users/${userId}/role`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ role }),
    });
    return await res.json();
  }

  async deleteAdminUser(userId: number) {
    const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  // ==========================================
  // CLUSTER CONNECTIONS MANAGER
  // ==========================================
  async getProxmoxConnections(): Promise<ApiProxmoxConnection[]> {
    const res = await fetch(`${API_BASE_URL}/admin/proxmox`, { headers: this.getHeaders() });
    return await res.json();
  }

  async addProxmoxConnection(payload: any) {
    const res = await fetch(`${API_BASE_URL}/admin/proxmox`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  async deleteProxmoxConnection(id: string) {
    const res = await fetch(`${API_BASE_URL}/admin/proxmox/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async testProxmoxConnection(payload: { host_ip: string; port: number; token_id: string; token_secret: string }) {
    const res = await fetch(`${API_BASE_URL}/admin/proxmox/test`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  // ==========================================
  // USER SECURITY & SETTINGS ENDPOINTS
  // ==========================================
  async changePrimaryEmail(newEmail: string) {
    const res = await fetch(`${API_BASE_URL}/user/change-email`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail(), newEmail: newEmail.toLowerCase().trim() }),
    });
    return await res.json();
  }

  async getSecondaryEmails() {
    const res = await fetch(`${API_BASE_URL}/user/secondary-emails?email=${encodeURIComponent(this.getUserEmail())}`, {
      headers: this.getHeaders(),
    });
    const data = await res.json();
    return data.data || [];
  }

  async addSecondaryEmail(secondaryEmail: string) {
    const res = await fetch(`${API_BASE_URL}/user/secondary-emails`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail(), secondaryEmail }),
    });
    return await res.json();
  }

  async removeSecondaryEmail(secondaryEmail: string) {
    const res = await fetch(`${API_BASE_URL}/user/secondary-emails/${encodeURIComponent(secondaryEmail)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async setup2FA() {
    const res = await fetch(`${API_BASE_URL}/user/2fa/setup`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail() }),
    });
    return await res.json();
  }

  async getPasskeys() {
    const res = await fetch(`${API_BASE_URL}/user/passkeys?email=${encodeURIComponent(this.getUserEmail())}`, {
      headers: this.getHeaders(),
    });
    const data = await res.json();
    return data.data || [];
  }

  async registerPasskey(credentialId: string, keyName: string) {
    const res = await fetch(`${API_BASE_URL}/user/passkeys`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail(), credentialId, keyName }),
    });
    return await res.json();
  }

  async deletePasskey(credentialId: string) {
    const res = await fetch(`${API_BASE_URL}/user/passkeys/${encodeURIComponent(credentialId)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async startRemoteSession() {
    const res = await fetch(`${API_BASE_URL}/user/remote-session/start`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail() }),
    });
    return await res.json();
  }

  async getActiveRemoteSession() {
    const res = await fetch(`${API_BASE_URL}/user/remote-session/active?email=${encodeURIComponent(this.getUserEmail())}`, {
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async disconnectRemoteSession() {
    const res = await fetch(`${API_BASE_URL}/user/remote-session/disconnect`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ email: this.getUserEmail() }),
    });
    return await res.json();
  }

  async uploadFile(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE_URL}/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.getToken()}`,
        'x-user-email': this.getUserEmail(),
      },
      body: formData,
    });
    return await res.json();
  }

  async getUploadedFiles() {
    const res = await fetch(`${API_BASE_URL}/files/list`, {
      headers: this.getHeaders(),
    });
    const data = await res.json();
    return data.data || [];
  }

  // ==========================================
  // VM SNAPSHOTS / BACKUPS
  // ==========================================
  async getVmSnapshots(vmid: number) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/snapshots`, { headers: this.getHeaders() });
    const data = await res.json();
    return data.data || [];
  }

  async createVmSnapshot(vmid: number, name: string, description: string) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/snapshots`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ name, description }),
    });
    return await res.json();
  }

  async deleteVmSnapshot(vmid: number, name: string) {
    const res = await fetch(`${API_BASE_URL}/vms/${vmid}/snapshots/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  // ==========================================
  // VM FIREWALL RULES
  // ==========================================
  async getFirewallRules(vmid: number) {
    const res = await fetch(`${API_BASE_URL}/client/vms/${vmid}/firewall`, { headers: this.getHeaders() });
    return await res.json();
  }

  async toggleFirewall(vmid: number, enable: boolean) {
    const res = await fetch(`${API_BASE_URL}/client/vms/${vmid}/firewall/toggle`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ enable }),
    });
    return await res.json();
  }

  async addFirewallRule(vmid: number, rule: { action: string; type: string; proto?: string; dport?: string; enable?: boolean; comment?: string }) {
    const res = await fetch(`${API_BASE_URL}/client/vms/${vmid}/firewall`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(rule),
    });
    return await res.json();
  }

  async deleteFirewallRule(vmid: number, pos: number) {
    const res = await fetch(`${API_BASE_URL}/client/vms/${vmid}/firewall/${pos}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  // ==========================================
  
  // USER EDIT + PASSWORD RESET (ADMIN)
  async updateAdminUser(userId: number, payload: { name?: string; email?: string; role?: string; phone?: string }) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error. Please check your connection.' };
    }
  }

  async resetAdminUserPassword(userId: number, newPassword: string, confirmPassword: string) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users/${userId}/reset-password`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ newPassword, confirmPassword }),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error. Please check your connection.' };
    }
  }

  // CLUSTER CONNECTION EDIT
  async updateProxmoxConnection(id: string, payload: any) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/proxmox/${id}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error. Please check your connection.' };
    }
  }

  // AUDIT LOGS
  async getFilteredAuditLogs(params: { action?: string; user_email?: string; status?: string; q?: string; limit?: number; offset?: number } = {}) {
    try {
      const qs = new URLSearchParams();
      if (params.action) qs.set('action', params.action);
      if (params.user_email) qs.set('user_email', params.user_email);
      if (params.status) qs.set('status', params.status);
      if (params.q) qs.set('q', params.q);
      if (params.limit) qs.set('limit', String(params.limit));
      if (params.offset) qs.set('offset', String(params.offset));
      const res = await fetch(`${API_BASE_URL}/audit-logs/filtered?${qs.toString()}`, { headers: this.getHeaders() });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error. Please check your connection.', total: 0, data: [] };
    }
  }

  async getAuditLogStats() {
    try {
      const res = await fetch(`${API_BASE_URL}/audit-logs/stats`, { headers: this.getHeaders() });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.', data: { total: 0, byAction: [], byStatus: [], byUser: [] } };
    }
  }

  // MAIL TEMPLATES
  async getMailTemplates() {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/mail-templates`, { headers: this.getHeaders() });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.', data: [] };
    }
  }

  async updateMailTemplate(key: string, payload: { subject?: string; body?: string; enabled?: boolean }) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/mail-templates/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.' };
    }
  }

  // MAIL NOTIFICATIONS
  async getMailNotifications() {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/settings/mail-notifications`, { headers: this.getHeaders() });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.', data: {} };
    }
  }

  async updateMailNotifications(payload: any) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/settings/mail-notifications`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.' };
    }
  }

  // SMTP (API v1)
  async getSmtpConfig() {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/settings/smtp`, { headers: this.getHeaders() });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.', data: null };
    }
  }

  async saveSmtpConfig(config: any) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/settings/smtp`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(config),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error.' };
    }
  }

  async testSmtp(testEmail: string) {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/settings/smtp/test`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ testEmail }),
      });
      return await res.json();
    } catch {
      return { success: false, error: 'Network error sending test email.' };
    }
  }

// ALERT RULES & NOTIFICATIONS
  // ==========================================
  async getAlertRules() {
    const res = await fetch(`${API_BASE_URL}/alert-rules`, { headers: this.getHeaders() });
    return await res.json();
  }

  async createAlertRule(rule: any) {
    const res = await fetch(`${API_BASE_URL}/alert-rules`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(rule),
    });
    return await res.json();
  }

  async updateAlertRule(id: number, rule: any) {
    const res = await fetch(`${API_BASE_URL}/alert-rules/${id}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(rule),
    });
    return await res.json();
  }

  async deleteAlertRule(id: number) {
    const res = await fetch(`${API_BASE_URL}/alert-rules/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async getNotifications(unreadOnly: boolean = false) {
    const res = await fetch(`${API_BASE_URL}/notifications?unreadOnly=${unreadOnly}`, { headers: this.getHeaders() });
    return await res.json();
  }

  async markNotificationsRead(ids?: number[]) {
    const res = await fetch(`${API_BASE_URL}/notifications/read`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ ids: ids || [] }),
    });
    return await res.json();
  }

  async deleteNotification(id: number) {
    const res = await fetch(`${API_BASE_URL}/notifications/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  async clearNotifications() {
    const res = await fetch(`${API_BASE_URL}/notifications/clear`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return await res.json();
  }

  // ==========================================
  // TELEMETRY EXPORT
  // ==========================================
  async getTelemetryHistoryFull() {
    const res = await fetch(`${API_BASE_URL}/telemetry/history`, { headers: this.getHeaders() });
    return await res.json();
  }

  async downloadTelemetryExport(format: 'csv' | 'json' = 'csv', range: '1h' | '24h' | '7d' = '24h') {
    const url = `${API_BASE_URL}/telemetry/export?format=${format}&range=${range}`;
    if (format === 'csv') {
      window.open(url, '_blank');
      return;
    }
    const res = await fetch(url, { headers: this.getHeaders() });
    const json = await res.json();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stellar-telemetry-${range}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async downloadVmTelemetryExport(vmid: number, format: 'csv' | 'json' = 'csv', range: '1h' | '24h' | '7d' = '24h') {
    const url = `${API_BASE_URL}/client/vms/${vmid}/export?format=${format}&range=${range}`;
    if (format === 'csv') {
      window.open(url, '_blank');
      return;
    }
    const res = await fetch(url, { headers: this.getHeaders() });
    const json = await res.json();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vm-${vmid}-telemetry-${range}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async automationFetch(path: string, options: RequestInit = {}) {
    const headers = new Headers(this.getHeaders());
    new Headers(options.headers || {}).forEach((value, key) => headers.set(key, value));
    const res = await fetch(`${API_ORIGIN}/api/automation${path}`, { ...options, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Automation request failed (${res.status})`);
    return data;
  }

  async checkRescue(vmid: number) { return this.automationFetch(`/vms/${vmid}/rescue/check`); }
  async enterRescueMode(vmid: number) { return this.automationFetch(`/vms/${vmid}/rescue/enter`, { method: 'POST' }); }
  async exitRescueMode(vmid: number) { return this.automationFetch(`/vms/${vmid}/rescue/exit`, { method: 'POST' }); }
  async getBandwidth(vmid: number) { return this.automationFetch(`/vms/${vmid}/bandwidth`); }
  async getQuota(vmid: number) { return this.automationFetch(`/vms/${vmid}/quota`); }
  async setQuota(vmid: number, bandwidthGb: number) { return this.automationFetch(`/vms/${vmid}/quota`, { method: 'PUT', body: JSON.stringify({ bandwidthGb }) }); }
  async getRdnsRequests(vmid: number) { return this.automationFetch(`/vms/${vmid}/rdns-requests`); }
  async requestRdns(vmid: number, ip: string, ptr: string) { return this.automationFetch(`/vms/${vmid}/rdns`, { method: 'POST', body: JSON.stringify({ ip, ptr }) }); }
  async getAppCatalogWithTemplates(vmid: number) { return this.automationFetch(`/apps/catalog?withTemplates=1&vmid=${vmid}`); }
  async deployApp(appId: string, vmid: number) { return this.automationFetch(`/apps/${encodeURIComponent(appId)}/deploy`, { method: 'POST', body: JSON.stringify({ vmid }) }); }
  async getUserApiKeys() { return this.automationFetch('/user/api-keys'); }
  async createApiKey(name: string, scope: 'read' | 'power' | 'full') { return this.automationFetch('/user/api-keys', { method: 'POST', body: JSON.stringify({ name, scope }) }); }
  async deleteApiKey(id: number) { return this.automationFetch(`/user/api-keys/${id}`, { method: 'DELETE' }); }
  async getSubUsers(vmid: number) { return this.automationFetch(`/vms/${vmid}/sub-users`); }
  async addSubUser(vmid: number, email: string, scope: 'readonly' | 'power' | 'full') { return this.automationFetch(`/vms/${vmid}/sub-users`, { method: 'POST', body: JSON.stringify({ email, scope }) }); }
  async updateSubUser(vmid: number, id: number, scope: 'readonly' | 'power' | 'full') { return this.automationFetch(`/vms/${vmid}/sub-users/${id}`, { method: 'PUT', body: JSON.stringify({ scope }) }); }
  async removeSubUser(vmid: number, id: number) { return this.automationFetch(`/vms/${vmid}/sub-users/${id}`, { method: 'DELETE' }); }
}

export const apiClient = new ApiClient();
