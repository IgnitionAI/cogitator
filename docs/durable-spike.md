# P0 — isolated Pi Durable compatibility/crash evidence

Date: 2026-10-09. Execution baseline: Cogitator `bd128d2` / 0.3.0.

**P0 local runtime seam: PASS for the explicitly supported fixture profiles below.** The initial partial spike was blocked by unwritten local checks; those checks have now been implemented and exercised. There is no remaining external-access blocker for this bounded P0 proof. This is **not** production integration, authentication, isolation, arbitrary preset compatibility, or completion of P1–P5.

## Reproduce

With the repository's existing development dependencies installed:

```sh
npm --prefix scripts/durable-spike ci --ignore-scripts
npm run durable:spike
```

The command typechecks only `scripts/durable-spike/*.ts` with strict TypeScript, then runs the real SDK checks. Failed assertions, unexpected child exits and crash-child timeouts fail the command. No application suite is run by this bounded implementation unit.

Latest local evidence: macOS, Node `v26.10.0`, repeated focused runs, exit zero:

```text
Fixture source revision: 33288b180e7ff667554325053aae205d17b277bf
PASS: SIGKILL generation; durable queued request IDs; approval data; committed events; FULL connection setting
PASS: SIGKILL fixture_edit / reopen
PASS: SIGKILL fixture_edit_mutant / reopen
PASS: SIGKILL fixture_conflict / reopen
PASS: SIGKILL fixture_unsafe / reopen
PASS: SIGKILL fixture_grant_boundary / reopen
PASS: SIGKILL fixture_offline / reopen
PASS: SIGKILL profile_unknown / reopen
PASS: SIGKILL profile_missing / reopen
PASS: SIGKILL acceptance_before / reopen
PASS: SIGKILL acceptance_after / reopen
PASS: SIGKILL grant_expired / reopen
PASS: SIGKILL grant_revoked / reopen
PASS: SIGKILL grant_denied / reopen
PASS: SIGKILL grant_arguments / reopen
PASS: SIGKILL grant_artifact / reopen
PASS: SIGKILL grant_mission / reopen
PASS: SIGKILL grant_target / reopen
PASS: SIGKILL grant_action / reopen
PASS: timeout waits for harness close; live supervisor cleanup before rm; non-ENOENT read errors propagate
PASS: real skill loader / Durable prompt; necessary Cogitator list_skills MCP against ephemeral HTTP fixture; missing extension negative case; document/task version rejection
PASS: SQLite schema 1; future schema rejected
P0 LOCAL SUPPORTED PROFILE: PASS — not production integration, isolation, or deployment.
```

## Pins and provenance

Exact development-only pins in private `scripts/durable-spike/package.json`:

| Package | Version |
| --- | --- |
| `@earendil-works/pi-durable` | `1.1.0` |
| `@earendil-works/pi-ai` | `1.1.0` |
| `@earendil-works/chord` | `1.1.0` |
| Resolved `@earendil-works/pi-telemetry` | `1.1.0` |
| Resolved `diff` | `8.0.4` |
| Resolved `typebox` | `1.3.27` |

The adjacent lockfile records the entire resolved tooling graph; install with `ci`. The spike reuses existing root TypeScript/tsx/Node types, MCP client and public coding-agent skill-loader exports. Root manifest adds only `durable:spike`; root lockfile and classic coding-agent/agent-core/pi-ai/chord/pi-telemetry `1.0.4` graph are unchanged. There are no aliases, application dependency overrides, production Durable imports or changes to `src/` or `web/`. The package's existing publish allowlist excludes the spike.

Durable tarball identity:

- SHA-1: `17592b5975cffc39a82bc91dda51de5d06e28548`.
- SRI: `sha512-NtuB3RY24vQ+0/rWYpeHupyFWBfXuKq17to3VMYUYqfD/uuGnz6F6UTPBEm51VSxxA6LZwRcDwLX2LtRehnIgQ==`.
- npm provenance resolved dependency: `git+https://github.com/earendil-works/pi@refs/tags/v1.1.0`, commit `abe508e1b89912adde45528136c3221eb69acdd7`, also observed with `git ls-remote`. Payload inspection is not an independent cryptographic attestation audit.

