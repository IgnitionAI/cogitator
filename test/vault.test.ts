import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { parseCsv, parseGooglePasswordsCsv, siteMatches, Vault } from "../src/vault.js";
import { SharedBrowser } from "../src/shared-browser.js";
import { parseUI, parseUIResponse, serializeUIResponse } from "../src/generative-ui.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "vault-test-"));
  const { db } = openDb(join(home, "db.sqlite"));
  const agent = randomUUID(), other = randomUUID(), conv = randomUUID(), otherConv = randomUUID();
  for (const [id, name] of [[agent, "allowed"], [other, "other"]]) db.prepare("INSERT INTO agent_preset(id,slug,name,provider,model) VALUES (?,?,?,?,?)").run(id, name, name, "fake", "fake");
  db.prepare("INSERT INTO conversation(id,agent_id,provider,model) VALUES (?,?,?,?)").run(conv, agent, "fake", "fake");
  db.prepare("INSERT INTO conversation(id,agent_id,provider,model) VALUES (?,?,?,?)").run(otherConv, other, "fake", "fake");
  return { home, db, agent, other, conv, otherConv, vault: new Vault(home, db, {}) };
}

const GOOGLE = `name,url,username,password,note
github.com,https://github.com/login,octo,"p@ss,word ""1""",
Bank,https://secure.bank.example/,me@x.io,"multi
line",a note
broken,,user,nopass,
nope,https://nopass.example,user,,
`;

test("vault: CSV parsing handles quotes, commas, newlines and Google columns", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n1,2,3'), [["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  const { entries, invalid } = parseGooglePasswordsCsv(GOOGLE);
  assert.equal(entries.length, 2);
  assert.equal(invalid, 2);
  assert.equal(entries[0]!.password, 'p@ss,word "1"');
  assert.equal(entries[1]!.password, "multi\nline");
  assert.throws(() => parseGooglePasswordsCsv("a,b\n1,2"), /VAULT_IMPORT_FORMAT/);
});

test("vault: site matching accepts the host and its subdomains only", () => {
  assert.ok(siteMatches("github.com", "https://github.com/login"));
  assert.ok(siteMatches("github.com", "https://www.github.com/"));
  assert.ok(siteMatches("google.com", "https://accounts.google.com/signin"));
  assert.ok(!siteMatches("github.com", "https://github.com.evil.example/"));
  assert.ok(!siteMatches("github.com", "https://evilgithub.com/"));
  assert.ok(!siteMatches("github.com", "file:///etc/passwd"));
});

