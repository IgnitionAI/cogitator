# Live configuration acceptance harness (plan 0005 / #21)

Implementation harness, **not a final verification report**. All new files are `scripts/live-configuration-*`; no product/test files are modified.

## Run after review

```sh
# Fast infrastructure smoke: actual official pi subprocess + local streaming HTTP fixture.
node scripts/live-configuration-run.mjs --rpc-smoke

# Build the UI separately first (the app serves web/dist), then run acceptance + keep isolated app alive.
npm run build:web
node scripts/live-configuration-run.mjs --serve

# In another shell, using the disposable directory printed above:
node scripts/live-configuration-browser.mjs /absolute/path/to/cogitator-live-configuration-XXXXXX
# Ctrl-C the --serve process afterwards.
```

Omit `--serve` for API/RPC acceptance alone. Every invocation creates a new directory and random loopback ports. The launcher whitelists its child environment, uses disposable HOME, pi config, sessions, SQLite DB, workspace and Chrome profile, disables extensions/tools/context discovery, and sets pi offline. Both fixture providers have two reasoning-capable models. Dummy API keys only; no remote model endpoint, credential inheritance or existing controller/store access. Do not run the TS entry directly. Evidence is deliberately retained for inspection; remove the printed temporary directory yourself when done.

## Evidence and checks

- `trace.jsonl`: ordered HTTP requests/results, official RPC calls/readbacks/events and actual outbound model HTTP bodies including `reasoning_effort`. The fixture explicitly holds an open stream until configuration and next prompt acceptance; tests assert no early setter/dispatch and `agent_settled` before setters. A passive wrapper records methods but does not replace their implementations.
- `evidence.json`: fixture/app URLs, object IDs, outcome, limitations. Success is labeled as harness checks, never full plan completion.
- `browser-evidence.json`: API response bodies, Chrome DevTools EventSource messages, browser checks, screenshots. Browser changes go through native editor controls and keyboard Apply, not API substitutions. API is used to start the controlled stream and independently read results.
- At most three screenshots: standalone pending/composer, group member editors, French mobile preset defaults. **Display and inspect all three in the final report**; files alone are not visual verification.

Implemented: never-started switch, idle switch, stream pending/next-prompt ordering, competing-request rejection, eviction/resume and whole-controller recreation preserving session/effective tuple/history, DB/snapshot agreement, actual provider/model/reasoning calls, conversation/preset/sibling isolation, future conversation defaults, unrelated preset field preservation, invalid model/reasoning rejection, ad-hoc preset-scope rejection, Durable zero RPC/row mutation, independent group edit, pending restart recovery as an authorization-renewal failure with no implicit replay and an explicit fresh local-owner retry. Browser covers EN/FR, keyboard Apply, pending/error state, effective SSE update, composer preservation, reload/history, actual offline/online SSE reconnect with missed-state recovery, host/non-host independence, embedded workspace Project manager ChatView, explicit live-editor preset scope with sibling isolation and future defaults, Durable control absence, and mobile preset reasoning.

## Deliberate coverage boundaries

Not an A1–A6 blanket proof. Fault-injected setter/readback/persistence/rollback/quarantine, authorization revocation, retries/compaction and stop/delete queue feedback belong to dedicated regression coverage. The fixture does not manufacture `agent_end`/`agent_settled` or substitute a fake PiClient. Controller restart closes and recreates the HTTP app, SQLite connection and pool on the same paths. For pending recovery it stops the real RpcClients and abandons the old in-memory pool rather than invoking graceful cancellation (`pool.dispose`), so the persisted accepted request is recovered by the new app; this is lifecycle recreation, not an OS-level controller kill. The browser disconnect hook closes real controller sockets while Chrome is offline (offline emulation alone can leave an existing EventSource socket alive). No Durable mission is started. Full `npm test`, typecheck, build, Standards/Spec reviews and screenshot inspection remain final-stage gates owned by the parent.

The browser script centralizes accessible field labels (EN/FR) and uses `.live-configuration` / `.preset-configuration` containers. Adapt those selectors if frontend review changes the markup. Chrome uses the existing browser-tools `puppeteer-core` installation; set `CHROME_PATH` if needed. No new dependency.

## Implementation smoke evidence

Implementation-only smoke commands (no full suite, no final verification claim):

```sh
node scripts/live-configuration-run.mjs
node scripts/live-configuration-run.mjs --serve
node scripts/live-configuration-browser.mjs <printed-disposable-directory>
```

The expanded API/RPC checks and complete browser script ran to completion against the integrated code. Latest implementation smoke evidence: `/var/folders/ms/l8tr27yx5gnczd_3gsqrrd500000gn/T/cogitator-live-configuration-WaScoN` (use the run output for subsequent evidence paths). Screenshots were captured, not visually approved here; parent review and final gates remain outstanding.
