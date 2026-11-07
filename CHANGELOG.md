# Changelog

User-facing changes to Cogitator. GitHub development updates and npm releases are separate: an entry marked **Unreleased** is not yet available from npm.

## [0.5.2] - Unreleased

### Added

- **Cogitator updates:** sidebar release check compares the running version with npm and explains pi/VPS update steps without downgrading newer source deployments.
- **Documentation:** illustrated onboarding, English/French working guides and a dedicated single-owner HTTPS VPS guide.

- **What’s new:** a short bilingual changelog is available from the sidebar footer.
- **Extensions catalog:** browse pi packages, search and filter by type, install or uninstall packages, check for updates, update individual npm packages, and reload extensions from the web interface without interrupting active agents.
- **Subagent conversations:** click a subagent to inspect its instructions, messages, tool calls and results in a read-only dialog. The journal refreshes automatically without interrupting the parent conversation or moving your reading position.
- **GitHub connection:** connect your account with a browser device code to import private repositories. Project imports, classic agents and the GitHub issue board share the installation's connection.
- **Git repository import:** add a project from a repository link, with an automatic name and optional settings.
- Provider-specific model reasoning levels in the model settings.

### Improved

- New protected installations use owner email/password login by default. Authenticator-based MFA remains optional. Existing MFA installations keep their authentication mode unless their owner explicitly changes it.
- Provider setup supports clearer API-key/account choices, searchable providers and a template for local model endpoints.
- Conversations explain missing provider configuration and allow connecting the provider without leaving the chat.
- Extension changes reload idle conversations while preserving active agents and background subagents; busy conversations can be reloaded after their work finishes.

### Fixed

- Missing provider credentials no longer leave conversations in an endless reconnect loop.
- Provider availability refreshes immediately after setup. Availability indicates local configuration, not a successful model request.
- ChatGPT sign-in retains a stable installation identity; unfinished provider logins are cancelled during server shutdown.
- Opening the protected app from an external link reaches the login page correctly.
- Background subagents keep their parent process alive until they finish.
- Scheduled work and queued image messages retain their expected dispatch and recovery behavior; long-running delivered work is no longer incorrectly failed at the queue timeout.
- Team handoffs preserve their originating hop limit.
- Running `/cogitator` after updating the extension replaces an older local Cogitator server when its identity can be verified.
- Durable recovery preserves requests for attention and checks protected effects before execution.

### Updating and requirements

- Once this version is published, run `pi update --extensions`, then `/reload` and `/cogitator` in pi. An explicitly pinned package version must be changed to receive a newer release. Finish active work before restarting the server.
- Browser-based GitHub connection requires GitHub CLI (`gh`) on the server and your authorization on GitHub. Organizations may require additional approval or SSO authorization.
- The subagent features require `@gotgenes/pi-subagents` in the same pi profile as Cogitator. Reading a journal does not start a model request.
- Remote Git imports require a configured project directory inside the server's enrolled workspace roots. Updating the npm package does not configure a VPS or its reverse proxy automatically.
- For Caddy deployments, the repository includes a proxy example excluding live event streams from compression to avoid buffered login/chat events.
- The Extensions screen does not yet provide a self-update button for Cogitator. General Durable production qualification and automated backup/restore remain unfinished.

## [0.5.1]

Previously published npm baseline. The 0.5.2 notes above describe changes since this published package; earlier release notes have not been reconstructed.
