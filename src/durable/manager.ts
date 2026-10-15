/**
 * Gestionnaire des runtimes durables (point de composition `src/runtime.ts`) :
 * une runtime ouverte par conversation durable, dans le processus contrôleur,
 * avec bail OS sur son stockage. Le catalogue ne garde que la référence (D4) ;
 * la vérité de mission (transcripts, checkpoints, profil gelé) vit dans le
 * stockage Durable propre à la conversation, sous `<home>/durable/<convId>/`.
 */

import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, type Extension, type Registry } from "@earendil-works/pi-durable";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationRow } from "../conversations.js";
import type { Paths } from "../paths.js";
import type { ToolchainRegistry } from "../execution/egress.js";
import { DurableMissionRuntime } from "./mission-runtime.js";
import { digest } from "./profile.js";

export interface DurableManagerOptions {
  paths: Paths;
  /** Toolchain classée approuvée, gelée dans chaque profil de mission à la création. */
  toolchain: ToolchainRegistry;
  /** Accès modèles (défaut production : fournisseurs built-in, clés détenues par le contrôleur). */
  modelsFactory?: () => Models;
  /** Registre d'extensions (défaut : aucune — fail closed, voir docs/durable-compatibility.md). */
  registryFactory?: () => Registry;
  /** Extensions sélectionnables par les missions durables (défaut : aucune). */
  agentExtensions?: readonly Extension[];
}

interface ManagedRuntime {
  runtime: DurableMissionRuntime;
  closed: boolean;
}

export class DurableRuntimeManager {
  private readonly open = new Map<string, ManagedRuntime>();

  constructor(private readonly opts: DurableManagerOptions) {}

  private dirFor(convId: string): string {
    return join(this.opts.paths.home, "durable", convId);
  }

  /** Ouvre (ou réouvre après fermeture) la runtime durable d'une conversation. */
  async get(conv: ConversationRow): Promise<DurableMissionRuntime> {
    const managed = this.open.get(conv.id);
    if (managed && !managed.closed) return managed.runtime;
    const spawn = JSON.parse(conv.spawn_args || "{}") as { provider?: string; model?: string };
    const runtime = await DurableMissionRuntime.open({
      dir: this.dirFor(conv.id),
      cwd: conv.workspace_dir ?? homedir(),
      model: { provider: spawn.provider ?? conv.provider, modelId: spawn.model ?? conv.model },
      presetDigest: digest(conv.spawn_args || "{}"),
      models: (this.opts.modelsFactory ?? (() => builtinModels()))(),
      registry: (this.opts.registryFactory ?? (() => createRegistry()))(),
      agentExtensions: this.opts.agentExtensions ?? [],
      toolchain: {
        commands: [...this.opts.toolchain.approvedCommands],
        mcpServers: [...this.opts.toolchain.approvedMcpServers],
      },
    });
    const entry: ManagedRuntime = { runtime, closed: false };
    this.open.set(conv.id, entry);
    return runtime;
  }

  /** Runtime déjà ouverte dans ce processus (sans ouvrir) — lecture SSE sans créer de mission. */
  getIfOpen(convId: string): DurableMissionRuntime | undefined {
    const managed = this.open.get(convId);
    return managed && !managed.closed ? managed.runtime : undefined;
  }

  /** Ferme la runtime d'une conversation (le stockage Durable, lui, survit). */
  async release(convId: string): Promise<void> {
    const managed = this.open.get(convId);
    this.open.delete(convId);
    if (managed && !managed.closed) {
      managed.closed = true;
      await managed.runtime.close();
    }
  }

  async dispose(): Promise<void> {
    for (const convId of [...this.open.keys()]) await this.release(convId);
  }
}
