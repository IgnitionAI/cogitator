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

Implemented: never-started switch, idle switch, stream pending/next-prompt ordering, competing-request rejection, eviction/resume preserving session/history, DB/snapshot agreement, actual provider/model/reasoning calls, conversation/preset/sibling isolation, future conversation defaults, unrelated preset field preservation, invalid model/reasoning rejection, ad-hoc preset-scope rejection, Durable zero RPC/row mutation, independent group edit. Browser covers EN/FR, keyboard Apply, pending/error state, effective SSE update, composer preservation, reload/history, non-host independence, mobile preset reasoning.

## Deliberate coverage boundaries

Not an A1–A6 blanket proof. Controller crash with pending recovery, fault-injected setter/readback/persistence/rollback/quarantine, authorization revocation, retries/compaction and stop/delete queue feedback belong to dedicated regression coverage. The fixture does not manufacture `agent_end`/`agent_settled` or substitute a fake PiClient. Resume currently exercises real process eviction, not whole-controller restart. Browser does not yet cover embedded chat, explicit network disconnect/reconnect, or Durable control hiding. Full `npm test`, typecheck, build, Standards/Spec reviews and screenshot inspection remain final-stage gates owned by the parent.

The browser script centralizes accessible field labels (EN/FR) and uses `.live-configuration` / `.preset-configuration` containers. Adapt those selectors if frontend review changes the markup. Chrome uses the existing browser-tools `puppeteer-core` installation; set `CHROME_PATH` if needed. No new dependency.

## Implementation smoke evidence

An infrastructure smoke was run during implementation: real official RpcClient, two local fixture calls, low/high outbound reasoning, and persisted-session resume completed. The full app harness currently stops on the old never-started model endpoint (`500 session non démarrée (pool)`); this is expected until the backend implementation is integrated. No browser/full acceptance pass is claimed.
