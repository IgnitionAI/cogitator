# Deployment specification — TLS termination, reverse proxy, systemd (for Plan 0002 phase P5)

Status: **reviewed specification, ready to execute in the P5 ticket**. Nothing here has been
provisioned, installed or exposed. This document does not authorize deployment; the owner
executes it during P5 after the P1/P2 gates pass. Sources: Plan 0002 §4 access boundary and
§8 P5, ADR-008 (D1, O4/O7), ADR-009, Plan 0003.

## 1. Topology and trust model

```
Owner browser ──HTTPS(443)──> Caddy (TLS termination, public surface)
                                   │  reverse proxy, headers preserved
                                   ▼
                          Cogitator HTTP ──127.0.0.1:5320── (loopback only)
                                   │  private owner Unix socket (local IPC exception, O4)
                                   ▼
                     auth SQLite + catalog SQLite (dedicated non-root account)
```

- Caddy is a maintained TLS terminator only (ADR-008: "A maintained TLS terminator may still be
  used without owning product authentication"). Cogitator owns authentication and authorization;
  the proxy adds TLS and attack-surface reduction, never identity.
- The backend binds `127.0.0.1:5320` (default; `COGITATOR_PORT` to change). No public port
  reaches it. Proven: `test/access-boundary.test.ts` — direct port access fails closed
  (401/403), only minimal loopback liveness (`GET /api/status` with loopback Host) answers.
- The reviewed owner-only Unix socket (`<home>/auth/owner.sock`, mode 0600) stays available for
  the trusted local OS owner (O4/O7). It is not reachable remotely and carries no TCP bypass.

## 2. Cogitator service configuration (application-side contract)

Environment for the systemd unit (all required; the app fails closed on typos — `COGITATOR_AUTH_REQUIRED`
accepts only unset/`0`/`1`):

| Variable | Value at deployment | Why |
| --- | --- | --- |
| `COGITATOR_AUTH_REQUIRED` | `1` | Protected mode; missing/invalid never silently selects local mode |
| `COGITATOR_HOME` | `/var/lib/cogitator` | Dedicated state root (auth SQLite, catalog, workspaces) |
| `COGITATOR_URL` | unset for the service | The app must compute its own canonical origin from the bootstrap config, not from proxy headers |
| `COGITATOR_PORT` | `5320` (default) | Loopback backend port |
| `NODE_ENV` | `production` | |

The **canonical origin** (e.g. `https://cogitator.example.com`) is pinned offline at owner
bootstrap (`initializeOwner`) and stored in the private auth config. The boundary enforces it:
requests whose `Host` does not match the configured origin host, whose `Origin` differs on any
request, or that mutate without the exact origin and JSON `Content-Type`, are rejected
(403/400). The proxy must therefore:

1. **Forward `Host` and `Origin` untouched** (Caddy does this by default). Never rewrite,
   never inject `X-Forwarded-*` identity headers, never add CORS headers: the application
   rejects cross-origin writes itself and permissive credentialed CORS must not exist.
2. Terminate TLS and redirect HTTP→HTTPS (Caddy automatic HTTPS).
3. Serve only `https://<canonical-origin>`; obtain the certificate for that exact name
   (ACME). The certificate name and the bootstrap origin must match, or every request 403s.

## 3. Caddyfile

```caddy
# /etc/caddy/Cogitator.conf — included from the main Caddyfile (import /etc/caddy/*.conf)
cogitator.example.com {
    # TLS: automatic ACME. No internal listener, no debug endpoints exposed.
    encode zstd gzip

    # Backend is the only upstream; it binds loopback and enforces auth itself.
    reverse_proxy 127.0.0.1:5320

    # Fail closed if the backend is down instead of serving a stale or blank success.
    @backendDown expression {http.reverse_proxy.status_code} == 502
    handle @backendDown {
        respond "unavailable" 503
    }

    # Request size bound; the application already caps auth bodies at 8 KiB.
    request_body {
        max_size 10MB
    }

    # Security headers that make sense at the edge; the app sets its own CSP/frame headers.
    header {
        -Server
        -X-Powered-By
    }

    log {
        output file /var/log/caddy/cogitator-access.log
        format json
        # Cookies and bodies are never logged.
    }
}
```

Review notes:

- `reverse_proxy` preserves the browser `Host` (default `header_up Host {http.request.host}` is
  a no-op pass-through) — required, because the backend compares `Host` to the canonical origin.
- No `header_up X-Real-IP`/`X-Forwarded-User`: the backend deliberately ignores forwarding
  headers (`browserHeaders` copies only cookie/origin/content-type/user-agent and sets
  `x-cogitator-peer` from the socket peer). A forged identity header at the edge confers nothing.
- WebSocket/SSE: Caddy handles Upgrade transparently; no extra directive needed. SSE revocation
  is proven in `test/access-boundary.test.ts` (stream closes within the 60 s bound).

## 4. systemd unit

`/etc/systemd/system/cogitator.service` — dedicated non-root account (Plan 0002 §4: "The
controller runs under a dedicated non-root account"):

```ini
[Unit]
Description=Cogitator control server
After=network.target
# Fail closed: never start unauthenticated by accident.
ConditionEnvironment=COGITATOR_AUTH_REQUIRED

[Service]
Type=simple
User=cogitator
Group=cogitator
Environment=COGITATOR_AUTH_REQUIRED=1
Environment=COGITATOR_HOME=/var/lib/cogitator
Environment=COGITATOR_PORT=5320
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/cogitator/dist/cli.js --auth-required
Restart=on-failure
RestartSec=5
# Bounded restart, not a retry storm (Plan 0002 worker/limits philosophy).
StartLimitIntervalSec=300
StartLimitBurst=5

# Filesystem and privilege hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/cogitator
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

# Network: nothing needed beyond loopback outbound (model provider APIs, package
# registries). Outbound is NOT restricted here because the controller legitimately
# reaches provider APIs; worker egress is constrained in P2, not in this unit.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

# Capability and syscall bounds
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

# Resource bounds (revisit after the P5 capacity test; Plan 0002 targets 4 vCPU/8 GiB host)
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=multi-user.target
```

Provisioning steps for P5 (execute only in the P5 ticket):

```sh
sudo useradd --system --home /var/lib/cogitator --shell /usr/sbin/nologin cogitator
sudo install -d -o cogitator -g cogitator -m 0700 /var/lib/cogitator
# Install the pinned release (same version the test matrix ran on) under /opt/cogitator.
sudo systemctl daemon-reload && sudo systemctl enable --now cogitator
# Owner bootstrap (offline, one owner, mandatory MFA) — interactive password prompt:
sudo -u cogitator COGITATOR_AUTH_REQUIRED=1 node /opt/cogitator/dist/cli.js auth init \
  --origin https://cogitator.example.com --email owner@example.com
```

## 5. Firewall and exposure

- Public inbound: 443 (and 80 only for ACME HTTP-01 redirects). SSH restricted separately
  (key-only, non-default policy; out of scope here). **No other port.**
- The Docker API (P2 workers) is never exposed; rootless worker daemon runs under a separate
  worker account (P2 ticket).
- Detailed health (`/api/health`) stays authenticated; only `/api/status` (minimal service/
  authentication status) and the login shell are public — this is application behavior, already
  tested; no proxy rule needed.

## 6. Pre-deployment verification checklist (P5 executes)

1. `npm run build && npm test` on the exact release commit — full suite green
   (includes `test/access-boundary.test.ts`: external denial matrix, direct-port fail-closed,
   IPC exception, owner journey + revocation).
2. Real TLS + clean-browser owner journey: `BROWSER_TOOLS_DIR=/path/to/browser-tools
   node --import tsx scripts/ui-native-auth-live.mjs` against the deployed origin.
3. From an external host: `curl -i https://<origin>/api/health` → 401; `curl -i -H "Host: evil"
   https://<origin>/` → 403; `curl -i http://<vps>:5320/api/health` → connection refused.
4. Reboot drill and 24 h controlled soak per Plan 0002 §8 P5.

## 7. Explicit non-goals

- No Authelia/OIDC gateway (superseded by ADR-009); no Firetower changes.
- No multi-user, registration or reset surface.
- This specification does not cover P2 worker isolation, backups or the durable runtime —
  those remain separate gates in Plan 0002.
