# Changelog

User-facing changes to Cogitator. GitHub development updates and npm releases are separate: an entry marked **Unreleased** is not yet available from npm.

## [0.6.0] - 2026-11-22

**Highlight:** a terminal on your server, in the browser, with an agent at your side.

### Added

- **Web terminal:** shells on the server and your Cogitator agents running in pi's interactive interface, in tabs, from your home folder or a workspace. Sessions survive a closed tab or a lost connection (recent output is replayed), up to 8 at once. On phones, a key bar provides Esc, Tab, Ctrl C and the arrow keys. See [Web terminal](https://github.com/IgnitionAI/cogitator/blob/dev/docs/terminal.md).
- **Terminal assistant:** type `# your request` to get a command written on the line, see live grey suggestions (accept with →), and get an explanation and fix for a failed command. It uses the model of the agent you choose. Commands are never run without you.

### Security

- The terminal is a full shell with the server account's rights. It is available only in protected mode to the signed-in owner, never to MCP tokens or OAuth connectors. Its WebSocket checks the exact origin and re-checks the owner session every second, and signing out cuts open terminals. Disable it with `COGITATOR_TERMINAL=0`.

### Requirements

- The pseudo-terminal uses the optional `@lydell/node-pty` dependency, with prebuilt binaries for Linux, macOS and Windows (no compilation).

## [0.5.2] - 2026-11-21

**Highlights:** drive Cogitator from Claude, ChatGPT or your own bots over MCP · manage pi extensions from the interface · read what subagents are doing · import GitHub projects from a link · simpler owner login for a VPS.

### Added

**Remote control and integrations**

- **Remote MCP (Streamable HTTP):** external agents (Claude Code, the Claude/OpenAI APIs, your own bots) can operate Cogitator through `/mcp` with a Bearer token. `cogitator mcp token create|list|revoke` manages the tokens, which are hashed, revocable at once and scoped `read` or `full`. New tools: read a conversation transcript, send a message and wait for the reply with progress notifications, and stop a turn. They are also available to the Majordome over stdio. See [Remote MCP](https://github.com/IgnitionAI/cogitator/blob/dev/docs/mcp-http.md).
- **ChatGPT / Claude.ai connectors (OAuth):** in protected mode, the web apps can add Cogitator as a custom connector. The app registers itself, then the owner signs in and chooses read-only or full access on a consent page. Connections use PKCE, short-lived access tokens and rotating refresh tokens, and can be revoked with the CLI.
- **Shared browsers:** persistent Chromium profiles, explicit agent access, live interactive view and human takeover. Classic pi conversations gain a browser tool. Runtime installation and site-specific login acceptance are documented.

**Agents and conversations**

- **Subagent conversations:** click a subagent to inspect its instructions, messages, tool calls and results in a read-only dialog. The journal refreshes automatically without interrupting the parent conversation or moving your reading position.
- **Extensions catalog:** browse pi packages, search and filter by type, install or uninstall packages, check for updates, update individual npm packages, and reload extensions from the web interface without interrupting active agents.
- **Reasoning levels:** model settings offer the reasoning levels each provider supports.

**Projects and skills**

- **Git repository import:** add a project from a repository link, with an automatic name and optional settings.
- **GitHub connection:** connect your account with a browser device code to import private repositories. Project imports, classic agents and the GitHub issue board share the installation's connection.
- **Project preparation:** check MCP connectivity and preview existing agents and skills before initialization. Conversations receive the resource inventory and load the bundled integration explicitly.
- **Local skill folders:** import from this computer (including to a VPS) or from a server path, preserving references and existing skills.

**Operations**

- **Machine indicators:** live host CPU/RAM summary and a detail panel with logical cores, data-disk usage, uptime and Cogitator process memory. Metrics require authentication and refresh every five seconds.
- **Cogitator updates:** a sidebar release check compares the running version with npm and explains pi/VPS update steps, without downgrading newer source deployments.
- **What's new:** release highlights in the sidebar footer, with a dot when there are notes you have not read.
- **Documentation:** illustrated onboarding, English/French working guides and a dedicated single-owner HTTPS VPS guide.

### Improved

- New protected installations use owner email/password login by default. Authenticator-based MFA remains optional. Existing MFA installations keep their authentication mode unless their owner changes it.
- Provider setup offers clearer API-key/account choices, searchable providers and a template for local model endpoints.
- Conversations explain missing provider configuration and let you connect the provider without leaving the chat.
- Extension changes reload idle conversations while preserving active agents and background subagents. Busy conversations can be reloaded after their work finishes.

### Fixed

- **Conversation status:** “Running” shows only while work is in progress, with the same orange indicator in the list and the conversation. Loaded idle sessions show “Ready”, and the counter follows actual work.
- Missing provider credentials no longer leave conversations in an endless reconnect loop.
- Provider availability refreshes immediately after setup. Availability means local configuration, not a successful model request.
- ChatGPT sign-in keeps a stable installation identity. Unfinished provider logins are cancelled during server shutdown.
- Opening the protected app from an external link reaches the login page correctly.
- Background subagents keep their parent process alive until they finish.
- Scheduled work and queued image messages keep their expected dispatch and recovery behavior. Long-running delivered work is no longer failed at the queue timeout.
- Team handoffs preserve their originating hop limit.
- Running `/cogitator` after updating the extension replaces an older local Cogitator server when its identity can be verified.
- Durable recovery preserves requests for attention and checks protected effects before execution.

### Updating and requirements

- **Update:** run `pi update --extensions`, then `/reload` and `/cogitator` in pi. A pinned package version must be changed to receive this release. Finish active work before restarting the server.
- **Remote MCP:** `/mcp` always requires a token. OAuth connectors need protected mode (`cogitator --auth-required`) behind a public HTTPS origin.
- **GitHub:** browser-based connection requires GitHub CLI (`gh`) on the server and your authorization on GitHub. Organizations may require additional approval or SSO authorization.
- **Subagents:** these features require `@gotgenes/pi-subagents` in the same pi profile as Cogitator. Reading a journal does not start a model request.
- **Remote Git imports:** these require a configured project directory inside the server's enrolled workspace roots. Updating the npm package does not configure a VPS or its reverse proxy.
- **Caddy:** the repository includes a proxy example that excludes live event streams from compression, so login and chat events are not buffered.
- **Known limits:** the Extensions screen has no self-update button for Cogitator yet. General Durable production qualification and automated backup/restore remain unfinished.

## [0.5.1]

Previously published npm baseline. The 0.5.2 notes above describe changes since this published package; earlier release notes have not been reconstructed.
