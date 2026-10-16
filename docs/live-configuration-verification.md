# Live configuration verification — #21

Date: 2026-10-16. **PASS**, bounded to classic conversations and preset defaults in Plan 0005. Verified implementation: `857f82be6b202598d9aa55c414370b909915e2a1` (baseline `3d111e5b4cd5c8394d56d734e6858daac37945d2`). Durable missions remain immutable and excluded.

## Acceptance evidence

| Criterion | Result | Current evidence |
| --- | --- | --- |
| A1: effective tuple and resume | PASS | Actual official pi RPC subprocesses changed provider/model/thinking; recorded outbound model requests were `fixture-b/model-two:high` and `fixture-a/model-one:low`. DB columns and spawn snapshot agreed. Eviction and controller/app/pool/DB recreation retained session identity and history. |
| A2: response boundary and ordering | PASS | A held real HTTP response produced 202 pending; competing request returned 409; no setter or next prompt ran early. Trace ordering placed `agent_settled` before setters and the subsequent model request used the new tuple. Regression tests additionally cover `agent_end` not being settlement and settlement before RPC acknowledgement. |
| A3: scopes and groups | PASS | API and browser checks confirm conversation-only leaves preset/siblings unchanged, preset scope preserves unrelated fields and affects future chats, ad-hoc preset scope rejects, and host/non-host edits leave the other member unchanged. Workspace-embedded ChatView was exercised. |
| A4: failures, authorization and Durable isolation | PASS | Injected regression tests exercise unsupported model/reasoning, incorrect readback, DB failure, verified rollback, failed rollback quarantine, authorization loss before/after setters, and authorized queued dispatch. Real RPC harness confirms invalid choices cannot change committed state; pending restart fails visibly without replay and requires explicit authorized retry. Durable rejection has zero RPC calls or row mutations. |
| A5: user surfaces | PASS | Chrome exercised native selects and keyboard Apply, pending and error feedback, EN/FR, standalone and embedded chats, both group members, live preset scope, preset reasoning, offline/online SSE reconnection, history and composer preservation, Durable editor absence, and 390px layout without horizontal overflow. Three current screenshots inspected. Focused UI regressions cover stale GET versus SSE, Stop routing and text/attachment-only queue recovery. |
| A6: regression/build and independent review | PASS | `npm test`: **246 tests, 246 passed, 0 failed**. `npm run build`: exit 0 (includes server/web typecheck, Vite and server compilation). Independent Standards and Spec re-reviews passed after fixes. |

## Reproducible commands

```sh
npm test
npm run build
node scripts/live-configuration-run.mjs --serve
node scripts/live-configuration-browser.mjs <disposable-directory-printed-by-runner>
```

Final run's disposable directory:
`/var/folders/ms/l8tr27yx5gnczd_3gsqrrd500000gn/T/.ctx-mode-GFkcJ0/cogitator-live-configuration-96eJzP`

A convenience copy of the evidence is retained at `/tmp/cogitator-21-verification/`:

- `evidence.json`: real RPC/API checks, object IDs and restart checks.
- `trace.jsonl`: 176 recorded RPC commands and responses, 128 RPC events, 9 outbound model requests and 2 controller recreations at capture time.
- `browser-evidence.json`: 132 captured API responses, 48 SSE messages, 8 browser-check groups.
- `cogitator-21-final-tests.log`, `cogitator-21-final-build.log`, `cogitator-21-final-runtime.log`.
- `live-configuration-standalone-pending.png`.
- `live-configuration-group-member.png` (scrolled to the non-host editor).
- `live-configuration-mobile-preset-fr.png`.

These are local temporary artifacts, not published/deployed evidence. Harness JSON deliberately labels its own checks narrowly; this report combines them with the final suite, reviews and visual inspection.

## Standards review

Final verdict: **PASS, no remaining findings**. Review-driven fixes prevent configuration events redirecting group Stop, expose cleared/failed queued messages with explicit draft restoration, and show reattachment guidance for image-only failures. The native-fetch acceptance harness uses boolean `Response.ok` correctly. No remaining material baseline-smell finding.

## Spec review

Final verdict: **PASS, no remaining findings**. Review-driven fixes evict member handles before group deletion, prevent stale reconnect GETs overwriting newer SSE configuration, and retain visible queue failure/cancellation feedback. Durable exclusion and explicit restart retry match the agreed scope.

## Proof boundaries and cleanup

- Real official pi processes and HTTP/SSE/browser surfaces were exercised; the model endpoint was a deterministic local fixture, not a paid external provider. Provider-specific remote availability and every model's reasoning implementation are not certified.
- Setter/readback/persistence failure and authorization-revocation cases are injected regression evidence, not claims about an authenticated deployed VPS.
- Controller restart recreates controller/app, DB connection and pool with the same files. Pending-crash simulation abandons in-memory state after stopping clients; it is not an OS SIGKILL durability certification.
- Classic queued prompts remain non-durable. A pending configuration interrupted by controller restart remains visible as failed and requires a fresh authorized retry. Attachment-only failures instruct reattachment rather than pretending the attachment is recoverable from text.
- The isolated server was stopped after verification; its listener was confirmed closed. No user provider credentials, production store or workspace was used. No deployment, npm publication or git push was performed.
- Existing dirty `cogitator.board.json` and `.bak` hashes are unchanged. The repository lacks `docs/agents/issue-tracker.md`; this run used its GitHub remote and agent-attributed issue reports. `/setup-matt-pocock-skills` can establish that optional tracker adapter separately.
