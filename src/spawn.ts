import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_ENV_VAR, type McpServerEntry } from "./mcp-env.js";
import { OWNED_PI_ENV } from "./reap-orphans.js";

/** Config figée de spawn (snapshot d'un preset ou choix ad hoc) — O6 du contrat. */
export interface SpawnConfig {
  provider: string;
  model: string;
  thinking?: string | null;
  systemPrompt?: string;
  /** Contrat UI copié à la création ; absent des anciens snapshots. */
  uiInstructions?: string;
  skills?: string[];
  tools?: string[] | null;
  /** Serveurs MCP du preset — transportés via env et enregistrés par l'extension au session_start (ADR-002) */
  mcpServers?: McpServerEntry[];
}

/** Snapshot d'un preset d'agent (type structurel : pas de dépendance vers agents.js). */
export function spawnConfigFromPreset(preset: {
  provider: string;
  model: string;
  thinking?: string | null;
  system_prompt?: string;
  skills?: string[];
  tools_allowlist?: string[] | null;
  mcp_servers?: McpServerEntry[];
}): SpawnConfig {
  return {
    provider: preset.provider,
    model: preset.model,
    thinking: preset.thinking,
    systemPrompt: preset.system_prompt || undefined,
    skills: preset.skills,
    tools: preset.tools_allowlist,
    mcpServers: preset.mcp_servers,
  };
}

export function modelArg(c: SpawnConfig): string {
  return c.thinking ? `${c.provider}/${c.model}:${c.thinking}` : `${c.provider}/${c.model}`;
}

/**
 * Matérialise un SpawnConfig en flags natifs pi (ADR-001).
 * Effet de bord unique : écrit le fichier du system prompt dans tmpDir.
 */
export function buildArgs(c: SpawnConfig, tmpDir: string, convId: string): string[] {
  mkdirSync(tmpDir, { recursive: true });
  // pi n'accepte pas la forme --flag=valeur : tout passe en deux éléments
  const args = ["--model", modelArg(c)];
  const systemPrompt = [c.systemPrompt, c.uiInstructions].filter(Boolean).join("\n\n");
  if (systemPrompt) {
    const file = join(tmpDir, `${convId}.prompt.md`);
    writeFileSync(file, systemPrompt);
    args.push("--append-system-prompt", file);
  }
  if (c.skills?.length) {
    args.push("--no-skills"); // O5 : skills exactes, jamais de fusion avec la découverte globale
    for (const skill of c.skills) args.push("--skill", skill);
  }
  if (c.tools?.length) args.push("--tools", c.tools.join(","));
  return args;
}

/** Variables OS nécessaires à un process pi (PATH, locale, home, tmp). */
export const CHILD_OS_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TZ", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "COLORTERM",
] as const;

/** Proxy / certificats pour que l'enfant joigne l'API du fournisseur. */
export const CHILD_NETWORK_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

/** Variables pi lues par le CLI / l'agent, pas des secrets du serveur Cogitator. */
export const CHILD_PI_ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;

/**
 * Variables Cogitator que l'enfant ou l'extension lit réellement.
 * Tout autre `COGITATOR_*` (auth, enrolment, browser, durable) est exclu.
 */
export const CHILD_COGITATOR_ENV_KEYS = [
  "COGITATOR_HOME",
  "COGITATOR_CONVERSATION_ID",
  "COGITATOR_URL",
  MCP_ENV_VAR,
  OWNED_PI_ENV,
  "COGITATOR_PI_CLI",
] as const;

/** Config gh de l'installation, jamais les tokens ambiants. */
export const CHILD_GITHUB_ENV_KEYS = ["GH_CONFIG_DIR", "GH_PROMPT_DISABLED", "GH_BROWSER", "BROWSER", "NO_COLOR"] as const;

/** Noms d'env d'API key par fournisseur (miroir de pi-ai `getApiKeyEnvVars`). */
const PROVIDER_API_KEY_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  typesafe: ["TYPESAFE_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  meta: ["META_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "ant-ling": ["ANT_LING_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
};

const CHILD_ENV_DENY = /^(COGITATOR_AUTH|BETTER_AUTH|AUTH_SECRET|SESSION_SECRET)|^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/;

export function providerEnvKeys(provider: string): readonly string[] {
  const known = PROVIDER_API_KEY_ENV[provider];
  if (known) return known;
  const slug = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return slug ? [`${slug}_API_KEY`] : [];
}

export function providerFromSpawnArgs(args: string[]): string | undefined {
  const providerFlag = args.indexOf("--provider");
  const flagged = providerFlag >= 0 ? args[providerFlag + 1] : undefined;
  if (flagged) return flagged;
  const modelFlag = args.indexOf("--model");
  const spec = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : undefined;
}

function allowedChildEnvKeys(provider: string | undefined): Set<string> {
  const keys = new Set<string>([
    ...CHILD_OS_ENV_KEYS,
    ...CHILD_NETWORK_ENV_KEYS,
    ...CHILD_PI_ENV_KEYS,
    ...CHILD_COGITATOR_ENV_KEYS,
    ...CHILD_GITHUB_ENV_KEYS,
  ]);
  if (provider) for (const key of providerEnvKeys(provider)) keys.add(key);
  return keys;
}

function copyDefined(out: Record<string, string>, source: NodeJS.ProcessEnv | Record<string, string>, key: string): void {
  const value = source[key];
  if (typeof value === "string") out[key] = value;
}

export interface BuildChildEnvOptions {
  provider?: string;
  source?: NodeJS.ProcessEnv;
  extra?: Record<string, string>;
}

/**
 * Environnement d'un enfant pi : liste d'autorisation, jamais `...process.env`.
 * `extra` (opts RpcClient) l'emporte sur `source` pour les clés autorisées.
 */
export function buildChildEnv(options: BuildChildEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const allowed = allowedChildEnvKeys(options.provider);
  const out: Record<string, string> = {};
  for (const key of allowed) {
    if (CHILD_ENV_DENY.test(key)) continue;
    copyDefined(out, source, key);
  }
  for (const key of Object.keys(options.extra ?? {})) {
    if (!allowed.has(key) || CHILD_ENV_DENY.test(key)) continue;
    copyDefined(out, options.extra!, key);
  }
  return out;
}
