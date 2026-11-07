# Firetower deployment readiness

## Extension updates and short release notes — 2026-11-07

Release **c20ebbf** adds explicit update checks, per-package npm updates, an always-visible extension reload action, and a short bilingual What’s new dialog. Installed manifests determine versions; unknown/prerelease comparisons report unavailable rather than up to date. Native pi installation replaces a pinned source with the newer exact version while preserving package resource filters. Reload recycles idle handles and defers busy parents/children.

Typecheck, build and 19 focused tests passed locally and on Firetower. A temporary profile upgraded @gotgenes/pi-subagents 25.0.4 to 25.0.5 with filters retained. A separate isolated local browser test exercised Check updates → Update → Up to date and Reload → confirmation, plus the release notes dialog. No model request was initiated.

**Staged, not activated:** `/opt/cogitator/releases/c20ebbf` is built and tested. The idle guard repeatedly reported one busy conversation, so the current symlink and service were left unchanged at 912ab89. Activate only after parent and background subagents settle, then verify the live browser. No npm publication occurred.

## Subagent conversation viewer — 2026-11-07

Release **912ab89** makes subagent rows open a wide read-only dialog with mission, status/model, messages, collapsed tool calls/results, and automatic three-second refresh. Reading earlier messages preserves scroll position; a latest-messages action resumes following. It reads existing journals only and never prompts or restarts a child. The API resolves child session IDs inside the parent task directory, validates the parent relationship, rejects symlinks and bounds reads to 4 MiB / 300 rendered entries with a truncation notice.

Build and 23 focused tests passed locally and on Linux, covering parent isolation, symlink rejection, incomplete/appended journal records, bounded history and localization. Deployed only after native status reported conversations idle. The actual owner subagent returned 25 entries including 22 tools; its completed result was opened and visually verified in Chrome. Anonymous transcript requests return 401. No paid model call was initiated for verification.

## GitHub browser connection — 2026-11-07

Release **7580ef7** adds Connect GitHub to project import, using the native GitHub CLI device flow (compatible with Firetower gh 2.46). The authenticated UI displays a short-lived code and the fixed github.com/login/device link, polls completion, and supports cancellation/expiry. Credentials stay in the installation’s private `github` directory (directory 0700; configuration files 0600), with no token returned by the API. Connected GitHub imports use HTTPS and the gh credential helper; classic agents and board operations share this profile. Existing ambient authentication remains the fallback before a Cogitator connection exists.

Validation: builds and 46 focused login/git-import/i18n tests passed on macOS and Linux. The actual Firetower CLI obtained a device code in a temporary profile and was cancelled before authorization, with no credentials stored. The deployed UI then started the owner’s login and displayed the code/link successfully. Anonymous connection API returns 401. **Owner authorization is pending; private clone and authenticated board use are not yet verified.** No authorization code or token is retained in documentation.

## Simplified project import — 2026-11-07

Release **f1c5010** defaults the add-workspace dialog to GitHub: one repository link, automatic name, an Import action, and collapsed optional naming/private-repository guidance. The server-folder alternative remains available. The actual Chrome dialog was verified and the owner’s repository URL restored without submitting an import. Build and 11 focused workspace/i18n tests passed locally and on Linux.

Firetower had no enrolled workspace roots, causing imports to fail before git ran. Created the private controller-owned `/var/lib/cogitator/projects` directory and added exactly that path to `COGITATOR_ENROLLED_ROOTS`, preserving a private backup of the service environment. The existing confinement checks remain intact. Controller enrollment validation accepts this directory; services are active and anonymous workspaces requests return 401. Access to the private IgnitionRAG repository and its actual clone have not been tested.

## Extensions catalog deployed — 2026-11-07

Release **8d74518** adds an authenticated Extensions screen backed by the live pi.dev/packages catalogue: search, package-type filters, pagination, installed packages, install/remove progress and idle-session reload. Operations invoke native pi with the controller’s explicit profile, pin registry-resolved versions, serialize package changes and preserve busy parents/async children. Busy sessions require the displayed reload action once their work finishes. The catalog currently parses the official HTML cards; a site markup change may require adapting the parser.

