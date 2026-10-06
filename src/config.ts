import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const HOME = process.env.COGITATOR_HOME ?? join(process.env.HOME ?? "~", ".cogitator");
export const HOST = "127.0.0.1";
export const PORT = Number(process.env.COGITATOR_PORT ?? 5320);

mkdirSync(HOME, { recursive: true });
