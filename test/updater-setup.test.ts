import assert from "node:assert/strict";
import test from "node:test";

import { updaterSetupCommand } from "../src/self-update.js";

const base = { root: "/opt/cogitator/current", home: "/var/lib/cogitator", port: 5320, user: "cogitator", platform: "linux" as const, env: {} };

test("updater setup: prefilled command for a systemd release", () => {
  const cmd = updaterSetupCommand({ ...base, support: { supported: false, reason: "NOT_PI_MANAGED" }, cgroup: () => "0::/system.slice/cogitator.service\n" });
  assert.equal(cmd, "sudo node /opt/cogitator/current/dist/src/updater/cogitator-updater.js install --user cogitator --unit cogitator.service --home /var/lib/cogitator --port 5320");
});

test("updater setup: unit read from the cgroup, env override, safe quoting", () => {
  const fromCgroup = updaterSetupCommand({ ...base, support: { supported: false, reason: "SERVICE_MANAGED" }, cgroup: () => "0::/system.slice/my-cogitator.service" });
  assert.match(fromCgroup!, /--unit my-cogitator\.service /);
  const fromEnv = updaterSetupCommand({ ...base, env: { COGITATOR_SERVICE_UNIT: "cg.service" }, support: { supported: false, reason: "SERVICE_MANAGED" }, cgroup: () => "0::/system.slice/other.service" });
  assert.match(fromEnv!, /--unit cg\.service /);
  const fallback = updaterSetupCommand({ ...base, support: { supported: false, reason: "NOT_PI_MANAGED" }, cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice" });
  assert.match(fallback!, /--unit cogitator\.service /);
  const spaced = updaterSetupCommand({ ...base, home: "/srv/my data", support: { supported: false, reason: "NOT_PI_MANAGED" }, cgroup: () => "" });
  assert.match(spaced!, /--home '\/srv\/my data' /);
});

test("updater setup: nothing to show when one-click works or cannot apply", () => {
  assert.equal(updaterSetupCommand({ ...base, support: { supported: true, mode: "updater" } }), null);
  assert.equal(updaterSetupCommand({ ...base, support: { supported: false, reason: "SOURCE_BUILD" } }), null);
  assert.equal(updaterSetupCommand({ ...base, root: null, support: { supported: false, reason: "NOT_PI_MANAGED" } }), null);
  assert.equal(updaterSetupCommand({ ...base, platform: "darwin", support: { supported: false, reason: "NOT_PI_MANAGED" } }), null);
});
