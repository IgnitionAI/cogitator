# Changelog

User-facing changes to Cogitator. GitHub development updates and npm releases are separate: an entry marked **Unreleased** is not yet available from npm.

## [0.11.0] - 2026-11-23

**Highlight:** a five-icon rail, settings in one place, and an update center that tells you exactly how to turn on one-click updates on your server.

### Changed

- **A five-icon rail.** The rail now holds Home, Projects, Agents and Terminal, with Settings at the bottom. Providers, extensions, browsers, scheduled tasks and general settings live in Settings, behind one sub-menu. ⌘K still reaches every screen.
- **An update center instead of a dialog.** Settings › Updates shows the new release, then each step of the update (request, download and signatures, installation, switch, health check) and the result. When one-click updates are not set up yet on a systemd server, the page shows the `cogitator-updater` install command already filled in for this server (user, service unit, data folder, port), plus a button to check again. The Settings icon gets a dot when a release is available.
- **A cleaner thread.** The thread header keeps the state, Stop, a panel button and a "more" menu (delete). Changed files, subagents and the browser now share one side panel with tabs. Agent messages are signed with the agent's machine head and name.
- **Agents as a gallery.** The Agents page shows every agent as a portrait card with its type and model. Selecting one opens its profile on the side: animated head, description, model settings, skills and tools, subagents, and a button to start chatting.
- **Providers, sorted.** Connected providers appear first as cards with their status. The others form a searchable catalog that tells whether you sign in with an account or an API key.
- **Clearer extension errors.** When the pi catalog cannot be reached, the Extensions page says so plainly and reminds you that installed extensions keep working.

## [0.10.0] - 2026-11-23

**Highlight:** every agent gets its own 3D machine head, built from what the agent is and does.

### Added

- **A 3D machine head for every agent.** Each agent now has its own avatar, generated from the agent itself: the same metal skull and riveted mask for everyone, with the Cogitator gear as ears. Its type changes the mask: a telescopic monocle for developers, a slit visor with a sweeping eye for QA, a lens cluster for experts and reviewers, a mast and gyroscope for project leads, a third eye and floating halo for designers, a polished mask for the butler. The type is guessed from the agent's name, description and skills. The finish follows the provider (copper, steel, gold), the crest gets one light per skill and the head one antenna per subagent. The selected agent's head is animated on the home screen and lights up while it works. Lists show still portraits rendered once, so many agents cost a single 3D context.

## [0.9.0] - 2026-11-22

**Highlight:** a new home built around your agents, with the model in the composer and ⌘K everywhere.

### Changed

- **New home: your agents, their threads, the chat.** Cogitator now opens on your agents, listed like contacts with their status (working, online, idle). Pick one to see its conversations as threads, then continue one or start a new thread from a single centered question: “What do you want to do?”. Free conversations (a model with no agent) and agent groups stay one click away.
- **Model in the composer.** The large “Model settings” panel is now a pill next to the message box. It shows the current model and reasoning level and opens the same settings in a small popover. Only configured providers are listed.
- **A better 3D logo.** The animated mark now matches the app icon: six wide rounded teeth, a gold rim around a slate-blue body, a glowing plasma lens with spiral arms seated in a gold ring, and a violet halo. It also greets you, larger, above “What do you want to do?”.
- **Icon rail and ⌘K.** The sidebar is now a compact icon rail. Machine status, language, version, updates and what's new open from its menu button. Press ⌘K (Ctrl+K) anywhere to talk to an agent, reopen a thread or go to any screen.

## [0.8.1] - 2026-11-22

### Fixed

- **Provider pickers:** model and agent settings now list only the providers you have configured, instead of every provider pi knows. The current choice stays visible even when it is not configured. When no provider is configured yet, the full list remains available.

## [0.8.0] - 2026-11-22

**Highlight:** the same one-click update on a systemd VPS, with automatic rollback.

### Added

- **One-click updates on a VPS (cogitator-updater):** a small root service for systemd installations. Cogitator only drops a request (a version number). The service accepts only the latest published release, downloads it, installs it as a new release and verifies npm signatures and provenance. It then switches `/opt/cogitator/current`, restarts Cogitator and checks that the new version is served. If the new version does not start, it automatically returns to the previous one. The code stays protected from the service account. Install it once with `sudo node /opt/cogitator/current/dist/src/updater/cogitator-updater.js install --user cogitator`. See [VPS updates](https://github.com/IgnitionAI/cogitator/blob/dev/docs/updater.md).

## [0.7.0] - 2026-11-22

**Highlight:** update Cogitator and your pi extensions in one click.

### Added

- **One-click updates:** in **Updates**, “Update to X and restart” installs the new Cogitator release with pi, restarts the server and reloads the page. If conversations are still working, Cogitator asks before interrupting them. “Update all” updates every pi extension that has a newer release, then reloads extensions once, without interrupting active conversations. This works for installations managed by pi (`pi install`, server started with `/cogitator`). Source releases and system services (systemd) keep the VPS guide procedure: their code is protected from the server account. Set `COGITATOR_SELF_UPDATE=0` to turn it off.

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
