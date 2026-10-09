# UI acceptance testing with a real backend

## Verdict: PASS

The four flows were executed in Chrome with the production UI served by the backend at `127.0.0.1:5320`, real pi processes, and the authenticated `kimi-coding/kimi-for-coding` provider. No API, SSE response, or model execution was simulated.

Initial setup used Vite. That service was stopped during acceptance testing; the flows were then resumed on the production UI to avoid the unstable proxy. No cosmetic fixes were added.

## Observed results

| Criterion | Result | Authoritative evidence |
| --- | --- | --- |
| Create an agent | PASS | Created through the UI editor, reread through the API, and validated by the server without errors |
| Open a conversation, send, and interrupt | PASS | Created and sent through the UI; 43 real `text_delta` events; Stop accepted; `agent_end` observed; response persisted in the pi session file |
| Create a card, assign, save, and launch | PASS | GitHub issue [#5](https://github.com/IgnitionAI/cogitator/issues/5), launch disabled before saving and enabled afterward; assignment reread; conversation linked to the card; `in_progress` status |
| Comments refreshed | PASS | Comment sent through the UI and then displayed in the detail view without closing/reopening the card; also recorded on GitHub |
| Files and activity refreshed | PASS | The real agent wrote `acceptance-result.txt` with `COGITATOR_REAL_ACCEPTANCE_OK`; file reread on disk and in the UI file tree; conversation files and workspace/card activity present in the APIs and UI |
| Two cron runs with resume | PASS | Task created and run twice through the UI; statuses `ok` / `ok`; same non-null `session_file`; two `CRON_REAL_OK` assistant responses in that same `.jsonl` |
| Cleanup | PASS | Agent, workspace, two conversations, and test task absent after rereading the API; GitHub issue #5 confirmed `CLOSED` |

Automatic scheduling of the acceptance task was disabled. No existing agent or workspace was modified. Board writes use the normal GitHub implementation, including its mechanism for ensuring system labels exist.

The acceptance issue is **closed, not deleted**. The temporary directory and pi session files remain available as evidence; they are not part of the commit.

## Local evidence

Directory: `/tmp/cogitator-real-acceptance-3KxLHE/`

- `state.json`: acceptance IDs, assertions, and session paths.
- `agent-created.png`
- `conversation-stopped-mobile.png`
- `board-comment.png`
- `workspace-activity.png`
- `workspace-file.png`
- `cron-two-runs.png`
- `workspace/acceptance-result.txt`

These temporary files are neither permanent fixtures nor credentials to check into version control.

## Explicit replay

The script refuses to run without opt-in: it consumes model calls and creates a GitHub issue on the current repository's `origin` remote. It requires the real backend to be running, an available frontend build, Chrome, and Puppeteer from the browser-tools skill. `CHROME_PATH` overrides the default macOS Chrome path.

```bash
export COGITATOR_REAL_TEST=1
export BROWSER_TOOLS_DIR=/path/to/browser-tools
node scripts/ui-real-acceptance.mjs setup
# Copy the displayed "output" directory:
export ACCEPTANCE_DIR=/tmp/cogitator-real-acceptance-XXXXXX
node scripts/ui-real-acceptance.mjs conversation
node scripts/ui-real-acceptance.mjs board
node scripts/ui-real-acceptance.mjs cron
node scripts/ui-real-acceptance.mjs cleanup
```

The `REAL_PROVIDER`, `REAL_MODEL`, `COGITATOR_API_URL`, and `COGITATOR_UI_URL` parameters allow explicit service selection. By default, the UI is served by the backend, with no Vite dependency. Do not rerun a creation phase that has already succeeded: continue with the next phase or clean up its identified resources.

## Git isolation

The repository was clean at the start. The previous UI pass had already been committed in `918932b`, then included in release `52b3252`. Another commit (`b5cf258`) arrived during acceptance testing; it was neither modified nor rewritten.

Final checks: `npm run build` passed, `npm test` **69/69**, script syntax check and `git diff --check` passed.

This pass versions only the real acceptance script and this report. No database state, Board sidecar, session file, screenshot, secret, or unrelated change is included.

This validation covers the requested flows with a real provider. It does not claim to certify all providers, devices, or screen readers.
