# Deploy Cogitator on your own VPS

[Home](../README.md) · [Working guide](user-guide.md) · [Français](guide-fr.md) · [Authentication reference](native-auth.md)

This guide is for a **single trusted owner on a Unix server**. The current build supports browser access over HTTPS with an owner **email and password**. Email is the login identifier; there is no email verification, public signup or password-reset email. Optional MFA is enabled explicitly.

The authentication/HTTPS path is in use on the project's VPS. This is not a claim that arbitrary agent commands are sandboxed: classic agents, extensions and local MCP tools run with the controller account's authority. Use a dedicated OS account and keep unrelated applications and secrets out of its reach. Durable worker isolation, fully automated recovery and off-host backup/restore qualification remain separate work.

## Choose the installation you are updating

| Installation | Where updates happen |
| --- | --- |
| pi package on your computer | That computer's pi profile, followed by `/reload` and `/cogitator` |
| pi package running on a VPS | The VPS's pi profile and OS account, then restart its actual controller |
| Source release managed by systemd | A new server release directory, then activate it and restart the service |

The source-release recipe below matches the deployment model used by the project. **0.5.2 is currently unreleased on npm.** Use an inspected source revision containing native auth for these features; do not assume an older global/npm binary understands `--auth-required`.

## Prerequisites and layout

