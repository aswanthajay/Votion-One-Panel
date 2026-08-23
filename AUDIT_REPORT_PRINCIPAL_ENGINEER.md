# Votion One Panel — Principal Engineer Audit

**Audit status:** Read-only audit completed; no files deleted and no refactors executed.

**Scope:** Frontend source, backend source, package manifest, build configuration, local runtime artifacts, route wiring, dependency usage, and representative performance/security hot paths.

## Executive assessment

The repository is currently in a **non-green state**. The frontend production build transforms successfully only when TypeScript checking is bypassed, but the configured `npm run build` fails with **26 TypeScript errors** in `AutomationPanel.tsx` and `ScheduleOverlay.tsx`. A separate backend typecheck exposes **8 additional errors**, including a duplicate database method and API/schema type drift. The configured lint command is also not operational because `eslint` is not installed or declared.

The most significant operational risks are not cosmetic. Several live administrative and profile mutation endpoints derive identity from caller-controlled `x-user-email` headers or request-body email values instead of enforcing a verified session identity. The application also contains fallback secrets, disables TLS certificate verification globally for Proxmox requests, and embeds a Proxmox token secret in source as a fallback. These items should be treated as priority-one security remediation before broad feature refactoring.

The largest measurable performance issue is the initial frontend bundle: Vite reports a **2,301.23 kB minified JavaScript chunk (619.84 kB gzip)** and a **267.27 kB CSS bundle (35.03 kB gzip)**. The initial path eagerly includes React Three Fiber through the authentication screen and noVNC through the client panel module, while the dashboard and client panel independently poll the backend every five seconds.

## 1. Immediate Deletions

The following are **high-confidence removal proposals**. They have not been deleted. Before execution, preserve any item that is required for an operational runbook or external deployment process.

| Exact path | Recommendation | Justification | Confidence |
|---|---|---|---|
| `app.js` | Delete | Legacy `DOMContentLoaded` DOM-prototype script. `index.html` loads only `/src/main.tsx`; the live UI is React and does not load this script. | High |
| `src/routes.ts` | Delete or archive outside the source tree | No active import or runtime reference was found. `App.tsx` uses local `ViewMode` state and does not consume this route map. | High |
| `package.json.broken_backup` | Delete | This is an unrelated third-party `otpauth` package manifest, not a backup of the Votion manifest. It cannot participate in the active build. | High |
| `dist/` | Delete from the working tree, unless used as a deployment input | It is reproducible Vite output and is not needed by the development scripts. Rebuild with `npx vite build` when required. | High, conditional on deployment process |
| `vite_dev.log` | Delete or move to an external log archive | Generated development log; not application source or configuration. | High |
| `vite.log` | Delete or move to an external log archive | Generated development log. | High |
| `vite_err.log` | Delete or move to an external log archive | Empty/generated development error log. | High |
| `backend_restart.log` | Delete or move to an external log archive | Generated local runtime log. | High |
| `final_be2.log` | Delete or move to an external log archive | Generated local runtime log. | High |
| `pg_log.txt` | Delete or move to an external log archive | Local PostgreSQL runtime log; the active startup script writes a new log. | High |
| `pg_log2.txt` | Delete or move to an external log archive | Stale local PostgreSQL runtime log. | High |
| `_pg_log.txt` | Delete or move to an external log archive | Stale local PostgreSQL runtime log. | High |
| `_be_log.txt` | Delete or move to an external log archive | Stale backend diagnostic log. | High |
| `_fe_log.txt` | Delete or move to an external log archive | Stale frontend diagnostic log. | High |
| `_fe_err.txt` | Delete or move to an external log archive | Empty/generated frontend diagnostic log. | High |
| `build_output.txt` | Delete or move to an external audit archive | Captured build output is stale now that the build has been re-run. | High |
| `ui_fix_result.txt` | Delete or move to an external audit archive | One-off change-result artifact with no runtime role. | High |

### Dependency scrub proposals

These packages have **zero direct source references** in the inspected `src/` and `server/` trees and should be removed after one final product-owner confirmation that the associated UI is not planned for immediate reactivation:

