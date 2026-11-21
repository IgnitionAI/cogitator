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

**ChatGPT / Claude.ai custom connectors** (web apps) use OAuth instead of a token you paste. This requires **protected mode** (`cogitator --auth-required` with a public HTTPS origin):

1. In the app, add a custom connector with the URL `https://cogitator.example.org/mcp`. Leave client ID/secret empty: the app registers itself automatically.
2. The app opens Cogitator's consent page. If you are not signed in, sign in as the owner in that browser, then click **Continue**.
3. Choose **Read only** or **Full control**, then **Allow**.

Connected apps appear in `cogitator mcp token list` (marked OAuth). Revoke one with `cogitator mcp token revoke "<app name>"`.

## 4. Talking to Cogitator agents

| Tool | Purpose |
| --- | --- |
| `cogitator_create_conversation` | start a conversation with an agent (optional first prompt) |
| `cogitator_send_message` | send a message. With `wait: true` (default) it streams **progress notifications** while the agent works, then returns `{ status: "completed", reply, tools_used }`. After `timeout_seconds` (default 120, max 900) it returns `status: "running"`. |
| `cogitator_read_conversation` | transcript (user/assistant). Set `include_tools: true` for tool calls and reasoning. |
| `cogitator_get_conversation` | state: model, workspace, `streaming` |
| `cogitator_stop_conversation` | interrupt the current turn |

Reverse proxies and hosted clients may cut very long requests. For long tasks, use `wait: false`, then poll `cogitator_get_conversation` or `cogitator_read_conversation`.

## 5. OAuth details

- Discovery: `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414). A `401` from `/mcp` points to them through `WWW-Authenticate: Bearer resource_metadata="…"`.
- Dynamic client registration at `/oauth/register` (RFC 7591). Redirect URIs must be `https` or loopback `http`. Registration is capped at 30 per hour and 100 clients; clients never authorized are purged after 24 h.
- Authorization code with mandatory **PKCE S256**. The `redirect_uri` must match exactly, and `resource`, when sent, must be this server's `/mcp`. Codes are single-use and last 60 s.
- The consent page requires an approved owner session (including MFA when it is enabled) and a same-origin form. The authorization request is bound to that session.
- Access tokens (`cgo_…`) last 1 hour. Refresh tokens (`cgr_…`) rotate on each use and last 30 days. If a client replays a refresh token that has already been rotated, Cogitator revokes the whole grant.
- Only hashes are stored, in `<COGITATOR_HOME>/mcp-oauth.json` (mode `0600`). In local mode, OAuth is disabled and these endpoints return `404`.

## 6. Sessions and limits

- Sessions are stateful (`Mcp-Session-Id`) and bound to the token that opened them. Another token gets `403`, and an unknown or expired session gets `404`, after which the client re-initializes.
- Idle sessions close after 30 minutes. At most 64 sessions are kept; the oldest is evicted first.
- Requests are limited to 4 MB.
- Every tool call goes through the same `/api/*` handlers, validation and availability checks as the web UI. Comments on the board are authored as `MCP: <token name>`.
