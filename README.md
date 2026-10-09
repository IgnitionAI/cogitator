<div align="center">

<img src="https://raw.githubusercontent.com/IgnitionAI/cogitator/dev/web/public/icon.png" width="120" alt="Cogitator — nebula gear logo" />

# Cogitator

**A web control panel for [pi](https://pi.dev)** — composable agents, workspaces, GitHub-native kanban, and scheduled tasks.

[![npm version](https://img.shields.io/npm/v/@ignitionai/cogitator)](https://www.npmjs.com/package/@ignitionai/cogitator)
[![pi package](https://img.shields.io/badge/pi-package-5e6ad2)](https://pi.dev/packages)
[![license](https://img.shields.io/npm/l/@ignitionai/cogitator)](#license)

</div>

Cogitator lets you orchestrate pi processes from your browser: compose agents from a provider, model, thinking level, skills, MCP servers, and subagents; manage project workspaces; and dispatch work through a kanban board backed by **GitHub Issues**. Track the work through modified files, diffs, and a chronological activity feed.

The application currently has a French-language interface. The documentation is in English.

## Installation

```sh
pi install npm:@ignitionai/cogitator
```

Then, in pi:

```text
/cogitator          # starts the detached server and opens http://127.0.0.1:5320
```

Or run it standalone: `npx @ignitionai/cogitator` (Node.js ≥ 22.19.0).

## Features

- **Composable agents** — each preset combines a provider, model, thinking level, explicit skill set, MCP servers, scope prompt, and subagents. These become native pi flags when the process starts (`--model id:thinking`, `--no-skills --skill …`, `--append-system-prompt`).
- **Three built-in agents** — Majordome (the default operator), Chef de Projet (project management, board dispatch, and the `to-tickets`/`use-delegate` methods), and Architecte de Skills (`SKILL.md` authoring). Includes their skills and the Cogitator MCP server with 28 tools.
- **Project workspaces** — a dedicated page for each directory, with a board, file activity (+/−), chronological feed, read-only file tree, team overview, project manager chat, and one-click project setup.
- **GitHub-native kanban** — each card is a GitHub issue, with `status:`/`priority:` labels, native blocking relationships, and writes through `gh`. No synchronization layer: GitHub remains the single source of truth.
- **Agent dispatch** — use “Lancer l’agent” (launch agent) on a ticket to start a conversation in its workspace, link the card to its activity, and move it to in progress.
- **Conversations** — SSE streaming with reconnection recovery, copyable code, structured tool output and diffs, pasted images, history, and skills invoked with `/skill:name`.
- **Automatic interactive UI** — agents choose between text, forms, choices, checklists, and tables as needed, in both standalone and workspace conversations. Responses are submitted explicitly and saved in pi JSONL transcripts. Generated HTML and JavaScript are never executed. See the [contract and limitations](https://github.com/IgnitionAI/cogitator/blob/dev/docs/chat-generative-ui.md).
- **Scheduled tasks** — cron scheduling with concurrent-run protection, catch-up behavior, run history, and notifications.
- **Providers and skills** — inspect pi configuration, check authentication with `pi auth check`, use atomic writes with backups, and import skills from GitHub, local directories, or npm commands.

## Architecture

Specifications live in [`docs/`](https://github.com/IgnitionAI/cogitator/tree/dev/docs): [domain model](https://github.com/IgnitionAI/cogitator/blob/dev/docs/architecture/domain-model.md), [blueprint](https://github.com/IgnitionAI/cogitator/blob/dev/docs/architecture/blueprint.md), [API contract](https://github.com/IgnitionAI/cogitator/blob/dev/docs/architecture/api-contract.md), and [architecture decisions](https://github.com/IgnitionAI/cogitator/tree/dev/docs/context/decisions/). They cover apply-on-spawn configuration, MCP registration through `registerMcpServer`, and the GitHub-backed board's single-writer model. The project uses strict TypeScript, Zod validation at boundaries, and 92 tests.

```text
Browser (React) → REST + SSE → Node server → pool of `pi --mode rpc` processes
                                  ↕ SQLite in ~/.cogitator + native pi files
```

## License

MIT — © IgnitionAI
