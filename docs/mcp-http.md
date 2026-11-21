# Remote MCP (Streamable HTTP)

Cogitator exposes its MCP tools over **Streamable HTTP** at `/mcp`, so an external agent can operate Cogitator directly. That agent can be Claude Code, the Claude API, the OpenAI Responses API, or your own bot. The tools are the same ones the bundled stdio server gives the Majordome. Both transports share `src/mcp-tools.ts`.

```
external agent ──HTTPS──▶ Caddy ──▶ Cogitator /mcp ──(in-process)──▶ /api/* routes
                Authorization: Bearer cgt_…
```

## 1. Create a token

Run this as the Cogitator OS account, with the same `COGITATOR_HOME` as the server. The server does not need to be stopped.

```sh
cogitator mcp token create my-bot              # scope full (read + write)
cogitator mcp token create dashboard --scope read
cogitator mcp token list
cogitator mcp token revoke my-bot              # by id or name
```

The token (`cgt_…`) is shown **once**. Only its SHA-256 is stored in `<COGITATOR_HOME>/mcp-tokens.json` (mode `0600`). Revocation applies immediately, including to sessions that are already open.

| Scope | Tools exposed |
| --- | --- |
| `read` | lists and details: agents, schedules and runs, workspaces, conversations and transcripts, board, providers, skills, health |
| `full` | everything in `read`, plus creating, updating, deleting, sending messages, starting work, firing schedules and importing skills |

A `full` token has the authority of the owner: it can create agents that run commands on the host. Give bots `read` unless they need to act.

## 2. Endpoint

- Local mode: `http://127.0.0.1:5320/mcp` (only reachable from the same machine).
- VPS / protected mode: `https://<your-origin>/mcp`. Keep the existing Caddy `reverse_proxy` for the whole site. SSE responses are flushed automatically. In protected mode the `Host` must match the configured origin, and a browser `Origin` other than the origin is rejected.

Hosted APIs (Claude API, OpenAI) call your server from their cloud. They therefore need the public HTTPS origin, not `127.0.0.1`.

The token is always required, even in local mode. Browser session cookies are never accepted on `/mcp`.

## 3. Connect a client

**Claude Code**

```sh
claude mcp add --transport http cogitator https://cogitator.example.org/mcp \
  --header "Authorization: Bearer cgt_…"
```

**OpenAI Responses API**

```json
{
  "type": "mcp",
  "server_label": "cogitator",
  "server_url": "https://cogitator.example.org/mcp",
  "headers": { "Authorization": "Bearer cgt_…" },
  "require_approval": "never"
}
```

**Claude API (MCP connector)**: declare a URL MCP server with `url` set to `https://cogitator.example.org/mcp` and `authorization_token` set to `cgt_…`. See the Anthropic documentation for the current beta header.

**Your own bot**: use any MCP SDK's Streamable HTTP client with the `Authorization` header. Example in TypeScript:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("https://cogitator.example.org/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.COGITATOR_MCP_TOKEN}` } },
});
const client = new Client({ name: "my-bot", version: "1.0.0" });
await client.connect(transport);
const reply = await client.callTool({
  name: "cogitator_send_message",
  arguments: { conversation_id: "…", text: "Summarize the board blockers" },
}, undefined, { onprogress: (p) => console.log(p.message) });
```

**ChatGPT / Claude.ai custom connectors** (the web apps) require OAuth sign-in. This is not supported yet: use the APIs above, or Claude Code.

## 4. Talking to Cogitator agents

| Tool | Purpose |
| --- | --- |
| `cogitator_create_conversation` | start a conversation with an agent (optional first prompt) |
| `cogitator_send_message` | send a message. With `wait: true` (default) it streams **progress notifications** while the agent works, then returns `{ status: "completed", reply, tools_used }`. After `timeout_seconds` (default 120, max 900) it returns `status: "running"`. |
| `cogitator_read_conversation` | transcript (user/assistant). Set `include_tools: true` for tool calls and reasoning. |
| `cogitator_get_conversation` | state: model, workspace, `streaming` |
| `cogitator_stop_conversation` | interrupt the current turn |

Reverse proxies and hosted clients may cut very long requests. For long tasks, use `wait: false`, then poll `cogitator_get_conversation` or `cogitator_read_conversation`.

## 5. Sessions and limits

- Sessions are stateful (`Mcp-Session-Id`) and bound to the token that opened them. Another token gets `403`, and an unknown or expired session gets `404`, after which the client re-initializes.
- Idle sessions close after 30 minutes. At most 64 sessions are kept; the oldest is evicted first.
- Requests are limited to 4 MB.
- Every tool call goes through the same `/api/*` handlers, validation and availability checks as the web UI. Comments on the board are authored as `MCP: <token name>`.
