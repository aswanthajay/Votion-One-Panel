import React, { useState, useEffect } from 'react';
import { apiClient } from '../services/apiClient';

interface MailTemplate {
  id: number;
  template_key: string;
  subject: string;
  body: string;
  enabled: boolean;
  updated_at?: string;
}

interface MailNotifs {
  smtp_enabled?: boolean;
  alert_emails?: string;
  expiry_warning_emails?: string;
  welcome_emails?: string;
  alert_enabled?: boolean;
  expiry_enabled?: boolean;
  welcome_enabled?: boolean;
}

const PREVIEW_STYLES = {
  color: '#1a1a1a',
  fontFamily: 'sans-serif',
  lineHeight: 1.5,
};

const friendlyKey = (key: string): string => {
  const map: Record<string, string> = {
    welcome: 'Welcome Email',
    ticket_update: 'Support Ticket Update',
    expiry_warning: 'Service Expiry Warning',
    alert_fired: 'Alert Triggered',
    password_reset: 'Password Changed',
    account_updated: 'Account Updated',
    connection_test: 'Connection Test Result',
  };
  return map[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

export const SystemSettings: React.FC = () => {
  const [tab, setTab] = useState<'smtp' | 'templates' | 'notifications'>('smtp');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // SMTP
  const [config, setConfig] = useState({
    enabled: false,
    host: '',
    port: 587,
    user: '',
    pass: '',
    secure: false,
    from: 'noreply@votioncloud.org',
  });

  // Mail templates
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [editTemplate, setEditTemplate] = useState<MailTemplate | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');

  // Notifications
  const [notifs, setNotifs] = useState<MailNotifs>({});
  const [notifsSaving, setNotifsSaving] = useState(false);

  const show = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  useEffect(() => {
    (async () => {
      try {
        const smtp = await apiClient.getSmtpConfig();
        if (smtp.success && smtp.data) setConfig(smtp.data);
        const tpl = await apiClient.getMailTemplates();
        if (tpl.success) setTemplates(tpl.data || []);
        const n = await apiClient.getMailNotifications();
        if (n.success) setNotifs(n.data || {});
      } catch (err) {
        console.error('Failed to load settings', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiClient.saveSmtpConfig(config);
      if (res.success) {
        show('success', 'SMTP configuration saved and applied.');
      } else {
        show('error', res.error || 'Failed to save settings.');
      }
    } catch (err) {
      show('error', 'Network error saving configuration.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!testEmail) {
      show('error', 'Please enter a test email address.');
      return;
    }
    setTesting(true);
    try {
      const res = await apiClient.testSmtp(testEmail);
      if (res.success) {
        show('success', 'Test email dispatched successfully! Check your inbox.');
      } else {
        show('error', res.error || 'Failed to send test email.');
      }
    } catch (err) {
      show('error', 'Network error sending test email.');
    } finally {
      setTesting(false);
    }
  };

  const openTemplateEdit = (t: MailTemplate) => {
    setEditTemplate(t);
    setEditSubject(t.subject);
    setEditBody(t.body);
  };

  const handleSaveTemplate = async () => {
    if (!editTemplate) return;
    setSaving(true);
    try {
      const res = await apiClient.updateMailTemplate(editTemplate.template_key, {
        subject: editSubject,
        body: editBody,
        enabled: editTemplate.enabled,
      });
      if (res.success) {
        setTemplates((prev) => prev.map((x) => (x.template_key === editTemplate.template_key ? res.template : x)));
        show('success', `Template "${friendlyKey(editTemplate.template_key)}" updated`);
        setEditTemplate(null);
      } else {
        show('error', res.error || 'Failed to update template');
      }
    } catch (err) {
      show('error', 'Network error updating template');
    } finally {
      setSaving(false);
    }
  };

  const toggleTemplateEnabled = async (t: MailTemplate) => {
    try {
      const res = await apiClient.updateMailTemplate(t.template_key, { enabled: !t.enabled });
      if (res.success) {
        setTemplates((prev) => prev.map((x) => (x.template_key === t.template_key ? res.template : x)));
      }
    } catch (err) {
      show('error', 'Network error');
    }
  };

  const handleSaveNotifs = async () => {
    setNotifsSaving(true);
    try {
      const res = await apiClient.updateMailNotifications(notifs);
      if (res.success) {
        show('success', 'Notification preferences saved');
      } else {
        show('error', res.error || 'Failed to save preferences');
      }
    } catch (err) {
      show('error', 'Network error saving preferences');
    } finally {
      setNotifsSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-[#656b6b]">Loading system settings...</div>;
  }

  const tabs = [
    { key: 'smtp', label: 'SMTP Server' },
    { key: 'templates', label: 'Mail Templates' },
    { key: 'notifications', label: 'Notifications' },
  ] as const;

  return (
    <div className="p-8 max-w-[960px]">
      <div className="mb-8">
        <h1 className="page-heading">System Settings</h1>
        <p className="text-sm text-[#656b6b]">Manage global platform configurations, mailers, and notification preferences.</p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 border-b border-[#dedfdf]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-semibold tracking-wide transition-colors border-b-2 -mb-px cursor-pointer ${
              tab === t.key
                ? 'border-[#2563eb] text-[#2563eb]'
                : 'border-transparent text-[#656b6b] hover:text-[#1a1a1a]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {message && (
        <div className={`mb-6 p-4 text-sm font-medium border rounded-lg ${message.type === 'success' ? 'bg-[#f0fdf4] text-[#16a34a] border-[#bbf7d0]' : 'bg-[#fef2f2] text-[#dc2626] border-[#fecaca]'}`}>
          {message.type === 'success' ? '✓ ' : '⚠ '}{message.text}
        </div>
      )}

      {/* ================= SMTP TAB ================= */}
      {tab === 'smtp' && (
        <div className="bg-ink-card border border-[#dedfdf] rounded-xl shadow-sm overflow-hidden mb-8">
          <div className="px-6 py-5 border-b border-[#dedfdf] flex items-center justify-between bg-[#fbfaf9]">
            <div>
              <h2 className="text-base font-bold text-[#1a1a1a]">SMTP Mail Server</h2>
              <p className="text-xs text-[#656b6b] mt-1">Configure outbound transactional emails (Password Resets, Tickets, Welcome).</p>
            </div>
            <label className="flex items-center cursor-pointer">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={config.enabled}
                  onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                />
                <div className={`block w-12 h-6 rounded-full transition-colors ${config.enabled ? 'bg-[#2563eb]' : 'bg-[#dedfdf]'}`}></div>
                <div className={`dot absolute left-1 top-1 bg-ink-card w-4 h-4 rounded-full transition-transform ${config.enabled ? 'transform translate-x-6' : ''}`}></div>
              </div>
              <span className="ml-3 text-sm font-semibold text-[#1a1a1a]">{config.enabled ? 'Active' : 'Disabled'}</span>
            </label>
          </div>

          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6 relative">
            {!config.enabled && (
              <div className="absolute inset-0 bg-ink-card/60 backdrop-blur-[1px] z-10 flex items-center justify-center">
                <div className="bg-ink-card border border-[#dedfdf] shadow-lg rounded-lg px-4 py-2 text-sm font-semibold text-[#656b6b]">
                  Enable SMTP to configure settings
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">SMTP Host</label>
              <input
                type="text"
                value={config.host}
                onChange={(e) => setConfig({ ...config, host: e.target.value })}
                className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                placeholder="smtp.mailgun.org"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Port</label>
              <input
                type="number"
                value={config.port}
                onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 587 })}
                className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Username</label>
              <input
                type="text"
                value={config.user}
                onChange={(e) => setConfig({ ...config, user: e.target.value })}
                className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                placeholder="postmaster@domain.com"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Password</label>
              <input
                type="password"
                value={config.pass}
                onChange={(e) => setConfig({ ...config, pass: e.target.value })}
                className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                placeholder="••••••••••••"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Sender Address (From)</label>
              <input
                type="email"
                value={config.from}
                onChange={(e) => setConfig({ ...config, from: e.target.value })}
                className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                placeholder="noreply@votioncloud.org"
              />
            </div>

            <div className="flex items-center pt-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.secure}
                  onChange={(e) => setConfig({ ...config, secure: e.target.checked })}
                  className="rounded border-[#dedfdf]"
                />
                <span className="text-sm font-semibold text-[#1a1a1a]">Use SSL/TLS (Secure)</span>
              </label>
            </div>
          </div>

          <div className="bg-[#fbfaf9] border-t border-[#dedfdf] p-4 px-6 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="Test email address..."
                className="border border-[#dedfdf] rounded px-3 py-1.5 text-sm outline-none focus:border-[#1a1a1a] min-w-[200px]"
                disabled={!config.enabled}
              />
              <button
                onClick={handleTest}
                disabled={!config.enabled || testing}
                className="px-4 py-1.5 bg-ink-card border border-[#dedfdf] text-[#1a1a1a] font-semibold text-sm rounded hover:bg-[#f1f1f1] transition-colors disabled:opacity-50 cursor-pointer"
              >
                {testing ? 'Sending...' : 'Send Test'}
              </button>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2 bg-[#1a1a1a] text-white font-semibold text-sm rounded-lg hover:bg-black transition-colors cursor-pointer disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}

      {/* ================= MAIL TEMPLATES TAB ================= */}
      {tab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((t) => (
            <div key={t.template_key} className="bg-ink-card border border-[#dedfdf] rounded-xl p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-[#1a1a1a]">{friendlyKey(t.template_key)}</h3>
                  <p className="text-[10px] font-mono text-[#656b6b]">{t.template_key}</p>
                </div>
                <label className="flex items-center cursor-pointer">
                  <div className="relative">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={t.enabled}
                      onChange={() => toggleTemplateEnabled(t)}
                    />
                    <div className={`block w-10 h-5 rounded-full transition-colors ${t.enabled ? 'bg-[#2563eb]' : 'bg-[#dedfdf]'}`}></div>
                    <div className={`dot absolute left-0.5 top-0.5 bg-ink-card w-4 h-4 rounded-full transition-transform ${t.enabled ? 'transform translate-x-5' : ''}`}></div>
                  </div>
                </label>
              </div>
              <div className="bg-[#fbfaf9] border border-[#dedfdf] rounded-lg p-3 text-xs">
                <p className="font-semibold text-[#1a1a1a] mb-1">Subject: {t.subject}</p>
                <p className="text-[#656b6b] line-clamp-2" dangerouslySetInnerHTML={{ __html: t.body.replace(/<[^>]+>/g, '').slice(0, 120) }} />
              </div>
              <button
                onClick={() => openTemplateEdit(t)}
                className="mt-auto self-start px-4 py-1.5 text-xs font-semibold text-[#2563eb] bg-[#eff6ff] rounded hover:bg-[#dbeafe] transition-colors cursor-pointer"
              >
                Edit Template
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ================= NOTIFICATIONS TAB ================= */}
      {tab === 'notifications' && (
        <div className="flex flex-col gap-4">
          <div className="bg-ink-card border border-[#dedfdf] rounded-xl p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-base font-bold text-[#1a1a1a] mb-1">Notification Preferences</h2>
              <p className="text-xs text-[#656b6b]">Control which events generate email notifications and where they are delivered. These preferences require SMTP to be enabled.</p>
            </div>
            <div className="flex flex-col gap-4 pt-2">
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <p className="text-sm font-semibold text-[#1a1a1a]">Master Switch</p>
                  <p className="text-[11px] text-[#656b6b]">Globally enable or disable outbound email notifications</p>
                </div>
                <input
                  type="checkbox"
                  checked={!!notifs.smtp_enabled}
                  onChange={(e) => setNotifs({ ...notifs, smtp_enabled: e.target.checked })}
                  className="w-4 h-4 accent-[#2563eb]"
                />
              </label>
              <div className="border-t border-[#dedfdf] pt-4 flex flex-col gap-4">
                <label className="flex items-center justify-between gap-4 cursor-pointer">
                  <div>
                    <p className="text-sm font-semibold text-[#1a1a1a]">Alert Notifications</p>
                    <p className="text-[11px] text-[#656b6b]">Email when a custom alert rule threshold is triggered</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!notifs.alert_enabled}
                    onChange={(e) => setNotifs({ ...notifs, alert_enabled: e.target.checked })}
                    className="w-4 h-4 accent-[#2563eb]"
                  />
                </label>
                <div>
                  <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Alert Recipients (comma-separated emails)</label>
                  <input
                    type="text"
                    value={notifs.alert_emails || ''}
                    onChange={(e) => setNotifs({ ...notifs, alert_emails: e.target.value })}
                    placeholder="admin@votioncloud.org"
                    className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                  />
                </div>
              </div>
              <div className="border-t border-[#dedfdf] pt-4 flex flex-col gap-4">
                <label className="flex items-center justify-between gap-4 cursor-pointer">
                  <div>
                    <p className="text-sm font-semibold text-[#1a1a1a]">Expiry Warnings</p>
                    <p className="text-[11px] text-[#656b6b]">Email users when their virtual machines approach the expiry date</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!notifs.expiry_enabled}
                    onChange={(e) => setNotifs({ ...notifs, expiry_enabled: e.target.checked })}
                    className="w-4 h-4 accent-[#2563eb]"
                  />
                </label>
                <div>
                  <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Expiry Warning Recipients</label>
                  <input
                    type="text"
                    value={notifs.expiry_warning_emails || ''}
                    onChange={(e) => setNotifs({ ...notifs, expiry_warning_emails: e.target.value })}
                    placeholder="admin@votioncloud.org"
                    className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                  />
                </div>
              </div>
              <div className="border-t border-[#dedfdf] pt-4 flex flex-col gap-4">
                <label className="flex items-center justify-between gap-4 cursor-pointer">
                  <div>
                    <p className="text-sm font-semibold text-[#1a1a1a]">Welcome Emails</p>
                    <p className="text-[11px] text-[#656b6b]">Email new users when their account is provisioned</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!notifs.welcome_enabled}
                    onChange={(e) => setNotifs({ ...notifs, welcome_enabled: e.target.checked })}
                    className="w-4 h-4 accent-[#2563eb]"
                  />
                </label>
                <div>
                  <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Welcome CC Recipients</label>
                  <input
                    type="text"
                    value={notifs.welcome_emails || ''}
                    onChange={(e) => setNotifs({ ...notifs, welcome_emails: e.target.value })}
                    placeholder="admin@votioncloud.org"
                    className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveNotifs}
                disabled={notifsSaving}
                className="px-6 py-2 bg-[#1a1a1a] text-white font-semibold text-sm rounded-lg hover:bg-black transition-colors cursor-pointer disabled:opacity-60"
              >
                {notifsSaving ? 'Saving...' : 'Save Preferences'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= TEMPLATE EDIT MODAL ================= */}
      {editTemplate !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1010] flex items-center justify-center p-6 overflow-y-auto">
          <div className="w-full max-w-[640px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 my-8">
            <h3 className="text-base font-bold text-[#1a1a1a] mb-1">Edit Template: {friendlyKey(editTemplate.template_key)}</h3>
            <p className="text-xs text-[#656b6b] mb-5">Use placeholders like {'{name}'}, {'{email}'}, {'{vmid}'}, {'{ticketNumber}'}, {'{status}'} — they are replaced with real values when the email is sent.</p>

            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Subject Line</label>
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a]"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Email Body (HTML)</label>
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={10}
                  className="w-full border border-[#dedfdf] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1a1a1a] font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#1a1a1a] mb-1.5 uppercase tracking-wide">Live Preview</label>
                <div className="border border-[#dedfdf] rounded-lg p-4 bg-[#fbfaf9]" style={PREVIEW_STYLES} dangerouslySetInnerHTML={{ __html: editBody }} />
              </div>

              <div className="flex items-center gap-3 pt-2 border-t border-[#dedfdf]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editTemplate.enabled}
                    onChange={(e) => setEditTemplate({ ...editTemplate, enabled: e.target.checked })}
                    className="w-4 h-4 accent-[#2563eb]"
                  />
                  <span className="text-xs font-semibold text-[#1a1a1a]">Template enabled</span>
                </label>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setEditTemplate(null)}
                  className="btn-secondary px-4 py-2 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveTemplate}
                  disabled={saving}
                  className="btn-primary px-4 py-2 cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Saving...' : 'Save Template'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
