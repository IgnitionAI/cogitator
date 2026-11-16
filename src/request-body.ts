import type { IncomingMessage } from "node:http";
import { AuthError } from "./native-auth.js";

/** Corps JSON des routes ordinaires : assez pour un objet de config, pas pour une archive. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** Upload de skills (fichiers base64, plafond métier 6 Mo décodés). */
export const SKILL_UPLOAD_MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Messages avec images : 8 × 15 Mo base64 + texte (~121 Mo), marge 130 Mo. */
export const IMAGE_MAX_BODY_BYTES = 130_000_000;

export function maxBodyBytesFor(method: string, pathname: string): number {
  if (method === "POST" && /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) return IMAGE_MAX_BODY_BYTES;
  if (method === "POST" && /^\/api\/groups\/[^/]+\/messages$/.test(pathname)) return IMAGE_MAX_BODY_BYTES;
  if (method === "POST" && pathname === "/api/skills/upload") return SKILL_UPLOAD_MAX_BODY_BYTES;
  return DEFAULT_MAX_BODY_BYTES;
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const overflow = () => {
      if (settled) return;
      settled = true;
      req.pause?.();
      req.destroy();
      reject(new AuthError("INVALID_INPUT", 413));
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      overflow();
      return;
    }
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflow();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AuthError("INVALID_INPUT", 400));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
