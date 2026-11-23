import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AuthError } from "./native-auth.js";
import { ArtifactProblem, type Artifacts } from "./artifacts.js";

type Ctx = { params: Record<string, string>; body: unknown; req: IncomingMessage; res: ServerResponse; check: () => void };
type Route = [string, string, (ctx: Ctx) => Promise<void> | void];

/** Le contenu d'un agent n'est jamais exécuté avec l'origine de Cogitator : bac à sable CSP strict. */
export function artifactHeaders(kind: string, mime: string): Record<string, string> {
  const sandbox = kind === "html"
    ? "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads"
    : "sandbox";
  const policy = kind === "html"
    ? `${sandbox}; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; frame-ancestors 'self'`
    : `${sandbox}; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'`;
  return {
    "content-type": mime,
    "content-security-policy": policy,
    "x-content-type-options": "nosniff",
    // Affichable seulement dans l'interface de Cogitator (iframe sandboxé), pas par un autre site.
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
  };
}

export function artifactRoutes(opts: {
  artifacts: Artifacts;
  /** Socket privée des agents (extension) ou requête MCP synthétique. */
  privateRequest: (req: IncomingMessage) => boolean;
  nonBrowser: (req: IncomingMessage) => boolean;
  protectedMode: boolean;
  send: (res: ServerResponse, status: number, data: unknown) => void;
  published: (event: { id: string; title: string; version: number; conversationId: string | null }) => void;
}): Route[] {
  const { artifacts, send } = opts;
  const fail = (res: ServerResponse, error: unknown) => {
    if (error instanceof ArtifactProblem) send(res, error.status, { error: error.message });
    else if (error instanceof z.ZodError) send(res, 400, { error: "ARTIFACT_INVALID_INPUT" });
    else throw error;
  };
  const ui = (fn: (ctx: Ctx) => unknown) => (ctx: Ctx) => {
    if (opts.nonBrowser(ctx.req)) throw new AuthError("FORBIDDEN", 403);
    try { ctx.check(); const value = fn(ctx); ctx.check(); send(ctx.res, 200, value); }
    catch (error) { fail(ctx.res, error); }
  };
  return [
    ["POST", "/api/artifacts/agent", (ctx) => {
      // Identité de l'agent fournie par l'extension intégrée, jamais acceptée sur la surface HTTP publique.
      if (!opts.privateRequest(ctx.req) && opts.protectedMode) throw new AuthError("FORBIDDEN", 403);
      try {
        ctx.check();
        const { artifact, version } = artifacts.publish(ctx.body);
        opts.published({ id: artifact.id, title: artifact.title, version, conversationId: artifact.conversation_id });
        send(ctx.res, 200, { artifact: { id: artifact.id, title: artifact.title, kind: artifact.kind, version, versions: artifact.versions.length }, link: `#artifact=${artifact.id}` });
      } catch (error) { fail(ctx.res, error); }
    }],
    ["GET", "/api/artifacts", ui((ctx) => {
      const url = new URL(ctx.req.url ?? "/", "http://local");
      return { artifacts: artifacts.list({ conversationId: url.searchParams.get("conversation") ?? undefined }) };
    })],
    ["GET", "/api/artifacts/:id", ui((ctx) => ({ artifact: artifacts.get(ctx.params.id!) }))],
    ["PATCH", "/api/artifacts/:id", ui((ctx) => ({ artifact: artifacts.rename(ctx.params.id!, ctx.body) }))],
    ["DELETE", "/api/artifacts/:id", ui((ctx) => artifacts.remove(ctx.params.id!))],
    ["GET", "/api/artifacts/:id/raw", (ctx) => {
      if (opts.nonBrowser(ctx.req)) throw new AuthError("FORBIDDEN", 403);
      try {
        ctx.check();
        const url = new URL(ctx.req.url ?? "/", "http://local");
        const v = url.searchParams.get("v");
        const content = artifacts.content(ctx.params.id!, v ? Number(v) : undefined);
        const headers = artifactHeaders(content.kind, content.mime);
        const download = url.searchParams.get("download") === "1";
        headers["content-disposition"] = `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(content.filename)}`;
        ctx.res.writeHead(200, { ...headers, "content-length": String(content.bytes.length) });
        ctx.res.end(content.bytes);
      } catch (error) { fail(ctx.res, error); }
    }],
  ];
}
