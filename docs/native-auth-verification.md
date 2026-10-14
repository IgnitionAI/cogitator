# Native authentication — local verification record

Date: 2026-10-10. Baseline: `8d137e7`, package 0.3.0, **uncommitted working tree**. No commit, push, release, public exposure or VPS change is implied.

**Disposition: accepted for the bounded local increment.** Independent Standards and Spec re-reviews have no remaining blocking findings. The final parent-run build/test/TLS matrix below includes the enrollment activation/rotation correction. This is not security certification, public-deployment approval or completion of P1–P5.

## Evidence matrix

| Surface | Observed result | Scope |
| --- | --- | --- |
| Node 26.10.0, macOS arm64 | Full build; **140/140** application tests | Actual library, HTTP, private IPC, CLI/PTY and SQLite fault fixtures; no real provider work |
| Minimum Node 22.19.0 | Clean `npm ci` in a separate source copy; full build; **140/140** tests | Official archive checksum checked; working-tree native addons were not rebuilt for Node 22 |
| Real local HTTPS/browser, both runtimes | **6 journeys**, exit 0 on each runtime | Real controller/Better Auth/SQLite, disposable self-signed TLS proxy, isolated headless Chrome; no mocked responses, rate-counter resets or provider spawns |
| Mocked native UI | **7 journeys**, exit 0 | Malformed/offline status, mounting barrier, pending/error/focus state, enrollment contention, lost-response paths, logout failure, expiry and SSE retry behavior; not real-backend proof |
| Existing bilingual UI | Seven fresh complete diagnostic/ordinary runs exited 0 | Earlier post-PASS timeout did not reproduce; final `beforeExit` had no resources/handles. Its earlier cause remains unconfirmed; no forced-exit workaround |
| Durable P0 compatibility | Full supported-profile spike passed after clean isolated install | 19 interruption scenarios, real stdio MCP/isolated HTTP fixture, exact result and negative control, cleanup and storage gates; not production Durable integration |
| Package dry run | **82 files** | Six new runtime modules included; no tests/scripts/private auth state, SQLite databases, certificates or socket artifacts packaged |
| Standards reviews | Initial and follow-up: no actionable findings | Independent complete-module source review, not runtime certification |
| Spec review | Final source re-review: approve bounded local increment, no blocking findings | Complete corrected modules, installed library sequencing and regression assertions reviewed; runtime matrix separately executed by parent |

Runtime dependencies observed: Better Auth **1.7.7**, better-sqlite3 **12.11.1**, SQLite **3.53.2**. The browser harness uses the already-installed puppeteer-core **23.11.1**; no browser dependency was added to the product.

The build retains the existing Vite warning for a bundle above 500 kB. Build success does not establish performance/capacity targets.

## Corrections driven by evidence

- **Bodyless mutations:** the browser API originally omitted JSON Content-Type for POST/DELETE without bodies. It now supplies it for mutations; a real UI “Set as default” POST succeeds through the protected boundary.
- **Socket failure cleanup:** injected post-bind stat/chmod/receipt-write/fsync failures originally could leave a listener outside caller ownership. The helper now closes owned resources before rejection; fault tests include retry.
- **Invalid required-mode configuration:** only unset/`0`/`1` environment values and exact startup options are accepted; typos cannot silently select local operation.
- **Unix pathname truncation:** the official Node 22 binary actually bound a truncated 104-byte macOS pathname when asked for 106 bytes. The implementation now rejects paths above **103 UTF-8 bytes** before bind/connect and protected initialization. IPC fixtures deliberately use short temporary roots. Initial minimum-runtime failures were not counted as passes.
- **TTY echo race:** prompts were previously visible before no-echo mode was active. Raw/no-echo now precedes prompts and spans the credential sequence, with UTF-8 decoding and terminal restoration. Real PTY regression repetitions passed.
- **False logout success:** library session-deletion errors could be swallowed. The boundary now verifies durable absence before acknowledgment or cookie-clearing headers; failure stays explicit and retryable.
- **Pending challenge logout:** the library's signed-cookie and verification-consumption primitives now invalidate a pending MFA challenge. A saved pre-logout challenge cannot subsequently grant access in the regression.
- **Recovery-code replacement:** response suppression was insufficient when authorization disappeared during password verification. Temporary SQLite guards now check authoritative session/MFA/expiry at the actual write. Paused real-library validation tests preserve stored codes on revocation/expiry.
- **Enrollment activation/rotation:** SQL constraints now check original-session/claim authority at user activation, replacement-session insertion and final factor verification. Only this activation request's intentional old-session deletion is deferred; final verification and retirement share one SQLite statement. Failed replacements are cleaned up and rotation cookies withheld. Actual cryptography-pause and later-boundary regressions cover logout/session/claim expiry, replacement expiry/deletion and retirement failure. No transaction spans library awaits; an interrupted partial activation still requires offline recovery. Final independent Spec/Standards follow-ups approved this bounded correction.

