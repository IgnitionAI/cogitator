# Working with Cogitator

[Home](../README.md) · [Français](guide-fr.md) · [VPS setup](vps.md) · [Release notes](../CHANGELOG.md)

Cogitator gives pi a browser interface. A **bot** is a saved agent preset; a **conversation** is one run/history using that preset; a **workspace** is a folder on the host machine. A **skill** is a reusable procedure. An **extension** adds pi capabilities. An **MCP server** exposes tools an agent can call. A **subagent** is a child agent delegated a particular task.

## 1. Connect a model provider

Open **Providers**, select a provider and use the supported connection method: API key, browser OAuth or device code. Follow the dialog until it reports completion. Provider login is independent of the email/password used to enter Cogitator. For a VPS, credentials and models belong to the VPS's pi profile.

A provider can be configured while a particular model remains unavailable to your account. Send a small first message using a model you can access to confirm real acceptance; model calls can incur provider charges. For local models, configure an endpoint reachable from the server. `localhost` on a VPS does not mean your laptop.

If an OAuth provider redirects to a loopback callback your laptop cannot reach, return to Cogitator and follow its prompt to supply the callback URL. Do not paste authorization URLs into issues or public chat. If the flow expires, cancel and begin again.

## 2. Start with the Majordome

On **Bots**, choose **Majordome → Talk**. It operates Cogitator through the bundled MCP server: list/create agents, register workspaces, configure scheduled tasks and create conversations. It can inspect a project, propose conventions and useful agents, then execute the approved setup.

Try:

> Inspect this workspace. Suggest a minimal setup: project instructions, two useful agent presets and the first backlog items. Present the proposed changes before applying them.

The Majordome is an operator, not an automatic installation wizard for your host or provider subscriptions. Its actual tools and file permissions determine what it can do.

## 3. Bring a project

Open **Workspaces → Add workspace**. Paste a repository URL and import it. The repository is cloned into the server's configured projects directory; its name is inferred unless you override it.

For private repositories, choose **Connect GitHub**, open the provided GitHub page and enter the device code. Approve access in your own browser. The server needs GitHub CLI (`gh`); an organization may require additional SSO authorization. The resulting connection is used for imports, classic agent GitHub operations and the issue board.

Alternatively, choose a server folder. It must exist on the machine running Cogitator and lie within any configured enrollment boundaries. This is not a file upload from your browser.

Open the project to inspect its files, activity and board. Ask for project setup rather than immediately authorizing a large change. Review its generated instructions and backlog.

## 4. Give work to the Project Manager

**Chef de Projet** reads the project's GitHub Issues board. Cards represent issues, with status/priority labels and dependencies. GitHub remains the source of truth; these operations change real issues.

Project initialization first checks the bundled MCP connection and shows the existing agent/skill inventory. The Majordome receives this context and must inspect relevant skills before proposing new resources. MCP tools may be discovered through pi’s `tool_search`/`codemode`, not exposed as top-level tool names.

A useful loop:

1. Describe an outcome and acceptance criteria.
2. Ask the Project Manager to read the board and propose small deliverable tasks.
3. Review dependencies and priorities.
4. Launch an agent from a ticket, or ask the manager to assign and start it.
5. Follow the linked conversation and file changes.
6. Ask for validation evidence before marking the ticket done.

Example:

> Break “add CSV export” into independently testable tasks. Reuse existing agents and skills. Identify dependencies and tell me which task can start first.

Additional methods referenced by this preset—such as `to-tickets` and `use-delegate`—require those skills to be installed. Cogitator does not bundle every skill named in a prompt.

## 5. Make an agent your own

In **Agents**, edit or create a preset with a provider/model, reasoning level, system instructions, skills, tool selection and MCP servers. Keep its responsibility specific: reviewer, researcher, implementer or project manager.

In a conversation, **Model settings** lets you change provider, model and reasoning. Choose whether to apply to this conversation only or also to the bot's future defaults. Existing sibling chats retain their settings. Wait for the current response to finish. Durable missions use a separate frozen-configuration contract.

A conversation retains its history across navigation. Tool cards can be expanded for details; the files panel provides modified-file context and diffs. Interactive forms or checklists require explicit submission. Generated UI is declarative; it does not execute arbitrary agent-provided JavaScript.

## 6. Build reusable skills

Ask **Architecte de Skills** to design a procedure with a clear purpose, trigger, inputs, steps, output and acceptance checks:

> Create a skill called review-api-change. It should compare an API change against existing clients, identify compatibility risks and produce a short review with evidence. Add a worked example and validate discovery.

The architect writes `SKILL.md` and optional references/scripts, normally under the server account's `~/.agents/skills`. It checks the frontmatter and discovery. You can import existing skills through Cogitator's skill tools, select skills in agent settings, or invoke `/skill:name` in a message.

