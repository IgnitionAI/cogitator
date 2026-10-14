import { initializeOwner, lockHome, recoverOwner, replaceSetupKey, reservePort } from "./auth-state.js";

import { StringDecoder } from "node:string_decoder";

async function ttyInput(label: string): Promise<string> {
  return new Promise((done, reject) => {
    const decoder = new StringDecoder("utf8");
    let value = "";
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.off("error", onError);
      process.stdin.pause(); process.stdout.write("\n");
      if (error) reject(error); else done(value);
    };
    const onEnd = () => finish(new Error("Terminal input ended."));
    const onError = () => finish(new Error("Terminal input failed."));
    const onData = (buffer: Buffer) => {
      const text = decoder.write(buffer);
      if (text.includes("\uFFFD")) return finish(new Error("Invalid UTF-8 terminal input."));
      const lineEnd = text.search(/[\r\n]/);
      if (lineEnd >= 0 && text.slice(lineEnd + 1).replace(/^\n/, "")) return finish(new Error("Enter each value only after its prompt."));
      for (const char of text) {
        if (char === "\u0003" || char === "\u0004") { finish(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char === "\u0015") value = "";
        else if (char >= " " && value.length < 256) value += char;
        else { finish(new Error("Unsupported terminal input or value too long.")); return; }
      }
    };
    // Raw/no-echo is already active for the whole command, including gaps between prompts.
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.once("error", onError);
    process.stdout.write(label); process.stdin.resume();
  });
}
export async function authCommand(home: string, port: number, args: string[]): Promise<void> {
  if (process.platform === "win32") throw new Error("Protected authentication currently requires a Unix server platform.");
  const [command, ...flags] = args;
  if (!["init", "recover", "setup-key"].includes(command ?? "")) throw new Error("Usage: cogitator auth init --origin https://host --email owner@example.org | recover | setup-key");
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i]; const value = flags[i + 1];
    if (command !== "init" || !name || !["--origin", "--email"].includes(name) || !value || values.has(name)) throw new Error("Invalid auth arguments; passwords and setup keys are never command-line arguments.");
    values.set(name, value);
  }
  if (command === "init" && (!values.get("--origin") || !values.get("--email"))) throw new Error("init requires --origin and --email");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Authentication administration requires an interactive local TTY.");
  const wasRaw = process.stdin.isRaw;
  const restoreTerminal = () => { process.stdin.pause(); process.stdin.setRawMode(wasRaw); };
  const interrupt = () => { restoreTerminal(); process.exit(130); };
  process.stdin.setRawMode(true);
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
  if (await ttyInput("Stop and verify ALL previous Cogitator instances for this data home, including custom ports. Old binaries cannot observe the new guard. Type STOPPED: ") !== "STOPPED") throw new Error("Offline administration cancelled.");
  const unlock = lockHome(home);
  let releasePort: (() => Promise<void>) | undefined;
  try {
    releasePort = await reservePort(port);
    let password = "";
    if (command !== "setup-key") {
      password = await ttyInput("New owner password (12–128 characters): ");
      const confirmation = await ttyInput("Confirm password: ");
      if (password !== confirmation) throw new Error("Passwords do not match.");
    }
    const key = command === "init" ? await initializeOwner(home, values.get("--origin")!, values.get("--email")!, password) :
      command === "recover" ? await recoverOwner(home, password) : replaceSetupKey(home);
    password = "";
    process.stdout.write(`Setup key (expires in 30 minutes; save privately): ${key}\nStart Cogitator, open the configured HTTPS origin, sign in, and enter this key during authenticator enrollment.\n`);
  } finally { await releasePort?.(); unlock(); }
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); restoreTerminal(); }
}
