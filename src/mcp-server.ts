#!/usr/bin/env node
/**
 * Serveur MCP Cogitator (stdio) — expose l'API Cogitator en outils pour les agents pi.
 * Transporte toutes les requêtes vers le serveur HTTP local (COGITATOR_URL).
 *
 * C'est le mécanisme du "Majordome" : un agent pi qui manipule Cogitator
 * (agents, crons, workspaces, conversations) via des outils MCP natifs.
 * Les outils sont partagés avec le transport Streamable HTTP (`/mcp`, voir mcp-http.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCogitatorTools } from "./mcp-tools.js";
import { ownerRequest } from "./owner-transport.js";
import { packageVersion } from "./pi.js";

const server = new McpServer({
  name: "cogitator",
  version: packageVersion(),
});

registerCogitatorTools(server, {
  call: (method, path, body) => ownerRequest(method, path, body),
  scope: "full",
  fromConversationId: process.env.COGITATOR_CONVERSATION_ID,
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[cogitator-mcp] connecté (stdio)");
