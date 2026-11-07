import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.js";

export function githubEnv(paths: Paths): NodeJS.ProcessEnv {
  const env = { ...process.env, GH_CONFIG_DIR: join(paths.home, "github"), GH_PROMPT_DISABLED: "1", GH_BROWSER: "true", BROWSER: "true", NO_COLOR: "1", TERM: "dumb", LC_ALL: "C" };
  // This connection belongs to this installation, never an ambient token.
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}
export function githubConfigured(paths: Paths): boolean { return existsSync(join(paths.home, "github", "hosts.yml")); }
export function deviceCode(output: string): string | undefined {
  return output.match(/(?:one-time code|code):\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i)?.[1];
}
export interface GitHubConnection {
  available: boolean; connected: boolean; login?: string;
  status: "idle" | "starting" | "waiting" | "done" | "error";
  code?: string; url?: string; error?: string;
}
export class GitHubLogin {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private view: GitHubConnection = { available: true, connected: false, status: "idle" };
  private checkedAt = 0;
  private checking?: Promise<GitHubConnection>;
  constructor(private paths: Paths, private onConnected: () => Promise<unknown> = async () => {}) {}
  async state(): Promise<GitHubConnection> {
    if (this.child || Date.now() - this.checkedAt < 10_000) return { ...this.view };
    if (this.checking) return this.checking;
    this.checking = new Promise(resolve => {
      execFile("gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"], { env: githubEnv(this.paths), timeout: 10_000, maxBuffer: 16_384 }, (error, stdout) => {
        const login = stdout.trim();
        this.view.available = (error as NodeJS.ErrnoException | null)?.code !== "ENOENT";
        this.view.connected = !error && /^[a-z0-9-]{1,39}$/i.test(login);
        this.view.login = this.view.connected ? login : undefined;
        this.checkedAt = Date.now(); this.checking = undefined;
        resolve({ ...this.view });
      });
    });
    return this.checking;
  }
  start(): GitHubConnection {
    if (this.child) return { ...this.view };
    const dir = githubEnv(this.paths).GH_CONFIG_DIR!;
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.view = { available: true, connected: false, status: "starting" };
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], { env: githubEnv(this.paths), cwd: this.paths.home, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let output = "";
    const receive = (chunk: Buffer) => {
      if (this.child !== child || this.view.code) return;
      output = (output + chunk.toString()).slice(-4096);
      const code = deviceCode(output);
      if (code) {
        this.view = { ...this.view, status: "waiting", code, url: "https://github.com/login/device" };
        output = "";
        child.stdin?.write("\n");
      }
    };
    child.stdout?.on("data", receive); child.stderr?.on("data", receive);
    const finish = (ok: boolean) => {
      if (this.child !== child) return;
      clearTimeout(this.timer); this.child = undefined; this.checkedAt = 0;
      for (const file of ["hosts.yml", "config.yml"]) { const path = join(dir, file); if (existsSync(path)) chmodSync(path, 0o600); }
      this.view = { available: true, connected: false, status: ok ? "done" : "error", ...(ok ? {} : { error: "github.loginFailed" }) };
      if (ok) void this.state().then(state => state.connected ? this.onConnected() : undefined).catch(() => {});
    };
    child.once("error", () => finish(false)); child.once("close", code => finish(code === 0));
    this.timer = setTimeout(() => { this.cancel(); this.view.status = "error"; this.view.error = "github.expired"; }, 15 * 60_000);
    return { ...this.view };
  }
  cancel() {
    const child = this.child; this.child = undefined;
    clearTimeout(this.timer); child?.kill("SIGTERM");
    if (child) { const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000); timer.unref(); }
    this.view = { available: true, connected: false, status: "idle" }; this.checkedAt = 0;
  }
}
