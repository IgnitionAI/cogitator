import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codingAgentRoot, findPackageFrom, hostPiPackage, piAiProviders, piAiRoot, piCliPath } from "../src/host-pi.js";

const version = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

const noHostPi = hostPiPackage === null
  ? "aucune installation pi résolvable (pas de binaire pi hors node_modules/.bin du projet)"
  : false;

test("le CLI spawné et le catalogue providers viennent de la même installation pi", { skip: noHostPi }, () => {
  assert.ok(existsSync(piCliPath), `entry CLI absente: ${piCliPath}`);
  assert.equal(codingAgentRoot, hostPiPackage);
  assert.equal(piCliPath, join(codingAgentRoot, "dist/cli.js"));
  const fromBinary = findPackageFrom("@earendil-works/pi-ai", codingAgentRoot);
  assert.ok(fromBinary, "pi-ai introuvable en marchant depuis le binaire pi résolu");
  assert.equal(piAiRoot, fromBinary);
  assert.equal(version(piAiRoot), version(codingAgentRoot));
});

test("le catalogue hôte connaît les providers utilisés par les presets", () => {
  const providers = piAiProviders.getBuiltinProviders();
  assert.ok(providers.includes("kimi-coding"));
  assert.ok(piAiProviders.getBuiltinModels("kimi-coding").length > 0);
  assert.ok(piAiProviders.builtinProviders().some((provider) => provider.id === "deepseek"));
});
