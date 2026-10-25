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
  | { type: "done" }
  | { type: "error"; message: string };

interface Session {
  events: LoginEvent[];
  listeners: Set<(event: LoginEvent) => void>;
  abort: AbortController;
  resolvePrompt?: (value: string) => void;
  rejectPrompt?: (error: Error) => void;
}

function fileCredentialStore(path: string): CredentialStore {
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
          atomicWriteJson(path, file);
        }
        return next ?? file[providerId];
      });
    },
    delete(providerId) {
      return locked(async () => {
        const file = all();
        delete file[providerId];
        atomicWriteJson(path, file);
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

  constructor(private readonly paths: Paths) {}

  start(providerId: string, type: AuthType): { id: string } {
    const id = randomUUID();
    const abort = new AbortController();
    const session: Session = { events: [], listeners: new Set(), abort };
    this.sessions.set(id, session);
    const emit = (event: LoginEvent) => {
      session.events.push(event);
      for (const listener of session.listeners) listener(event);
    };
    const models = piAiProviders.builtinModels({ credentials: fileCredentialStore(this.paths.piAuthJson) });
    void models.login(providerId, type, {
      signal: abort.signal,
      notify: (event) => emit(event),
      prompt: (prompt) => new Promise<string>((resolve, reject) => {
        if (abort.signal.aborted) {
          reject(abort.signal.reason instanceof Error ? abort.signal.reason : new Error("cancelled"));
          return;
        }
        session.resolvePrompt = resolve;
        session.rejectPrompt = reject;
        emit({ type: "prompt", prompt: publicPrompt(prompt) });
      }),
    }, { agentName: "Cogitator" }).then(() => emit({ type: "done" }), (error: unknown) => {
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
    if (!session?.resolvePrompt) return false;
    const resolve = session.resolvePrompt;
    session.resolvePrompt = undefined;
    session.rejectPrompt = undefined;
    resolve(value);
    return true;
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.rejectPrompt?.(new Error("cancelled"));
    session.abort.abort();
    this.sessions.delete(id);
    return true;
  }
}
