# Debian PostgreSQL Setup for Votion One on Pterodactyl

This guide installs PostgreSQL on a Debian server, creates a least-privilege Votion database account, allows only the Pterodactyl host to connect, configures Votion One, initializes the schema, and verifies the deployment.

The commands assume PostgreSQL runs on a Debian server and Votion One runs in a Pterodactyl container. Replace every uppercase placeholder before executing it. Never paste real passwords into a public repository, startup command, or chat.

## 1. Decide the network layout first

The Pterodactyl container must be able to reach the Debian server’s **private IP address**. Do not use `127.0.0.1` in Votion’s database URL unless PostgreSQL and Votion run in the same network namespace. In a normal Pterodactyl container, `127.0.0.1` means the container itself, not the Debian host.

Set these values for your environment:

```text
DB_PRIVATE_IP=<private IP of the Debian PostgreSQL server>
PTERODACTYL_PRIVATE_IP=<private IP of the Pterodactyl host>
DB_PORT=5432
DB_NAME=votion_proxmox_db
DB_USER=votion_app
```

If both services are on the same physical server, first try the server’s private/LAN IP from the container. Do not expose PostgreSQL to the public Internet merely to make the connection work.

## 2. Install PostgreSQL on Debian

SSH into the Debian server as a sudo-capable user:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y postgresql postgresql-contrib postgresql-client openssl
sudo systemctl enable --now postgresql
sudo systemctl is-active --quiet postgresql && echo "PostgreSQL is running"
```

Confirm the installed server and cluster:

```bash
psql --version
sudo pg_lsclusters
sudo -u postgres psql -c "SELECT version();"
```

The default PostgreSQL service port is TCP `5432`. Votion’s active database module uses `DATABASE_URL` when it is present, so the connection string should explicitly include `5432`.

## 3. Create the database and application role

Create a strong password without shell-special characters. Store it temporarily in a root-readable file so it is not lost before configuring Pterodactyl:

```bash
sudo install -d -m 700 /root/votion-secrets
sudo sh -c 'openssl rand -hex 32 > /root/votion-secrets/database-password'
sudo chmod 600 /root/votion-secrets/database-password
sudo cat /root/votion-secrets/database-password
```

Copy that value temporarily into `DB_PASSWORD` in the next command. Do not publish it.

```bash
DB_PASSWORD='<paste-the-generated-64-character-value-here>'
```

Create the role and database. This command is idempotent for the database, but the role command is intended for a fresh installation. If the role already exists, use the `ALTER ROLE` command shown below instead of `CREATE ROLE`.

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 --set=db_password="$DB_PASSWORD" <<'SQL'
CREATE ROLE votion_app LOGIN PASSWORD :'db_password';
CREATE DATABASE votion_proxmox_db OWNER votion_app;
REVOKE ALL ON DATABASE votion_proxmox_db FROM PUBLIC;
GRANT CONNECT ON DATABASE votion_proxmox_db TO votion_app;
SQL
```

