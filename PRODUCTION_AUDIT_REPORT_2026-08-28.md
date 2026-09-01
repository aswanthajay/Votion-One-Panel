# Votion One™ Production-Readiness Audit

**Author:** Manus AI  
**Audit date:** 28 August 2026  
**Repository:** `aswanthajay/stellar-panel`  
**Audited revision:** `eb5b05fa8974728e59e71d61f22b388e565335e1`  
**Method:** Non-destructive source inspection, dependency inspection, production build, unit tests, static route and configuration analysis. No files were deleted, no database rows were changed, no email was sent, and no Proxmox/provider mutation was attempted.

## Executive assessment

The application is buildable and the principal authentication, administrator-gated namespaces, TLS fingerprint pinning, client delegation policy, and manual OS-reimage workflow are present. The repository is **not production-ready without remediation**, however. The highest-impact risks are dependency vulnerabilities, direct browser calls hardcoded to `localhost:5000`, an unreferenced legacy database module containing a hardcoded fallback database password, missing lint/CI enforcement, and very large frontend chunks.

The current production build passes, but this is not equivalent to a clean production gate. The audit found **10 npm audit advisories: 7 high and 3 moderate**, including direct vulnerabilities in Vite, Multer, React Router, and `@remix-run/react`. The `npm run lint` script is currently not executable in the isolated audit environment because ESLint is not declared or installed. Only one unit-test file exists, containing nine tests for team-access policy and invitation expiry; route, database, billing, VNC, Proxmox, upload, and UI behavior do not have automated coverage.

## 1. Confirmed findings