Validation: builds passed on macOS and the exact Linux release; **17 focused tests** cover parsing, canonical redirects, input validation, profile isolation, version pinning, operation serialization, active-child preservation and bilingual UI. A real installation/removal cycle of `@gotgenes/pi-subagents` passed in a separate temporary controller profile; the owner’s existing package remained installed. Actual Chrome verification confirmed the new navigation item, live search results and installed status. All monitored services are active; anonymous `/api/packages` returns 401. No model requests were made for this feature verification.

## Subagent extension installed in the service profile — 2026-11-07

The owner reported that an actual model reply had only file and shell tools when asked to launch five subagents. The controller's `/var/lib/cogitator/.pi/agent` had neither package settings nor extensions: the laptop installation did not carry over to Firetower. Installed `npm:@gotgenes/pi-subagents@25.0.5` as the `cogitator` OS user with that exact `PI_CODING_AGENT_DIR`, using the isolated runtime's pi command.

An ephemeral SDK session on the deployed runtime loaded the profile with zero extension errors and registered `subagent`, `get_subagent_result`, and `steer_subagent`, without sending a model prompt. The existing conversation was non-streaming and had no child agents before restarting Cogitator to reload its processes. All three monitored services are active; the public anonymous agents endpoint returns 401 after startup (one transient 502 was observed during startup). No credentials or history were changed. Five real child model runs were not executed as part of this installation verification.

## Owner-authorized OpenAI connection completed — 2026-11-07

The owner completed OpenAI authorization in their browser. The provider returned to the fixed loopback callback on the owner's computer, where no callback server was listening because Cogitator runs on Firetower. The existing supported manual-return flow was completed in Cogitator after verifying that the callback state matched the pending attempt; the authorization code was not written to project files or documentation.

The provider credential was accepted and persisted by the native SDK. Read-only server metadata confirms `openai`, OAuth, locally available. The owner's previously requested conversation settings were retried successfully: **openai / gpt-6.1-sol / medium**, with no pending configuration or UI error. The actual browser shows **Connecté · Prêt**. No model prompt was sent on the owner's behalf; a real model response remains unverified.

## OAuth streaming proxy correction — 2026-11-07

The owner's real browser remained on the provider pending screen after choosing account login. Chrome network evidence identified the cause: the HTTP/2 provider-login SSE response had `Content-Encoding: zstd` and did not deliver the authorization events promptly. The earlier uncompressed HTTP checks and local browser fixtures did not exercise this proxy path.

The Firetower Caddy site now excludes all four current SSE route families from `encode`; compression remains enabled elsewhere. Its configuration was backed up privately, validated and gracefully reloaded without restarting Cogitator or changing credentials. See the reusable [Caddy example](examples/Caddyfile.cogitator).

Live verification: replaying OAuth events with either identity or zstd in `Accept-Encoding` returns an uncompressed event stream and `auth_url` in approximately 0.1 seconds. In the owner's actual Chrome tab, starting account login produced the authorization link in **654 ms**; network observation confirmed an uncompressed HTTP/2 stream and both `auth_url` and `prompt` events. The authorization page was not opened or approved on the owner's behalf. The pending flow was left open for the owner; real provider acceptance remains unverified.

## Conversation startup correction — 2026-11-07

The owner's failing chat exposed an unhandled setup state: no provider credential was configured, but the UI offered catalog models and the RPC startup rejected the default tuple as `unsupported model`. Its SSE endpoint returned a failure that the browser retried indefinitely. Service and catalog health did not establish working model conversations.

Release **697652f** distinguishes missing provider credentials from an unavailable model. Startup failures are terminal `session_error` SSE events with machine-readable codes; the chat stops automatic retries, preserves drafts and provides an inline provider-connection action plus explicit recheck. Model changes remain blocked with an explanation while the selected provider lacks credentials. Successful credential setup reopens the session and refreshes the model editor. Unfinished provider OAuth flows are canceled when the controller closes, so their callback listeners do not hold the service open during restart. Entering the exact public login shell from an external link is permitted for top-level browser GET navigation; cross-site API requests, mutations and requests with a foreign Origin remain rejected. No provider credentials were added on the owner's behalf.

