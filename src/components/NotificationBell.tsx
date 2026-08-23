import React, { useState, useEffect, useRef } from 'react';
import { apiClient } from '../services/apiClient';

interface Notification {
  id: number;
  title: string;
  message: string;
  severity: string;
  isRead: boolean;
  createdAt: string;
}

export const NotificationBell: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const res = await apiClient.getNotifications(false);
      if (res?.success) {
        setNotifications(res.data || []);
        setUnreadCount(Number(res.unreadCount || 0));
      }
    } catch {
      // Silent — bell should never break the header
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await apiClient.markNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch {
      // ignore
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Delete all notifications? This cannot be undone.')) return;
    try {
      await apiClient.clearNotifications();
      setNotifications([]);
      setUnreadCount(0);
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiClient.deleteNotification(id);
      setNotifications(prev => prev.filter(n => n.id !== id));
    } catch {
      // ignore
    }
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  const severityColor = (sev: string) =>
    sev === 'critical' ? 'text-[#dc2626] bg-[#fef2f2] border-[#fecaca]' :
    sev === 'info' ? 'text-[#2563eb] bg-[#eff6ff] border-[#bfdbfe]' :
    'text-[#b45309] bg-[#fffbeb] border-[#fde68a]';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="header-link relative cursor-pointer flex items-center gap-1"
        title="Alert notifications"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span>Alerts</span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-2 min-w-[16px] h-4 bg-[#dc2626] text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-80 max-w-[92vw] bg-white border border-[#dedfdf] rounded-xl shadow-2xl z-[300] flex flex-col overflow-hidden">
          <div className="flex items-center justify-between bg-[#fbfaf9] px-4 py-2.5 border-b border-[#dedfdf]">
            <span className="text-xs font-bold uppercase tracking-widest text-[#1a1a1a]">
              Alert Notifications{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}
            </span>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button onClick={handleMarkAllRead} className="text-[10px] font-bold uppercase tracking-wide text-[#2563eb] hover:underline cursor-pointer">
                  Mark all read
                </button>
              )}
              <button onClick={handleClear} className="text-[10px] font-bold uppercase tracking-wide text-[#dc2626] hover:underline cursor-pointer">
                Clear
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-[#dedfdf]">
            {notifications.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#a7aaaa] font-mono">
                No notifications yet.<br />Set alert rules in Admin Settings.
              </div>
            ) : (
              notifications.map(n => (
                <div key={n.id} className={`px-4 py-3 flex gap-2.5 ${n.isRead ? '' : 'bg-[#fbfaf9]'}`}>
                  <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${n.severity === 'critical' ? 'bg-[#dc2626]' : n.severity === 'info' ? 'bg-[#2563eb]' : 'bg-[#f59e0b]'}`}></span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1">
                      <span className={`text-[11px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityColor(n.severity)}`}>
                        {n.severity}
                      </span>
                      <span className="text-[10px] text-[#a7aaaa] whitespace-nowrap">{timeAgo(n.createdAt)}</span>
                    </div>
                    <p className="text-xs font-bold text-[#1a1a1a] mt-1">{n.title}</p>
                    <p className="text-[11px] text-[#656b6b] mt-0.5 leading-snug">{n.message}</p>
                  </div>
                  <button onClick={() => handleDelete(n.id)} className="text-[#a7aaaa] hover:text-[#dc2626] text-[12px] cursor-pointer shrink-0" title="Dismiss">✕</button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