Reading included complete installed Durable and matching pi-ai READMEs, complete Durable `docs/spec.md` at that immutable commit, its recovery example, installed declarations/implementations for used APIs, and Pi skills documentation. Executable evidence uses installed pinned code, not mutable upstream `main`.

## Test boundary and fixture ownership

`repository.ts` constructs a synthetic Git repository under a private temporary directory with fixed content, author and timestamps. Git plumbing creates **only this fixture's** source revision; there is no commit to Cogitator, user repository history or remote. Each scenario uses a genuine `git clone --no-local` into its own disposable `workspace`, verifies HEAD against the recorded revision, and stores that revision in a Durable profile document. The original fixture source remains unchanged after the scenarios. No owner files or data are copied into fixtures.

`spike.ts` forks fresh Node processes with temporary HOME and a minimal environment. pi-ai's `fauxProvider` is the **only registered model provider**. Harness scheduling, SQLite storage, commits, tasks, inboxes, submissions, documents, model-event adaptation and recovery are real SDK implementations. The parent waits for a reached-checkpoint IPC message, sends real SIGKILL, checks signal exit, and launches a fresh child over the same SDK storage. Parent witness IDs are assertion data, never a substitute for Durable recovery state.

`tools.ts` defines a deliberately small supported profile. It delegates edits to SDK `createEditTool` and uses real SDK memos/transactions. Its harmless external-effect fixture appends to a temporary file. `offline-worker.ts` supervises a real `node --test --experimental-test-isolation=none --test-timeout=10000 offline.test.mjs` command in the clone. The test reads the clone's file and makes an actual assertion; no network or credentials are involved. Isolation `none` keeps this trusted fixture's test in that Node process, so there are no test-runner descendants to silently abandon.

The offline test announces that it started **before** the crash checkpoint. Unlike the initial spike, harness death intentionally leaves the supervisor and its test alive. A private Unix socket in the temporary state directory lets the recovered tool observe that execution, request termination, and await the test's exit acknowledgment. Only then does it rerun the offline test. The supervisor has a 12-second kill deadline even if recovery fails. These files/socket/receipts belong to the harmless external worker fixture; Durable still owns execution intent and identity. This is not a second task scheduler or a production container-control protocol.

`compatibility.ts` now launches the **actual `src/mcp-server.ts`** through Node/tsx and calls its actual `cogitator_list_skills` implementation through the real MCP client and a Durable tool. The explicit `COGITATOR_URL` points to an isolated HTTP fixture bound to loopback port **0** (OS-selected ephemeral port), never the live default port 5320; fallback `COGITATOR_PORT` is explicitly 0. The fixture permits only `GET /api/skills`, returns unique synthetic skill data, and records all requests. The successful call requires an authoritative committed `toolResult` with `isError === false` and exact expected content, plus the real MCP server's startup confirmation of the configured fixture URL. A second call deliberately returns wrong HTTP fixture content: the SDK records the tool assertion as an error containing the expected fixture UUID, reproducing the old text-match false positive. The same success assertion must reject that result. Exactly these two read-only requests are allowed. No live HTTP application, user database, model provider, private preset/configuration or external write is used. The HTTP backend is the only mock here; MCP server/client and tool callback are real. This replaces the earlier echo-only mechanics test.

On failure as well as success, `runChild` records timeout/error, sends SIGKILL only to its **owned ChildProcess**, and settles only after `close`. Final cleanup waits for any expected fixture supervisor to stop its owned test and reach its process-exit marker before deleting directories. It uses the private fixture socket, not an arbitrary PID. Cleanup is bounded; if quiescence cannot be established it fails and preserves the directory instead of racing deletion. An executable negative check starts a live supervisor, times out the next harness process, awaits both cleanup boundaries, verifies the supervisor marker, then deletes the scope. The marker is emitted only on supervisor exit after the test's `close`; it cannot certify an abandoned still-running test. A separate EISDIR check proves optional reads propagate non-ENOENT errors; only genuine ENOENT means absent effect evidence.

## Per-gate evidence

All PASS results below are scoped to this fixed, trusted local profile.

