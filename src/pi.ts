import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function packageVersion(): string {
  // dist/src/pi.js → ../../package.json ; en dev tsx (src/pi.ts) → ../package.json
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      return (require(rel) as { version: string }).version;
    } catch {
      // candidate suivant
    }
  }
  return "0.0.0-dev";
}

export function piVersion(): string | null {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