| Dependency | Recommendation | Evidence and caveat |
|---|---|---|
| `@headlessui/react` | Remove | No direct source reference found. |
| `@heroicons/react` | Remove | No direct source reference found. |
| `@remix-run/react` | Remove | No direct source reference found; it also contributes to the current production audit findings through its React Router/turbo-stream dependency chain. |
| `@react-three/drei` | Remove | No direct source reference found. Keep `@react-three/fiber` and `three` for now because `ThreeBackground.tsx` imports Fiber and Three directly. |
| `framer-motion` | Remove | No direct source reference found. |
| `busboy` | Remove direct declaration only after lockfile verification | No direct source reference found, but upload middleware may resolve a transitive Busboy dependency through `multer`; do not remove transitive packages manually. |

The following items are **not immediate deletion candidates**: `StellarPanel_Backup_2026-08-20_07-45.zip` and `votion_db_backup.sql` should be moved to controlled backup storage rather than deleted; `pgsql/` is referenced by `START.bat` and must remain if the bundled local PostgreSQL workflow is still supported; and `referance/`, `scratch/`, and `shots/` should be archived outside the application tree only after confirming their use in design review or operations documentation.

The following source modules appear unreachable from the active `App.tsx` graph and should be dispositioned separately, not mass-deleted yet: `src/components/AdminVMFleet.tsx`, `src/components/AutomationPanel.tsx`, `src/components/ClusterAuditLogs.tsx`, `src/components/OverviewDashboard.tsx`, and `src/components/ScheduleOverlay.tsx`. Two of these unreachable modules currently block TypeScript compilation, so the first decision is whether they are to be restored and wired or retired cleanly.

## 2. High-Impact Speed Fixes

| Rank | Optimization | Impact | Effort | Recommended implementation |
|---:|---|---|---|---|
| 1 | Split heavy feature modules and defer decorative/console code | Very high | Medium | Lazy-load the authentication background or replace the full-screen 3D scene with a lightweight CSS/SVG treatment; dynamically import `VncTerminal`/noVNC only when the console tab is opened; load chart modules only for metrics views. Add explicit Rollup manual chunks if needed. |
| 2 | Replace duplicate five-second polling with one cached snapshot and visibility-aware refresh | Very high | Medium | Introduce a single dashboard snapshot endpoint or a shared client request cache, deduplicate Dashboard and ClientPanel requests, pause or slow polling when `document.visibilityState !== 'visible'`, and prevent overlapping refreshes with an abort or in-flight guard. The server already runs a 15-second telemetry poller, so the UI should consume a cached snapshot rather than repeatedly trigger five independent calls. |
| 3 | Reduce repeated client-side aggregation from quadratic-style scans | Medium-high | Low | In `DashboardContent.tsx`, build a `Map<node, count>` from the VM list once instead of calling `apiVMs.filter(...)` for every node. Memoize filtered VM lists in `ClientPanelContent.tsx` and memoize row-level derived values for large tables. |
| 4 | Mount modal and chart trees only on demand | High | Medium | `DashboardContent.tsx` is an all-in-one container with data loading, large tables, destructive actions, and modal suites. Split modal bodies and heavy charts into lazy child modules and render only the active modal/tab. Use stable callbacks and selected-record state to reduce re-render fan-out. |
| 5 | Consolidate duplicated global CSS and make the API origin environment-relative | Medium | Low-medium | `styles.css` and `src/index.css` both define overlapping resets, layout wrappers, buttons, tiles, headers, and typography. Establish one token-driven stylesheet. Replace hardcoded `http://localhost:5000` values with an environment-relative API base or same-origin proxy so production does not incur failed calls or mixed-origin behavior. |

### Additional performance findings

`DashboardContent.tsx` executes five API calls on every five-second interval and performs repeated VM filtering while mapping nodes. `ClientPanelContent.tsx` independently executes its own five-second interval. `server/services/proxmox.ts` runs a 15-second background poller and, for each active VM, performs a Proxmox status request followed by database telemetry writes and alert evaluation. `getNodeMetrics()` also performs multiple per-node requests, including version and storage calls. These paths can overlap under slow network conditions because there is no visible in-flight guard or request cancellation.

The Vite build warning is actionable rather than cosmetic: the principal JavaScript chunk exceeds the 500 kB post-minification threshold by a wide margin. The eager `ThreeBackground` import in `AuthPages.tsx`, the top-level noVNC import in `VncTerminal.tsx`, and chart dependencies are the clearest split points.

## 3. Audit Execution Plan

No mass deletion or core-architecture refactor should occur until the user confirms the proposal. The safe sequence is as follows.

