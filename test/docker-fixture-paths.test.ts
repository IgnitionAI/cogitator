import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkerContainerSpec } from "../src/execution/container.js";
import { daemonFixtureSource, fixtureRootsFromEnv } from "./helpers/docker-fixture-paths.js";

const home = mkdtempSync(join(process.cwd(), ".fixture-mapping-"));
test.after(() => rmSync(home, { recursive: true, force: true }));
const controller = join(home, "controller");
mkdirSync(controller);
const roots = { controller: realpathSync(controller), daemon: "/daemon-only/fixtures" };

test("fixture Docker : défaut local inchangé", () => {
  assert.equal(fixtureRootsFromEnv({}), undefined);
  assert.equal(daemonFixtureSource("/local/workspace"), "/local/workspace");
});

test("fixture Docker : mapping exact et daemon sans realpath contrôleur", () => {
  assert.deepEqual(fixtureRootsFromEnv({
    COGITATOR_TEST_CONTROLLER_ROOT: controller,
    COGITATOR_TEST_DAEMON_ROOT: roots.daemon,
  }), roots);
  assert.equal(daemonFixtureSource(join(roots.controller, "run/enrolled/ws"), roots), "/daemon-only/fixtures/run/enrolled/ws");
  assert.equal(daemonFixtureSource(roots.controller, roots), roots.daemon);
});

test("fixture Docker : racine voisine, sortie et source relative refusées", () => {
  assert.throws(() => daemonFixtureSource(`${roots.controller}-neighbor/ws`, roots), /hors de la racine/);
  assert.throws(() => daemonFixtureSource(join(roots.controller, "../outside"), roots), /hors de la racine/);
  assert.throws(() => daemonFixtureSource("relative/ws", roots), /non absolue/);
});

test("fixture Docker : configuration partielle ou non absolue refusée", () => {
  const invalidConfigurations = [
    { COGITATOR_TEST_CONTROLLER_ROOT: controller },
    { COGITATOR_TEST_DAEMON_ROOT: roots.daemon },
    { COGITATOR_TEST_CONTROLLER_ROOT: "relative", COGITATOR_TEST_DAEMON_ROOT: roots.daemon },
    { COGITATOR_TEST_CONTROLLER_ROOT: controller, COGITATOR_TEST_DAEMON_ROOT: "relative" },
    { COGITATOR_TEST_CONTROLLER_ROOT: "", COGITATOR_TEST_DAEMON_ROOT: roots.daemon },
  ];
  for (const env of invalidConfigurations) {
    assert.throws(() => fixtureRootsFromEnv(env), /deux racines absolues requises/);
  }
});

test("fixture Docker : racine contrôleur symlink canonicalisée", () => {
  const alias = join(home, "alias");
  symlinkSync(controller, alias);
  assert.deepEqual(fixtureRootsFromEnv({
    COGITATOR_TEST_CONTROLLER_ROOT: alias,
    COGITATOR_TEST_DAEMON_ROOT: roots.daemon,
  }), roots);
});

test("fixture Docker : symlink sortant refusé par l'enrôlement avant traduction", () => {
  const outside = join(home, "outside");
  mkdirSync(outside);
  const escape = join(controller, "escape");
  symlinkSync(outside, escape);
  const built = buildWorkerContainerSpec({
    image: "alpine:3", name: "mapping-test", command: [],
    workspaceMount: { source: escape, target: "/workspace" },
  }, { remote: true, enrolledRoots: [controller] });
  assert.ok("error" in built);
  assert.match(built.error, /symlink hors de la racine/);
  assert.throws(() => daemonFixtureSource(realpathSync(escape), roots), /hors de la racine/);
});