test("vault: encrypted at rest, private file modes, passwords never listed", () => {
  const f = setup();
  try {
    const entry = f.vault.create({ url: "github.com", username: "octo", password: "S3cret-value", note: "pin 1234", agentIds: [f.agent] });
    assert.equal(entry.host, "github.com");
    assert.equal(JSON.stringify(f.vault.list()).includes("S3cret-value"), false);
    assert.equal(JSON.stringify(f.vault.list()).includes("pin 1234"), false);
    const disk = readFileSync(join(f.home, "vault.json"), "utf8");
    assert.equal(disk.includes("S3cret-value"), false);
    assert.equal(disk.includes("pin 1234"), false);
    assert.equal(statSync(join(f.home, "vault.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.home, "vault.key")).mode & 0o777, 0o600);
    assert.deepEqual(f.vault.reveal(entry.id), { password: "S3cret-value", note: "pin 1234" });
    // Survit au redémarrage avec la même clé.
    assert.equal(new Vault(f.home, f.db, {}).reveal(entry.id).password, "S3cret-value");
    // Mise à jour sans mot de passe : il ne change pas.
    f.vault.update(entry.id, { username: "octo2" });
    assert.equal(f.vault.reveal(entry.id).password, "S3cret-value");
    assert.throws(() => f.vault.create({ url: "javascript:alert(1)", password: "x" }), /VAULT_URL_INVALID/);
    assert.throws(() => f.vault.create({ url: "a.example", password: "x", agentIds: [randomUUID()] }), /VAULT_AGENT_NOT_FOUND/);
  } finally { f.db.close(); }
});

test("vault: Google import, duplicates and overwrite", () => {
  const f = setup();
  try {
    assert.deepEqual(f.vault.importGoogle({ csv: GOOGLE, allAgents: true }), { added: 2, updated: 0, skipped: 0, invalid: 2 });
    assert.deepEqual(f.vault.importGoogle({ csv: GOOGLE, allAgents: true }), { added: 0, updated: 0, skipped: 2, invalid: 2 });
    const changed = GOOGLE.replace('"p@ss,word ""1"""', "new-pass");
    assert.deepEqual(f.vault.importGoogle({ csv: changed, overwrite: true }), { added: 0, updated: 2, skipped: 0, invalid: 2 });
    const github = f.vault.list().find((e) => e.host === "github.com")!;
    assert.equal(f.vault.reveal(github.id).password, "new-pass");
    assert.equal(github.source, "import");
  } finally { f.db.close(); }
});

test("vault: agents only get references, and credentials only for allowed agents on the right site", () => {
  const f = setup();
  try {
    const mine = f.vault.create({ url: "https://github.com", username: "octo", password: "pw1", agentIds: [f.agent] });
    const shared = f.vault.create({ url: "https://bank.example", username: "me", password: "pw2", allAgents: true });
    const listed = f.vault.forConversation(f.conv);
    assert.deepEqual(listed.map((e) => e.id).sort(), [`secret:${mine.id}`, `secret:${shared.id}`].sort());
    assert.equal(JSON.stringify(listed).includes("pw1"), false);
    assert.deepEqual(f.vault.forConversation(f.otherConv).map((e) => e.id), [`secret:${shared.id}`]);
    assert.deepEqual(f.vault.forConversation(f.conv, "https://github.com/login").map((e) => e.id), [`secret:${mine.id}`]);
    assert.equal(f.vault.credentialFor(`secret:${mine.id}`, f.conv, "https://github.com/login").password, "pw1");
    assert.throws(() => f.vault.credentialFor(mine.id, f.otherConv, "https://github.com/login"), /VAULT_ACCESS_DENIED/);
    assert.throws(() => f.vault.credentialFor(mine.id, f.conv, "https://github.com.evil.example/login"), /VAULT_SITE_MISMATCH/);
    assert.ok(f.vault.list().find((e) => e.id === mine.id)!.last_used_at);
  } finally { f.db.close(); }
});

test("generative UI: a secret request answers with a vault reference only", () => {
  const spec = { version: 1, id: "github-login", kind: "secret", title: "Connexion GitHub", site: "https://github.com/login", username: "octo" };
  const parsed = parseUI(JSON.stringify(spec));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const reference = `secret:${randomUUID()}`;
  const text = serializeUIResponse(parsed.value, { secret: reference, username: "octo" });
  assert.equal(parseUIResponse(text)?.values.secret, reference);
  assert.throws(() => serializeUIResponse(parsed.value, { secret: reference, password: "leak" }), /Champ inconnu/);
  assert.throws(() => serializeUIResponse(parsed.value, { secret: "pw-in-clear" }), /Référence de secret invalide/);
  assert.equal(parseUI(JSON.stringify({ ...spec, site: "javascript:alert(1)" })).ok, false);
});

const real = process.env.COGITATOR_BROWSER_TESTS === "1";
test("real Chromium: the server types a saved login, reads and screenshots never leak it", { skip: !real, timeout: 60000 }, async () => {
  const f = setup();
  const browser = new SharedBrowser(f.home, f.db, undefined, f.vault);
  const http = httpServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<html><body><form><label>Email <input type="email" name="email"></label><label>Mot de passe <input id="pw" type="password" name="pw"></label>
      <button type="button" id="peek" onclick="document.getElementById('pw').type='text'">Afficher</button></form></body></html>`);
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/login`;
  try {
    const entry = f.vault.create({ url, username: "octo@example.com", password: "Sup3r-S3cret!", agentIds: [f.agent] });
    const other = f.vault.create({ url: "https://github.com", username: "x", password: "other", allAgents: true });
    const profile = browser.create({ name: "Dev", agentIds: [f.agent, f.other] });
    await browser.control(profile.id, false);
    await browser.act(profile.id, { action: "open", url }, f.conv);
    const tab = (await browser.tabs(profile.id)).at(-1)!;
    const listed = await browser.act(profile.id, { action: "secrets", tabId: tab.id }, f.conv) as { secrets: Array<{ id: string }> };
    assert.deepEqual(listed.secrets.map((s) => s.id), [`secret:${entry.id}`]);
    await assert.rejects(browser.act(profile.id, { action: "login", tabId: tab.id, secret: `secret:${entry.id}` }, f.otherConv), /ACCESS_DENIED/);
    await assert.rejects(browser.act(profile.id, { action: "login", tabId: tab.id, secret: `secret:${other.id}` }, f.conv), /SITE_MISMATCH/);
    const result = await browser.act(profile.id, { action: "login", tabId: tab.id, secret: `secret:${entry.id}` }, f.conv);
    assert.deepEqual((result as { filled: string[] }).filled, ["username", "password"]);
    assert.equal(JSON.stringify(result).includes("Sup3r-S3cret!"), false);
    const read = JSON.stringify(await browser.act(profile.id, { action: "read", tabId: tab.id }, f.conv));
    assert.match(read, /octo@example\.com/);
    assert.equal(read.includes("Sup3r-S3cret!"), false);
    // Même si l'agent fait apparaître le mot de passe en clair, la lecture le masque et la capture est refusée.
    await browser.act(profile.id, { action: "click", tabId: tab.id, selector: "#peek" }, f.conv);
    assert.equal(JSON.stringify(await browser.act(profile.id, { action: "read", tabId: tab.id }, f.conv)).includes("Sup3r-S3cret!"), false);
    await assert.rejects(browser.act(profile.id, { action: "screenshot", tabId: tab.id }, f.conv), /SECRET_VISIBLE/);
    // Un agent ne peut toujours pas taper lui-même dans un champ mot de passe.
    await browser.act(profile.id, { action: "navigate", tabId: tab.id, url }, f.conv);
    await assert.rejects(browser.act(profile.id, { action: "fill", tabId: tab.id, selector: "#pw", text: "x" }, f.conv), /SECRET_TAKEOVER/);
  } finally { await browser.dispose(); http.close(); f.db.close(); }
});
