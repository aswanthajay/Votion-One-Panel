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
import { RouteNotFound } from './components/RouteNotFound';

const DashboardContent = lazy(() => import('./components/DashboardContent'));
const OverviewDashboard = lazy(() => import('./components/OverviewDashboard').then(module => ({ default: module.OverviewDashboard })));
const ClientPanelContent = lazy(() => import('./components/ClientPanelContent').then(module => ({ default: module.ClientPanelContent })));
const UserSettingsContent = lazy(() => import('./components/UserSettingsContent').then(module => ({ default: module.UserSettingsContent })));
const AuthPages = lazy(() => import('./components/AuthPages').then(module => ({ default: module.AuthPages })));
const CommandPalette = lazy(() => import('./components/CommandPalette').then(module => ({ default: module.CommandPalette })));
const InteractiveModals = lazy(() => import('./components/InteractiveModals').then(module => ({ default: module.InteractiveModals })));
const UserManagement = lazy(() => import('./components/UserManagement').then(module => ({ default: module.UserManagement })));
const ProxmoxConnections = lazy(() => import('./components/ProxmoxConnections').then(module => ({ default: module.ProxmoxConnections })));
const SystemSettings = lazy(() => import('./components/SystemSettings').then(module => ({ default: module.SystemSettings })));
const AlertRulesModal = lazy(() => import('./components/AlertRulesModal').then(module => ({ default: module.AlertRulesModal })));
const ClusterAuditLogs = lazy(() => import('./components/ClusterAuditLogs').then(module => ({ default: module.ClusterAuditLogs })));
const ReimageRequestsPanel = lazy(() => import('./components/ReimageRequestsPanel').then(module => ({ default: module.ReimageRequestsPanel })));
const OperatorReimagePanel = lazy(() => import('./components/OperatorReimagePanel').then(module => ({ default: module.OperatorReimagePanel })));
const BillingOperationsPanel = lazy(() => import('./components/BillingOperationsPanel').then(module => ({ default: module.BillingOperationsPanel })));

export type ViewMode =
  | 'overview'
  | 'dashboard'
  | 'instances'
  | 'instances-qemu'
  | 'instances-lxc'
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
  | 'reimage-requests'
  | 'operator-reimage'
  | 'billing-operations'
  | 'user-settings'
  | 'system-settings'
  | 'proxmox-connections'
  | 'user-management';

type UserRole = 'admin' | 'client';
type AuthMode = 'login' | 'register' | 'forgot-password' | 'recovery';

type ClientFilter = 'qemu' | 'lxc' | 'vnc' | 'metrics' | 'firewall' | 'backups';

const VIEW_PATHS: Record<ViewMode, string> = {
  overview: '/overview',
  dashboard: '/dashboard',
  instances: '/instances',
  'instances-qemu': '/instances/qemu',
  'instances-lxc': '/instances/lxc',
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
  'reimage-requests': '/reimage-requests',
  'operator-reimage': '/operator-reimage',
  'billing-operations': '/billing-operations',
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

const RouteLoading = () => (
  <div className="app-content flex items-center justify-center" aria-busy="true">
    <div className="text-sm text-[#656b6b]" role="status">Loading view…</div>
  </div>
);

const OverlayLoading = () => (
  <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/20" aria-busy="true">
    <div className="rounded-lg border border-[#dedfdf] bg-white px-4 py-3 text-sm text-[#656b6b] shadow-lg" role="status">
      Loading…
    </div>
  </div>
);

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
        onNavigateToDashboard={() => startTransition(() => navigate(VIEW_PATHS.overview))}
        onNavigateToAuth={(nextMode) => startTransition(() => navigate(AUTH_PATHS[nextMode]))}
      />
    </Suspense>
  );
};

