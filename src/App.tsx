import React, { lazy, startTransition, Suspense, useEffect, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
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

export type ViewMode =
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
  | 'user-management';

type UserRole = 'admin' | 'client';
type AuthMode = 'login' | 'register' | 'forgot-password' | 'recovery';

type ClientFilter = 'qemu' | 'lxc' | 'vnc' | 'metrics' | 'firewall' | 'backups';

const VIEW_PATHS: Record<ViewMode, string> = {
  dashboard: '/dashboard',
  'client-instances': '/client-instances',
  'client-instances-qemu': '/client-instances/qemu',
  'client-instances-lxc': '/client-instances/lxc',
  'client-instances-vnc': '/client-instances/vnc',
  'client-instances-metrics': '/client-instances/metrics',
  'client-instances-firewall': '/client-instances/firewall',
  'client-instances-backups': '/client-instances/backups',
  'node-matrix': '/node-matrix',
  storage: '/storage',
  firewall: '/firewall',
  backups: '/backups',
  ha: '/ha',
  'audit-logs': '/audit-logs',
  'user-settings': '/user-settings',
  'system-settings': '/system-settings',
  'proxmox-connections': '/proxmox-connections',
  'user-management': '/user-management',
};

const AUTH_PATHS: Record<AuthMode, string> = {
  login: '/login',
  register: '/register',
  'forgot-password': '/forgot-password',
  recovery: '/recovery',
};

const normalizePath = (pathname: string) => {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
};

const viewForPath = (pathname: string): ViewMode => {
  const normalizedPath = normalizePath(pathname);
  const matchingView = (Object.entries(VIEW_PATHS) as [ViewMode, string][]).find(([, path]) => path === normalizedPath);
  return matchingView?.[0] || 'dashboard';
};

const authModeForPath = (pathname: string): AuthMode => {
  const normalizedPath = normalizePath(pathname);
  const matchingMode = (Object.entries(AUTH_PATHS) as [AuthMode, string][]).find(([, path]) => path === normalizedPath);
  return matchingMode?.[0] || 'login';
};

const isAuthPath = (pathname: string) => Object.values(AUTH_PATHS).includes(normalizePath(pathname));

const navigateForView = (navigate: ReturnType<typeof useNavigate>, view: unknown) => {
  const path = typeof view === 'string' && view in VIEW_PATHS
    ? VIEW_PATHS[view as ViewMode]
    : VIEW_PATHS.dashboard;
  startTransition(() => navigate(path));
};

const RouteLoading = () => <div className="app-content" aria-busy="true" />;

const ClientPanelRoute: React.FC<{
  filter?: ClientFilter;
  onOpenModal: (modalName: string) => void;
}> = ({ filter, onOpenModal }) => (
  <ClientPanelContent onOpenModal={onOpenModal} filter={filter} />
);

const AuthRoute: React.FC<{ mode: AuthMode }> = ({ mode }) => {
  const navigate = useNavigate();

  return (
    <Suspense fallback={<div className="min-h-screen bg-white" aria-busy="true" />}>
      <AuthPages
        initialMode={mode}
        onNavigateToDashboard={() => startTransition(() => navigate(VIEW_PATHS.dashboard))}
        onNavigateToAuth={(nextMode) => startTransition(() => navigate(AUTH_PATHS[nextMode]))}
      />
    </Suspense>
  );
};

const RootRedirect: React.FC = () => {
  const hasSession = Boolean(localStorage.getItem('votion_jwt_token'));
  return <Navigate to={hasSession ? VIEW_PATHS.dashboard : AUTH_PATHS.login} replace />;
};

const AppShell: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const currentView = viewForPath(location.pathname);
  const [userRole, setUserRole] = useState<UserRole>(() => {
    const savedRole = localStorage.getItem('votion_user_role');
    return savedRole === 'admin' ? 'admin' : 'client';
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isCmdOpen, setIsCmdOpen] = useState(false);
  const [cmdInitialQuery, setCmdInitialQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [alertRulesOpen, setAlertRulesOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsCmdOpen(previous => !previous);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  const handleOpenCmdModal = (query = '') => {
    setCmdInitialQuery(query);
    setIsCmdOpen(true);
  };

  const handleNavigate = (view: unknown) => navigateForView(navigate, view);

  const handleToggleRole = () => {
    const nextRole: UserRole = userRole === 'admin' ? 'client' : 'admin';
    setUserRole(nextRole);
    localStorage.setItem('votion_user_role', nextRole);
    startTransition(() => {
      navigate(nextRole === 'client' ? VIEW_PATHS['client-instances'] : VIEW_PATHS.dashboard);
    });
  };

  return (
    <ToastProvider>
      <div className="min-h-screen bg-white text-[#1a1a1a] flex flex-col font-sans">
        <AppSwitcher />
        <Header
          currentView={currentView}
          onNavigate={handleNavigate}
          userRole={userRole}
          onToggleRole={handleToggleRole}
          onOpenModal={(modalName) => setActiveModal(modalName)}
          onOpenAlertRules={() => setAlertRulesOpen(true)}
        />
        <div className="app-body">
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed(previous => !previous)}
            onOpenCmdModal={handleOpenCmdModal}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            currentView={currentView}
            onNavigate={handleNavigate}
            userRole={userRole}
          />

          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path={VIEW_PATHS.dashboard} element={<DashboardContent />} />
              <Route path={VIEW_PATHS['node-matrix']} element={<DashboardContent />} />
              <Route path={VIEW_PATHS.storage} element={<DashboardContent />} />
              <Route path={VIEW_PATHS.firewall} element={<DashboardContent />} />
              <Route path={VIEW_PATHS.backups} element={<DashboardContent />} />
              <Route path={VIEW_PATHS.ha} element={<DashboardContent />} />
              <Route path={VIEW_PATHS['audit-logs']} element={<DashboardContent />} />
              <Route path={VIEW_PATHS['user-settings']} element={<UserSettingsContent />} />
              <Route path={VIEW_PATHS['system-settings']} element={<SystemSettings />} />
              <Route path={VIEW_PATHS['user-management']} element={<UserManagement />} />
              <Route path={VIEW_PATHS['proxmox-connections']} element={<ProxmoxConnections />} />
              <Route path={VIEW_PATHS['client-instances']} element={<ClientPanelRoute onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path={VIEW_PATHS['client-instances-qemu']} element={<ClientPanelRoute filter="qemu" onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path={VIEW_PATHS['client-instances-lxc']} element={<ClientPanelRoute filter="lxc" onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path={VIEW_PATHS['client-instances-vnc']} element={<ClientPanelRoute filter="vnc" onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path={VIEW_PATHS['client-instances-metrics']} element={<ClientPanelRoute filter="metrics" onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path={VIEW_PATHS['client-instances-firewall']} element={<ClientPanelRoute filter="firewall" onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path={VIEW_PATHS['client-instances-backups']} element={<ClientPanelRoute filter="backups" onOpenModal={(modalName) => setActiveModal(modalName)} />} />
              <Route path="*" element={<Navigate to={VIEW_PATHS.dashboard} replace />} />
            </Routes>
          </Suspense>
        </div>

        {isCmdOpen && (
          <CommandPalette
            isOpen={isCmdOpen}
            onClose={() => setIsCmdOpen(false)}
            initialQuery={cmdInitialQuery}
            onNavigate={handleNavigate}
          />
        )}

        {activeModal && (
          <InteractiveModals
            activeModal={activeModal}
            onClose={() => setActiveModal(null)}
          />
        )}

        {alertRulesOpen && (
          <AlertRulesModal onClose={() => setAlertRulesOpen(false)} />
        )}
      </div>
    </ToastProvider>
  );
};

const AppRouter: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = normalizePath(location.pathname);

  useEffect(() => {
    const handleAuthExpired = () => {
      localStorage.removeItem('votion_jwt_token');
      localStorage.removeItem('votion_user_email');
      localStorage.removeItem('votion_user_role');
      startTransition(() => navigate(AUTH_PATHS.login, { replace: true }));
    };

    window.addEventListener('votion:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('votion:auth-expired', handleAuthExpired);
  }, [navigate]);

  if (isAuthPath(pathname)) {
    return <AuthRoute mode={authModeForPath(pathname)} />;
  }

  if (!localStorage.getItem('votion_jwt_token')) {
    return <Navigate to={AUTH_PATHS.login} replace />;
  }

  return <AppShell />;
};

export const App: React.FC = () => (
  <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="*" element={<AppRouter />} />
    </Routes>
  </BrowserRouter>
);

export default App;