In **Agents → Import skills**, choose **Folder on this computer** to upload a folder to the server, including on a VPS. `SKILL.md`, references and scripts are retained; hidden files and node_modules are excluded. The limit is 500 files / 6 MB, and existing skills are preserved. **Folder on the server** takes an absolute server path; GitHub remains a separate option.

A skill describes a method; it does not grant missing tools, credentials or filesystem access. With an explicit nonempty skill selection, the preset requests that selection rather than merging every globally discovered skill.

## 7. Install extensions and delegate

In **Extensions**, search the live pi package catalog. Install the package you want, then follow its operation status. For child agents, install **`@gotgenes/pi-subagents`**. This makes delegation tools available to pi; merely opening Cogitator's Subagents panel does not install them.

Use **Check updates**, then **Update** beside a package with a newer release. Updates preserve package resource filters and compare actual installed manifest versions. A failed check is not shown as “up to date.” Non-npm sources are displayed but cannot be updated through this npm workflow.

**Reload extensions** recycles idle sessions. Active conversations and background children continue; reload again after their work completes. Installing into a laptop profile does not affect the VPS profile.

Try:

> Delegate documentation review and test review to two subagents. Keep changes separate and report the evidence from each.

Open **Subagents**, then click a child to read its conversation in a wide dialog. Messages, tool activity and the final result are available without leaving the parent chat; running children refresh periodically. Scrolling back preserves your position. This is a read-only viewer. Closing it does not stop the child. A missing or truncated transcript is reported explicitly.

## 8. Understand MCP

The bundled server at `dist/src/mcp-server.js` speaks **stdio MCP**. Its tools cover Cogitator agents, workspaces, conversations, schedules, provider/skill discovery and board operations. New built-in presets are seeded with this MCP server.

The flow is: **agent → MCP tool → Cogitator API → operation**. It is why the Majordome can operate the app instead of only describing what to click.

For a custom local MCP client, configure `node` with the absolute path to this script. Run it as the Cogitator owner OS account, with the same `COGITATOR_HOME`. In protected mode it uses the owner-only Unix socket. Do not set `COGITATOR_URL` for that private-socket path: an explicit URL selects ordinary HTTP and does not bypass login. There is no public unauthenticated HTTP MCP endpoint.

Other MCP servers can be attached to an agent. **Settings** also exposes the global pi MCP configuration. A saved definition still requires its executable, credentials and any necessary adapter on the host. Check agent tools after setup; do not assume every MCP entry is usable merely because JSON was saved.

## 9. Schedule recurring work

Use **Scheduled tasks**, or ask the Majordome to propose a cron expression for a clear recurring task. Verify the timezone, workspace, agent and prompt. Inspect the run history after the first execution. The controller must stay running and the provider must remain connected. Closing a browser does not stop a scheduled task; stopping the server does.

## 10. Maintain your installation

At the sidebar footer, **Updates** compares the running version with npm; **What’s new** summarizes changes. It guides a Cogitator update rather than restarting the application. Extension package updates have their own actions under Extensions.

For local pi installs, update published packages and run `/reload`, then `/cogitator`, after agents finish. For a VPS service, follow the [deployment update procedure](vps.md#updating-and-rollback). Refresh the browser after activation.

On a remote protected installation, sign in with the owner email and password. Email is an identifier, not an email delivery service. MFA is optional. Signing out closes that browser's access but does not stop running agents. Lost credentials require [offline owner recovery](native-auth.md#offline-owner-recovery), not an email reset.

Back up the application data and pi profile coherently. Provider keys, GitHub credentials, auth databases and transcripts are private. Authentication protects access to the panel; agents still act with the server account's capabilities. See [deployment boundaries](vps.md) before exposing an installation.

## Shared browsers

Create a profile in **Browsers**, select the allowed agents, and open a page. **Take control** blocks agent input and inspection while you sign in. **Return control to agents** lets them use the same session. Conversations also have a **Browsers** button. Closing the view keeps the browser running; stopping it retains its profile. Website reauthentication and verification may still be required. See [installation, usage and limitations](browsers.md).

### Machine indicators

The **CPU / RAM** button at the bottom of navigation shows the machine hosting Cogitator, including a remote VPS. Open **Machine** for interval CPU usage, logical cores, memory, the data filesystem's disk usage and available space, uptime and Cogitator server process memory.

Metrics require owner authentication and refresh every five seconds while the tab is visible. Linux memory uses `MemAvailable` to exclude reclaimable memory. Reserved filesystem blocks can make available space differ from free space. These are OS-visible machine metrics, not systemd/container quotas. Unavailable readings are shown explicitly instead of displaying old values as current.
