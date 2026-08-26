import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { apiClient, ApiTask, ApiProxmoxConnection } from '../services/apiClient';
import { NotificationBell } from './NotificationBell';

interface HeaderProps {
  currentView: string;
  onNavigate: (view: any) => void;
  userRole: 'admin' | 'client';
  onToggleRole: () => void;
  onOpenModal: (modalName: string) => void;
  onOpenAlertRules?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  currentView,
  onNavigate, 
  userRole, 
  onToggleRole,
  onOpenModal,
  onOpenAlertRules,
}) => {
  const [tasksOpen, setTasksOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState('Global');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<ApiTask | null>(null);
  const [liveTasks, setLiveTasks] = useState<ApiTask[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [currentUserName, setCurrentUserName] = useState('');
  const [locations, setLocations] = useState<ApiProxmoxConnection[]>([]);

  const menuRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
      if (workspaceRef.current && !workspaceRef.current.contains(event.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load live user name and tasks from backend
  useEffect(() => {
    const loadHeaderData = async () => {
      try {
        const [profile, tasks, proxmoxConns, supportTickets] = await Promise.all([
          apiClient.getUserProfile(),
          apiClient.getTasks(),
          apiClient.getProxmoxConnections().catch(() => []),
          apiClient.getSupportTickets().catch(() => []),
        ]);
        if (profile) {
          setCurrentUserName(profile.name || profile.email || 'Account');
        }
        if (tasks) {
          setLiveTasks(tasks);
        }
        if (proxmoxConns && Array.isArray(proxmoxConns)) {
          setLocations(proxmoxConns);
        }
        setInboxCount(Array.isArray(supportTickets) ? supportTickets.filter(ticket => ticket.unread).length : 0);
      } catch {
        // Fallback: read from localStorage
        const email = apiClient.getUserEmail();
        setCurrentUserName(email.split('@')[0] || 'Account');
      }
    };
    loadHeaderData();
    const interval = setInterval(loadHeaderData, 10000);
    return () => clearInterval(interval);
  }, [userRole]);

  const filteredLocations = locations.filter(loc => loc.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const runningTasks = liveTasks.filter(t => t.status === 'running');
  const activeBadgeCount = runningTasks.length;

  return (
    <header className={`app-header ${currentView === 'overview' ? 'header-overview-context' : ''}`}>
      <div className="header-left">
        {/* VOTION Box Logo */}
        <button 
          onClick={() => onNavigate('overview')}
          className="brand-logo cursor-pointer" 
          title="Votion One™ Platform"
        >
          <div className="theme-brand-logo border-[3px] border-[#1a1a1a] bg-white px-3 py-0.5 text-base font-extrabold lowercase tracking-tight flex items-center justify-center">votion</div>
        </button>

        {/* WORKSPACE / COMPANY SELECTOR DROPDOWN */}
        <div className="header-workspace-menu-wrap" ref={workspaceRef}>
          <button 
            onClick={() => {
              setWorkspaceMenuOpen(!workspaceMenuOpen);
              setUserMenuOpen(false);
              setTasksOpen(false);
              setNotificationsOpen(false);
            }}
            className="header-workspace-control flex items-center gap-2 border border-[#1a1a1a] rounded-lg px-3 py-1 bg-white hover:bg-[#f1f1f1] transition-all cursor-pointer font-semibold text-sm text-[#1a1a1a]"
            title="Select Workspace or Company"
          >
            <span>{selectedWorkspace}</span>
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>

          {workspaceMenuOpen && (
            <div className="workspace-dropdown-menu absolute left-0 top-10 w-72 bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-3 z-[200] text-sm flex flex-col gap-3 animate-in fade-in zoom-in-95 duration-100">
              <div>
                <input
                  type="text"
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full border border-[#2563eb] focus:border-[#2563eb] rounded-lg px-3 py-2 text-xs outline-none bg-white text-[#1a1a1a] placeholder-[#a7aaaa]"
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-[#1a1a1a] px-2 py-1">Global</span>
                <button 
                  className={`block w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                    selectedWorkspace === 'Global' ? 'bg-[#f1f1f1] font-semibold text-[#1a1a1a]' : 'text-[#656b6b] hover:bg-[#f1f1f1] hover:text-[#1a1a1a]'
                  }`}
                  onClick={() => {
                    setSelectedWorkspace('Global');
                    setWorkspaceMenuOpen(false);
                  }}
                >
                  Global
                  {selectedWorkspace === 'Global' && <span className="ml-2 text-[#16a34a] font-bold">✓</span>}
                </button>
              </div>
              <div className="flex flex-col gap-1 border-t border-[#dedfdf] pt-2">
                <span className="text-xs font-bold text-[#1a1a1a] px-2 py-1">Datacenters</span>
                {filteredLocations.length > 0 ? filteredLocations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => {
                      setSelectedWorkspace(loc.name);
                      setWorkspaceMenuOpen(false);
                    }}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors cursor-pointer flex items-center justify-between ${
                      selectedWorkspace === loc.name ? 'bg-[#f1f1f1] font-semibold text-[#1a1a1a]' : 'text-[#656b6b] hover:bg-[#f1f1f1] hover:text-[#1a1a1a]'
                    }`}
                  >
                    <span>{loc.name}</span>
                    {selectedWorkspace === loc.name && <span className="text-[#10b981] font-bold">✓</span>}
                  </button>
                )) : (
                  <div className="px-2 py-2 text-xs text-[#a7aaaa]">
                    No locations found. Add one in Admin Settings.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ADMIN vs CLIENT ROLE SWITCHER */}
        {userRole === 'admin' && (
          <button 
            onClick={onToggleRole}
            className="header-role-switcher px-3 py-1.5 rounded-md text-[13px] font-semibold flex items-center gap-2 transition-colors border cursor-pointer bg-[#fbfaf9] text-[#1a1a1a] border-[#dedfdf] hover:bg-[#f1f1f1]"
            title="Toggle between Admin & Client Panels"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3l4 4-4 4" />
              <path d="M3 7h18" />
              <path d="M7 21l-4-4 4-4" />
              <path d="M21 17H3" />
            </svg>
            <span>{userRole === 'admin' ? 'Switch to Client View' : 'Switch to Admin View'}</span>
          </button>
        )}
      </div>

      <div className="header-right relative" ref={menuRef}>
        {/* ALERT RULES MANAGEMENT — Admin only */}
        {onOpenAlertRules && (
          <button 
            onClick={onOpenAlertRules}
            className="header-alert-control cursor-pointer hidden md:inline-flex"
            title="Manage alert thresholds and notification rules"
            aria-label="Manage alert rules"
          >
            <SlidersHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
            <span>Alert Rules</span>
          </button>
        )}

        {/* NOTIFICATION BELL — live unread count from PostgreSQL */}
        <NotificationBell
          open={notificationsOpen}
          onToggle={() => {
            setNotificationsOpen(previous => !previous);
            setTasksOpen(false);
            setUserMenuOpen(false);
            setWorkspaceMenuOpen(false);
          }}
            onClose={() => setNotificationsOpen(false)}
          />

        {/* TASKS BUTTON — Live data from /api/v1/tasks */}
        <div className="header-task-menu-wrap">
          <button
            onClick={() => {
              setTasksOpen(!tasksOpen);
              setNotificationsOpen(false);
              setUserMenuOpen(false);
              setWorkspaceMenuOpen(false);
            }}
            className="header-task-control header-btn relative cursor-pointer"
          >
            <span>Tasks</span>
            {activeBadgeCount > 0 && <span className="task-count" aria-label={`${activeBadgeCount} active tasks`}>{activeBadgeCount > 9 ? '9+' : activeBadgeCount}</span>}
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>

          {/* Tasks Dropdown Drawer — Live tasks from PostgreSQL */}
          {tasksOpen && (
            <div className="tasks-dropdown-menu active">
              <div className="tasks-header">
                Active background tasks{liveTasks.length > 0 ? ` · ${liveTasks.length}` : ''}
              </div>

              {liveTasks.length === 0 ? (
                <div className="tasks-empty-state">
                  <span className="tasks-empty-mark" aria-hidden="true">✓</span>
                  <p>No active tasks</p>
                  <span>Background work will appear here.</span>
                </div>
              ) : (
                liveTasks.map(task => (
                  <div
                    key={task.id}
                    className="task-item cursor-pointer mt-2"
                    onClick={() => { setSelectedTaskDetail(task); setTasksOpen(false); }}
                  >
                    <div className="task-title-line">
                      <span>{task.name}</span>
                      <span className={`task-status-tag ${
                        task.status === 'completed' ? 'bg-[#dcfce7] text-[#15803d]' :
                        task.status === 'failed' ? 'bg-[#fef2f2] text-[#dc2626]' :
                        'bg-[#fef3c7] text-[#b45309]'
                      }`}>
                        {task.status === 'running' ? `${task.progressPct}%` : task.status}
                      </span>
                    </div>
                    <div className="task-progress-bar">
                      <div
                        className={`task-progress-fill ${
                          task.status === 'completed' ? 'bg-[#10b981]' :
                          task.status === 'failed' ? 'bg-[#ef4444]' : ''
                        }`}
                        style={{ width: `${task.progressPct || 0}%` }}
                      ></div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* DOWNLOADS BUTTON */}
        <button 
          onClick={() => onOpenModal('downloads')}
          className="header-secondary-control header-link cursor-pointer"
        >
          <span>Downloads</span>
        </button>

        {/* UPGRADE LINK */}
        <button 
          onClick={() => onOpenModal('upgrade')}
          className="header-secondary-control header-link cursor-pointer"
        >
          <span>Upgrade</span>
        </button>

        {/* USER PROFILE BUTTON — Live user name from PostgreSQL */}
        <div className="header-user-menu-wrap relative">
          <button 
            onClick={() => {
              setUserMenuOpen(!userMenuOpen);
              setTasksOpen(false);
              setNotificationsOpen(false);
              setWorkspaceMenuOpen(false);
            }}
            className={`header-user-trigger flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all cursor-pointer ${
              userMenuOpen 
                ? 'border-[#1a1a1a] bg-[#f1f1f1] text-[#1a1a1a]' 
                : 'border-transparent text-[#1a1a1a] hover:bg-[#f1f1f1]'
            }`}
          >
            <span>{currentUserName || apiClient.getUserEmail().split('@')[0]}</span>
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>

          {userMenuOpen && (
            <div className="header-user-menu absolute right-0 top-11 w-56 bg-white border border-[#dedfdf] rounded-lg shadow-xl py-2 z-[350] text-sm text-[#1a1a1a]">
              
              {/* Role Toggle Link */}
              <button 
                onClick={() => { onToggleRole(); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors font-semibold text-[#2563eb] flex items-center justify-between cursor-pointer"
              >
                <span>Switch to {userRole === 'admin' ? 'Client View' : 'Admin View'}</span>
                <span>⇄</span>
              </button>

              <div className="my-1 border-t border-[#dedfdf]"></div>

              <button 
                onClick={() => { onNavigate('user-settings'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                User settings
              </button>

              {/* Inbox — shows count from live tasks */}
              <button 
                onClick={() => { onOpenModal('inbox'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors flex items-center gap-2 cursor-pointer"
              >
                <span>Inbox</span>
                <span className="bg-[#2563eb] text-white text-[11px] font-bold px-2 py-0.5 rounded-full">
                  {inboxCount}
                </span>
              </button>

              <button 
                onClick={() => { onOpenModal('dataroom'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                Data room
              </button>

              <button 
                onClick={() => { onOpenModal('support'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                VOTION Support Center
              </button>

              <button 
                onClick={() => { onOpenModal('help'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                VOTION Help
              </button>

              <button 
                onClick={() => { onOpenModal('pricing'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                Plans and pricing
              </button>

              <button 
                onClick={() => { onOpenModal('release-notes'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                Release notes
              </button>

              <button 
                onClick={() => { onOpenModal('terms'); setUserMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors cursor-pointer"
              >
                Terms and privacy
              </button>

              {/* Log out — clears session */}
              <button 
                onClick={() => {
                  localStorage.removeItem('votion_jwt_token');
                  localStorage.removeItem('votion_user_email');
                  localStorage.removeItem('votion_user_role');
                  setUserMenuOpen(false);
                  onNavigate('login');
                }}
                className="w-full text-left px-4 py-2 hover:bg-[#f1f1f1] transition-colors font-medium text-[#dc2626] cursor-pointer"
              >
                Log out
              </button>

            </div>
          )}
        </div>
      </div>

      {/* TASK DETAIL DRAWER MODAL — Live PostgreSQL task data */}
      {selectedTaskDetail && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1500] flex items-center justify-center p-6">
          <div className="w-full max-w-[480px] bg-white border border-[#dedfdf] rounded-xl shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#dedfdf] pb-3">
              <h3 className="text-base font-bold text-[#1a1a1a]">{selectedTaskDetail.name}</h3>
              <button onClick={() => setSelectedTaskDetail(null)} className="text-[#656b6b] font-bold cursor-pointer">✕</button>
            </div>
            <div className="bg-[#fbfaf9] border border-[#dedfdf] rounded-lg p-3 text-xs flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[#656b6b]">Node</span>
                <span className="font-mono font-bold text-[#1a1a1a]">{selectedTaskDetail.node}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#656b6b]">Status</span>
                <span className={`font-bold uppercase text-[11px] px-2 py-0.5 rounded ${
                  selectedTaskDetail.status === 'completed' ? 'bg-[#dcfce7] text-[#15803d]' :
                  selectedTaskDetail.status === 'failed' ? 'bg-[#fef2f2] text-[#dc2626]' :
                  'bg-[#fef3c7] text-[#b45309]'
                }`}>
                  {selectedTaskDetail.status}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#656b6b]">Progress</span>
                <span className="font-mono font-bold text-[#1a1a1a]">{selectedTaskDetail.progressPct}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#656b6b]">Started</span>
                <span className="font-mono text-[#1a1a1a]">{new Date(selectedTaskDetail.startTime).toLocaleString()}</span>
              </div>
              {/* Progress Bar */}
              <div className="mt-1 w-full bg-[#dedfdf] rounded-full h-1.5">
                <div 
                  className={`h-1.5 rounded-full ${
                    selectedTaskDetail.status === 'completed' ? 'bg-[#10b981]' :
                    selectedTaskDetail.status === 'failed' ? 'bg-[#ef4444]' : 'bg-[#f59e0b]'
                  }`}
                  style={{ width: `${selectedTaskDetail.progressPct}%` }}
                ></div>
              </div>
            </div>
            <div className="flex items-center justify-end pt-2">
              <button onClick={() => setSelectedTaskDetail(null)} className="btn-primary">Close Details</button>
            </div>
          </div>
        </div>
      )}

    </header>
  );
};
