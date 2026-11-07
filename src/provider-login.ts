import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { piAiProviders } from "./host-pi.js";
import type { AuthEvent, AuthPrompt, AuthType, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { atomicWriteJson, readJson } from "./json-files.js";
import type { Paths } from "./paths.js";

export type LoginPrompt = Pick<AuthPrompt, "type" | "message"> & {
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};

export type LoginEvent =
  | { type: "prompt"; prompt: LoginPrompt }
  | AuthEvent
  | { type: "prompt_clear" }
  | { type: "done" }
  | { type: "error"; message: string };

interface Session {
  events: LoginEvent[];
  listeners: Set<(event: LoginEvent) => void>;
  abort: AbortController;
  resolvePrompt?: (value: string) => void;
  rejectPrompt?: (error: Error) => void;
  expiry: ReturnType<typeof setTimeout>;
  terminal?: boolean;
  prompt?: LoginPrompt;
}

export function fileCredentialStore(path: string): CredentialStore {
  let queue = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  const all = () => readJson<Record<string, Credential>>(path, {});
  return {
    async read(providerId) {
      return all()[providerId];
    },
    async list() {
      return Object.entries(all()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    modify(providerId, fn) {
      return locked(async () => {
        const file = all();
        const next = await fn(file[providerId]);
        if (next !== undefined) {
          file[providerId] = next;
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          atomicWriteJson(path, file, 0o600);
        }
        return next ?? file[providerId];
      });
    },
    delete(providerId) {
      return locked(async () => {
        const file = all();
        delete file[providerId];
        atomicWriteJson(path, file, 0o600);
      });
    },
  };
}

function publicPrompt(prompt: AuthPrompt): LoginPrompt {
  return {
    type: prompt.type,
    message: prompt.message,
    placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
    options: prompt.type === "select" ? prompt.options.map((option) => ({ ...option })) : undefined,
  };
}

export class ProviderLogins {
  private readonly sessions = new Map<string, Session>();

  private readonly models;
  private deviceId?: string;
  private readonly deviceFile: string;

  constructor(paths: Paths, models?: Pick<ReturnType<typeof piAiProviders.builtinModels>, "login">) {
    this.deviceFile = join(paths.home, "provider-device.json");
    this.models = models ?? piAiProviders.builtinModels({ credentials: fileCredentialStore(paths.piAuthJson) });
  }

  private getDeviceId(): string {
    if (this.deviceId) return this.deviceId;
    const saved = readJson<{ id?: string }>(this.deviceFile, {});
    if (typeof saved.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.id)) return this.deviceId = saved.id;
    const id = randomUUID();
    mkdirSync(dirname(this.deviceFile), { recursive: true, mode: 0o700 });
    atomicWriteJson(this.deviceFile, { id }, 0o600);
    return this.deviceId = id;
  }

  start(providerId: string, type: AuthType): { id: string } {
    if (this.sessions.size >= 64) throw new Error("Too many pending provider logins");
    const id = randomUUID();
    const abort = new AbortController();
    const expiry = setTimeout(() => {
      emit({ type: "error", message: "Provider login expired. Start again." });
      this.cancel(id);
    }, 15 * 60_000);
    expiry.unref();
    const session: Session = { events: [], listeners: new Set(), abort, expiry };
    this.sessions.set(id, session);
    const emit = (event: LoginEvent) => {
      if (session.terminal) return;
      session.events.push(event);
      if (event.type === "done" || event.type === "error") {
        session.terminal = true;
        clearTimeout(session.expiry);
        session.expiry = setTimeout(() => this.cancel(id), 60_000);
        session.expiry.unref();
      }
      for (const listener of session.listeners) listener(event);
    };
    void this.models.login(providerId, type, {
      signal: abort.signal,
      notify: (event) => emit(event),
      prompt: (prompt) => new Promise<string>((resolve, reject) => {
        if (abort.signal.aborted) {
          reject(abort.signal.reason instanceof Error ? abort.signal.reason : new Error("cancelled"));
          return;
        }
        const signals = [abort.signal, prompt.signal].filter((signal): signal is AbortSignal => Boolean(signal));
        const finish = (value?: string, error?: Error) => {
          for (const signal of signals) signal.removeEventListener("abort", onAbort);
          session.resolvePrompt = undefined;
          session.rejectPrompt = undefined;
          session.prompt = undefined;
          emit({ type: "prompt_clear" });
          if (error) reject(error); else resolve(value!);
        };
        const onAbort = () => finish(undefined, new Error("cancelled"));
        session.prompt = publicPrompt(prompt);
        session.resolvePrompt = (value) => finish(value);
        session.rejectPrompt = (error) => finish(undefined, error);
        for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
        emit({ type: "prompt", prompt: publicPrompt(prompt) });
        if (signals.some((signal) => signal.aborted)) onAbort();
      }),
    }, { agentName: "Cogitator", getDeviceId: () => this.getDeviceId() }).then(() => emit({ type: "done" }), (error: unknown) => {
      if (abort.signal.aborted) return;
      emit({ type: "error", message: error instanceof Error ? error.message : "login failed" });
    });
    return { id };
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  subscribe(id: string, listener: (event: LoginEvent) => void): LoginEvent[] | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.listeners.add(listener);
    return session.events;
  }

  unsubscribe(id: string, listener: (event: LoginEvent) => void): void {
    this.sessions.get(id)?.listeners.delete(listener);
  }

  reply(id: string, value: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.resolvePrompt || session.terminal) return false;
    if (session.prompt?.type !== "text" && !value.trim()) return false;
    if (session.prompt?.type === "select" && !session.prompt.options?.some(option => option.id === value)) return false;
    const resolve = session.resolvePrompt;
    session.resolvePrompt = undefined;
    session.rejectPrompt = undefined;
    resolve(value);
    return true;
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.cancel(id);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    clearTimeout(session.expiry);
    session.rejectPrompt?.(new Error("cancelled"));
    session.abort.abort();
    this.sessions.delete(id);
    return true;
  }
}