| P0 gate | Result | Executed evidence |
| --- | --- | --- |
| Accepted request identity and deduplication | **PASS** | Two accepted request IDs survive SIGKILL; retry returns identical IDs, with exactly two user entries. Busy rejection creates no submission record. |
| Before acceptance crash | **PASS** | Kill after runtime/profile creation but before submit. Reopen has no boundary submission and no provider call; first submit creates exactly one user input and one model call. |
| Immediately after acceptance crash | **PASS** | Kill after `submit` resolves. Reopen finds the accepted ID before enabling scheduling. Resubmit reuses it, creates one user entry, and completes with one fresh provider invocation. |
| Durable queued work | **PASS** | Second accepted input is queued while first streams; after kill/reopen first and queued follow-up both settle without new request identities. |
| Interrupted model response | **PASS** | Kill follows a committed streaming update. Reopen is initially paused with retained live message; SDK converts committed partial into an aborted entry and completes the interrupted request and queued request. This is checkpoint retry, not restoration of the original network stream. |
| Recorded file edit in disposable clone | **PASS** | Memo records exact before/after bytes; real SDK edit writes the clone; kill before tool-result commit; recovery reads actual after bytes and requires a real `toolResult` with `isError === false` and exactly `edit reconciled` content, not just unchanged bytes. A stored-unsafe replay-policy mutant produces SDK `interrupted`; the same success assertion is proved to throw on that mutant. The edit is not reapplied. Source repo's file remains unchanged. |
| Conflicting edit recovery | **PASS** | After kill, fixture bytes are changed to a third value. Recovery produces the explicit conflict error and leaves conflicting bytes untouched rather than overwriting or claiming success. |
| Real interrupted offline test / live worker | **PASS** | Real cloned Node test starts and remains alive after harness kill. Replay observes the existing supervisor via socket, requests stop, waits for test exit, records `observedLiveWorker` in committed tool details, then reruns successfully. Unknown outcomes are not declared safe. |
| Unsafe success before result receipt | **PASS** | Grant consumption and intent task association commit atomically; dispatch details commit; effect file is appended; process dies before result receipt. SDK emits `interrupted`, retaining dispatch details, without reexecuting the effect. Count remains one. |
| After grant consumption, before dispatch | **PASS** | Kill after atomic consumption/intent commit, before external effect. Reopen sees consumed grant and matching intent, classifies unsafe tool interrupted, and effect count stays zero. It does not infer from absence of effect that authority may be reused. |
| Model attempts same unsafe effect again | **PASS** | Scripted later tool invocation fails consumed-grant validation. Counts remain one for success-before-receipt and zero for consumption-before-dispatch. |
| Approval data and atomicity | **PASS** | Synthetic mission/target/digest/artifact/argument/expiry/revocation/denial/uses document round-trips through SIGKILL; consumption and intent association survive atomically. |
| Expired / revoked / denied grants across restart | **PASS** | Each state is durably written, process killed, reopened state checked, and protected tool attempted. All reject without an effect or consuming the grant. |
| Approval mission/target/action binding | **PASS** | Dispatch validates the fixed expected mission, target and SHA-256 action identity before consuming the grant. Three independently persisted mismatches survive kill/reopen and reject without effect or consumption. These are fixture-only scope bindings, not authenticated owner authorization. |
| Approved argument mismatch | **PASS** | Persisted approved argument SHA-256 differs from actual tool arguments after restart. Dispatch rejects with no effect and no consumption. |
| Approved artifact mismatch | **PASS** | Approved artifact SHA-256 persists, file bytes are changed after crash, and dispatch-time hashing rejects those bytes without effect/consumption. |
| Frozen supported profile preflight | **PASS** | Durable profile contains tool implementation source hash and clone revision; preflight checks those, stored extension selection and installed exact tool names before any submission/resume. Unknown persisted selection and missing installed extension both reject on fresh reopen with scheduler still paused. |
| Committed events and entry identities | **PASS** | For observed `message_end`, storage lookup equals the emitted committed entry. Final IDs are unique. Event snapshot begins before processing later batches. |
| Skill loader reuse | **PASS** | Existing public `loadSkillsFromDir` discovers the temporary SKILL.md without diagnostics; formatter metadata becomes a committed Durable system section. |
| Necessary read-only Cogitator MCP integration | **PASS** | Actual Cogitator stdio server and `cogitator_list_skills` implementation run against an explicit ephemeral HTTP backend fixture. Successful committed output must be non-error and exactly equal the expected content. A second wrong-content call reproduces an error diagnostic containing the expected UUID and is rejected by the same assertion. Exactly two GETs and the isolated startup URL are checked. MCP and HTTP services close afterward. Skill discovery is explicitly required by the shipped profiles inventoried below. |
| Failure cleanup / no false absent-effect evidence | **PASS** | Induced harness timeout waits for child close, live supervisor is stopped through its private socket and awaited before scope removal. ENOENT-only optional reads reject EISDIR; other I/O failures cannot become zero-effect PASS. |
| SQLite durability configuration | **PASS** | Every open observes adapter default `synchronous=1` (NORMAL), uses public `openNodeSqliteDatabase` to set FULL, verifies `2`, and passes that connection to public `SqliteStorage.open`. Crash tests use this composition. FULL is connection-local and reapplied on reopen. |
| Schema/document/task versions | **PASS** | Schema 1 opens; isolated future schema 2 rejects. Version-2 document rejects a version-1 token. Version-2 task with only a version-1 definition remains blocked `task_too_old` without dispatch. |

