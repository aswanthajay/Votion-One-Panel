import React, { lazy, Suspense, useState, useEffect } from 'react';
import { apiClient, API_BASE_URL } from '../services/apiClient';
const ThreeBackground = lazy(() => import('./ThreeBackground').then(module => ({ default: module.ThreeBackground })));

interface AuthPagesProps {
  initialMode?: 'login' | 'register' | 'forgot-password' | 'reset-password';
  onNavigateToDashboard?: () => void;
  onNavigateToAuth?: (mode: 'login' | 'register' | 'forgot-password' | 'reset-password') => void;
  onLoginSuccess?: (userRole: 'admin' | 'client') => void;
}

export const AuthPages: React.FC<AuthPagesProps> = ({
  initialMode = 'login',
  onNavigateToDashboard,
  onNavigateToAuth,
  onLoginSuccess,
}) => {
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'forgot-password' | 'reset-password'>(initialMode);

  useEffect(() => {
    setAuthMode(initialMode);
  }, [initialMode]);

  // Login Form Inputs
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  // Register Form Inputs
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');

  // Password reset form inputs
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirmation, setResetPasswordConfirmation] = useState('');

  // Status & Error Banners
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Live Cluster Status (public endpoint, no auth needed)
  const [clusterStatus, setClusterStatus] = useState<{
    nodes: { name: string; ip: string; status: string; cpu: number; ramUsedGb: number; ramTotalGb: number; uptimeSeconds: number }[];
    summary: { totalNodes: number; onlineNodes: number; activeVMs: number; totalVMs: number };
  } | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/status`, { credentials: 'include' });
        const data = await res.json();
        if (data.success) setClusterStatus(data);
      } catch {}
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (s: number) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    return `${h}h`;
  };

  const triggerSuccess = (role: 'admin' | 'client') => {
    if (onNavigateToDashboard) onNavigateToDashboard();
    if (onLoginSuccess) onLoginSuccess(role);
  };

  const changeMode = (mode: 'login' | 'register' | 'forgot-password' | 'reset-password') => {
    setAuthMode(mode);
    setErrorMsg(null);
    setSuccessMsg(null);
    if (onNavigateToAuth) onNavigateToAuth(mode);
  };

  // Handle Login Submission
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoading(true);

    const res = await apiClient.login(email, password);

    setIsLoading(false);
    if (res.success && res.user) {
      localStorage.setItem('votion_jwt_token', res.token || 'votion_auth_token');
      localStorage.setItem('votion_user_email', res.user.email);
      localStorage.setItem('votion_user_role', res.user.role || 'client');
      triggerSuccess(res.user.role as 'admin' | 'client');
    } else {
      setErrorMsg(res.error || 'Invalid email address or password. Please verify your credentials or use Account Recovery.');
    }
  };

  // Handle Registration Submission
  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoading(true);

    const res = await apiClient.register(regName, regEmail, regPassword);

    setIsLoading(false);
    if (res.success && res.user) {
      setSuccessMsg(`Account created successfully for ${res.user.email}! Logging in...`);
      setTimeout(() => {
        triggerSuccess('client');
      }, 1000);
    } else {
      setErrorMsg(res.error || 'Registration failed');
    }
  };

  // Handle Forgot Password Submission — sends API request to backend
  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Always show success to prevent email enumeration
      setSuccessMsg(`If an account exists for ${email}, password reset instructions have been sent.`);
    } catch {
      setSuccessMsg(`If an account exists for ${email}, password reset instructions have been sent.`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    const token = new URLSearchParams(window.location.search).get('token')?.trim() || '';
    if (!token) {
      setErrorMsg('This password reset link is missing its security token. Request a new link.');
      return;
    }
    if (resetPassword.length < 12) {
      setErrorMsg('Use a password with at least 12 characters.');
      return;
    }
    if (resetPassword !== resetPasswordConfirmation) {
      setErrorMsg('The password confirmation does not match.');
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: resetPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setErrorMsg(data.error || 'This reset link is invalid or has expired.');
        return;
      }
      setResetPassword('');
      setResetPasswordConfirmation('');
      setSuccessMsg('Password reset successfully. You can now sign in.');
      window.history.replaceState({}, document.title, '/login');
      setTimeout(() => changeMode('login'), 1200);
    } catch {
      setErrorMsg('Unable to reset your password right now. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass =
    'w-full px-0 py-2.5 bg-transparent border-0 border-b border-[#111111] outline-none text-sm text-[#1a1a1a] placeholder-transparent focus:border-[#1a1a1a] transition-colors';

  return (
    <div className="auth-page relative min-h-screen w-full font-sans bg-[#ffffff] overflow-hidden">
      <div className="absolute inset-0 z-0 opacity-[0.12]"><Suspense fallback={<div className="absolute inset-0 bg-[#0b0f14]" aria-hidden="true" />}><ThreeBackground /></Suspense></div>

      {/* ================= LEFT BLACK EDITORIAL PANEL ================= */}
      <div className="hidden lg:flex fixed inset-y-0 left-0 w-[42%] bg-[#000000] flex-col justify-between p-12 z-10">
        {/* Top brand lockup */}
        <div>
          <div className="text-[#ffffff] text-lg font-bold lowercase tracking-tight font-mono">votion</div>
          <div className="mt-1 text-[11px] text-[#a1a1aa] tracking-wide">ONE Platform</div>
        </div>

        {/* Middle editorial content */}
        <div className="mb-10">
          <div className="text-[11px] text-[#ffffff]/80 tracking-wider mb-5">Now Live</div>
          <h1
            className="text-[34px] leading-[1.15] text-[#ffffff] font-serif italic font-medium mb-6"
            style={{ fontFamily: 'var(--ink-font-global-family-prominent), Georgia, serif' }}
          >
            Automation, precision, and insight, everywhere you work
          </h1>
          <p className="text-[13px] leading-[1.7] text-[#ffffff]/70 max-w-[380px] mb-8">
            VOTION&apos;s proprietary compute platform is here. Provision VMs, manage firewalls,
            snapshot backups, and monitor cluster health — all from your live VOTION data,
            computed on the cluster itself, not estimated by a model.
          </p>
          <button
            type="button"
            onClick={() => changeMode('register')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[#ffffff]/40 text-[#ffffff] text-[13px] font-medium hover:bg-[#ffffff]/10 transition-colors"
          >
            Create a client account
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 7h8M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Bottom cluster status card with dot-grid */}
        <div className="relative rounded-xl bg-[#0a0a0a] border border-[#27272a] p-6 overflow-hidden">
          <svg className="absolute inset-0 w-full h-full opacity-[0.12] pointer-events-none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="dotgrid" width="14" height="14" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="0.8" fill="#3f3f46" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#dotgrid)" />
          </svg>

          <div className="relative z-10 flex items-start justify-between mb-5">
            <div>
              <div className="text-[9px] font-mono text-[#3f3f46] uppercase tracking-[0.2em] mb-2">NODE CLUSTER / STATUS</div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse ${
                    clusterStatus && clusterStatus.summary.onlineNodes === clusterStatus.summary.totalNodes
                      ? 'bg-emerald-400'
                      : 'bg-amber-400'
                  }`}
                ></span>
                <span className="text-[11px] font-semibold text-[#a1a1aa] uppercase tracking-widest">
                  {clusterStatus
                    ? clusterStatus.summary.onlineNodes === clusterStatus.summary.totalNodes
                      ? 'All Systems Operational'
                      : `${clusterStatus.summary.onlineNodes}/${clusterStatus.summary.totalNodes} Nodes Online`
                    : 'Connecting...'}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] font-mono text-[#3f3f46] uppercase tracking-[0.2em] mb-1">SERVER TIME</div>
              <div className="text-lg font-extrabold text-white font-mono tracking-tighter">
                {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            </div>
          </div>

          {/* Node rows */}
          <div className="relative z-10 flex flex-col gap-[1px] bg-[#27272a] rounded-lg overflow-hidden border border-[#27272a] mb-5">
            {clusterStatus && clusterStatus.nodes.length > 0 ? (
              clusterStatus.nodes.map((node, i) => (
                <div key={i} className="flex items-center bg-[#0a0a0a] px-4 py-3 gap-4">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.status === 'online' ? 'bg-emerald-400' : 'bg-red-400'}`}
                  ></span>
                  <span className="font-mono text-xs font-bold text-white w-20 truncate">{node.name || `stellar-0${i + 1}`}</span>
                  <span className="font-mono text-[11px] text-[#52525b] flex-1">{node.ip}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-14 h-1 bg-[#27272a] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#a1a1aa] rounded-full transition-all duration-700"
                        style={{ width: `${Math.min(node.cpu, 100)}%` }}
                      ></div>
                    </div>
                    <span className="font-mono text-[11px] text-[#71717a] w-8 text-right">{node.cpu}%</span>
                  </div>
                </div>
              ))
            ) : (
              [0, 1, 2].map((i) => (
                <div key={i} className="flex items-center bg-[#0a0a0a] px-4 py-3 gap-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#27272a] flex-shrink-0"></span>
                  <span className="font-mono text-xs bg-[#1c1c1e] text-[#1c1c1e] rounded w-16 h-3">stellar-0{i + 1}</span>
                  <span className="flex-1 bg-[#1c1c1e] h-2 rounded"></span>
                  <span className="w-8 bg-[#1c1c1e] h-2 rounded"></span>
                </div>
              ))
            )}
          </div>

          {/* Bottom stat bar */}
          <div className="relative z-10 grid grid-cols-3 gap-4 pt-4 border-t border-[#27272a]">
            {[
              { label: 'ACTIVE VMs', value: clusterStatus ? String(clusterStatus.summary.activeVMs) : '—' },
              {
                label: 'NODES ONLINE',
                value: clusterStatus ? `${clusterStatus.summary.onlineNodes}/${clusterStatus.summary.totalNodes}` : '—',
              },
              { label: 'UPTIME', value: clusterStatus?.nodes[0] ? formatUptime(clusterStatus.nodes[0].uptimeSeconds) : '—' },
            ].map((s, i) => (
              <div key={i}>
                <div className="text-[9px] font-mono text-[#3f3f46] uppercase tracking-[0.18em] mb-1">{s.label}</div>
                <div className="text-sm font-bold font-mono text-[#e4e4e7]">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ================= RIGHT WHITE LOGIN PANEL ================= */}
      <div className="auth-page-panel min-h-screen w-full lg:w-[58%] lg:ml-auto flex flex-col justify-between py-12 px-6 sm:px-12 relative z-20 bg-white">
        {/* Mobile brand (only visible on small screens) */}
        <div className="lg:hidden flex items-center gap-2 mb-8">
          <div className="text-lg font-bold lowercase tracking-tight font-mono">votion</div>
          <span className="text-[11px] text-[#656b6b] tracking-wide">ONE Platform</span>
        </div>

        {/* Centered form column */}
        <div className="w-full max-w-[380px] mx-auto mt-8 lg:mt-16">
          {/* Wordmark */}
          <div className="text-center mb-10">
            <div className="inline-block border border-[#111111] px-4 py-1.5 rounded text-xl font-bold lowercase tracking-tight font-mono">
              votion
            </div>
          </div>

          {/* Error / success banners */}
          {errorMsg && (
            <div className="mb-5 px-4 py-3 bg-[#fef2f2] border border-[#fecaca] text-[#dc2626] text-xs rounded-lg font-medium">
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="mb-5 px-4 py-3 bg-[#f0fdf4] border border-[#bbf7d0] text-[#16a34a] text-xs rounded-lg font-medium">
              {successMsg}
            </div>
          )}

          {authMode === 'login' && (
            <>
              <form onSubmit={handleLoginSubmit} className="flex flex-col gap-6">
                <div>
                  <label htmlFor="votion-email" className="block text-sm font-medium text-[#1a1a1a] mb-1.5">
                    Email
                  </label>
                  <input
                    id="votion-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    autoComplete="email"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="votion-password" className="block text-sm font-medium text-[#1a1a1a]">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => changeMode('forgot-password')}
                      className="text-xs text-[#1a1a1a] underline underline-offset-2 hover:opacity-70"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    id="votion-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    autoComplete="current-password"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                  />
                </div>

                {/* Terms line */}
                <p className="text-[11px] text-[#656b6b] leading-relaxed -mt-1">
                  By clicking the Log in button, you agree to VOTION&apos;s{' '}
                  <a href="#" className="underline underline-offset-2 hover:opacity-70">
                    Terms of Service
                  </a>{' '}
                  and{' '}
                  <a href="#" className="underline underline-offset-2 hover:opacity-70">
                    Privacy Policy
                  </a>
                  .
                </p>

                {/* Black pill Log in button */}
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 rounded-full bg-[#000000] text-[#ffffff] text-sm font-semibold tracking-wide hover:bg-[#1c1c1c] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isLoading && (
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  )}
                  Log in
                </button>

                {/* Link row with dividers, Carta-style */}
                <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-[#656b6b]">
                  <button
                    type="button"
                    onClick={() => changeMode('forgot-password')}
                    className="text-[#1a1a1a] underline underline-offset-2 hover:opacity-70"
                  >
                    Account recovery
                  </button>
                  <span className="text-[#d4d4d4]">|</span>
                  <button
                    type="button"
                    onClick={() => changeMode('register')}
                    className="text-[#1a1a1a] underline underline-offset-2 hover:opacity-70"
                  >
                    Create client account
                  </button>
                  <span className="text-[#d4d4d4]">|</span>
                  <button type="button" className="hover:opacity-70 text-[#656b6b]">
                    Help
                  </button>
                </div>
              </form>
            </>
          )}

          {authMode === 'register' && (
            <>
              <div className="mb-6">
                <h2
                  className="text-[26px] text-[#1a1a1a] leading-tight mb-1 font-medium"
                  style={{ fontFamily: 'var(--ink-font-global-family-prominent), Georgia, serif' }}
                >
                  Create client account
                </h2>
                <p className="text-xs text-[#656b6b]">Register a new client on the VOTION Cloud.</p>
              </div>

              <form onSubmit={handleRegisterSubmit} className="flex flex-col gap-5">
                <div>
                  <label className="block text-sm font-medium text-[#1a1a1a] mb-1.5">Full Name</label>
                  <input
                    type="text"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="Jane Doe"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1a1a1a] mb-1.5">Work Email</label>
                  <input
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="jane@company.com"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1a1a1a] mb-1.5">Password</label>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 rounded-full bg-[#000000] text-[#ffffff] text-sm font-semibold tracking-wide hover:bg-[#1c1c1c] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isLoading && (
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  )}
                  Create Account
                </button>
                <div className="flex items-center justify-center gap-2 text-xs text-[#656b6b]">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => changeMode('login')}
                    className="text-[#1a1a1a] underline underline-offset-2 hover:opacity-70"
                  >
                    Log in
                  </button>
                </div>
              </form>
            </>
          )}

          {authMode === 'forgot-password' && (
            <>
              <div className="mb-6">
                <h2
                  className="text-[26px] text-[#1a1a1a] leading-tight mb-1 font-medium"
                  style={{ fontFamily: 'var(--ink-font-global-family-prominent), Georgia, serif' }}
                >
                  Reset your password
                </h2>
                <p className="text-xs text-[#656b6b]">Enter your email to receive password reset instructions.</p>
              </div>

              <form onSubmit={handleForgotSubmit} className="flex flex-col gap-5">
                <div>
                  <label className="block text-sm font-medium text-[#1a1a1a] mb-1.5">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 rounded-full bg-[#000000] text-[#ffffff] text-sm font-semibold tracking-wide hover:bg-[#1c1c1c] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isLoading && (
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  )}
                  Send Reset Link
                </button>
                <div className="flex items-center justify-center text-xs text-[#656b6b]">
                  <button
                    type="button"
                    onClick={() => changeMode('login')}
                    className="text-[#1a1a1a] underline underline-offset-2 hover:opacity-70"
                  >
                    ← Back to Log in
                  </button>
                </div>
              </form>
            </>
          )}

          {authMode === 'reset-password' && (
            <>
              <div className="mb-6">
                <h2
                  className="text-[26px] text-[#1a1a1a] leading-tight mb-1 font-medium"
                  style={{ fontFamily: 'var(--ink-font-global-family-prominent), Georgia, serif' }}
                >
                  Set a new password
                </h2>
                <p className="text-xs text-[#656b6b]">Choose a new password for your account. This link can be used once.</p>
              </div>

              <form onSubmit={handleResetPasswordSubmit} className="flex flex-col gap-5">
                <div>
                  <label className="block text-sm font-medium text-[#1a1a1a] mb-1.5">New password</label>
                  <input
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    autoComplete="new-password"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                    minLength={12}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1a1a1a] mb-1.5">Confirm new password</label>
                  <input
                    type="password"
                    value={resetPasswordConfirmation}
                    onChange={(e) => setResetPasswordConfirmation(e.target.value)}
                    autoComplete="new-password"
                    className="w-full px-3 py-2.5 border border-[#111111] rounded-md outline-none text-sm text-[#1a1a1a] placeholder:text-[#9a9a9a] focus:border-[#1a1a1a] focus:ring-2 focus:ring-[#1a1a1a]/10 transition-shadow"
                    required
                    minLength={12}
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 rounded-full bg-[#000000] text-[#ffffff] text-sm font-semibold tracking-wide hover:bg-[#1c1c1c] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isLoading && (
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  )}
                  Reset password
                </button>
                <div className="flex items-center justify-center text-xs text-[#656b6b]">
                  <button
                    type="button"
                    onClick={() => changeMode('login')}
                    className="text-[#1a1a1a] underline underline-offset-2 hover:opacity-70"
                  >
                    ← Back to Log in
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        {/* Footer links, Carta-style */}
        <div className="auth-page-footer w-full max-w-[380px] mx-auto mt-12 flex items-center justify-between text-[11px] text-[#656b6b]">
          <div>&copy; 2026 Votion One™ Platform</div>
          <button type="button" className="hover:opacity-70 underline underline-offset-2">
            View latest updates
          </button>
        </div>
      </div>
    </div>
  );
};