| ID | Severity | Area | Location | Confirmed issue | Production impact | Recommended disposition |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | **High** | Dependencies | `package.json`, `package-lock.json` | `npm audit` reports 10 vulnerabilities: 7 high and 3 moderate. Direct vulnerable dependencies include `vite`, `multer`, `react-router-dom`, and `@remix-run/react`. | Known request-processing, dev-server, routing, and transitive stream/parser risks remain in the deployed dependency graph. | Upgrade in a dedicated dependency commit, run build and smoke tests, and review major-version migration notes before release. |
| F-02 | **High** | Frontend deployment | `src/components/CommandPalette.tsx`, `src/components/TelemetryChart.tsx`, `src/components/UserSettingsContent.tsx` | Several active browser paths call `http://localhost:5000` directly instead of using `API_BASE_URL`. | On a real domain, these features call the end user’s own machine and fail or target an unintended local service. Affected areas include PBS backup command, telemetry chart, secondary-email management, and 2FA verification. | Route every request through `apiClient` or a shared same-origin URL resolver. Add a production-origin browser smoke test. |
| F-03 | **High** | Secret hygiene | `server/database.ts` | A legacy, production-tree database module contains a hardcoded fallback password literal (`votion_secret_2026`). It is not referenced by normal application routes, but is referenced by migration/bootstrap/verification files through `server/db/database.ts` only in the current source map. | The literal is exposed to anyone with repository access and creates a dangerous fallback if the legacy module is imported accidentally. | Remove the unused legacy module only after approval, or refactor it to fail closed with no fallback secret. Rotate any database credentials that may have used the value. |
| F-04 | **High** | Environment hardening | `server/index.ts:64-86` | `NODE_ENV` defaults to `development`. Production-only HSTS and mandatory trusted CORS-origin validation are activated only when `NODE_ENV=production`. | A deployment that omits `NODE_ENV=production` silently receives development defaults, including localhost CORS fallback and no HSTS. | Make deployment mode explicit at startup, fail closed when `PUBLIC_APP_URL`/CORS are inconsistent, and document a required production environment contract. |
| F-05 | **Medium** | Quality gate | `package.json` | `npm run lint` fails with `eslint: not found`; no ESLint dependency/configuration was found in the repository inventory. | A stated quality gate cannot run in CI or a clean checkout. Regressions can be merged without lint enforcement. | Add ESLint and a checked-in config, or remove the script until a real lint gate exists. Add it to CI and branch protection. |
| F-06 | **Medium** | Test coverage | Repository test inventory | Only `server/services/teamAccessPolicy.test.ts` exists. It has 9 passing tests, but there is no automated coverage for route authorization, SQL/migrations, billing, VNC handshake, upload handling, mail delivery, reimage states, or critical frontend flows. | High-risk production behavior is validated mostly by compilation and manual testing. | Add route-level tests with mocked database/provider boundaries, migration smoke tests, and component tests for auth, billing, firewall, tickets, and reimage workflows. |
| F-07 | **Medium** | Delivery controls | Repository inventory | No `.github/workflows` files were found. | There is no repository-native automated build, test, audit, or deployment gate visible in source control. | Add CI for `npm ci`, `npm test`, `npm run build`, lint, `npm audit --audit-level=high`, migration verification, and artifact checks. |
| F-08 | **Medium** | Performance | Production build output | Vite reports chunks above 500 kB. `ThreeBackground` is approximately 870 kB and `Tracker` approximately 838 kB; the base bundle is approximately 257 kB. | Initial/authentication load and cache invalidation are heavier than necessary, especially on mobile and constrained networks. | Remove confirmed-dead modules or isolate them behind route-level/demand-driven imports. Review the authentication background before removing it because it is still reachable from `AuthPages.tsx`. |
| F-09 | **Medium** | Upload security | `server/routes/api.ts:63-70, 645-663` | Authenticated uploads are limited to 25 MB but do not enforce an allowlisted MIME type, extension, content signature, antivirus/scanning policy, or storage quota in the route. | Malicious or oversized-but-within-limit files can consume disk or become unsafe if a future static-serving path exposes the uploads directory. | Store uploads outside static roots, allowlist diagnostic formats, inspect content, apply per-account quotas, and add cleanup/retention policies. |
| F-10 | **Medium** | Error handling | `server/routes/api.ts`, route/service files | Many handlers catch `err: any`, several intentionally swallow errors, and the public `/status` route returns a success-shaped JSON fallback with empty operational data on failure. | Failures can be hidden from operators and clients may treat unavailable telemetry as a valid empty state. | Standardize typed errors, structured server logging with request IDs, explicit degraded status fields, and observable error metrics. |
| F-11 | **Low/Medium** | Transport validation | `server/services/proxmoxHttp.ts:40-46` | Proxmox host validation rejects URL delimiters but intentionally permits arbitrary private/internal hosts. | An administrator-only fingerprint endpoint and stored admin connection records can still be used to make server-side connections to internal addresses. | Preserve support for private Proxmox networks, but add explicit allowlist/connection ownership controls and audit all outbound targets. |
| F-12 | **Low** | Maintainability | `server/database.ts` and `server/db/database.ts` | Two database modules coexist; the legacy module is not part of the normal route import graph but remains in the production tree. | Future contributors can import the wrong connection defaults or duplicate business logic. | Delete only after the exact deletion proposal is approved, or mark the legacy module as deprecated and make it fail closed. |

### Dependency advisory detail

The dependency scan identified the following direct or transitive problem families. Upgrade work should be treated as a separate controlled change rather than performed during this audit.

| Package/path | Severity reported | Fix direction reported by npm | Notes |
| --- | --- | --- | --- |
| `multer` → `busboy`/`dicer` | High | Upgrade Multer to a fixed major version | Review multipart behavior and file limits after upgrade. |
| `vite` → `esbuild` and Vite server paths | High/moderate | Upgrade Vite to a fixed major version | Development-server advisories still matter on developer/operator workstations. |
| `react-router-dom` → `react-router` | Moderate | Upgrade to fixed React Router major | Test navigation, redirects, and hydration assumptions. |
| `@remix-run/react` → server-runtime/turbo-stream | High | Upgrade to the fixed Remix major or remove if unused | The audit did not find source imports for this package; confirm whether it is legacy before removing. |

