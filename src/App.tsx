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
import { readWorkspaceScope, saveWorkspaceScope, type WorkspaceScope } from './workspaceScope';
import { apiClient, type ApiAccount } from './services/apiClient';

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
const SupportCenter = lazy(() => import('./components/SupportCenter').then(module => ({ default: module.SupportCenter })));
const LegalPages = lazy(() => import('./components/LegalPages').then(module => ({ default: module.LegalPages })));
const InstallationWizard = lazy(() => import('./components/InstallationWizard').then(module => ({ default: module.InstallationWizard })));

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
  | 'support'
  | 'user-settings'
  | 'system-settings'
  | 'proxmox-connections'
  | 'user-management';

type UserRole = 'admin' | 'client';
type AuthMode = 'login' | 'register' | 'forgot-password' | 'reset-password' | 'setup-admin';

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
  support: '/support',
  'user-settings': '/user-settings',
  'system-settings': '/system-settings',
  'proxmox-connections': '/proxmox-connections',
  'user-management': '/user-management',
};

const AUTH_PATHS: Record<AuthMode, string> = {
  login: '/login',
  register: '/register',
  'forgot-password': '/forgot-password',
  'reset-password': '/reset-password',
  'setup-admin': '/setup',
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

const hasAdministratorRole = (role: ApiAccount['role'] | undefined): boolean => role === 'admin' || role === 'administrator';

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
  workspaceConnectionId?: string;
}> = ({ filter, onOpenModal, workspaceConnectionId }) => {
  const location = useLocation();
  const requestedVmid = Number(new URLSearchParams(location.search).get('vmid'));
  return <ClientPanelContent
    onOpenModal={onOpenModal}
    filter={filter}
    workspaceConnectionId={workspaceConnectionId}
    selectedVmid={Number.isInteger(requestedVmid) && requestedVmid > 0 ? requestedVmid : undefined}
  />;
};

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
  const [hasAdministrativeAccess, setHasAdministrativeAccess] = useState(() => hasAdministratorRole(apiClient.getUserRole() as ApiAccount['role']));
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>(() => readWorkspaceScope());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isCmdOpen, setIsCmdOpen] = useState(false);
  const [cmdInitialQuery, setCmdInitialQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [alertRulesOpen, setAlertRulesOpen] = useState(false);
  const roleQuery = new URLSearchParams(location.search).get('role');
  const requestedRole: UserRole | null = roleQuery === 'admin' || roleQuery === 'client' ? roleQuery : null;
  const activeRole: UserRole = hasAdministrativeAccess && (requestedRole || userRole) === 'admin' ? 'admin' : 'client';

  useEffect(() => {
    if (requestedRole && (requestedRole !== 'admin' || hasAdministrativeAccess)) {
      setUserRole(requestedRole);
      localStorage.setItem('votion_user_role', requestedRole);
    }
  }, [hasAdministrativeAccess, requestedRole]);

  useEffect(() => {
    let active = true;
    void apiClient.getUserProfile()
      .then((profile) => {
        if (!active) return;
        const canUseAdminWorkspace = hasAdministratorRole(profile?.role);
        setHasAdministrativeAccess(canUseAdminWorkspace);
        if (!canUseAdminWorkspace && userRole === 'admin') {
          setUserRole('client');
          localStorage.setItem('votion_user_role', 'client');
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [userRole]);

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
    const requestedView = typeof view === 'string' ? view : '';
    const requestedVmid = requestedView.startsWith('vm:') ? Number(requestedView.slice(3)) : null;
    const path = requestedVmid && Number.isInteger(requestedVmid) && requestedVmid > 0
      ? VIEW_PATHS.instances
      : requestedView in VIEW_PATHS
        ? VIEW_PATHS[requestedView as ViewMode]
        : VIEW_PATHS.dashboard;

    if (activeRole === 'client') {
      if (requestedVmid && Number.isInteger(requestedVmid) && requestedVmid > 0) {
        void apiClient.recordNavigationUsage({ itemKey: `vm:${requestedVmid}`, itemType: 'vm', vmid: requestedVmid }).catch(() => undefined);
      } else if (['overview', 'instances', 'instances-qemu', 'instances-lxc', 'client-instances-vnc', 'client-instances-metrics', 'client-instances-firewall', 'client-instances-backups', 'support', 'user-settings'].includes(requestedView)) {
        void apiClient.recordNavigationUsage({ itemKey: requestedView, itemType: 'destination' }).catch(() => undefined);
      }
    }

    startTransition(() => {
      setIsMobileSidebarOpen(false);
      const query = new URLSearchParams({ role: activeRole });
      if (requestedVmid && Number.isInteger(requestedVmid) && requestedVmid > 0) query.set('vmid', String(requestedVmid));
      navigate(`${path}?${query.toString()}`);
    });
  };

  const handleWorkspaceScopeChange = (scope: WorkspaceScope) => {
    setWorkspaceScope(scope);
    saveWorkspaceScope(scope);
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
          canSwitchToAdmin={hasAdministrativeAccess}
          onToggleRole={handleToggleRole}
          onOpenModal={handleOpenModal}
          onOpenAlertRules={activeRole === 'admin' ? () => startTransition(() => setAlertRulesOpen(true)) : undefined}
          onToggleMobileSidebar={() => setIsMobileSidebarOpen(previous => !previous)}
          workspaceScope={workspaceScope}
          onWorkspaceScopeChange={handleWorkspaceScopeChange}
        />
        <div className="app-body">
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            isMobileOpen={isMobileSidebarOpen}
            onToggleCollapse={() => setIsSidebarCollapsed(previous => !previous)}
            onOpenCmdModal={handleOpenCmdModal}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            currentView={currentView}
            onNavigate={handleNavigate}
            userRole={activeRole}
            onCloseMobile={() => setIsMobileSidebarOpen(false)}
          />
          {isMobileSidebarOpen && (
            <button
              type="button"
              className="mobile-sidebar-backdrop"
              aria-label="Close navigation menu"
              onClick={() => setIsMobileSidebarOpen(false)}
            />
          )}

          <Suspense fallback={<RouteLoading />}>
            <Routes>
                            <Route path={VIEW_PATHS.overview} element={activeRole === 'admin' ? <DashboardContent pageTitle="Overview" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} workspaceName={workspaceScope.name} /> : <OverviewDashboard onOpenManage={() => handleNavigate('instances')} onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} workspaceName={workspaceScope.name} />} />
              <Route path={VIEW_PATHS.dashboard} element={activeRole === 'admin' ? <DashboardContent onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} workspaceName={workspaceScope.name} /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS.instances} element={activeRole === 'admin' ? <DashboardContent pageTitle="Virtual Machines" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} workspaceName={workspaceScope.name} /> : <ClientPanelRoute onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['instances-qemu']} element={activeRole === 'admin' ? <DashboardContent pageTitle="QEMU Virtual Machines" typeFilter="qemu" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} workspaceName={workspaceScope.name} /> : <ClientPanelRoute filter="qemu" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['instances-lxc']} element={activeRole === 'admin' ? <DashboardContent pageTitle="LXC Containers" typeFilter="lxc" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} workspaceName={workspaceScope.name} /> : <ClientPanelRoute filter="lxc" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['audit-logs']} element={activeRole === 'admin' ? <ClusterAuditLogs /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['reimage-requests']} element={activeRole === 'admin' ? <ReimageRequestsPanel /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['operator-reimage']} element={activeRole === 'admin' ? <OperatorReimagePanel /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['billing-operations']} element={activeRole === 'admin' ? <BillingOperationsPanel /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS.support} element={<SupportCenter userRole={activeRole} />} />
              <Route path={VIEW_PATHS['user-settings']} element={<UserSettingsContent />} />
              <Route path={VIEW_PATHS['system-settings']} element={activeRole === 'admin' ? <SystemSettings /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['user-management']} element={activeRole === 'admin' ? <UserManagement /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['proxmox-connections']} element={activeRole === 'admin' ? <ProxmoxConnections /> : <Navigate to={VIEW_PATHS.overview} replace />} />
              <Route path={VIEW_PATHS['client-instances']} element={<ClientPanelRoute onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['client-instances-qemu']} element={<ClientPanelRoute filter="qemu" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['client-instances-lxc']} element={<ClientPanelRoute filter="lxc" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['client-instances-vnc']} element={<ClientPanelRoute filter="vnc" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['client-instances-metrics']} element={<ClientPanelRoute filter="metrics" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['client-instances-firewall']} element={<ClientPanelRoute filter="firewall" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
              <Route path={VIEW_PATHS['client-instances-backups']} element={<ClientPanelRoute filter="backups" onOpenModal={handleOpenModal} workspaceConnectionId={workspaceScope.connectionId || undefined} />} />
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
              userRole={activeRole}
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

  if (pathname === '/install') {
    return <Suspense fallback={<div className="min-h-screen bg-white" aria-busy="true" />}><InstallationWizard /></Suspense>;
  }

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
      <Route path="/legal/terms" element={<Suspense fallback={<RouteLoading />}><LegalPages documentId="terms" /></Suspense>} />
      <Route path="/legal/privacy" element={<Suspense fallback={<RouteLoading />}><LegalPages documentId="privacy" /></Suspense>} />
      <Route path="/legal/acceptable-use" element={<Suspense fallback={<RouteLoading />}><LegalPages documentId="acceptable-use" /></Suspense>} />
      <Route path="/legal/service-level" element={<Suspense fallback={<RouteLoading />}><LegalPages documentId="service-level" /></Suspense>} />
      <Route path="/legal/billing" element={<Suspense fallback={<RouteLoading />}><LegalPages documentId="billing" /></Suspense>} />
      <Route path="/legal/data-processing" element={<Suspense fallback={<RouteLoading />}><LegalPages documentId="data-processing" /></Suspense>} />
      <Route path="*" element={<AppRouter />} />
    </Routes>
  </BrowserRouter>
);

export default App;
