import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codingAgentRoot, piAiProviders, piAiRoot, piCliPath } from "../src/host-pi.js";

const version = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

test("le CLI spawné et le catalogue providers viennent de la même installation pi", () => {
  assert.ok(existsSync(piCliPath), `entry CLI absente: ${piCliPath}`);
  assert.equal(dirname(dirname(piCliPath)), codingAgentRoot);
  // Un catalogue figé décalé du binaire fait diverger providers, logins et raisonnement.
  assert.equal(dirname(piAiRoot), dirname(codingAgentRoot));
  assert.equal(version(piAiRoot), version(codingAgentRoot));
});

test("le catalogue hôte connaît les providers utilisés par les presets", () => {
  const providers = piAiProviders.getBuiltinProviders();
  assert.ok(providers.includes("kimi-coding"));
  assert.ok(piAiProviders.getBuiltinModels("kimi-coding").length > 0);
  assert.ok(piAiProviders.builtinProviders().some((provider) => provider.id === "deepseek"));
});
