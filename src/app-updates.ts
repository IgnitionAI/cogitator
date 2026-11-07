import { packageVersion } from "./pi.js";
import { newerVersion } from "./packages.js";

export async function appUpdateStatus(current = packageVersion()) {
  const response = await fetch("https://registry.npmjs.org/@ignitionai%2Fcogitator/latest", {
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) throw new Error("npm registry unavailable");
  const data = await response.json() as { name?: unknown; version?: unknown };
  if (data.name !== "@ignitionai/cogitator" || typeof data.version !== "string" || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error("Invalid release metadata");
  const latest = data.version;
  const status = current === latest ? "current" : newerVersion(latest, current) ? "available" : newerVersion(current, latest) ? "ahead" : "unknown";
  return { current, latest, status };
}
