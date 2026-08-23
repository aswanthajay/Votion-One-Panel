import React, { lazy, Suspense, useState, useEffect } from 'react';
import { AppSwitcher } from './components/AppSwitcher';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { ToastProvider } from './components/ToastContext';

const DashboardContent = lazy(() => import('./components/DashboardContent'));
const ClientPanelContent = lazy(() => import('./components/ClientPanelContent').then(module => ({ default: module.ClientPanelContent })));
const UserSettingsContent = lazy(() => import('./components/UserSettingsContent').then(module => ({ default: module.UserSettingsContent })));
const AuthPages = lazy(() => import('./components/AuthPages').then(module => ({ default: module.AuthPages })));
const CommandPalette = lazy(() => import('./components/CommandPalette').then(module => ({ default: module.CommandPalette })));
const InteractiveModals = lazy(() => import('./components/InteractiveModals').then(module => ({ default: module.InteractiveModals })));
const UserManagement = lazy(() => import('./components/UserManagement').then(module => ({ default: module.UserManagement })));
const ProxmoxConnections = lazy(() => import('./components/ProxmoxConnections').then(module => ({ default: module.ProxmoxConnections })));
const SystemSettings = lazy(() => import('./components/SystemSettings').then(module => ({ default: module.SystemSettings })));
const AlertRulesModal = lazy(() => import('./components/AlertRulesModal').then(module => ({ default: module.AlertRulesModal })));

type ViewMode = 
  | 'dashboard' 
  | 'client-instances'
  | 'client-instances-qemu'
  | 'client-instances-lxc'
  | 'client-instances-vnc'
  | 'client-instances-metrics'
  | 'client-instances-firewall'
  | 'client-instances-backups'
  | 'node-matrix'
  | 'storage'
  | 'firewall'
  | 'backups'
  | 'ha'
  | 'audit-logs'
  | 'user-settings' 
  | 'system-settings'
  | 'proxmox-connections'
  | 'user-management'
  | 'login' 
  | 'register' 
  | 'forgot-password' 
  | 'recovery';

type UserRole = 'admin' | 'client';

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewMode>(() => {
    // If a session exists, start on dashboard; otherwise show login
    const token = localStorage.getItem('votion_jwt_token');
    return token ? 'dashboard' : 'login';
  });
  const [userRole, setUserRole] = useState<UserRole>(() => {
    const savedRole = localStorage.getItem('votion_user_role');
    return (savedRole as UserRole) || 'client';
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isCmdOpen, setIsCmdOpen] = useState(false);
  const [cmdInitialQuery, setCmdInitialQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [alertRulesOpen, setAlertRulesOpen] = useState(false);

  // Global Ctrl+K / Cmd+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCmdOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenCmdModal = (query = '') => {
    setCmdInitialQuery(query);
    setIsCmdOpen(true);
  };

  const handleToggleRole = () => {
    setUserRole(prev => {
      const newRole = prev === 'admin' ? 'client' : 'admin';
      
      // Persist the role so it survives reloads
      localStorage.setItem('votion_user_role', newRole);

      // Force route to the correct panel to avoid broken intermediate views
      if (newRole === 'client') {
        setCurrentView('client-instances');
      } else {
        setCurrentView('dashboard');
      }
      
      return newRole;
    });
  };

  const isAuthPage = ['login', 'register', 'forgot-password', 'recovery'].includes(currentView);

  if (isAuthPage) {
    return (
      <Suspense fallback={<div className="min-h-screen bg-white" aria-busy="true" />}>
        <AuthPages
          initialMode={currentView as 'login' | 'register' | 'forgot-password' | 'recovery'}
          onNavigateToDashboard={() => setCurrentView('dashboard')}
          onNavigateToAuth={(mode) => setCurrentView(mode)}
        />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
    <div className="min-h-screen bg-white text-[#1a1a1a] flex flex-col font-sans">
      <AppSwitcher />
      <Header 
        currentView={currentView}
        onNavigate={setCurrentView}
        userRole={userRole}
        onToggleRole={handleToggleRole}
        onOpenModal={(modalName) => setActiveModal(modalName)}
        onOpenAlertRules={() => setAlertRulesOpen(true)}
      />
      <div className="app-body">
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          onOpenCmdModal={handleOpenCmdModal}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          currentView={currentView}
          onNavigate={setCurrentView}
          userRole={userRole}
        />
        
        {/* VIEW ROUTER */}
        <Suspense fallback={<div className="app-content" aria-busy="true" />}>
        {currentView === 'user-settings' ? (
          <UserSettingsContent />
        ) : currentView === 'system-settings' ? (
          <SystemSettings />
        ) : currentView === 'user-management' ? (
          <UserManagement />
        ) : currentView === 'proxmox-connections' ? (
          <ProxmoxConnections />
        ) : currentView.startsWith('client-instances') ? (
          <ClientPanelContent 
            onOpenModal={(modalName) => setActiveModal(modalName)} 
            filter={currentView.includes('-') ? currentView.replace('client-instances-', '').replace('client-instances', '') : undefined}
          />
        ) : (
          <DashboardContent />
        )}
        </Suspense>
      </div>

      {/* COMMAND PALETTE */}
      {isCmdOpen && <CommandPalette
        isOpen={isCmdOpen}
        onClose={() => setIsCmdOpen(false)}
        initialQuery={cmdInitialQuery}
        onNavigate={setCurrentView}
      />}

      {/* INTERACTIVE MODAL SUITE */}
      {activeModal && <InteractiveModals
        activeModal={activeModal}
        onClose={() => setActiveModal(null)}
      />}

      {/* ALERT RULES MANAGEMENT MODAL */}
      {alertRulesOpen && (
        <AlertRulesModal onClose={() => setAlertRulesOpen(false)} />
      )}
    </div>
    </ToastProvider>
  );
};

export default App;