The P0 compatibility fixture's startup-log assertion was updated from destination text to stdio identification. Destination selection remains proven by its fixture-owned request ledger, exact authoritative tool result and wrong-content negative control; a log line is not that authority.

## Dependency advisory reconciliation

`npm audit --omit=dev` returned zero reported vulnerabilities. That result is **not sufficient** to dismiss the upstream advisory:

- Repository advisory API: `https://api.github.com/repos/better-auth/better-auth/security-advisories/GHSA-fmh4-wcc4-5jm3`, updated **2026-09-26**, lists `< 1.6.11` and `>= 1.6.14`; the latter has no listed patch.
- Global advisory API: `https://api.github.com/advisories/GHSA-fmh4-wcc4-5jm3`, updated **2026-07-20**, lists only `< 1.6.11`, patched in 1.6.11.

The newer upstream record therefore still covers pinned 1.7.7's organization-invitation feature. Cogitator enables only the two-factor plugin and strictly exposes its selected owner-auth routes; no organization plugin/invitation route is available. This is a scope restriction, **not a fix or a claim that Better Auth is vulnerability-free**. Recheck the upstream record, registry graph and exact-version behavior before any upgrade/release.

## Reproduction

```sh
npm run build
npm test
npm --prefix scripts/durable-spike ci --ignore-scripts
npm run durable:spike
BROWSER_TOOLS_DIR=/path/to/browser-tools \
  node --import tsx scripts/ui-native-auth-live.mjs
npm audit --omit=dev
npm pack --dry-run --json
git diff --check
```

Run the minimum-runtime checks in a clean separate copy/install, with that Node binary first on PATH; do not replace the working tree's native SQLite binary in place. The TLS fixture requires Chrome and OpenSSL, uses its own temporary profile/certificate/home and emits PASS only after cleanup. It never opens the owner's browser profile.

Temporary local evidence includes `/tmp/cogitator-native-final-{build,test,tls}.log`, `/tmp/cogitator-native-node22-{install,build,test,tls}.log`, `/tmp/cogitator-native-p0-check.log`, `/tmp/cogitator-native-pack-final.json` (rechecked after documentation reconciliation), `/tmp/cogitator-native-auth-audit.json`, and the mocked UI/i18n reports. These paths are local artifacts, not remotely published certification.

## Limits that remain even after local acceptance

- Authentication is not worker isolation. Same-UID processes retain owner capabilities, including private IPC. Public remote operation remains prohibited until P2 and the other required gates pass.
- SIGKILL between Unix bind and ownership-receipt creation can require stopped-owner inspection of an unrecognized stale socket. Startup fails closed; complete autonomous startup recovery is not established.
- No deployed TLS/proxy configuration, actual host capacity/p95, Linux/rootless isolation, boot/24-hour soak, encrypted off-host backup/restore or production upgrade is certified here.
- The TLS browser fixture forbids provider spawning. It demonstrates global SSE behavior and session scope, not continuation of real provider work or per-conversation streaming. Separate backend fixtures cover both feed types with synthetic clients.
- Exact-library feasibility, mocked UI, real-library fixtures, HTTP/TLS integration and production certification are different evidence levels. Do not collapse them into a single “secure” result.
- Issue #7 and the overall P0–P5 work remain open. The [final local checkpoint](https://github.com/IgnitionAI/cogitator/issues/7#issuecomment-6096543522) was posted and its complete body read back exactly; issue state was verified OPEN. Firetower's earlier inventory/admin handoff remains suspended.

See [operator guidance](native-auth.md), [integrated browser proof](native-auth-live-proof.md), [isolated library feasibility](native-auth-runtime-proof.md), [Plan 0003](context/plans/active/0003-native-owner-auth.md) and [Plan 0002](context/plans/active/0002-secure-vps-durable.md).
