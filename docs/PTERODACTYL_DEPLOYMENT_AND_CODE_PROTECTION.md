# Pterodactyl Deployment and Code Protection

## Recommended Node.js Egg setup

### Does it need `index.js`?

No. This project does **not** use a root-level `index.js`. Its production entrypoint is `server/entry.ts`, launched through the package script:

```bash
npm run start
```

The `server/entry.ts` bootstrap loads the persisted runtime configuration and then selects either the first-run installer or the normal application server. With the project’s current scripts, the correct Pterodactyl startup command is `npm run start`, not `node index.js`.

The Node.js Egg may display a “main file” field. Leave it unused when the Egg allows a custom startup command. If the Egg requires a value, use `server/entry.ts` only with an image that has the project’s `tsx` runtime available; the safer option is still the explicit `npm run start` command because it matches `package.json`.

### How many ports are required?

You need **one Pterodactyl allocation port** for Votion One. The Express server binds one `PORT`, and the same listener handles the web UI, REST API, health endpoints, authenticated WebSocket console relay, and the `/novnc`, `/api2`, `/pve2`, and `/proxmox-console` proxy paths. Do not allocate separate public ports for the API, VNC, noVNC, or WebSockets.

| Connection | Public Pterodactyl port required? | Explanation |
| --- | ---: | --- |
| Votion One HTTP/HTTPS web and API | **Yes: one port** | Set `PORT` to the Pterodactyl allocation port. |
| Votion One WebSocket and console relay | **No additional port** | Uses the same Node listener and reverse-proxy path. |
| PostgreSQL | **No** | Keep database access private; allow the Votion server to connect outbound to the database host, normally TCP 5432. |
| Proxmox API | **No** | The panel connects outbound to each provider’s configured API port, normally 8006. Do not expose Proxmox through the Votion container. |
| SMTP | **No** | Mail delivery is outbound, normally 587 or 465 depending on the provider. |

If a reverse proxy or Cloudflare sits in front of Pterodactyl, proxy only the single allocated application port and enable WebSocket support. The browser should use the public HTTPS origin; it should not connect directly to PostgreSQL or Proxmox.

Use the official **Generic Node.js** Egg with a Node.js 22 image. The Egg clones a repository or accepts uploaded files, installs `node_modules`, and starts the configured main file through Node.js or `ts-node`; its documentation also notes that the startup command and “done” detection text may need to be adjusted for the application.[1]

For this repository, the normal application startup command should be:

```bash
npm run start
```

The project’s `start` script launches `tsx server/entry.ts`, which selects the installer or application server based on runtime configuration. Set the Pterodactyl allocation port as the application `PORT` environment variable, and configure `NODE_ENV=production`, `PUBLIC_APP_URL`, and `CORS_ORIGINS` in the server variables. Do not put credentials in the startup command, repository URL, or public install script.

At minimum, configure these Pterodactyl variables:

| Variable | Example form | Required for normal production? |
| --- | --- | ---: |
| `NODE_ENV` | `production` | Yes |
| `PORT` | the allocated Pterodactyl port, such as `25580` | Yes |
| `PUBLIC_APP_URL` | `https://panel.example.com` | Yes |
| `CORS_ORIGINS` | `https://panel.example.com` | Yes |
| `DATABASE_URL` | private PostgreSQL connection URL | Yes, unless the complete `PG*` set is used |
| `TOKEN_SECRET` | long random secret | Yes |
| `PROXMOX_CREDENTIALS_KEY` | long random secret | Required for live provider operations |
| `TRUST_PROXY` | `true` only behind a trusted reverse proxy | Conditional |

Do not put credentials in the startup command, repository URL, or public install script.

The Generic Node.js Egg installation flow normally runs `npm install --production`.[1] This application also needs a frontend build, and Vite is a development dependency, so the one-time installation step must install all dependencies, build the frontend, and only then start the runtime. The application runtime itself includes `tsx` in production dependencies. Therefore, the legacy database cleanup is a **one-time maintenance action**, not an application startup action.

From `/home/container`, the initial deployment sequence is:

```bash
npm install
npm run build
npm run start
```

After `npm run build` succeeds, `/home/container/dist/index.html` must exist. Do not use `npm install --omit=dev` before the build; it omits Vite and the TypeScript build tooling. If you later prune development dependencies, keep the already-built `dist/` directory and the production `tsx` dependency.