Validation: build passed; the full local suite passed **390 / 402, with 12 environment skips and zero failures**. A real pi subprocess completed one HTTP chat against a disposable local OpenAI-compatible fixture, including streamed text and persisted assistant history. A separate HTTP test proves the terminal setup error and 409 model-switch response. A browser check covered blocked send, inline credential setup, preserved draft, automatic reconnect and a visible fixture reply. These are paid-free integration checks, not a real OpenAI account/token exchange or model acceptance. After the final lifecycle and navigation fixes, **46 focused chat/provider tests** and **22 auth/navigation tests** passed both locally and on Firetower. Live HTTPS returns a terminal `PROVIDER_NOT_CONFIGURED` event followed by EOF for the existing unconfigured conversation. External top-level login-shell navigation returns 200; a cross-site API request remains 403. The actual Chrome page shows the connection-required banner and opens OpenAI setup directly from the chat. Services are active on release 697652f. The owner's provider credentials are still absent; a real OpenAI reply remains unverified.

## Full application routing and provider setup — 2026-11-07

After the owner reported HTTP 503 following login, the onboarding-only Caddy catch-all was removed. The full application is routed to the loopback backend; native owner authentication remains required. Anonymous application catalogs returned 401, while authenticated agents/groups/workspaces/conversations/providers returned 200. Earlier sections below describing an onboarding-only gate are historical and superseded by this checkpoint. The health heartbeat now treats an application HTTP 503 as an incident.

Provider setup was simplified: searchable catalog with configured providers first, explicit API-key/account actions, inline errors with retry/cancel, masked key entry with Enter submission, and Ollama/custom endpoint templates. Local availability is read immediately from the explicit pi configuration used by login and RPC, without shelling out to another installation or caching stale results. OAuth prompts support out-of-band cancellation; completed/abandoned login sessions expire. Credential files and backups are owner-readable only. “Configured” means local credentials are available, not that a provider has accepted a billable model request.

Release **526119d** is active on Firetower. The macOS build passed; the full suite before the final device-ID addition passed **384 / 396 with 12 skips**, and all **33 focused tests** passed again after that addition, locally and on the exact Linux release. Live HTTPS checks returned anonymous 401 / owner 200 for the provider catalog. Starting and canceling API-key and ChatGPT OAuth flows produced the expected secret/manual-code prompts and OAuth authorization link inside the running service, without submitting any provider credential. The owner’s Chrome UI shows both OpenAI methods. Disposable local browser checks covered masked key entry with Enter, immediate status, OAuth selection/cancel, an Ollama template and 390 px layouts in French/English. No remote provider account/token exchange or paid model acceptance is claimed.

The broader Durable/worker/restore acceptance and nightly backups remain unfinished. This UI correction does not certify those gates.

## Simple owner login deployed — 2026-11-07

The owner explicitly requested email/password instead of mandatory MFA and clarified that every user installs their own Cogitator. [ADR-014](context/decisions/ADR-014-simple-owner-login.md) records the revised product policy.

Release **95385a8** is now installed. The offline switch preserved the existing owner and password, retired abandoned factor/setup state and revoked old sessions; an encrypted pre-change snapshot was retained. New installations default to password login, while MFA is opt-in and older configurations keep MFA until explicitly switched. No public signup or shared multi-user product was introduced.

Validation: macOS build and **379 passing tests / 12 skips**; target Linux build and **385 passing tests / six skips**, zero failures. The live HTTPS journey accepted the existing owner password without a setup key/MFA, returned authenticated status, authorized the backend and signed out correctly. The user's Chrome tab was refreshed and both email/password fields were verified enabled; the blocked enrollment screen is gone. Credential values were never printed. The clean password-only access file is in the private deployment bundle; the earlier file and its edits were preserved.

The historical public gate described below was subsequently replaced by full authenticated application routing (see the current checkpoint above). Worker integration/recovery, general backup/restore and full remote acceptance remain separate unfinished work. **Human MFA enrollment is no longer a deployment prerequisite for this instance.**

