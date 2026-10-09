# Consolidated review — rich chat and generative UI

## Scope and coverage

Main conversations and the “Chef de projet” (project manager) workspace chat. React 19, TypeScript, native CSS, and existing tokens; dark theme, Inter, indigo accent. References: `PRODUCT.md`, `DESIGN.md`, `docs/context/decisions/ARCHITECTURE_CONTRACT.md`, `docs/chat-generative-ui.md`, and the six guides in the `better` skill.

The review covers rendering actually observed in Chrome, supplemented by source inspection and tests. API calls in browser flows are intercepted: these scenarios created no real conversations, commands, or user data. Historical reading and message identification limits are explicitly described in the contract document.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Native controls/labels/fieldset in `web/src/GenerativeUI.tsx:43`, error/success focus at `:75`, composer tab order, scrollable tables, single workspace heading, reduced motion | Clear after corrections; real screen reader not tested |
| Layout | Screenshots at 1440/768/390/320 px, embedded chat, 720 × 450 viewport; overflow and composer visibility measurements; `web/src/chat.css:12`, `:68`, `:167` | Clear after corrections |
| Writing | French status text, recoverable errors, warning about secrets, distinction between submission and execution, tool labels and invalid interface; `web/src/GenerativeUI.tsx:66`, `src/generative-ui.ts:67` | Clear |
| Typography | Hierarchy inspected in screenshots, 760 px reading column, 75ch prose, monospace code, 16 px mobile input; `web/src/chat.css:16`, `:32`, `web/src/markdown.tsx:106` | Clear |
| Colors | Contrast measured on actually loaded tokens; native radio selection + border, text + icon states; `web/src/chat.css:94`, `web/src/ToolResult.tsx:54` | Clear |
| UI | Form/choices/checklist/table, code copying, tools, loading/error/retry/summary, invalid source, history, SSE interruptions; scripts and tests below | Clear for the controlled scenarios |

## Corrected findings

All findings below were **resolved** in this pass. They document the observed causes and their corrections, not remaining work.

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | UI | `web/src/screens/Conversations.tsx:132`, `:339`, `:386` | An interruption could leave a partial result, a disabled form, or a missing JSON closing fence; initial hydration could duplicate a response when inserting reasoning | Chronological replay, tools matched by ID, actual `isStreaming` state, repair of tested gaps, and stable local keys | Reconnection must restore a usable state and preserve existing input |
| MEDIUM | UI | `web/src/GenerativeUI.tsx:122` | An unclosed block remained in preparation after interruption/reloading | Preparation only during streaming; otherwise, a readable error, source, and correction request | A waiting state must provide a way out on failure |
| MEDIUM | Accessibility | `web/src/GenerativeUI.tsx:75`, `web/src/screens/Conversations.tsx:614` | Replacing the form could lose focus; composer DOM order differed from visual order | Explicit focus on error/summary; input, then tools, then send | Keyboard users must retain a predictable point from which to continue |
| MEDIUM | Layout | `web/src/chat.css:13`, `:68` | Tools could be compressed into an empty line; the return-to-latest-messages button overlapped an action | Non-shrinking thread children; button in normal flow, outside the scrolling area | Technical content and actions must remain visible and reachable |
| MEDIUM | Layout | `web/src/chat.css:2`, `:167` | A short viewport left too little room for the thread; workspace scrolling could move the page behind the top bar | Compact chrome at low heights, bounded internal scrolling, minimum height for embedded chat | Reflow must preserve a readable thread, title, and composer without overlap |
| LOW | Typography | `web/src/markdown.tsx:106`, `web/src/chat.css:32` | A response starting with `##` jumped directly to a small heading level; prose was too wide | First heading rendered at section level and prose limited to 75ch | Hierarchy and line length make long responses easier to read |

No actionable interface findings remain within the controlled scope.

## Verification

### Passed

- `npm run build`: web/server typechecks, Vite bundle, and server compilation.
- `npm test`: **92 tests, 92 passed**. Strict schemas, limits, inert content, correlated responses, frozen snapshots, JSONL reading, tools, text recovery, and no duplication in the added cases.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-generative.mjs`:
  - dedicated button removed from the composer; automatic capability verified in the spawner for new and old sessions, with no snapshot rewrite or synthetic message;
  - four components at 1440, 768, 390, and 320 px; no page overflow; tools not collapsed; composer visible;
  - 503 failure, values preserved, retry, focus on the error and then the summary; composer draft intact;
  - forms, choices, and checklists replayed after reloading; table filtering and sorting without sending;
  - partial UI non-interactive, activation after generation ends, user content never interpreted as an interface, arbitrary HTML rejected;
  - reconnection with a missed closing fence, tool result, and `agent_end`; user response from another client recovered; input preserved despite reasoning insertion;
  - embedded chat at 1440/390/320 px and 720 × 450 px; a single page h1; title not hidden by the app bar;
  - no JavaScript errors; four simulated submission requests, none sent to the real backend.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-stream-recovery.mjs`: recovery after initial history failure, snapshot shorter or longer than the stream; no duplicate, and the next delta appears in the correct bubble.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-polish.mjs`: six pages, seven workspace tabs, drawer, dialogs, empty/error states, and keyboard; no JavaScript errors.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-regression.mjs`: long mobile thread, input, send failure, unavailable history, workspace navigation, and embedded chat.
- Measured contrast ratios: secondary text/surface **5.86:1**, metadata/surface **5.13:1**, white/accent **4.70:1**, control border/background **3.08:1**.
- Screenshots inspected in `/tmp/cogitator-generative/`, including `conversation-1440.png`, `choices-390.png`, `form-1440.png`, `form-error-320.png`, `table-320.png`, `workspace-320.png`, `tool-error.png`, `zoom-200.png`, `workspace-zoom-200.png`.

### Not verified

- Generation by a real model and the suitability of the components it would choose: browser fixtures and fake pi clients only.
- VoiceOver/NVDA, Safari/Firefox, and a physical mobile device/virtual keyboard.
- Native browser zoom: the test uses a 720 × 450 CSS viewport, equivalent to 200% reflow on a 1440 × 900 screen.
- All message-matching ambiguities without authoritative identifiers, transcripts exceeding the history window, and arbitrary model outputs.

## Verdict

**Approve** — for the declared coverage and reproducible scenarios above. No remaining HIGH findings. This verdict certifies neither real model behavior nor untested environments.
