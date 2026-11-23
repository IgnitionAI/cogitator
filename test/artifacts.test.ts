import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db.js";
import { Artifacts } from "../src/artifacts.js";
import { artifactHeaders } from "../src/artifacts-http.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  const { db } = openDb(join(home, "db.sqlite"));
  const agent = randomUUID(), conv = randomUUID(), other = randomUUID();
  db.prepare("INSERT INTO agent_preset(id,slug,name,provider,model) VALUES (?,?,?,?,?)").run(agent, "a", "A", "fake", "fake");
  db.prepare("INSERT INTO conversation(id,agent_id,provider,model) VALUES (?,?,?,?)").run(conv, agent, "fake", "fake");
  db.prepare("INSERT INTO conversation(id,agent_id,provider,model) VALUES (?,?,?,?)").run(other, agent, "fake", "fake");
  return { home, db, agent, conv, other, store: new Artifacts(home, db) };
}
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

test("artifacts: publish, version by title or id, and read back each version", () => {
  const f = setup();
  try {
    const first = f.store.publish({ conversationId: f.conv, title: "Rapport", filename: "rapport.md", content: b64("# v1") });
    assert.equal(first.version, 1);
    assert.equal(first.artifact.kind, "markdown");
    assert.equal(first.artifact.agent_id, f.agent);
    const second = f.store.publish({ conversationId: f.conv, title: "Rapport", filename: "rapport.md", content: b64("# v2"), note: "corrections" });
    assert.equal(second.artifact.id, first.artifact.id);
    assert.equal(second.version, 2);
    const third = f.store.publish({ conversationId: f.conv, id: first.artifact.id, title: "Rapport final", filename: "x.md", content: b64("# v3") });
    assert.equal(third.version, 3);
    assert.equal(f.store.get(first.artifact.id).title, "Rapport final");
    assert.equal(f.store.content(first.artifact.id, 1).bytes.toString(), "# v1");
    assert.equal(f.store.content(first.artifact.id).bytes.toString(), "# v3");
    assert.equal(f.store.list({ conversationId: f.conv }).length, 1);
    assert.equal(statSync(join(f.home, "artifacts")).mode & 0o777, 0o700);
    // Une autre conversation ne peut pas ajouter de version à cet artifact.
    assert.throws(() => f.store.publish({ conversationId: f.other, id: first.artifact.id, title: "x", filename: "x.md", content: b64("y") }), /ARTIFACT_ACCESS_DENIED/);
  } finally { f.db.close(); }
});

test("artifacts: type, size and input checks", () => {
  const f = setup();
  try {
    assert.throws(() => f.store.publish({ conversationId: f.conv, title: "x", filename: "run.sh", content: b64("rm -rf /") }), /ARTIFACT_TYPE_UNSUPPORTED/);
    assert.throws(() => f.store.publish({ conversationId: f.conv, title: "x", filename: "a.html", content: "" }), /ARTIFACT_EMPTY/);
    assert.throws(() => f.store.publish({ conversationId: randomUUID(), title: "x", filename: "a.html", content: b64("<p>") }), /ARTIFACT_CONVERSATION_NOT_FOUND/);
    const page = f.store.publish({ conversationId: f.conv, title: "Page", filename: "index.html", content: b64("<h1>Hi</h1>") });
    assert.equal(page.artifact.kind, "html");
    f.store.rename(page.artifact.id, { title: "Accueil" });
    assert.equal(f.store.get(page.artifact.id).title, "Accueil");
    f.store.remove(page.artifact.id);
    assert.throws(() => f.store.get(page.artifact.id), /ARTIFACT_NOT_FOUND/);
  } finally { f.db.close(); }
});

test("artifacts: content is always served in a CSP sandbox, framable only by Cogitator", () => {
  const html = artifactHeaders("html", "text/html; charset=utf-8");
  assert.match(html["content-security-policy"]!, /^sandbox allow-scripts/);
  assert.doesNotMatch(html["content-security-policy"]!, /allow-same-origin/);
  assert.match(html["content-security-policy"]!, /frame-ancestors 'self'/);
  assert.equal(html["x-frame-options"], "SAMEORIGIN");
  assert.equal(html["x-content-type-options"], "nosniff");
  const svg = artifactHeaders("image", "image/svg+xml");
  assert.match(svg["content-security-policy"]!, /^sandbox; default-src 'none'/);
});