const RootRedirect: React.FC = () => {
  const hasSession = Boolean(localStorage.getItem('votion_jwt_token'));
  return <Navigate to={hasSession ? VIEW_PATHS.overview : AUTH_PATHS.login} replace />;
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
  const roleQuery = new URLSearchParams(location.search).get('role');
  const activeRole: UserRole = roleQuery === 'admin' || roleQuery === 'client' ? roleQuery : userRole;

  useEffect(() => {
    if (roleQuery === 'admin' || roleQuery === 'client') {
      setUserRole(roleQuery);
      localStorage.setItem('votion_user_role', roleQuery);
    }
  }, [roleQuery]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        startTransition(() => setIsCmdOpen(previous => !previous));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  const handleOpenCmdModal = (query = '') => {
    startTransition(() => {
      setCmdInitialQuery(query);
      setIsCmdOpen(true);
    });
  };

  const handleOpenModal = (modalName: string) => {
    startTransition(() => setActiveModal(modalName));
  };

  const handleNavigate = (view: unknown) => {
    const path = typeof view === 'string' && view in VIEW_PATHS
      ? VIEW_PATHS[view as ViewMode]
      : VIEW_PATHS.dashboard;
    startTransition(() => navigate(`${path}?role=${activeRole}`));
  };

  const handleToggleRole = () => {
    const nextRole: UserRole = activeRole === 'admin' ? 'client' : 'admin';
    localStorage.setItem('votion_user_role', nextRole);
    startTransition(() => {
      setUserRole(nextRole);
      navigate(`${VIEW_PATHS.overview}?role=${nextRole}`);
    });
  };

  return (
    <ToastProvider>
      <div className="min-h-screen bg-white text-[#1a1a1a] flex flex-col font-sans">
        <AppSwitcher />
        <Header
          currentView={currentView}
          onNavigate={handleNavigate}
          userRole={activeRole}
          onToggleRole={handleToggleRole}
          onOpenModal={handleOpenModal}
          onOpenAlertRules={() => startTransition(() => setAlertRulesOpen(true))}
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
            userRole={activeRole}
          />

          <Suspense fallback={<RouteLoading />}>
            <Routes>
                            <Route path={VIEW_PATHS.overview} element={activeRole === 'admin' ? <DashboardContent pageTitle="Overview" onOpenModal={handleOpenModal} /> :   <OverviewDashboard onOpenManage={() => handleNavigate('instances')} onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS.dashboard} element={<DashboardContent onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS.instances} element={<ClientPanelRoute onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['instances-qemu']} element={<ClientPanelRoute filter="qemu" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['instances-lxc']} element={<ClientPanelRoute filter="lxc" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['audit-logs']} element={<ClusterAuditLogs />} />
              <Route path={VIEW_PATHS['reimage-requests']} element={activeRole === 'admin' ? <ReimageRequestsPanel /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['operator-reimage']} element={activeRole === 'admin' ? <OperatorReimagePanel /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['billing-operations']} element={activeRole === 'admin' ? <BillingOperationsPanel /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['user-settings']} element={<UserSettingsContent />} />
              <Route path={VIEW_PATHS['system-settings']} element={<SystemSettings />} />
              <Route path={VIEW_PATHS['user-management']} element={<UserManagement />} />
              <Route path={VIEW_PATHS['proxmox-connections']} element={<ProxmoxConnections />} />
              <Route path={VIEW_PATHS['client-instances']} element={<ClientPanelRoute onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['client-instances-qemu']} element={<ClientPanelRoute filter="qemu" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['client-instances-lxc']} element={<ClientPanelRoute filter="lxc" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['client-instances-vnc']} element={<ClientPanelRoute filter="vnc" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['client-instances-metrics']} element={<ClientPanelRoute filter="metrics" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['client-instances-firewall']} element={<ClientPanelRoute filter="firewall" onOpenModal={handleOpenModal} />} />
              <Route path={VIEW_PATHS['client-instances-backups']} element={<ClientPanelRoute filter="backups" onOpenModal={handleOpenModal} />} />
              <Route path="*" element={<RouteNotFound />} />
            </Routes>
          </Suspense>
        </div>

        {isCmdOpen && (
          <Suspense fallback={<OverlayLoading />}>
            <CommandPalette
              isOpen={isCmdOpen}
              onClose={() => startTransition(() => setIsCmdOpen(false))}
              initialQuery={cmdInitialQuery}
              onNavigate={handleNavigate}
            />
          </Suspense>
        )}

        {activeModal && (
          <Suspense fallback={<OverlayLoading />}>
            <InteractiveModals
              activeModal={activeModal}
              onClose={() => startTransition(() => setActiveModal(null))}
            />
          </Suspense>
        )}

        {alertRulesOpen && (
          <Suspense fallback={<OverlayLoading />}>
            <AlertRulesModal onClose={() => startTransition(() => setAlertRulesOpen(false))} />
          </Suspense>
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