## Explicit compatibility matrix

| Profile / feature | Status |
| --- | --- |
| `fixture-v1`: fixed faux provider, one-file reconciled edit, bounded trusted Node offline test, guarded fake effect, frozen host profile | **SUPPORTED / local P0 proven**, only at the operations and failure boundaries above. Genuine clone/revision and real test lifecycle are included. |
| `fixture-compat-v1`: existing skill metadata loader/formatter plus actual Cogitator `cogitator_list_skills` over stdio | **SUPPORTED / local P0 bridge proven**. Not automatic compatibility for arbitrary MCP servers or skills. |
| General arbitrary coding/toolchain profile | **NOT SUPPORTED by this fixture**. No declaration that arbitrary `bash`, project tests, detached descendants or networked builds are replay-safe. A production profile must constrain those capabilities through P2/P3. |
| Existing classic presets / Pi extensions | **NOT IMPORTED into Durable**. Classic local runtime remains unchanged; unsupported remote presets must fail closed. |
| Existing MCP configurations other than the tested skill-listing route | **NOT SUPPORTED by this spike**. Need connector-specific scopes, schemas, effect classification, lifecycle and isolation checks. |
| herdr | **UNSUPPORTED**. No adapter or parity claim; Durable child ownership is not herdr compatibility. |
| SDK missing-extension default | SDK silently omits missing tools; reproduced as a negative check. The fixture's own preflight rejects missing/unknown extension selections before scheduling. This is an adapter responsibility, not an impossible SDK integration. |

## Required shipped-profile inventory (source only)

Inspected `src/default-agent.ts`, `src/mcp-server.ts`, and its URL configuration in `src/config.ts`; no private user configuration was read. All three shipped presets attach the bundled Cogitator stdio server when its built `dist/src/mcp-server.js` exists. They select provider/model from Pi defaults (fallback `openai/gpt-5.4`), and declare `skills: []`; this spike does not resolve user settings or infer additional permissions from an empty skill list.

