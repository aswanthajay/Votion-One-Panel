import React, { useState } from 'react';

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenCmdModal: (query?: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  currentView: string;
  onNavigate: (view: any) => void;
  userRole: 'admin' | 'client';
}

export const Sidebar: React.FC<SidebarProps> = ({
  isCollapsed,
  onToggleCollapse,
  onOpenCmdModal,
  searchQuery,
  onSearchChange,
  currentView,
  onNavigate,
  userRole,
}) => {
  const [essentialsOpen, setEssentialsOpen] = useState(true);

  // Distinct SVGs & dedicated view keys corresponding 1:1 to Carta Ink Design System
  const adminNavItems = [
    { 
      title: 'Cluster Dashboard', 
      key: 'dashboard',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M1 9.387h8V1.387H1v8ZM13 1.387h8v8h-8v-8ZM21 12.613h-8v8h8v-8ZM9 20.613H1v-8h8v8Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'PVE Node Matrix', 
      key: 'node-matrix',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M18.8 6.55a5.55 5.55 0 1 1-11.1 0 5.55 5.55 0 0 1 11.1 0ZM13.25 3a3.55 3.55 0 1 0 0 7.1 3.55 3.55 0 0 0 0-7.1ZM1 13.9a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H2a1 1 0 0 1-1-1ZM6.3 17.5a1 1 0 0 1 1-1h9.4a1 1 0 1 1 0 2H7.3a1 1 0 0 1-1-1Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'Storage & ZFS Pools', 
      key: 'storage',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M1 5a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5Zm4-2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm2.6 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.8-1a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1Zm-3.8-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.8-1a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1Zm-3.8-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.8-1a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'SDN & Firewall', 
      key: 'firewall',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M11 1.25a8.75 8.75 0 1 0 0 17.5 8.75 8.75 0 0 0 0-17.5ZM.25 10a10.75 10.75 0 1 1 21.5 0 10.75 10.75 0 0 1-21.5 0Zm14.28-2.53a1 1 0 0 1 0 1.41l-4.5 4.5a1 1 0 0 1-1.41 0l-2-2a1 1 0 0 1 1.41-1.41l1.3 1.29 3.79-3.79a1 1 0 0 1 1.41 0Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'PBS Backup Sync', 
      key: 'backups',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M2.54 10.68 7.92 5.3l3.85 3.84 6.6-6.6h-5.32V1H21v7.95h-1.54V3.63l-7.69 7.69-3.85-3.85-5.38 5.39v6.6H21V21H1V1h1.54z"></path>
        </svg>
      )
    },
    { 
      title: 'High Availability (HA)', 
      key: 'ha',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M11 1.387c-5.523 0-10 4.477-10 10s4.477 10 10 10 10-4.477-10-10-4.477-10-10-10ZM3 11.387c0-4.418 3.582-8 8-8s8 3.582 8 8-3.582 8-8 8-8-3.582-8-8Zm11.707-3.707a1 1 0 0 0-1.414 0L9.5 11.473 7.707 9.68a1 1 0 0 0-1.414 1.414l2.5 2.5a1 1 0 0 0 1.414 0l4.5-4.5a1 1 0 0 0 0-1.414Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'Cluster Audit Logs', 
      key: 'audit-logs',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M4 2a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7.414a2 2 0 0 0-.586-1.414l-4-4A2 2 0 0 0 14.586 2H4Zm11 1.414L18.586 7H15V3.414ZM13 3H4v16h14V9h-4a1 1 0 0 1-1-1V3Zm-7 7a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2H7Zm-1 5a1 1 0 0 1 1-1h5a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'Cluster Connections', 
      key: 'proxmox-connections',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )
    },
    { 
      title: 'User Management', 
      key: 'user-management',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
      )
    },
    { 
      title: 'System Settings', 
      key: 'system-settings',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle>
        </svg>
      )
    },
  ];

  const clientNavItems = [
    { 
      title: 'My Instances', 
      key: 'client-instances',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M1 9.387h8V1.387H1v8ZM13 1.387h8v8h-8v-8ZM21 12.613h-8v8h8v-8ZM9 20.613H1v-8h8v8Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'Virtual Machines (KVM)', 
      key: 'client-instances-qemu',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M18.8 6.55a5.55 5.55 0 1 1-11.1 0 5.55 5.55 0 0 1 11.1 0ZM13.25 3a3.55 3.55 0 1 0 0 7.1 3.55 3.55 0 0 0 0-7.1ZM1 13.9a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H2a1 1 0 0 1-1-1ZM6.3 17.5a1 1 0 0 1 1-1h9.4a1 1 0 1 1 0 2H7.3a1 1 0 0 1-1-1Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'LXC Containers', 
      key: 'client-instances-lxc',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M1 5a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5Zm4-2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'VNC Web Consoles', 
      key: 'client-instances-vnc',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M14 13.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM18 12.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM11 13.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
          <path clipRule="evenodd" d="M2 4h18v14H2V4zm16 12V6H4v10h14z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'Resource Metrics', 
      key: 'client-instances-metrics',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M2.54 10.68 7.92 5.3l3.85 3.84 6.6-6.6h-5.32V1H21v7.95h-1.54V3.63l-7.69 7.69-3.85-3.85-5.38 5.39v6.6H21V21H1V1h1.54z"></path>
        </svg>
      )
    },
    { 
      title: 'Firewall Rules', 
      key: 'client-instances-firewall',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M11 1.25a8.75 8.75 0 1 0 0 17.5 8.75 8.75 0 0 0 0-17.5ZM.25 10a10.75 10.75 0 1 1 21.5 0 10.75 10.75 0 0 1-21.5 0Zm14.28-2.53a1 1 0 0 1 0 1.41l-4.5 4.5a1 1 0 0 1-1.41 0l-2-2a1 1 0 0 1 1.41-1.41l1.3 1.29 3.79-3.79a1 1 0 0 1 1.41 0Z" fillRule="evenodd"></path>
        </svg>
      )
    },
  ];

  const activeNavItems = userRole === 'admin' ? adminNavItems : clientNavItems;

  const essentialsSublinks = userRole === 'admin' ? [
    { title: 'View Cluster Nodes', key: 'node-matrix' },
    { title: 'Virtual Machines', key: 'client-instances-qemu' },
    { title: 'LXC Containers', key: 'client-instances-lxc' },
    { title: 'ZFS Pool Scrub', key: 'storage' },
    { title: 'PBS Snapshot Jobs', key: 'backups' },
    { title: 'HA Fencing Rules', key: 'ha' },
    { title: 'System Settings (SMTP)', key: 'system-settings' },
    { title: 'Manage Users & Roles', key: 'user-settings' }
  ] : [
    { title: 'My Virtual Machines', key: 'client-instances-qemu' },
    { title: 'LXC Containers', key: 'client-instances-lxc' },
    { title: 'VNC Console Access', key: 'client-instances-vnc' },
    { title: 'Resource Bandwidth', key: 'client-instances-metrics' },
    { title: 'Snapshot Backups', key: 'client-instances-backups' },
    { title: 'Network Firewall', key: 'client-instances-firewall' },
    { title: 'User Profile Settings', key: 'user-settings' }
  ];

  const q = searchQuery.toLowerCase().trim();
  const filteredSublinks = essentialsSublinks.filter(s => !q || s.title.toLowerCase().includes(q));
  const isEssentialsMatch = !q || 'essentials'.includes(q) || filteredSublinks.length > 0;

  return (
    <aside className={`app-sidenav ${isCollapsed ? 'collapsed' : ''} max-md:hidden`}>
      {/* Top Search & Toggle */}
      <div className="sidenav-top-sticky flex items-center justify-between gap-1 w-full p-[14px]">
        {!isCollapsed && (
          <div 
            className="flex flex-1 items-center justify-between bg-[#f4f5f5] rounded h-[30px] px-2.5 cursor-pointer relative"
            onClick={() => onOpenCmdModal(searchQuery)}
          >
            <input
              type="text"
              placeholder="Navigate to..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpenCmdModal(searchQuery);
              }}
              className="bg-transparent border-none outline-none text-[13px] text-[#656b6b] placeholder-[#656b6b] w-full font-medium"
              onClick={(e) => e.stopPropagation()}
            />
            <span
              className="text-[12px] font-medium text-[#656b6b] bg-[#f4f5f5] pl-1 absolute right-2.5"
            >
              Ctrl+K
            </span>
          </div>
        )}

        {isCollapsed && (
          <button 
            className="w-[30px] h-[30px] flex items-center justify-center hover:bg-[#f4f5f5] text-[#1a1a1a] rounded transition-colors"
            onClick={() => onOpenCmdModal()}
            title="Search (Ctrl+K)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
          </button>
        )}

        <button
          className="w-[30px] h-[30px] shrink-0 flex items-center justify-center text-[#1a1a1a] hover:bg-[#f4f5f5] rounded transition-colors cursor-pointer"
          onClick={onToggleCollapse}
          title="Toggle Side Menu"
        >
          <svg aria-label="Close menu" height="16" viewBox="0 0 24 24" width="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 7h9" />
            <path d="M11 12h9" />
            <path d="M11 17h9" />
            <path d="M7 16l-4-4 4-4" />
          </svg>
        </button>
      </div>

      {/* Nav List */}
      <ul className="sidenav-nav-groups" id="sidenav-nav-groups">
        
        {/* Main View Item */}
        {(!q || 'dashboard'.includes(q) || 'instances'.includes(q)) && (
          <li className="sidenav-item">
            <div 
              onClick={() => onNavigate(activeNavItems[0].key)}
              className={`sidenav-link cursor-pointer ${currentView === activeNavItems[0].key ? 'active' : ''}`}
              title={activeNavItems[0].title}
            >
              <div className="sidenav-link-left">
                <span className="sidenav-icon">
                  {activeNavItems[0].icon}
                </span>
                <span className="sidenav-link-text">{activeNavItems[0].title}</span>
              </div>
            </div>
          </li>
        )}

        {/* Essentials Accordion */}
        {isEssentialsMatch && (
          <li className="sidenav-item">
            <div 
              onClick={() => setEssentialsOpen(!essentialsOpen)}
              className="sidenav-link cursor-pointer" 
              title="Essentials"
            >
              <div className="sidenav-link-left">
                <span className="sidenav-icon">
                  <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
                    <title>Essentials</title>
                    <path clipRule="evenodd" d="M13.02 9.23H18l-7.08 11.66-.06.11H9.1v-8.2H4l.23-.38 6.86-11.3.06-.12h1.87z" fillRule="evenodd"></path>
                  </svg>
                </span>
                <span className="sidenav-link-text">Essentials</span>
              </div>
              <svg 
                className={`sidenav-twiddle ${essentialsOpen || q ? 'open' : ''}`} 
                aria-hidden="true" 
                height="11" 
                viewBox="0 0 22 22" 
                width="11" 
                fill="currentColor"
              >
                <path d="m18.2 11.14-9.67 9.67-1.06-1.06 8.61-8.61-8.61-8.61 1.06-1.06 9.67 9.67Z"></path>
              </svg>
            </div>

            {/* Sublinks */}
            <ul className={`sidenav-subitems ${essentialsOpen || q ? 'open' : ''}`}>
              {filteredSublinks.map((sub) => (
                <li key={sub.title}>
                  <div 
                    onClick={() => onNavigate(sub.key)}
                    className={`sidenav-sublink cursor-pointer ${currentView === sub.key ? 'active' : ''}`}
                  >
                    {sub.title}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        )}

        {/* Other Active Items (Each with its distinct SVG icon and view key!) */}
        {activeNavItems.slice(1).map((item) => {
          if (q && !item.title.toLowerCase().includes(q)) return null;
          return (
            <li key={item.title} className="sidenav-item">
              <div 
                onClick={() => onNavigate(item.key)}
                className={`sidenav-link cursor-pointer ${currentView === item.key ? 'active' : ''}`}
                title={item.title}
              >
                <div className="sidenav-link-left">
                  <span className="sidenav-icon">
                    {item.icon}
                  </span>
                  <span className="sidenav-link-text">{item.title}</span>
                </div>
              </div>
            </li>
          );
        })}

        {!q && <li className="sidenav-section-label">MORE</li>}

        {/* User Settings in MORE section */}
        {(!q || 'user settings'.includes(q) || 'login & security'.includes(q)) && (
          <li className="sidenav-item">
            <div 
              onClick={() => onNavigate('user-settings')}
              className={`sidenav-link cursor-pointer ${currentView === 'user-settings' ? 'active' : ''}`}
              title="User Settings"
            >
              <div className="sidenav-link-left">
                <span className="sidenav-icon">
                  <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
                    <path clipRule="evenodd" d="M11 1.613a9.387 9.387 0 1 0 0 18.774 9.387 9.387 0 0 0 0-18.774ZM3.613 11a7.387 7.387 0 1 1 14.774 0 7.387 7.387 0 0 1-14.774 0Zm7.387-4a1 1 0 0 0-1 1v2H8a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2h-2V8a1 1 0 0 0-1-1Z" fillRule="evenodd"></path>
                  </svg>
                </span>
                <span className="sidenav-link-text">User Settings</span>
              </div>
            </div>
          </li>
        )}

        {/* Login Page Link in MORE section */}
        {(!q || 'login page'.includes(q) || 'auth'.includes(q)) && (
          <li className="sidenav-item">
            <div 
              onClick={() => onNavigate('login')}
              className={`sidenav-link cursor-pointer ${currentView === 'login' ? 'active' : ''}`}
              title="Login Page"
            >
              <div className="sidenav-link-left">
                <span className="sidenav-icon">
                  <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
                    <path clipRule="evenodd" d="M3 3h10a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0V5H3v14h10v-3a1 1 0 1 1 2 0v3a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm13.293 4.293a1 1 0 0 1 1.414 0l4 4a1 1 0 0 1 0 1.414l-4 4a1 1 0 0 1-1.414-1.414L18.586 13H9a1 1 0 1 1 0-2h9.586l-2.293-2.293a1 1 0 0 1 0-1.414Z" fillRule="evenodd"></path>
                  </svg>
                </span>
                <span className="sidenav-link-text">Login Page</span>
              </div>
            </div>
          </li>
        )}

      </ul>
    </aside>
  );
};
