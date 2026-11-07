import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubLogin, deviceCode, githubEnv } from "../src/github-login.js";
import { getPaths } from "../src/paths.js";

test("only device codes are extracted; unrelated credentials and output are not exposed", () => {
  assert.equal(deviceCode("! First copy your one-time code: ABCD-1234\nPress Enter"), "ABCD-1234");
  assert.equal(deviceCode("oauth_token: secret-value"), undefined);
});
test("isolated login parses split output, verifies account, protects config and can cancel", async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-gh-login-"));
  const paths = getPaths({ HOME: home, COGITATOR_HOME: home });
  const previousPath = process.env.PATH; const previousToken = process.env.GH_TOKEN;
  writeFileSync(join(home, "gh"), `#!/bin/sh
if [ "$1" = api ]; then
 if [ -f "$GH_CONFIG_DIR/hosts.yml" ]; then echo test-owner; exit 0; fi
 exit 1
fi
printf '! First copy your one-time code: ABCD-' >&2
sleep 0.1
printf '1234\n' >&2
read answer
sleep 0.2
printf 'fixture-no-secret' > "$GH_CONFIG_DIR/hosts.yml"
`, { mode: 0o700 });
  process.env.PATH = home + ":" + previousPath; process.env.GH_TOKEN = "ambient-not-for-this-installation";
  const login = new GitHubLogin(paths);
  try {
    assert.equal(githubEnv(paths).GH_TOKEN, undefined);
    assert.equal((await login.state()).connected, false);
    assert.equal(login.start().status, "starting");
    let state = await login.state();
    for (let i = 0; i < 30 && !state.connected; i++) { await new Promise(r => setTimeout(r, 30)); state = await login.state(); }
    assert.equal(state.connected, true); assert.equal(state.login, "test-owner");
    assert.equal(state.code, undefined);
    assert.equal(statSync(join(home, "github")).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "github/hosts.yml")).mode & 0o777, 0o600);
    login.start(); login.cancel();
    assert.notEqual((await login.state()).status, "waiting");
  } finally { login.cancel(); process.env.PATH = previousPath; if (previousToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousToken; }
});