| Built-in profile | Actual declared dependencies | Supported evidence vs blocked capability |
| --- | --- | --- |
| **Majordome** | Cogitator agent CRUD/validation/default selection; schedule CRUD/manual fire/run history; workspace CRUD; conversation creation/listing; provider and skill listing. Setup additionally reads repo/Git state, writes conventions/hooks, creates board cards, and references optional rules-manager/guardrail skills. | **Skill-discovery MCP seam supported** by actual `cogitator_list_skills` in this spike; bounded clone read/edit and fixture test primitives separately supported. **Full Majordome Durable preset blocked**: administrative mutations, cron execution, provisioning/import paths, actual providers, hooks and unrestricted filesystem capabilities have no remote policy/isolation adapter. Prompt confirmation is not authorization. |
| **Chef de Projet** | Board list/create/update/move/comment/start-work, assignment and conversation links; `gh` as an alternative; check-first `cogitator_list_agents` and `cogitator_list_skills`, agent create/update/validate and skill import. Explicit method files `to-tickets`, `use-delegate`, `use-goal`, `loop-me` under `~/.agents/skills`; delegation/model choices. | **Necessary check-first skill-discovery MCP seam supported**. **Full Chef Durable preset blocked**: GitHub/board writes and job spawning, scoped credentials, agent/preset mutation, imports and those host skill resources have not been adapted/authorized. No private method files or GitHub endpoints were accessed. |
| **Architecte de Skills** | Read/write `~/.agents/skills/<name>/SKILL.md` and references/scripts, Agent Skills frontmatter validation, and **`cogitator_list_skills` to verify discovery** (or file reread). | **Necessary actual validation/listing MCP seam plus loader metadata supported** using synthetic skill data. **Full Architecte Durable preset blocked**: writes to the owner's global skill directory and arbitrary generated scripts are deliberately unavailable; no remote publication/approval path was implemented. |
| **herdr / generated subagent definitions** | Actual MCP tool descriptions identify herdr definitions created/deleted by preset mutations; no source in this spike supplies an equivalent Durable adapter. | **Unsupported**. No identity, lifecycle, ownership, delegation or format-parity claim. |

The read-only MCP route is therefore a necessary common integration, not renamed echo. The explicit fixture profile offers only that one Durable bridge tool even though the real MCP server advertises administrative methods; those methods are not exposed to the faux model and the HTTP fixture denies other routes/methods. This is a test boundary, **not proof of a production capability firewall**. Full shipped presets remain blocked for Durable remote import until their individually listed dependencies pass later gates; they continue unchanged in classic local mode. Passing the local P0 seam does not mean any shipped preset may silently drop its blocked dependencies and claim compatibility.

## What this does not certify

The previously missing local proof gates are now checks, not external blockers. Passing this scoped P0 allows work to proceed to later gates; it does not quietly lower their requirements:

- Synthetic approval records are intentionally fixture-created; no authenticated owner decision API, human approval UI, canonical production action format, restoration epoch or real external authorization is implemented here. Fixture mission/target/action/argument/artifact validation is real, but it covers a single fixed operation, not arbitrary connectors or concurrent owner decisions.
- SDK interrupted tools return errors to the model and an enclosing input may still settle `done`. That is not proof of mission success. The future authoritative mission projection must preserve `needs_attention`/`action_denied` and known-versus-unknown outcomes independently of model prose. A local fixture error proves the seam, not those P3 API/UI semantics.
- Runtime code is trusted. Private sockets, file receipts, NodeExecutionEnv, profile hashes and narrow tools are not adversarial worker isolation or TOCTOU protection. An artifact is hashed at this fixed fixture dispatch; arbitrary mutable artifacts still need an immutable publication mechanism. Rootless containers, egress, quotas, secret boundaries and malicious fixtures belong to P2.
- The SDK has no cross-process lease. Each test uses one harness at a time. Acquire and prove an OS-enforced lease before production scheduling; no concurrent-harness support is inferred from SQLite locking.
- Running the spike makes no real-provider request, external mutation, deployment, access to real owner data/credentials, cloud charge, Cogitator commit or push. Its mutations affect only ephemeral synthetic Git objects, clone files and fixture processes. Source commits made by the surrounding implementation workflow are separate from executing the spike.
- Event/RPC protocol parity, UI overflow/reconnect behavior, two-slot admission, budget semantics, arbitrary worker adoption, unknown worker outcomes across host loss, full disk/corrupt storage, schema migration/rollback, minimum-version Node testing and other platforms remain unproved here. They are not prerequisites to truthfully marking the demonstrated P0 primitives PASS.
- FULL configuration and process SIGKILL do not prove power-loss survival, filesystem guarantees or backup correctness. VPS capacity, real OIDC/MFA, reboot, off-host restore, revocation and controlled soak still require P1–P5 evidence. No public enablement is authorized by this report.
