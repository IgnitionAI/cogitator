# Native owner authentication

Status: **implemented, independently re-reviewed and verified for the bounded local increment**. See the [evidence and limits](native-auth-verification.md). This is not approval to expose Cogitator publicly. Authentication does not isolate agent execution; the worker-isolation and remaining remote/Durable gates in [Plan 0002](context/plans/active/0002-secure-vps-durable.md) are still open. No Firetower or Authelia administration is part of this procedure.

## Supported boundary

- One offline-provisioned owner, with a password and mandatory authenticator/recovery-code verification. No public signup, email reset, social login or external identity service.
- Node **22.19.0 or newer**. Protected mode initially requires Unix; ordinary trusted local mode remains available on Windows.
- One controller process per data home, with TCP bound to `127.0.0.1`. A trusted TLS terminator must supply the configured canonical HTTPS origin. Cogitator does not provision that terminator or its certificate.
- The controller OS account, its same-UID local processes and its private local MCP socket remain trusted. Future remote workers must not inherit this capability. Native login is not a sandbox.
- Better Auth is pinned to **1.7.7**. Organization, admin, social, magic-link and SSO plugins/routes are unavailable. The [organization-invitation advisory](https://github.com/better-auth/better-auth/security/advisories/GHSA-fmh4-wcc4-5jm3) remains relevant to dependency review; a clean npm audit is not a claim that the package is vulnerability-free.

## Offline initialization

Use an interactive terminal owned by the controller account. Do not paste passwords or setup keys into arguments, environment variables, chat, logs or an issue.

The commands below require **this native-auth-capable build**, not the previously published/global binary. Until this increment is released, run `npm run build` in this checkout and substitute `node dist/src/cli.js` for every `cogitator` command below. An old binary can ignore the new arguments/markers and start trusted-local mode; do not use it for initialization or subsequent serving.

1. Stop and verify **all previous Cogitator instances** for this data home, including custom ports and old binaries. New guards cannot retrofit an already-running old version. The configured-port check is not a global process inventory.
2. Run:

   ```sh
   cogitator auth init --origin https://cogitator.example.org --email owner@example.org
   ```

   Replace the example origin and login identifier. The origin must be exact HTTPS, with no trailing slash, path, username or password. Email is a login identifier; no mail service is used. For a non-default data home, set `COGITATOR_HOME` consistently on every command and the server.
3. Confirm the stopped-server precondition. Enter a new **12–128-character password twice** through the hidden prompts.
4. Save the CLI-issued setup key privately. It expires after **30 minutes**; only its keyed digest is retained by Cogitator.
5. Start the controller with an independent required-mode guard:

   ```sh
   cogitator --auth-required
   # Equivalent startup guard: COGITATOR_AUTH_REQUIRED=1 cogitator
   ```

6. Open the configured HTTPS origin through your already-controlled TLS terminator. Do not expose it publicly before the separate remote-isolation/deployment gates pass. Select English or French before signing in if needed.
7. Sign in with the owner password, then enter the CLI setup key and confirm the password. Add the displayed **manual TOTP secret** to an authenticator. No third-party QR service is contacted. Save the recovery codes offline.
8. Verify an authenticator code, **sign out**, then sign in again with password and MFA. Enrollment and earlier password-only sessions never become full application sessions merely because enrollment completed.

Public liveness is `GET /api/status`; detailed `/api/health`, application data, files and event streams require authorization. Direct loopback HTTP is not a browser-authentication bypass. Do not disable Secure cookies to work around a missing HTTPS terminator.

## Sessions and everyday use

Full sessions have a fixed **24-hour lifetime**, with no indefinite refresh. Restricted enrollment sessions last at most **10 minutes**. Password, setup and MFA endpoints are rate-limited using persistent state; behind one loopback proxy, limits are deliberately shared rather than trusting client-supplied forwarding headers.

- **Sign out of this browser** applies only to its current session. Other browsers stay signed in, and already-running work continues. The interface immediately hides protected content and closes its streams. If server sign-out cannot be confirmed, the view stays locked and asks for a retry; do not treat an error as successful revocation.
- Settings → **Owner security** replaces recovery codes only after full MFA and password confirmation. Confirm the warning: replacement invalidates every previous recovery code, including when the response is lost.
- A successful TOTP login reserves a keyed digest for five minutes. A simultaneous/repeated attempt cannot create another approved session with that code. An insertion failure can consume the code without granting access: restart sign-in and use a fresh code. This is not a transaction spanning all library operations.
- Session expiry/revocation is checked against the database, including before SSE emissions/heartbeats. The required stream-closure bound is 60 seconds; the implementation checks idle streams every 15 seconds.
- Refreshing during a temporary MFA challenge may restart password sign-in. No JavaScript-readable session token or persistent browser secret is provided.

## Enrollment problems

| Situation | Safe next step |
| --- | --- |
| Another browser has a live enrollment claim | Resume there, or wait until its displayed deadline. A second password session cannot steal a live claim. |
| Setup response was lost, but the selected session remains valid | Reuse the saved authenticator secret, or explicitly replace pending setup with password confirmation. Replacement invalidates previous pending material. |
| Verification succeeded but its response/cookie was lost | Return to password sign-in and use the authenticator just configured. Do not expect the old enrollment cookie to become authorized. |
| Setup key was lost or expired before enrollment | Stop every controller instance and run `cogitator auth setup-key`. This invalidates restricted sessions and pending setup; restart, sign in again and use the new private key. |
| MFA is already enrolled and all factors/recovery codes are unavailable | Perform offline owner recovery below. `setup-key` does not disable an enrolled factor. |
| Partial/inconsistent factor state or maintenance mode | Keep the service stopped and perform offline recovery; never remove protection markers to obtain access. |

## Offline owner recovery

Stop and verify every instance, then run:

```sh
cogitator auth recover
```

Confirm the precondition and enter a new password twice. Recovery uses the library's password-reset APIs without mail delivery, clears factor/enrollment state, revokes **all owner sessions and pending challenges**, and issues a fresh setup key. It preserves replay reservations and both the owner identity and protected-mode requirement. Start the controller and repeat enrollment followed by a fresh password/MFA sign-in.

Recovery is maintenance-gated, not one atomic library transaction. An interruption leaves durable maintenance state and prevents serving partially reset credentials. Retry recovery with the server stopped. Interrupted first initialization may instead require rerunning the original `auth init` command with the same origin and owner identifier; once an owner configuration is committed, use recovery.

If the persistent secret/configuration or authentication database is missing or damaged, restore the **complete private backup** rather than reinitialize around missing files. There is no public reset or disable command. Origin changes and library migrations also require stopped-server administration; there is no online origin-change endpoint.

## Private state and restore

Default data home: `~/.cogitator`.

| Path under `COGITATOR_HOME` | Purpose |
| --- | --- |
| `auth-required` | Durable protection marker independent of the auth directory |
| `auth-maintenance` | Incomplete offline administration; serving must remain disabled |
| `auth/config.json` | Canonical origin, exact owner ID, library secret and replay key |
| `auth/auth.sqlite` | Credentials, factor material, sessions, challenges, rate limits and replay claims |
| `auth/owner.sock`, `auth/owner.sock.json` | Private local IPC and its ownership receipt; not browser credentials |
| `owner-lock.sqlite` | OS-released exclusive data-home administration/runtime lock; not conversation storage |

The auth directory is owner-only `0700`; secret/database/receipt files and the socket are `0600`. The data home must belong to the controller account and must not be group/world writable. Symlinks or unsafe ownership/permissions are refused. Conversation catalog SQLite and pi JSONL history remain separate and unchanged.

Back up the private auth configuration/database together with application state, using the encrypted off-host backup and restore procedure still required by Plan 0002. Do not copy live SQLite files unsafely or back up a live socket as reusable authority. A restore is not an ordinary restart: the future validated restore workflow must invalidate owner sessions/challenges/setup capabilities and keep dispatch disabled until reconciliation. This increment does **not** supply that complete restore workflow.

Either persisted protection indicator requires valid protected state. A service must additionally set `--auth-required` or `COGITATOR_AUTH_REQUIRED=1` independently of restored files, so a missing/legacy backup cannot select local mode. Environment values are limited to unset, `0`, or `1`; `0` does not override existing markers. Deliberate deletion of every indicator by a trusted administrator is outside automatic detection guarantees.

## Local MCP and startup limits

Protected local MCP uses the owner-only Unix socket, with the same application routes/event registration as TCP. The shipped adapter is stdio-only and does not open an HTTP MCP bridge. Browser Origin/Fetch-Metadata markers are rejected on the private transport; a TCP header cannot confer private identity.

An explicit `COGITATOR_URL`, including a loopback override, always uses ordinary HTTP semantics and never silently acquires the local socket's privilege. Clear that override when you intend to use the private local transport. No owner browser cookie is placed into MCP or agent snapshots.

The complete Unix socket pathname must fit within **103 UTF-8 bytes**. Choose a short data-home path; initialization refuses oversized paths before creating protected-mode markers, rather than relying on platform-specific truncation. Startup reserves the configured TCP port before reconciling an existing socket. Unsafe, live or unrecognized sockets are refused. **Known bounded limitation:** SIGKILL between Unix bind and the durable ownership receipt can leave an unrecognized stale socket. Startup fails closed and retains it for stopped-owner inspection; do not blindly unlink socket files. This is not complete autonomous startup recovery, and remains relevant to the later reliability gates.

See [Plan 0003](context/plans/active/0003-native-owner-auth.md), [ADR-009](context/decisions/ADR-009-native-owner-auth.md), [library research](native-auth-library.md) and the separate [isolated feasibility proof](native-auth-runtime-proof.md). Those sources describe different evidence scopes, not production certification.