## Installed onboarding checkpoint — 2026-11-07

The owner explicitly requested installation after selecting/delegating the operating defaults. The existing root SSH alias was verified to target the same host as the development alias; no sudo workaround or Docker-based privilege escalation was used.

- Release **`126bb51`** is installed under `/opt/cogitator/releases/126bb51`, with a `current` symlink, root-owned code and a separate **Node 26.13.0** runtime. The existing host Node/pi and rootful Docker were preserved.
- New dedicated accounts: `cogitator` (controller) and `cogitator-worker`. Their state directories are private. The controller is not in the Docker group and cannot modify the installed release; the worker cannot read controller authentication state.
- A separate **rootless Docker daemon** is active for the worker account, with seccomp and systemd cgroups. Aggregate user-manager limits are **5 GiB RAM, 4 CPU equivalents and 768 processes**. The adversarial container fixture passed **2/2** against that daemon. This does not establish immutable lifecycle/runtime integration, storage quotas or full P2/P3 acceptance.
- **`cogitator.service` is enabled and active**, with native owner authentication required, a 2 GiB memory limit, no additional capabilities and loopback-only port 5320. Owner initialization succeeded with generated credentials stored only in the private off-host deployment bundle. Human authenticator enrollment is pending; no MFA device was enrolled on the owner's behalf.
- Caddy was validated and gracefully reloaded with a separate **onboarding-only** site. Existing site definitions were retained, with a private pre-change backup. Live HTTPS and the real browser owner-login screen passed. `/api/status` and auth status return 200, foreign-Origin auth mutations return 403, and all application/agent routes remain **503**. No unrestricted remote classic execution was exposed.
- On the exact Linux/Node release: install and build passed; **387 tests: 381 passed, six skipped, zero failed**. The skips cover Docker access from the intentionally unprivileged controller, host-pi discovery, the platform-specific PTY journey and three opt-in real-pi cases. The rootless container fixture was run separately as the worker.
- **Bun 1.4.4** was installed separately and tested. Opening the project's `better-sqlite3` database fails with `ERR_DLOPEN_FAILED` and Bun's explicit unsupported-package message ([upstream tracking](https://github.com/oven-sh/bun/issues/4290)). Node remains the service runtime; this is not a claim that Bun is generally slower or unsuitable.
- A **cold, encrypted bootstrap backup** was uploaded to the private Drive destination and read back as not shared. Transfer SHA-256, decryption round trip and auth/catalog SQLite integrity passed. The age identity was retained off-host, never uploaded to Drive or persisted on Firetower. This is an initial-state backup, not a full recovery-epoch restore drill. **Nightly transfer/retention is not active**; an uninstalled onboarding backup helper remains a draft and must not interrupt human MFA enrollment.
- The ACTIVE Codex heartbeat **Surveiller Cogitator sur Firetower** checks service and HTTPS health every 15 minutes. It is read-only and does not resume deployment or run agents. It relies on the local Codex/SSH host being available; actual incident delivery and continuous external monitoring remain unproven.

The exact origin, credential file, age identity, backup IDs/checksums, active automation ID and current limits are in the private deployment bundle. **Remaining:** human MFA enrollment, #47/#17 integration/recovery, #18/#19 drain/backup/restore, and #20 application enablement/capacity/reboot/soak. The public application gate must stay closed until those prerequisites are met.

The readiness observations below are the earlier checkpoint, retained for chronology; the installed state above supersedes their missing-runtime/rootless/admin-access findings.

Checkpoint: 2026-11-07. The owner selected **Firetower** for the VPS work. This is a readiness record, not a completed deployment or approval to change existing services.

## Observed on the target

Read-only SSH checks under the existing unprivileged account established:

| Check | Observation | Consequence |
| --- | --- | --- |
| Connectivity | SSH works; Linux host | Target can be inspected |
| Capacity inventory | 8 logical CPUs, about 16 GiB RAM, about 242 GiB free on `/` | Sizing inventory only; two-job load acceptance remains required |
| Node | `v20.19.2` | Below the application's `>=22.19.0` requirement |
| Host pi | `0.73.1` | Not the package's pinned pi 1.1.0 baseline; install/verify an isolated application runtime |
| Caddy | Active; ports 80/443 listening | Preserve existing routes and consumers |
| Backend port | No listener on 5320 | Available at inspection time; recheck before binding |
| Docker | Accessible daemon advertises AppArmor, seccomp and cgroup namespaces; no rootless security option | This daemon is not rootless-production evidence |
| User Docker service | Inactive under the inspected account; `rootlesskit` exists | A separate worker account and verified rootless transport still need provisioning |

No packages, services, firewall rules, reverse-proxy configuration or credentials were changed. No workload was dispatched on this host.

## Concrete next work

1. Provide an application-specific supported Node installation and the pinned pi dependencies. Preserve the host's existing Node/pi and the applications using them.
2. Prepare separate controller and worker accounts with private state, enrolled disposable workspaces and the execution limits in Plan 0002. Do not give the application the existing rootful Docker socket as a substitute for isolation.
3. Complete the immutable worker identity/lifecycle adapter ([#47](https://github.com/IgnitionAI/cogitator/issues/47)) and integrated recovery gates ([#17](https://github.com/IgnitionAI/cogitator/issues/17)). The adapter issue is separately in progress; avoid overlapping its implementation.
4. Complete scheduling reconciliation and backup/restore ([#18](https://github.com/IgnitionAI/cogitator/issues/18), [#19](https://github.com/IgnitionAI/cogitator/issues/19)). Local regression results do not establish restart or restore behavior on Firetower.
5. Bind the [deployment specification](deployment-spec.md) to the chosen HTTPS origin, bootstrap native owner authentication privately, then run the desktop/mobile, denial, resource, reboot, restore, alert and soak acceptance gates in [#20](https://github.com/IgnitionAI/cogitator/issues/20).

## Defaults selected after owner delegation — 2026-11-07

The owner delegated the remaining choices ("comme tu veux"). No further preference confirmation is required:

- **Hostname:** a dedicated `cogitator.<target-ip>.sslip.io` HTTPS origin. DNS resolution was checked against Firetower. The exact origin is kept in the private deployment bundle rather than committed here. No domain purchase or DNS-account change is needed.
- **Runtime:** isolated Node **26.13.0 LTS**, from the official release index checked on this date. Install it separately from host Node/pi; qualify the exact runtime before starting the application.
- **Backup destination:** a new, private Google Drive folder named **Cogitator — sauvegardes chiffrées**, created through the connected account and read back as not shared. No application data or credentials were uploaded. Default policy: coherent recovery sets encrypted with age **before** transfer, daily at **03:15 Europe/Paris**, seven daily and four weekly copies; decryption identity retained off-host and outside the backup folder. Unattended transfer, retention and restore acceptance remain to be implemented. A connector-accessible folder is not a daemon credential or a successful backup.
- **Alerts:** Codex notifications, with planned external health checks every 15 minutes for unavailable VPS, stalled recovery, needs-attention and backup failures. Monitor scheduling and actual notification delivery remain unconfigured; no automation was created to track deployment completion. A sleeping/offline Mac is not continuous external monitoring.

The private bundle lives under `~/.config/cogitator-deploy/firetower-*` (directory 0700, files 0600); `firetower-current-path.txt` identifies the current directory. It includes the decisions, protected service environment, systemd unit and separate maintenance/application Caddy drafts. The Caddy drafts were adapted successfully by Firetower's installed Caddy via stdin; this did not load configuration, request certificates or prove live HTTPS.

The existing `noosphere-backup.timer` and its Restic script were discovered without reading password contents or changing the job. An off-host destination was not established, so it was not reused or presented as off-host protection. The SSH account has no non-interactive sudo. Provisioning dedicated users, an isolated runtime/rootless workers, private owner bootstrap and the open product gates remain the deployment prerequisites. Existing services and ingress are unchanged.

The historical Authelia/root inventory handoff remains obsolete. Firetower selection does not reinstate that procedure or authorize changes to the existing identity service. The full remote product remains incomplete under [#7](https://github.com/IgnitionAI/cogitator/issues/7).