- A Linux VPS with a dedicated account, SSH administration, systemd and Git.
- Node.js **≥22.19.0**, npm and a working native build toolchain if dependencies need compilation.
- A hostname pointing to the VPS and HTTPS, for example through [Caddy](https://caddyserver.com/docs/install).
- GitHub CLI (`gh`) if you want GitHub connection/import/boards.
- Inbound HTTPS (443) and the HTTP challenge/redirect port (80) when using Caddy's usual automatic HTTPS. Keep port 5320 loopback-only; preserve SSH access while configuring your firewall.

Example layout:

```text
/opt/cogitator/releases/<revision>/   application code and dependencies
/opt/cogitator/current               symlink to the active release
/var/lib/cogitator/                  private application state and OS home
/var/lib/cogitator/.pi/agent/         providers, installed extensions, pi sessions
/var/lib/cogitator/projects/          imported projects
```

Use absolute executable paths in systemd. The examples assume Node is `/usr/bin/node`; check `command -v node` and replace that path and `PATH` if using an isolated runtime. Bun is not a drop-in runtime for this build's `better-sqlite3` dependency.

## 1. Prepare a source release

As an administrator on a fresh target, create a non-root service account and its directories (skip account creation if it already exists):

```sh
sudo useradd --system --create-home --home-dir /var/lib/cogitator --shell /bin/bash cogitator
sudo install -d -m 0700 -o cogitator -g cogitator /var/lib/cogitator
sudo install -d -m 0700 -o cogitator -g cogitator /var/lib/cogitator/projects
sudo install -d -m 0755 /opt/cogitator/releases
sudo install -d -m 0755 -o cogitator -g cogitator /opt/cogitator/releases/initial
sudo -u cogitator -H git clone --branch dev https://github.com/IgnitionAI/cogitator.git /opt/cogitator/releases/initial
sudo -u cogitator -H sh -c 'cd /opt/cogitator/releases/initial && npm ci && npm run build && npm test'
```

For reproducible deployment, check out your reviewed commit before building and record its full hash. The repository must be accessible to the account cloning it; never embed a GitHub token in a URL or this guide. Build failures must be resolved before activation.

After the build, keep the deployed code read-only to the service account:

```sh
sudo chown -R root:root /opt/cogitator/releases/initial
sudo ln -s /opt/cogitator/releases/initial /opt/cogitator/current
```

This is a fresh-install example, not a command for overwriting an existing `current` symlink. The dependency installation includes the matching pi runtime. The service `PATH` below exposes its `pi` command. Application state and extension installations remain writable in the separate data home.

## 2. Create the owner offline

Ensure every previous Cogitator process using this data directory is stopped. Use an interactive SSH terminal; do not put a password in a shell argument, environment variable or issue.

```sh
sudo -u cogitator -H env \
  COGITATOR_HOME=/var/lib/cogitator \
  COGITATOR_PI_AGENT_DIR=/var/lib/cogitator/.pi/agent \
  /usr/bin/node /opt/cogitator/current/dist/src/cli.js auth init \
  --origin https://cogitator.example.org --email owner@example.org
```

Replace the origin and email. The HTTPS origin must match the browser URL exactly, without a path or trailing slash. Confirm that the server is stopped, then enter a 12–128-character password twice through hidden prompts. This default flow does not require a setup key or authenticator.

To opt into MFA, add `--mfa`; follow the separate [enrollment instructions](native-auth.md). If you already have an owner, do not initialize over it—use the existing data and the documented offline recovery/mode commands where appropriate.

## 3. Run a protected system service

Create `/etc/systemd/system/cogitator.service` with this example, adapting executable paths:

```ini
[Unit]
Description=Cogitator pi web interface
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cogitator
Group=cogitator
WorkingDirectory=/var/lib/cogitator
Environment=HOME=/var/lib/cogitator
Environment=COGITATOR_HOME=/var/lib/cogitator
Environment=COGITATOR_PI_AGENT_DIR=/var/lib/cogitator/.pi/agent
Environment=COGITATOR_PROJECTS_DIR=/var/lib/cogitator/projects
Environment=COGITATOR_ENROLLED_ROOTS=/var/lib/cogitator/projects
Environment=COGITATOR_AUTH_REQUIRED=1
Environment=PATH=/opt/cogitator/current/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /opt/cogitator/current/dist/src/cli.js --auth-required
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
```

Do not use `COGITATOR_URL` as a public-origin setting; it is a client transport override and can prevent the local MCP adapter using its private socket. The canonical public origin is stored by `auth init`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cogitator.service
sudo systemctl is-active cogitator.service
```

The app binds to `127.0.0.1:5320`. Project roots allow workspace import into the intended directory; they are not a shell sandbox or a restriction on every command an agent might run.

## 4. Put HTTPS in front

Adapt the [Caddy example](examples/Caddyfile.cogitator) to your configured hostname. Add a site block to your existing Caddy configuration; preserve other sites:

```caddyfile
cogitator.example.org {
    @compressible not path /api/events /api/provider-logins/*/events /api/conversations/*/events /api/groups/*/events
    encode @compressible zstd gzip
    request_body {
        max_size 10MB
    }
    reverse_proxy 127.0.0.1:5320
}
```

Validate the file, then reload Caddy using its deployment's usual method. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) manages certificates for an eligible reachable hostname. The SSE routes bypass compression so prompts and streaming updates do not wait in buffers. Do not solve a certificate problem by disabling Secure cookies or exposing an unprotected backend.

Open `https://cogitator.example.org` and sign in with the owner email/password. Then connect a model provider through **Providers**. The owner login does not automatically authorize model access.

## 5. Verify the boundary and the product

Without a browser session:

```sh
curl -i https://cogitator.example.org/api/status
curl -i https://cogitator.example.org/api/agents
curl -i http://127.0.0.1:5320/api/agents  # run on the VPS
```

Expect public minimal status from `/api/status` and **401** on both unauthenticated `/api/agents` requests. A 503 on a normal application route is not expected. Check the unit and reverse proxy if health fails.

After signing in, verify the UI, provider setup, a small real model request if desired, GitHub access if used, and a workspace operation. A passing HTTP health check alone does not prove a provider or subagent works. Real model acceptance can cost money.

In **Extensions**, installation applies to the server's pi profile. Check updates and reload there; installing an extension on your laptop has no effect on this VPS. Connect GitHub using the UI's code flow rather than copying private credentials into chat.

## Updating and rollback

The footer's **Updates** button checks npm and shows guidance. It does not replace this service deployment or restart the server. A source build can be newer than npm; do not downgrade it just because npm's latest tag differs.

For a pi-managed installation, run `pi update --extensions` under the owning account and matching `PI_CODING_AGENT_DIR`, then load/restart the controller through its actual launch method. For a pinned package, explicitly choose the new version. For the systemd/source layout above:

1. Read the release notes and record the current release path/hash.
2. Build and test the reviewed new revision in **another release directory**, without touching active code or data. Make that release root-owned after building.
3. Let conversations and background subagents finish. Pause relevant schedules during the maintenance window and avoid new submissions.
4. Stop the service. Make a coherent private backup of application state **and** the pi profile, including auth state. Protect and encrypt backups; do not copy only a live SQLite main file while ignoring its WAL.
5. Switch `current` to the new release and start the service. Keep its data paths, owner, auth origin and required-auth guard unchanged.
6. Check service health and anonymous 401s, then verify owner login and refresh the browser. Resume schedules after verification.

A symlink can be switched with a temporary symlink and atomic rename on Linux. Do not modify the active release in place. Keep the previous release for rollback, but inspect migration notes first: **code rollback is not necessarily database rollback**. If a new schema is incompatible, restore a matched, coherent backup under the documented offline procedure before serving again. Never delete authentication markers to force startup.

`Restart=on-failure` only restarts a failed process. It is not a guarantee that an interrupted agent operation resumes exactly once. Automated off-host backups, restore reconciliation and complete durable recovery remain separate qualification work.

## Administration

- **Lost password:** stop the controller; run `auth recover` with the same build, account and `COGITATOR_HOME` in an interactive terminal. Restart and sign in again. See [offline recovery](native-auth.md#offline-owner-recovery).
- **Optional MFA policy:** `auth mode password` or `auth mode mfa` is an offline operation. It revokes sessions and requires a fresh login.
- **Logs:** inspect systemd logs locally. Do not publish provider tokens, OAuth return URLs, private transcripts or auth database contents.
- **Backups:** retain the data home and pi profile together. Test restoration to an isolated environment; possessing an archive is not evidence that recovery works.
- **Process permissions:** the local MCP socket, GitHub connection and provider keys belong to the server account. Native login does not isolate same-account agents from that authority.

For the actual deployment's verification history and remaining work, see [readiness evidence](firetower-readiness.md). Historical plans describe earlier gates; this guide documents the current single-owner workflow without claiming multi-tenant isolation or complete autonomous operation.
