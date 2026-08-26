import React, { useState } from 'react';

interface SidebarProps {
  isCollapsed: boolean;
  isMobileOpen: boolean;
  onToggleCollapse: () => void;
  onOpenCmdModal: (query?: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  currentView: string;
  onNavigate: (view: any) => void;
  userRole: 'admin' | 'client';
  onCloseMobile: () => void;
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
  isMobileOpen,
  onCloseMobile,
}) => {
  const [essentialsOpen, setEssentialsOpen] = useState(true);

  // Distinct SVGs & dedicated view keys corresponding 1:1 to Carta Ink Design System
  const adminNavItems = [
    { 
      title: 'Overview',
      key: 'overview',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M1 9.387h8V1.387H1v8ZM13 1.387h8v8h-8v-8ZM21 12.613h-8v8h8v-8ZM9 20.613H1v-8h8v8Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    {
      title: 'Billing Operations',
      key: 'billing-operations',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M4 3.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V5A1.5 1.5 0 0 1 4 3.5Zm0 2a.5.5 0 0 0-.5.5v1h15V6a.5.5 0 0 0-.5-.5H4Zm-.5 4v7a.5.5 0 0 0 .5.5h14a.5.5 0 0 0 .5-.5v-7h-15Z" />
          <path d="M6 12h4v2H6zm6 0h4v2h-4z" />
        </svg>
      )
    },
    {
      title: 'Cluster Audit Logs',
      key: 'audit-logs',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M4 2a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7.414a2 2 0 0 0-.586-1.414l-4-4A2 2 0 0 0 14.586 2H4Zm11 1.414L18.586 7H15V3.414ZM13 3H4v16h14V9h-4a1 1 0 0 1-1-1V3Zm-7 7a1 1 0 0 1 1-1h8a1 1 0 0 1 1 2H7a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h8a1 1 0 0 0 0-2H7Zm-1 5a1 1 0 0 1 1-1h5a1 1 0 1 1 0 0 2H7a1 1 0 0 1-1-1Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    {
      title: 'OS Reimage Requests',
      key: 'reimage-requests',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M11 2.5a8.5 8.5 0 1 0 8.5 8.5A8.51 8.51 0 0 0 11 2.5Zm0 15a6.5 6.5 0 1 1 6.5-6.5 6.51 6.51 0 0 1-6.5-6.5Z" />
          <path d="M10 6h2v6h-2zm0 7.5h2v2h-2z" />
        </svg>
      )
    },
    {
      title: 'Operator Reimage Console',
      key: 'operator-reimage',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path d="M8.8 2.5a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 0 0 0-8.6Zm0 2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6ZM14 13.5a1 1 0 0 0-1 1v2h-2v2h2v2h2v-2h2v-2h-2v-2a1 1 0 0 0-1-1Z" />
          <path d="M1.5 20.5a7.3 7.3 0 0 1 14.6 0h-2a5.3 5.3 0 0 0-10.6 0h-2Z" />
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
      title: 'Overview',
      key: 'overview',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M1 9.387h8V1.387H1v8ZM13 1.387h8v8h-8v-8ZM21 12.613h-8v8h8v-8ZM9 20.613H1v-8h8v8Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'All Instances',
      key: 'instances',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M18.8 6.55a5.55 5.55 0 1 1-11.1 0 5.55 5.55 0 0 1 11.1 0ZM13.25 3a3.55 3.55 0 1 0 0 7.1 3.55 3.55 0 0 0 0-7.1ZM1 13.9a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H2a1 1 0 0 1-1-1ZM6.3 17.5a1 1 0 0 1 1-1h9.4a1 1 0 1 1 0 2H7.3a1 1 0 0 1-1-1Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    {
      title: 'Virtual Machines (QEMU)',
      key: 'instances-qemu',
      icon: (
        <svg aria-hidden="true" height="16" viewBox="0 0 22 22" width="16" fill="currentColor">
          <path clipRule="evenodd" d="M4 2.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h3v-2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm0 2v9h14v-9H4Zm2 2h2v2H6v-2Zm0 3h2v2H6v-2Zm4-3h6v2h-6v-2Zm0 3h4v2h-4v-2Z" fillRule="evenodd"></path>
        </svg>
      )
    },
    { 
      title: 'LXC Containers', 
      key: 'instances-lxc',
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
    { title: 'Virtual Machines', key: 'instances-qemu' },
    { title: 'LXC Containers', key: 'instances-lxc' },
    { title: 'System Settings (SMTP)', key: 'system-settings' },
    { title: 'Manage Users & Roles', key: 'user-management' }
  ] : [
    { title: 'My Virtual Machines', key: 'instances-qemu' },
    { title: 'LXC Containers', key: 'instances-lxc' },
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
    <aside className={`app-sidenav ${isCollapsed ? 'collapsed' : ''} ${isMobileOpen ? 'mobile-open' : ''}`}>
      {/* Top Search & Toggle */}
      <div className="sidenav-top-sticky flex items-center justify-between gap-1 w-full p-[14px]">
        <button type="button" className="mobile-sidebar-close" onClick={onCloseMobile} aria-label="Close navigation menu">×</button>
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
            className="collapsed-sidebar-control w-[30px] h-[30px] flex items-center justify-center text-[#1a1a1a] rounded transition-colors"
            onClick={() => onOpenCmdModal()}
            title="Search (Ctrl+K)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
          </button>
        )}

        <button
          className="collapsed-sidebar-control w-[30px] h-[30px] shrink-0 flex items-center justify-center text-[#1a1a1a] rounded transition-colors cursor-pointer"
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
        {(!q || activeNavItems[0].title.toLowerCase().includes(q) || activeNavItems[0].key.includes(q) || 'overview'.includes(q) || 'instances'.includes(q)) && (
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


      </ul>
    </aside>
  );
};