## 2. Production validation results

| Check | Result | Interpretation |
| --- | --- | --- |
| `npm test -- --reporter=dot` | **Passed: 9/9** | Covers team permission ranking and invitation expiry policy only. |
| `npm run build` | **Passed** | Client typecheck, server typecheck, and Vite production build passed. Large-chunk advisory remains. |
| `npm run lint` | **Failed to start** | `eslint` executable/configuration is absent from the checkout. This is a tooling failure, not a clean lint pass. |
| `npm audit --omit=optional` | **10 advisories** | 7 high, 3 moderate, 0 critical. |
| Repository status | **Clean** | No audit changes, deletion, or generated sensitive artifacts were committed. |
| Browser visual verification | **Unavailable** | The browser connector returned `No current window`; no visual conclusion is claimed from this audit. |

## 3. High-impact speed fixes ranked by impact versus effort

| Rank | Optimization | Impact | Effort | Proposed approach |
| --- | --- | --- | --- | --- |
| 1 | Remove or isolate the 838–870 kB visual chunks | High | Medium | Confirm whether `ThreeBackground` is needed on the login route; remove unused `Tracker` if it is not reachable, or load it only on the feature that needs it. |
| 2 | Consolidate all frontend API requests through `apiClient` | High | Low/Medium | Eliminates production-origin failures and creates one place for retry, auth, error normalization, and telemetry. |
| 3 | Add route/component-level bundle budgets | Medium/High | Low | Fail CI when base or route chunks exceed agreed thresholds; keep heavy VNC/chart modules demand-loaded. |
| 4 | Reduce polling overlap | Medium | Medium | Review the 15-second Proxmox sync, 15-second telemetry monitor, and client polling for duplicate provider/database work. Add visibility-aware polling and backoff on degraded providers. |
| 5 | Add server response caching and query budgets for read-heavy views | Medium | Medium | Cache bounded status/metadata reads, batch dashboard requests, and add query timing metrics for overview, billing, and fleet views. |

## 4. Security and architecture observations

The application has several positive controls. It disables Express `x-powered-by`, has Helmet enabled, validates production CORS when production mode is active, uses authenticated namespaces, protects administrator and operator routes separately, pins Proxmox certificates when a fingerprint is configured, and contains a manual-only OS-reimage path rather than silently performing a provider mutation.

The strongest security concern is not the Proxmox TLS helper itself; the helper correctly requires HTTPS for normal requests and performs exact fingerprint comparison when configured. The concern is operational configuration: a server-side connection helper that accepts arbitrary internal hosts should be bounded by explicit administrator-controlled connection records and deployment-level network policy. The hardcoded legacy database fallback and production-mode defaulting deserve higher priority because they are easier to mishandle during deployment.

The client navigation map is internally consistent in static analysis: sidebar keys found corresponding application route keys, including `team-access`, `client-instances-firewall`, `reimage-requests`, and `operator-reimage`. This does not replace a live browser test, which was unavailable during the audit.

## 5. Exact deletion candidates — no deletions performed

The following are **proposals only** and require explicit approval before deletion, consistent with the project’s cleanup policy.

