#!/usr/bin/env node
// Serveur MCP stdio minimal pour les tests E2E : un outil `echo`.
// Protocole : JSON-RPC 2.0 délimité par des newlines (transport stdio MCP officiel).

const TOOLS = [
  {
    name: "echo",
    description: "Renvoie le message préfixé par ECHO:",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Le message à renvoyer" } },
      required: ["message"],
    },
  },
];

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cogitator-echo", version: "1.0.0" },
      },
    });
    return;
  }
  if (req.method === "notifications/initialized") return;
  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
    return;
  }
  if (req.method === "tools/call") {
    const message = req.params?.arguments?.message ?? "";
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: `ECHO: ${message}` }], isError: false },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unknown method: ${req.method}` } });
}
