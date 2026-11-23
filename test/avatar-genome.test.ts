import assert from "node:assert/strict";
import test from "node:test";

import { agentGenome, avatarType, genomeKey, providerMetal } from "../web/src/avatar/genome.js";

test("avatar : le type est deviné d'après le nom, avec priorité à la Sentinelle", () => {
  const type = (name: string) => avatarType({ name });
  assert.equal(type("Majordome"), "intendant");
  assert.equal(type("Développeur Cogitator TS"), "artificier");
  assert.equal(type("Développeur Gameplay"), "artificier");
  assert.equal(type("Chef de Projet"), "logisticien");
  assert.equal(type("Architecte de Skills"), "logisticien");
  assert.equal(type("Expert Three.js & R3F"), "oracle");
  assert.equal(type("Game Designer — Gamification"), "oracle");
  assert.equal(type("QA & Recette — Jeux 3D"), "sentinelle");
  assert.equal(type("Expert RL — IgnitionRL"), "archiviste");
  assert.equal(type("Relecteur indépendant"), "archiviste");
  assert.equal(type("Nouvel agent"), "novice");
});

test("avatar : sans indice dans le nom, la description et les compétences décident", () => {
  assert.equal(avatarType({ name: "Bob", description: "Writes and reviews code" }), "artificier");
  assert.equal(avatarType({ name: "Alice", skills: ["security-audit"] }), "sentinelle");
});

test("avatar : le génome est stable et suit les données de l'agent", () => {
  const agent = { id: "a1", name: "Chef de Projet", provider: "anthropic", skills: ["a", "b", "c", "d", "e", "f", "g", "h"], subagents: [1, 2, 3, 4, 5] };
  const g1 = agentGenome(agent);
  const g2 = agentGenome({ ...agent });
  assert.deepEqual(g1, g2);
  assert.equal(g1.leds, 6, "voyants plafonnés à 6");
  assert.equal(g1.antennas, 3, "antennes plafonnées à 3");
  assert.equal(g1.metal, providerMetal("anthropic"));
  assert.ok(g1.hue >= 0 && g1.hue < 1);
  assert.notEqual(genomeKey(g1), genomeKey(agentGenome({ ...agent, id: "a2" })));
  assert.notEqual(genomeKey(g1), genomeKey(agentGenome({ ...agent, skills: [] })));
});