If the role already exists, reset its password and ensure ownership/connection rights:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 --set=db_password="$DB_PASSWORD" <<'SQL'
ALTER ROLE votion_app LOGIN PASSWORD :'db_password';
ALTER DATABASE votion_proxmox_db OWNER TO votion_app;
REVOKE ALL ON DATABASE votion_proxmox_db FROM PUBLIC;
GRANT CONNECT ON DATABASE votion_proxmox_db TO votion_app;
SQL
```

Confirm the database exists without printing credentials:

```bash
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname = 'votion_proxmox_db';"
```

The expected output is:

```text
votion_proxmox_db
```

## 4. Configure PostgreSQL for private remote access

If the Pterodactyl container is on a different host, configure PostgreSQL to listen on the Debian server’s private IP. First identify the PostgreSQL configuration paths:

```bash
sudo -u postgres psql -Atc "SHOW config_file; SHOW hba_file;"
```

Set `listen_addresses` to the private IP only. Replace `DB_PRIVATE_IP` with the Debian server’s private address:

```bash
sudo -u postgres psql -c "ALTER SYSTEM SET listen_addresses = 'DB_PRIVATE_IP';"
```

Now add one host-based authentication rule. Open the `pg_hba.conf` path printed by the previous command:

```bash
sudo nano "$(sudo -u postgres psql -Atc 'SHOW hba_file;')"
```

Append this line, replacing `PTERODACTYL_PRIVATE_IP` with the Pterodactyl host’s private IP:

```text
host    votion_proxmox_db    votion_app    PTERODACTYL_PRIVATE_IP/32    scram-sha-256
```

The `/32` restricts access to one source IP. Do not use `0.0.0.0/0` or an unrestricted public CIDR.

Apply the configuration:

```bash
sudo systemctl restart postgresql
sudo systemctl is-active --quiet postgresql && echo "PostgreSQL restarted successfully"
sudo ss -ltnp | grep ':5432'
```

If Votion and PostgreSQL are on the same private server and the container can access the host network, use the private IP rule above. If they share a trusted private Docker or bridge network, use that network’s narrow CIDR instead of opening PostgreSQL globally.

## 5. Configure the firewall safely

If UFW is installed and active, allow TCP 5432 only from the Pterodactyl host:

```bash
sudo ufw status verbose
sudo ufw allow from PTERODACTYL_PRIVATE_IP to any port 5432 proto tcp
sudo ufw status numbered
```

Do not run `sudo ufw allow 5432/tcp` because that permits every reachable source. If the Debian server uses nftables, a cloud firewall, or a hosting-provider firewall instead of UFW, create the equivalent rule allowing only `PTERODACTYL_PRIVATE_IP` to TCP `5432`.

PostgreSQL does not need to be exposed to the browser, public web, or Proxmox host.

## 6. Test the database from the Pterodactyl host

From the Pterodactyl server or a shell that has network access to the container, test TCP reachability:

```bash
nc -vz DB_PRIVATE_IP 5432
```

If `nc` is unavailable:

```bash
(timeout 5 bash -c '</dev/tcp/DB_PRIVATE_IP/5432' && echo "TCP 5432 is reachable") || echo "TCP 5432 is not reachable"
```

A reachable port does not prove authentication works. The Votion application’s `db:verify` command is the preferred application-level test after its runtime configuration is set.

## 7. Configure Votion One’s persistent runtime file

Stop the Pterodactyl server before editing the runtime file. From the Pterodactyl console:

```bash
cd /home/container
mkdir -p .runtime
chmod 700 .runtime
nano .runtime/installation.env
```

Add the following values. Replace every placeholder. Keep the generated database password URL-safe; the `hex` password created above contains only URL-safe characters.

```dotenv
NODE_ENV=production
PORT=<the-one-Pterodactyl-allocation-port>
PUBLIC_APP_URL=https://panel.example.com
CORS_ORIGINS=https://panel.example.com
DATABASE_URL=postgresql://votion_app:<database-password>@DB_PRIVATE_IP:5432/votion_proxmox_db
TOKEN_SECRET=<long-random-application-secret>
PROXMOX_CREDENTIALS_KEY=<long-random-provider-encryption-secret>
```

Generate application secrets on the server without printing them into shell history:

```bash
openssl rand -hex 64
openssl rand -hex 32
```

Use the first value for `TOKEN_SECRET` and the second for `PROXMOX_CREDENTIALS_KEY`. If you do not need provider operations yet, the provider key can be configured later, but live provider actions will remain paused.

Protect the file:

```bash
chmod 600 /home/container/.runtime/installation.env
```

The `.runtime` directory must persist across restarts and container rebuilds. If you recreate the Pterodactyl server, restore `.runtime/installation.env` from a protected backup before starting Votion.

## 8. Initialize and verify the Votion schema

Because the production Pterodactyl install may omit development dependencies, build the frontend during deployment before starting the server:

```bash
cd /home/container
npm install
npm run build
test -f dist/index.html && echo "Frontend build is ready"
```

With `DATABASE_URL` and `TOKEN_SECRET` present, verify the schema:

```bash
npm run db:verify
```

The application also initializes required tables during normal startup. Start Votion:

```bash
npm run start
```

The application must listen on the same port configured in the Pterodactyl allocation and the runtime file. Verify from another machine:

```bash
curl -fsS https://panel.example.com/healthz
```

A successful response contains a JSON status of `ok`. `/readyz` may remain unavailable until the database is healthy and the provider configuration meets the application’s readiness requirements.

## 9. Pterodactyl settings summary

| Pterodactyl setting | Value |
| --- | --- |
| Egg | Generic Node.js |
| Node image | Node.js 22, preferably 22.15+ |
| Startup command | `npm run start` |
| Main file | Leave blank when the Egg allows a custom startup command |
| Public allocation | One port only |
| Build command, one time | `npm install && npm run build` |
| Cleanup command, one time only | `npm run cleanup:legacy-db -- --apply --pterodactyl` |
| Database public allocation | None |

Do not put `npm run build` in the normal startup command unless you deliberately accept a slow rebuild on every restart. Build once during installation or deployment, then use `npm run start`.

## 10. Troubleshooting

### `ENOENT: no such file or directory, stat '/home/container/dist/index.html'`

The frontend was not built. Run:

```bash
cd /home/container
npm install
npm run build
test -f dist/index.html
```

Then start with `npm run start`.

### `ECONNREFUSED` or timeout to PostgreSQL

Check that PostgreSQL is active, listening on the private address, and allowed by the firewall:

```bash
sudo systemctl status postgresql --no-pager
sudo ss -ltnp | grep ':5432'
sudo ufw status verbose
```

Confirm that `DB_PRIVATE_IP` is not `127.0.0.1` when Votion runs inside Pterodactyl.

### `no pg_hba.conf entry`

The source IP reaching PostgreSQL is different from the IP you allowed. Inspect the PostgreSQL log and add the exact Pterodactyl source IP as a `/32` rule for `votion_app` and `votion_proxmox_db`, then restart PostgreSQL.

### `password authentication failed`

Reset the database role password and update the same value in `DATABASE_URL`:

```bash
sudo -u postgres psql -c "ALTER ROLE votion_app LOGIN PASSWORD 'REPLACE_WITH_NEW_URL_SAFE_PASSWORD';"
```

Use a URL-safe password or percent-encode special characters in the connection string.

### Installer opens instead of the application

The runtime gate did not find a complete database configuration and `TOKEN_SECRET`. Confirm that `/home/container/.runtime/installation.env` exists, is readable by the container process, contains `DATABASE_URL` and `TOKEN_SECRET`, and has mode `600`.

### `npm run db:verify` is unavailable

The container was installed with production-only dependencies. Run the verification in a deployment/build environment containing `tsx`, or use the first-run installer, which validates the database URL and applies the schema. The normal runtime still requires the production `tsx` dependency for `npm run start`.

## Security rules

Never open PostgreSQL to `0.0.0.0/0`, never commit `.runtime/installation.env`, never place database credentials in frontend code, and never use the PostgreSQL superuser as the Votion application user. Keep a protected database backup before changing authentication or firewall configuration.

## References

[1]: https://eggs.pterodactyl.io/egg/generic-node-js-generic/ "Pterodactyl Eggs — Generic node.js"
[2]: https://www.postgresql.org/docs/current/auth-pg-hba-conf.html "PostgreSQL: The pg_hba.conf File"
[3]: https://www.postgresql.org/docs/current/runtime-config-connection.html "PostgreSQL: Connections and Authentication"
[4]: https://www.postgresql.org/docs/current/client-authentication.html "PostgreSQL: Client Authentication"
