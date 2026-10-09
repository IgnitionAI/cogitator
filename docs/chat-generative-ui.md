# Rich chat and generative UI

## Validated scope

Main conversations and workspace chat use the same rendering. The owner confirmed both aspects: automatic enrichment of messages/tools and interactive components offered by agents. The dark, dense, French-language identity remains unchanged.

Goals: comfortable reading, accessible technical details, compact input, and interactive responses retained in history. Local use, with no external service. No arbitrary HTML, JavaScript, or styles from the model are executed. A submission sends a message to the agent; it never authorizes a command or destructive operation.

## Decisions

| Choice | Rejected alternatives | Reason |
| --- | --- | --- |
| Finite React catalog, JSON validated with the already-installed Zod | External generative SDK; execution of generated JSX/HTML | Provider independence, bounded security surface, local maintenance |
| `cogitator-ui` blocks in assistant text | New SSE transport and a second history database | Reuse streaming and pi JSONL files, the existing source of truth |
| Responses in `cogitator-response` user messages | Exclusively local state or a transcript in SQLite | Replay submissions after reloading, comply with I5 |
| Copy of the rendering contract in new conversation snapshots | Retroactive changes to presets/sessions | Respect snapshot O6; at runtime, the spawner supplements older sessions that lack a contract without changing their frozen data |
| CSS styles and native components | New component or animation library | Reuse existing tokens, focus behavior, controls, and conventions |

## Automatic format selection

The agent chooses a useful format on its own, with no dedicated button: text by default, a form/choices for structured information, a checklist for multiple selections, or a table for comparison. It must accept free-text responses and must not force a component. Only presentation is automatic; submission always requires an explicit action.

The spawner shared by conversations and scheduled tasks passes this policy in the system context on every start/resume. It retains the frozen contract when one exists and supplies the v1 contract to older sessions that lack one. No artificial user message, preliminary model call, or preset change is needed. After a server update, processes are lazily recreated on the next send using the same session file.

## Contract v1

A fenced `cogitator-ui` block contains a strict object: `version: 1`, an `id` unique to the step, `kind`, `title`, and an optional `description`.

- `form`: `fields` (id, label, type text/textarea/number/select, optional required; options for select), optional `submitLabel`.
- `choices`: `options` (id, label, optional description), optional `submitLabel`. One selection.
- `checklist`: `items` (id, label, optional description), optional `submitLabel`. Multiple selections, including none when appropriate.
- `table`: `columns` (id, label), `rows` (scalar values per column). Local filtering and sorting; no writes.

Limits on size and the number of fields, options, and rows are validated at input. Only assistant messages can trigger this rendering. An incomplete block during streaming shows a non-interactive preparation state. A block still incomplete after interruption or reloading switches to an error state with a request for correction. An invalid block keeps its source text accessible and offers a way to request correction. Ordinary code blocks are never interpreted as an interface.

A response contains `version: 1`, `request` (the exact validated specification), and `values` (values validated against that specification). This complete reference avoids fragile correlation by timeline position or a reused ID. It is bounded by the schema limits. A human-readable label accompanies the JSON block; in chat, it appears as a summary. The server receives a normal user message. No new permission, command, action URL, or secret to enter in a generated interface.

Controls are disabled while sending and while the agent is working. A reconnection rereads the pi process's `isStreaming` state through the pool and JSONL history; a running process is not necessarily producing a response. Local message keys remain stable when replay inserts reasoning, so forms are not reset. Failures remain inline, preserve values, and allow retries. After success, the summary is read-only. Text entered in the composer is not replaced by a form response. Responses are considered present only when they appear in user messages, never in a tool result or assistant message.

## Visual composition

- Compact header: title, provider/model, understandable status, access to files and secondary actions.
- Centered reading column, responses on the chat background, user messages on a subtle surface. No card around every paragraph.
- Secondary metadata and activity; reasoning and raw arguments remain collapsible.
- Code with language and copy controls; explicitly scrollable tables; tools with textual status, a summary, and an appropriate result format (text, JSON, diff).
- Generative UI as a response section: title and context, native controls, validation, submission action, and summary.
- Two-level composer: text, then attachments/skills and send. Shortcuts outside the placeholder. Return to the latest message when the reader scrolls back through the thread.
- Animations reserved for feedback; no repeated entrance animation on reloaded history. Reduced motion respected.

## Verification and limitations

`npm run build` and all 92 tests pass. `scripts/ui-generative.mjs` checks all four components, rejection of arbitrary HTML, interrupted outputs, failure followed by retry, focus, reloading, missed events, and preservation of a form during history insertion. Chrome was tested at 1440, 768, 390, and 320 px, as well as 720 × 450 px (a CSS viewport equivalent to 200% zoom on 1440 × 900). All API requests in these scenarios are intercepted. Consolidated report: `docs/chat-ui-review.md`.

Explicit limits: a maximum of 64 KiB for interface JSON, 128 KiB for the response JSON envelope, 20 fields/columns, 50 choices, and 200 rows. Replay retains the existing window of 300 entries from the last 2000 JSONL lines; it does not load an arbitrarily old transcript. Historical tool results remain subject to the existing server limit of 4000 characters, indicated by “tronqué” (truncated). Diffs show the requested change, not proof of a write. Unsubmitted values survive failures and the tested reconciliations, but not a page reload. Submitted responses, however, are persisted by pi.

Text reconciliation remains a chronological match within this bounded window: it does not replace authoritative message identifiers. The scripts cover the missed-event scenarios described in the report, not every possible ambiguity involving identical text messages. No testing with a real model provider, VoiceOver, or a physical mobile device was performed in this pass.

Generation depends on the agent: a documented instruction does not guarantee model compliance. Raw text and validation errors remain accessible. Older session snapshots and transcripts are not rewritten; only the presentation capability in the system context is supplemented on resume. No transcript migration, arbitrary dashboards, or artifact execution.
