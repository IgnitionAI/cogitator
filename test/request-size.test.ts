import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";
import { AuthError } from "../src/native-auth.js";
import { readBody } from "../src/request-body.js";

let home: string;
let db: ReturnType<typeof openDb>["db"];
let server: ReturnType<typeof createApp>;
let port: number;

const OVERSIZE = 100 * 1024;

function oversizedJson(): string {
  return JSON.stringify({ name: "pad", action: "install", pad: "x".repeat(OVERSIZE) });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "cog-reqsize-"));
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  server = createApp({
    db,
    dbPath: join(home, "cogitator.db"),
    dbVersion: opened.version,
    paths: getPaths({ COGITATOR_HOME: home }),
    pool: new PiPool({ factory: () => { throw new Error("request-size tests must not spawn pi"); } }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server?.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("POST d'une route JSON par défaut refuse un corps ~100 Kio (413), sans le tamponner jusqu'à 130 Mo", async () => {
  const payload = oversizedJson();
  assert.ok(Buffer.byteLength(payload) > 64 * 1024);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/packages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 413);
    const body = await res.json() as { error?: string };
    assert.ok(body.error);
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /fetch failed|aborted|ECONNRESET|socket/i);
  }
});

test("POST /api/conversations/:id/messages accepte un corps ~100 Kio (route images : pas 413)", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/conversations/missing/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ok", pad: "x".repeat(OVERSIZE) }),
  });
  assert.notEqual(res.status, 413);
  assert.ok(res.status === 404 || res.status === 400);
});

test("dépassement : le serveur coupe le flux (req.destroy) au lieu de continuer à lire", async () => {
  let destroyed = false;
  const req = new EventEmitter() as InstanceType<typeof IncomingMessage> & EventEmitter;
  req.destroy = (() => {
    destroyed = true;
    return req;
  }) as InstanceType<typeof IncomingMessage>["destroy"];
  req.headers = {};
  req.pause = (() => req) as InstanceType<typeof IncomingMessage>["pause"];
  const pending = readBody(req, 64);
  req.emit("data", Buffer.from("x".repeat(80)));
  await assert.rejects(pending, (err: unknown) => err instanceof AuthError && err.status === 413);
  assert.equal(destroyed, true);
});
