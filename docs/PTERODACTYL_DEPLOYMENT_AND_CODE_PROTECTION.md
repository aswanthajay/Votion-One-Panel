# Pterodactyl Deployment and Code Protection

## Recommended Node.js Egg setup

Use the official **Generic Node.js** Egg with a Node.js 22 image. The Egg clones a repository or accepts uploaded files, installs `node_modules`, and starts the configured main file through Node.js or `ts-node`; its documentation also notes that the startup command and “done” detection text may need to be adjusted for the application.[1]

For this repository, the normal application startup command should be:

```bash
npm run start
```

Set the Egg’s main file only if the Egg requires one; the project’s `start` script already launches `tsx server/entry.ts`, which selects the installer or application server based on runtime configuration. Set the Pterodactyl allocation port as the application `PORT` environment variable, and configure `NODE_ENV=production`, `PUBLIC_APP_URL`, and `CORS_ORIGINS` in the server variables. Do not put credentials in the startup command, repository URL, or public install script.

The Generic Node.js Egg installation flow normally runs `npm install --production`.[1] That is appropriate for the running application but means development-only tools such as ESLint, Vitest, and Vite may not exist inside the production container. Therefore, the legacy database cleanup is a **one-time maintenance action**, not an application startup action.

## Pterodactyl cleanup procedure

Upload or deploy the repository first, stop the server, and take a Pterodactyl backup/snapshot. Then run this once from `/home/container`:

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