| Phase | Work | Gate |
|---:|---|---|
| 1 | Confirm the immediate deletion table and identify any files that must remain for local launch, deployment, design history, or incident records. Move backups and database dumps to controlled storage rather than deleting them. | User approval required |
| 2 | Remove only confirmed legacy/generated artifacts and re-run the source-reference scan. Do not remove unreachable feature components until each is classified as “restore and wire” or “retire.” | Review diff and file inventory |
| 3 | Restore a green build by resolving or retiring `AutomationPanel.tsx` and `ScheduleOverlay.tsx`, then include backend files in the official TypeScript project configuration. Eliminate the duplicate `updateUserProfile` implementation and resolve database/API field drift. | `npm run build` and backend typecheck pass |
| 4 | Harden authentication and authorization: apply verified session middleware to live admin/profile mutation routes, stop trusting caller-supplied identity headers/body email, add token expiry and rotation, remove fallback secrets, and move all Proxmox credentials to required environment variables or encrypted storage. | Security review and negative authorization tests |
| 5 | Correct transport security by removing global `NODE_TLS_REJECT_UNAUTHORIZED='0'` and `rejectUnauthorized: false`; use configured certificate fingerprints or an explicit, narrowly scoped development-only exception. | Proxmox connectivity test with certificate validation |
| 6 | Apply the five speed fixes in ranked order, beginning with code-splitting and shared snapshot polling. Preserve the current design tokens and component patterns while extracting smaller modules. | Bundle-size and refresh-frequency comparison |
| 7 | Repair repository hygiene: add a working ESLint configuration and dependency, add a test script, define build/typecheck coverage for both frontend and backend, and add CI checks for secrets, generated artifacts, and dependency vulnerabilities. | Clean lint, typecheck, test, and production build |

## Validation evidence

| Check | Result |
|---|---|
| `npm run build` | Failed: 26 TypeScript errors in `AutomationPanel.tsx` and `ScheduleOverlay.tsx`. |
| `npx vite build` | Passed with warning: 2,301.23 kB minified JS / 619.84 kB gzip; 267.27 kB CSS / 35.03 kB gzip. |
| `npm run lint` | Failed to start: `eslint` is not installed or declared. |
| `npm ls --depth=0` | Shows `react-router-dom@6.30.6` as extraneous. |
| `npm audit --omit=dev` | Reports 8 production vulnerabilities: 6 high and 2 moderate, including the `multer`/Busboy chain and the React Router/turbo-stream chain. |
| Backend standalone typecheck | Failed with 8 errors, including duplicate `updateUserProfile` implementations and API/schema property mismatches. |
| Repository metadata | No `.git` directory was present in the attached project, so no tracked/untracked classification could be verified. |

## Security and architecture findings requiring remediation

The live admin router is mounted by `server/index.ts`, but its mutating handlers use `x-user-email` with an administrator fallback and do not visibly apply `requireAuth` or `requireAdmin`. The live profile handlers similarly select the target account from query parameters, request headers, or request-body email. This creates a serious identity and authorization boundary problem.

`server/middleware.ts` and `server/routes/api.ts` both contain the fallback session secret `votion-stellar-panel-secret-2026`, while `server/routes/api.ts` also contains fallback Proxmox credentials and a token secret. Session tokens have no expiry, and the middleware accepts a token through a query parameter for PDF links, which risks credential leakage through browser history, logs, referrers, and copied URLs.

`server/services/proxmox.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED` to `0` twice, and `server/index.ts` configures Proxmox requests with `rejectUnauthorized: false`. This disables certificate verification process-wide and should not be used as the default production behavior.

`server/index.ts` calls `express()` but the inspected import section does not import Express. This should be verified immediately because it can cause a runtime `ReferenceError` when the backend starts. The regular project TypeScript configuration includes only `src`, so this defect is not covered by the configured build.

The active application still hardcodes `http://localhost:5000` in `apiClient.ts`, `AuthPages.tsx`, and `VncTerminal.tsx`. This is a deployment and reliability defect, and the VNC component also hardcodes `localhost:5000` for the WebSocket host even when the page protocol is HTTPS.

## Final recommendation

Approve **artifact cleanup only** first: remove the high-confidence legacy/generated files after confirming that backups and local launch assets are preserved. Separately authorize a short “restore-or-retire” decision for the unreachable feature components because they currently block the build. Treat authorization, credential handling, TLS verification, and the green-build baseline as prerequisites to performance refactoring.

