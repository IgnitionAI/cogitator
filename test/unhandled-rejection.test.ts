import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const PROBE = join(import.meta.dirname, "fixtures", "unhandled-rejection-probe.ts");

test("cli.ts installe process.on('unhandledRejection')", () => {
  const src = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
  assert.match(src, /process\.on\(\s*["']unhandledRejection["']/);
});

test("un rejet non géré est journalisé et le process reste vivant", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", PROBE], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("probe timed out"));
    }, 8_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  assert.equal(signal, null);
  assert.equal(code, 0, `stderr=${stderr}`);
  assert.match(stderr, /\[cogitator\] unhandledRejection/);
  assert.match(stderr, /injected-unhandled-rejection/);
  assert.match(stdout, /still-alive/);
});