| Candidate | Why it is proposed | Confidence | Required verification before deletion |
| --- | --- | --- | --- |
| `server/database.ts` | Legacy duplicate database implementation with a hardcoded fallback password; not referenced by normal application route imports in the audit graph. | High | Search deployment scripts, external runbooks, and operator commands for direct imports; run migration/bootstrap/verification tests using `server/db/database.ts`. |
| `@remix-run/react` dependency | No source import was found during the dependency scan; npm audit reports a high transitive advisory path. | Medium | Confirm no dynamic import, build plugin, or external integration relies on it; remove with lockfile update and build/test validation. |
| `@headlessui/react` dependency | No source import found. | Medium | Confirm no generated or dynamically loaded component uses it. |
| `@heroicons/react` dependency | No source import found. | Medium | Confirm icon imports are entirely from `lucide-react`. |
| `@react-three/drei` dependency | No source import found; only `@react-three/fiber` and `three` are used by the login background. | Medium | Confirm no future or generated route relies on drei before removal. |
| `busboy` direct dependency | No direct source import found; Multer uses its own multipart dependency chain. | Low/Medium | Confirm package-manager graph and remove only if not required by Multer or deployment tooling. |
| `http-proxy` direct dependency | No direct source import found; `http-proxy-middleware` is imported instead. | Medium | Confirm no external server script imports it. |
| `clsx`, `tailwind-merge` | No source imports found in the scan. | Medium | Confirm no macro/plugin or generated class utility expects them. |

No files or dependencies from this table were removed.

## 6. Recommended remediation sequence

**Release blocker 1: repair deployment-origin API calls.** Replace the four active direct `localhost:5000` requests with `apiClient` methods or same-origin calls. This should be tested against a non-local `PUBLIC_APP_URL` because it is a functional production defect.

**Release blocker 2: remediate high dependency advisories.** Upgrade Multer first because it is directly involved in authenticated multipart uploads, then handle Vite and router/Remix major upgrades in isolated commits. Run the full build and new route/upload tests after each upgrade.

**Release blocker 3: eliminate the legacy hardcoded-secret module.** Perform the verification listed in the deletion table, then remove or fail-closed the module and rotate any affected database credential. Never print or commit the fallback value.

**Release blocker 4: make production mode explicit.** Require `NODE_ENV=production` for production deployment or replace the current defaulting behavior with an explicit deployment-mode check. Add startup assertions for canonical public URL, secure cookies, trusted CORS origins, and reverse-proxy configuration.

**Release blocker 5: establish CI.** The minimum CI gate should run clean-install, typecheck, unit tests, lint, production build, npm audit, migration verification against an ephemeral database, and a route authorization smoke suite.

After those blockers, address upload content policy, error observability, bundle budgets, polling overlap, and broader test coverage.

## 7. Audit execution plan requiring approval

The next safe implementation batch should be split into atomic commits:

1. **Fix production API origin handling** and add regression tests.
2. **Add ESLint and CI** with no application behavior changes.
3. **Upgrade vulnerable dependencies** package by package with compatibility tests.
4. **Remove the legacy database module and unused dependencies** only after approval of the exact deletion list above.
5. **Optimize large chunks and polling** after baseline measurements are recorded.

No mass deletion, dependency removal, or core architecture refactor should begin until the user approves the exact candidates and the affected deployment assumptions are confirmed.

## References

[1]: https://github.com/advisories/GHSA-4pg4-qvpc-4q3h "Multer denial-of-service advisory"
[2]: https://github.com/advisories/GHSA-wm7h-9275-46v2 "Dicer HeaderParser crash advisory"
[3]: https://github.com/advisories/GHSA-67mh-4wv8-2f99 "esbuild development-server request advisory"
[4]: https://github.com/advisories/GHSA-fx2h-pf6j-xcff "Vite Windows alternate-path advisory"
[5]: https://github.com/advisories/GHSA-wrjc-x8rr-h8h6 "React Router open redirect advisory"
[6]: https://github.com/advisories/GHSA-rxv8-25v2-qmq8 "React Router reflected-input denial-of-service advisory"
[7]: https://github.com/advisories/GHSA-jjmj-jmhj-qwj2 "React Router DOM open redirect/XSS advisory"
[8]: https://github.com/advisories/GHSA-337j-9hxr-rhxg "React Router error deserialization advisory"

> **Conclusion:** The repository is in a usable development state, but it should not be labelled production-ready until the direct localhost API calls, dependency advisories, legacy fallback secret, explicit production mode, and missing CI/lint gates are addressed. No unapproved changes were made during this audit.