## Pterodactyl cleanup procedure

Upload or deploy the repository first, stop the server, and take a Pterodactyl backup/snapshot. The repository does not include the ignored `dist/` directory, so build it before starting. From `/home/container`, run:

```bash
npm install
npm run build
```

Verify the frontend exists:

```bash
test -f dist/index.html && echo "frontend build is ready"
```

Then start the application with `npm run start`. If the server reports `ENOENT: no such file or directory, stat '/home/container/dist/index.html'`, return to `/home/container` and rerun `npm install` followed by `npm run build`.

For the legacy cleanup itself, run this once:

```bash
node scripts/cleanup-legacy-database.mjs
```

The default mode is a dry run. On a production container without Git metadata, execute the actual removal only after reviewing the dry-run output:

```bash
node scripts/cleanup-legacy-database.mjs --apply --pterodactyl
```

The `--pterodactyl` mode is intentionally explicit. It permits execution without Git, keeps a checksum-verified copy under `.runtime/backups/legacy-database/`, verifies that the active module exists and that no remaining source import targets the legacy module, then removes only `server/database.ts`. It does not run the development-only lint/test/build suite in a production-only installation.

If the container includes Git and development dependencies, prefer the stricter command:

```bash
node scripts/cleanup-legacy-database.mjs --apply
```

That mode requires a clean Git tree and runs lint, unit tests, and the production build after removal. If validation fails, the script restores the legacy file automatically from the verified backup. After either mode succeeds, restart the server with `npm run start` and confirm `/healthz` and `/readyz` from the panel or reverse proxy.

Do not place the cleanup command in the Pterodactyl startup command. It is destructive maintenance, and running it on every restart would fail after the first successful removal.

## Protecting the code when hosting publicly

There is no reliable way to give someone a complete JavaScript/TypeScript application and make it impossible for that person to copy or modify it. If a customer or host can read the container filesystem, they can generally copy the source, inspect compiled JavaScript, or replace files. “Encrypting the code” inside the same container does not solve this because the application must eventually obtain the decryption key to execute.

The strongest practical model is **do not distribute the source code**. Keep the repository private, build and publish an application artifact from a trusted CI runner, and run the service on infrastructure you control. For Pterodactyl, the most secure arrangement is a private deployment repository or private release artifact downloaded with a narrowly scoped, read-only deployment token, with automatic repository access disabled after deployment. Never give customers a GitHub personal access token or a token with write permissions.

If a third party must operate the Pterodactyl server, treat the panel owner as having administrative access to the application files. Move the most sensitive business logic and provider integrations into a separately hosted API that you control; the Pterodactyl instance then runs a thinner service that contains less proprietary logic. Keep all database, SMTP, provider, JWT, and encryption secrets in Pterodactyl environment variables or a dedicated secret manager, never in the repository and never in frontend bundles.

Obfuscation and minification can raise the effort required for casual copying, but they are not a security boundary. License enforcement, contractual terms, private repository access, watermarking, signed release manifests, and customer-specific builds can help with deterrence and attribution, but none prevents a privileged server operator from extracting executable code.

## Minimum hardening checklist

| Control | Recommendation |
| --- | --- |
| Repository | Keep it private; use deploy keys or fine-grained read-only tokens, never broad personal tokens. |
| Build | Build in CI and deploy an immutable release artifact rather than exposing the working repository. |
| Container | Run as a non-root container user where the Egg/image permits it; restrict filesystem permissions and disable shell access for non-operators. |
| Secrets | Use Pterodactyl variables or an external secret manager. Rotate credentials after any host/operator change. |
| Database | Allow only the application server’s private network to connect; use a dedicated least-privilege database role. |
| Updates | Pin releases/commit SHAs, review changes, and disable automatic Git pulls in production unless the deployment process verifies signatures. |
| Backups | Encrypt Pterodactyl backups and restrict their download permissions. Test restoration separately. |
| Code protection | Keep proprietary logic server-side; do not rely on JavaScript encryption or obfuscation as a control. |

## References

[1]: https://eggs.pterodactyl.io/egg/generic-node-js-generic/ "Pterodactyl Eggs — Generic node.js"
