import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AuthError } from "./native-auth.js";
import { VaultProblem, type Vault } from "./vault.js";

type Ctx = { params: Record<string, string>; body: unknown; req: IncomingMessage; res: ServerResponse; check: () => void };
type Route = [string, string, (ctx: Ctx) => Promise<void> | void];

/**
 * Coffre d'identifiants : interface du propriétaire uniquement. Les agents (socket privée) et le
 * serveur MCP (requêtes synthétiques) n'y ont JAMAIS accès ; ils passent par le navigateur partagé.
 */
export function vaultRoutes(vault: Vault, nonBrowser: (req: IncomingMessage) => boolean, send: (res: ServerResponse, status: number, data: unknown) => void): Route[] {
  const ui = (fn: (ctx: Ctx) => unknown) => (ctx: Ctx) => {
    if (nonBrowser(ctx.req)) throw new AuthError("FORBIDDEN", 403);
    try {
      ctx.check();
      const value = fn(ctx);
      ctx.check();
      send(ctx.res, 200, value);
    } catch (error) {
      if (error instanceof VaultProblem) send(ctx.res, error.status, { error: error.message });
      else if (error instanceof z.ZodError) send(ctx.res, 400, { error: error.issues[0]?.message?.startsWith("VAULT_") ? error.issues[0].message : "VAULT_INVALID_INPUT" });
      else throw error;
    }
  };
  return [
    ["GET", "/api/vault", ui(() => ({ entries: vault.list() }))],
    ["POST", "/api/vault", ui((ctx) => ({ entry: vault.create(ctx.body) }))],
    ["POST", "/api/vault/import", ui((ctx) => vault.importGoogle(ctx.body))],
    ["PUT", "/api/vault/:id", ui((ctx) => ({ entry: vault.update(ctx.params.id!, ctx.body) }))],
    ["DELETE", "/api/vault/:id", ui((ctx) => vault.remove(ctx.params.id!))],
    ["POST", "/api/vault/:id/reveal", ui((ctx) => vault.reveal(ctx.params.id!))],
  ];
}
