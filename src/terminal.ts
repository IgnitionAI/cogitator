/**
 * Terminal web du serveur : shells et agents pi interactifs dans un pseudo-terminal.
 *
 * Sécurité : un terminal est un shell complet avec les droits du compte serveur.
 *  - disponible uniquement en mode protégé (login propriétaire, MFA si activée) ;
 *  - jamais pour les jetons MCP ni la socket propriétaire (routes UI uniquement) ;
 *  - WebSocket : Origin exacte + session revérifiée chaque seconde (déconnexion = coupure) ;
 *  - désactivable par `COGITATOR_TERMINAL=0`.
 * Les sessions survivent à une déconnexion du navigateur (tampon de relecture borné)
 * et sont tuées à l'arrêt du serveur.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_TERMINALS = 8;
const REPLAY_BYTES = 256 * 1024;
const MIN_COLS = 10, MAX_COLS = 500, MIN_ROWS = 4, MAX_ROWS = 200;

export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): { dispose(): void } | void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type PtySpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string }) => PtyProcess;

/** node-pty (dépendance optionnelle, binaires précompilés) ; null si indisponible sur cette plateforme. */
export function loadPty(): PtySpawn | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@lydell/node-pty") as { spawn: PtySpawn };
    return (file, args, opts) => mod.spawn(file, args, opts);
  } catch { return null; }
}

export interface TerminalLaunch {
  /** Libellé affiché (onglet). */
  title: string;
  kind: "shell" | "agent";
  agentId?: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Le shell émet son code de sortie (OSC 133;D) : aide « expliquer l'erreur ». */
  shellIntegration: boolean;
}

export interface TerminalInfo {
  id: string;
  title: string;
  kind: "shell" | "agent";
  agentId?: string;
  cwd: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
}

export interface TerminalPeer {
  send(frame: string): void;
  close(): void;
}

interface Session {
  info: TerminalInfo;
  pty: PtyProcess;
  replay: string[];
  replaySize: number;
  peers: Set<TerminalPeer>;
}

const clampSize = (cols: number, rows: number) => ({
  cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(cols) || 80)),
  rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows) || 24)),
});

export class TerminalError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly spawnPty: PtySpawn | null) {}

  get available(): boolean { return this.spawnPty !== null; }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  get(id: string): TerminalInfo | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s.info } : undefined;
  }

  create(launch: TerminalLaunch, size: { cols: number; rows: number }): TerminalInfo {
    if (!this.spawnPty) throw new TerminalError("TERMINAL_UNAVAILABLE", 503);
    if (this.sessions.size >= MAX_TERMINALS) throw new TerminalError("TERMINAL_LIMIT", 409);
    if (!existsSync(launch.cwd) || !statSync(launch.cwd).isDirectory()) throw new TerminalError("TERMINAL_CWD_INVALID");
    const { cols, rows } = clampSize(size.cols, size.rows);
    const pty = this.spawnPty(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, cols, rows, name: "xterm-256color" });
    const info: TerminalInfo = {
      id: randomUUID(), title: launch.title, kind: launch.kind, cwd: launch.cwd, createdAt: new Date().toISOString(), exited: false,
      ...(launch.agentId ? { agentId: launch.agentId } : {}),
    };
    const session: Session = { info, pty, replay: [], replaySize: 0, peers: new Set() };
    this.sessions.set(info.id, session);
    pty.onData((data) => {
      session.replay.push(data);
      session.replaySize += data.length;
      while (session.replaySize > REPLAY_BYTES && session.replay.length > 1) session.replaySize -= session.replay.shift()!.length;
      const frame = JSON.stringify({ t: "o", d: data });
      for (const peer of session.peers) peer.send(frame);
    });
    pty.onExit(({ exitCode }) => {
      session.info.exited = true;
      session.info.exitCode = exitCode;
      const frame = JSON.stringify({ t: "x", code: exitCode });
      for (const peer of session.peers) peer.send(frame);
    });
    return { ...info };
  }

  /** Branche un client : relecture du tampon puis flux en direct. Renvoie la fonction de détachement. */
  attach(id: string, peer: TerminalPeer): () => void {
    const session = this.sessions.get(id);
    if (!session) throw new TerminalError("TERMINAL_NOT_FOUND", 404);
    if (session.replay.length) peer.send(JSON.stringify({ t: "o", d: session.replay.join("") }));
    if (session.info.exited) peer.send(JSON.stringify({ t: "x", code: session.info.exitCode ?? 0 }));
    session.peers.add(peer);
    return () => { session.peers.delete(peer); };
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.info.exited) return;
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.info.exited) return;
    const size = clampSize(cols, rows);
    try { session.pty.resize(size.cols, size.rows); } catch { /* processus en sortie */ }
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    for (const peer of session.peers) peer.close();
    if (!session.info.exited) { try { session.pty.kill("SIGHUP"); } catch { /* déjà sorti */ } }
    return true;
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

/** Variables du serveur à ne jamais propager aux shells (identité du processus hôte). */
const STRIPPED_ENV = /^(COGITATOR_AUTH_REQUIRED|COGITATOR_OWNED_PI|NODE_OPTIONS|NODE_CHANNEL_FD)$/;

export function terminalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.test(k)) env[k] = v;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", COGITATOR_TERMINAL_SESSION: "1", ...extra };
}

/**
 * Shell de connexion. Pour bash, un rcfile charge la configuration habituelle puis
 * émet le code de sortie de chaque commande (OSC 133;D) : l'UI propose alors d'expliquer un échec.
 */
export function shellLaunch(home: string, cwd?: string): TerminalLaunch {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const dir = cwd ?? homedir();
  if (shell.endsWith("/bash")) {
    const rcDir = join(home, "terminal");
    mkdirSync(rcDir, { recursive: true, mode: 0o700 });
    const rc = join(rcDir, "bashrc");
    writeFileSync(rc, [
      "# Généré par Cogitator : configuration habituelle + statut de sortie pour le terminal web.",
      "if [ -f /etc/profile ]; then . /etc/profile; fi",
      // Comme un shell de connexion : le premier fichier trouvé (il charge d'habitude ~/.bashrc).
      "if [ -f ~/.bash_profile ]; then . ~/.bash_profile; elif [ -f ~/.bash_login ]; then . ~/.bash_login; elif [ -f ~/.profile ]; then . ~/.profile; elif [ -f ~/.bashrc ]; then . ~/.bashrc; fi",
      "__cog_status() { local s=$?; printf '\\033]133;D;%s\\007' \"$s\"; return $s; }",
      "PROMPT_COMMAND=\"__cog_status${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"",
      "",
    ].join("\n"), { mode: 0o600 });
    return { title: "bash", kind: "shell", file: shell, args: ["--rcfile", rc, "-i"], cwd: dir, env: terminalEnv(), shellIntegration: true };
  }
  return { title: shell.split("/").pop() ?? "shell", kind: "shell", file: shell, args: ["-l"], cwd: dir, env: terminalEnv(), shellIntegration: false };
}
