import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { authPaths, initializeOwner, loadAuth, lockHome, maintenance, protectedRequired, recoverOwner, replaceSetupKey, reservePort } from "../src/auth-state.js";
import { AUTH_TEST_TMP, closeServer, email, fixture, httpCall, origin, password } from "./native-auth-fixture.js";
import { listenOwnerSocket, ownerRequest } from "../src/owner-transport.js";
import { createApp } from "../src/server.js";

test("private durable bootstrap, single-owner invariant, concurrent administration and partial-state refusal", async () => {
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-state-')); const release=lockHome(home);
  try {
    assert.throws(()=>lockHome(home),/busy/);
    const key=await initializeOwner(home,origin,email,password); assert.ok(key.length>=40);
    const p=authPaths(home);
    for(const path of [p.required,p.config,p.db]) assert.equal(lstatSync(path).mode & 0o777,0o600);
    assert.equal(lstatSync(p.directory).mode & 0o777,0o700);
    assert.ok(!readFileSync(p.config,'utf8').includes(password));
    const state=loadAuth(home);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM user').get() as {n:number}).n,1);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM session').get() as {n:number}).n,0);
    assert.throws(()=>state.db.exec(`INSERT INTO user SELECT 'other',name,email||'.other',emailVerified,image,createdAt,updatedAt,twoFactorEnabled FROM user`));
    state.db.close();
    await assert.rejects(initializeOwner(home,origin,email,password),/already exists/);
    rmSync(p.directory,{recursive:true}); assert.equal(protectedRequired(home),true); assert.throws(()=>loadAuth(home));
    unlinkSync(p.required); symlinkSync(join(home,'missing'),p.required); assert.equal(protectedRequired(home),true); assert.throws(()=>loadAuth(home));
  } finally { release();rmSync(home,{recursive:true,force:true}); }
});

test("offline recovery reset/write/cleanup faults retain maintenance and are rerunnable without losing replay", async () => {
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-recovery-'));const release=lockHome(home);
  try {
    await initializeOwner(home,origin,email,password);
    const p=authPaths(home); let db=new Database(p.db);
    db.prepare('INSERT INTO authReplay VALUES (?,?)').run('synthetic-digest',Date.now()+300000);
    db.exec(`CREATE TRIGGER failPassword BEFORE UPDATE OF password ON account BEGIN SELECT RAISE(ABORT,'synthetic reset fault'); END;`); db.close();
    await assert.rejects(recoverOwner(home,`${password}-new`));
    assert.ok(existsSync(p.maintenance)); assert.throws(()=>loadAuth(home),/AUTH_UNAVAILABLE/);
    db=new Database(p.db);db.exec('DROP TRIGGER failPassword');
    db.exec(`CREATE TRIGGER failCleanup BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT,'synthetic cleanup fault'); END;`);
    // Reset sessions itself is sequential too; force an actual revocation failure.
    db.prepare(`INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt,mfaApproved) VALUES ('fake','fake',?, ?, ?, ?, 0)`).run((db.prepare('SELECT id FROM user').get() as {id:string}).id,...Array(3).fill(new Date(Date.now()+60000).toISOString()));db.close();
    await assert.rejects(recoverOwner(home,`${password}-new`));assert.ok(existsSync(p.maintenance));assert.throws(()=>loadAuth(home));
    db=new Database(p.db);db.exec('DROP TRIGGER failCleanup');
    const owner=(db.prepare('SELECT id FROM user').get() as {id:string}).id;
    db.prepare('INSERT INTO twoFactor(id,secret,backupCodes,userId,verified,failedVerificationCount) VALUES (?,?,?,?,0,0)').run('synthetic-factor','synthetic-encrypted','synthetic-encrypted',owner);
    db.exec(`CREATE TRIGGER failFactorCleanup BEFORE DELETE ON twoFactor BEGIN SELECT RAISE(ABORT,'synthetic transactional cleanup fault'); END;`);db.close();
    await assert.rejects(recoverOwner(home,`${password}-new`));assert.ok(existsSync(p.maintenance));assert.throws(()=>loadAuth(home));
    db=new Database(p.db);assert.ok(db.prepare('SELECT 1 FROM twoFactor').get());db.exec('DROP TRIGGER failFactorCleanup');db.close();
    const replacement=await recoverOwner(home,`${password}-new`); assert.ok(replacement.length>=40);
    const state=loadAuth(home);assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM authReplay').get() as {n:number}).n,1);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM session').get() as {n:number}).n,0);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM verification').get() as {n:number}).n,0);
    state.db.close();assert.ok(!existsSync(p.maintenance));
    chmodSync(p.config,0o644);assert.throws(()=>loadAuth(home),/AUTH_UNAVAILABLE/);chmodSync(p.config,0o600);
    const key=replaceSetupKey(home); assert.notEqual(key,replacement);
  } finally { release();rmSync(home,{recursive:true,force:true}); }
});

test("one route registration, private Unix MCP, no TCP header bypass, explicit URL stays remote", async () => {
  const f=await fixture(); let socket;
  try {
    socket=await listenOwnerSocket(f.app,f.home);
    const path=authPaths(f.home).socket;
    assert.equal(lstatSync(path).mode & 0o777,0o600);
    const env={COGITATOR_HOME:f.home};
    const health=await ownerRequest<{ok:boolean}>('GET','/api/health',undefined,env);assert.equal(health.ok,true);
    assert.equal((await httpCall(f.port,'/api/health','GET',undefined,{'x-cogitator-owner':'true','x-cogitator-private':'true','x-forwarded-for':'127.0.0.1'})).status,401);
    assert.equal((await httpCall(f.port,'/api/health','GET',undefined,{origin},path)).status,403);
    assert.equal((await httpCall(f.port,'/api/health','GET',undefined,{origin:''},path)).status,403);
    assert.equal((await httpCall(f.port,'/api/health','GET',undefined,{'sec-fetch-site':'same-origin'},path)).status,403);
    assert.equal((await httpCall(f.port,'/api/auth/status','GET',undefined,{},path)).status,403);
    await assert.rejects(ownerRequest('GET','/api/health',undefined,{...env,COGITATOR_URL:`http://127.0.0.1:${f.port}`}),/FORBIDDEN/);
    await assert.rejects(listenOwnerSocket(f.app,f.home),/already live/);
    await assert.rejects(reservePort(f.port),/EADDRINUSE/);
    assert.equal(f.spawns(),0);
  } finally { if(socket)await closeServer(socket);await f.close(); }
});

test("local-mode instance observes newly required marker without restarting; protected data loss never downgrades", async () => {
  const f=await fixture();
  const localHome=join(f.home,'local');mkdirSync(localHome,{mode:0o700});
  const local=createApp({db:f.db,dbPath:f.paths.db,dbVersion:1,paths:{...f.paths,home:localHome},pool:f.pool});
  await new Promise<void>(done=>local.listen(0,'127.0.0.1',done));
  const port=(local.address() as {port:number}).port;
  try {
    assert.equal((await httpCall(port,'/api/status')).data.authentication,'local');
    writeFileSync(authPaths(localHome).required,'required',{mode:0o600});
    assert.equal((await httpCall(port,'/api/health')).data.error,'AUTH_UNAVAILABLE');
    assert.equal((await httpCall(port,'/api/status')).status,503);
    maintenance(f.home);
    assert.equal((await httpCall(f.port,'/api/health')).status,503);
  } finally {await closeServer(local);await f.close();}
});

test("Unix socket setup owns cleanup across post-bind stat, chmod, write and fsync failures", async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { createServer, Server } = await import('node:http');
  const app = createServer();
  const home = mkdtempSync(join(AUTH_TEST_TMP, 'cog-socket-fault-'));
  const { directory, socket } = authPaths(home);
  mkdirSync(directory, { mode: 0o700 });
  const receipt = `${socket}.json`;
  const originalChmod = fs.chmodSync;
  const originalFsync = fs.fsyncSync;
  const originalStat = fs.lstatSync;
  const originalWrite = fs.writeFileSync;
  const originalListen = Server.prototype.listen;
  const listeners: InstanceType<typeof Server>[] = [];
  t.mock.method(Server.prototype, 'listen', function(this: InstanceType<typeof Server>, ...args: Parameters<typeof originalListen>) {
    listeners.push(this);
    return Reflect.apply(originalListen, this, args);
  });
  try {
    for (const fault of ['stat', 'chmod', 'write', 'receipt', 'directory'] as const) {
      const stat = t.mock.method(fs, 'lstatSync', (path: Parameters<typeof originalStat>[0]) => {
        if (fault === 'stat' && path === socket) throw new Error('synthetic stat failure');
        return originalStat(path);
      });
      const write = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof originalWrite>) => {
        if (fault === 'write' && typeof args[0] === 'number' && existsSync(receipt) && fs.fstatSync(args[0]).ino === originalStat(receipt).ino) {
          originalWrite(args[0], 'partial receipt');
          throw new Error('synthetic write failure');
        }
        return originalWrite(...args);
      });
      const chmod = t.mock.method(fs, 'chmodSync', (path: Parameters<typeof originalChmod>[0], mode: Parameters<typeof originalChmod>[1]) => {
        if (fault === 'chmod' && path === socket) throw new Error('synthetic chmod failure');
        return originalChmod(path, mode);
      });
      const fsync = t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if (fault === 'receipt' && existsSync(receipt) && fs.fstatSync(fd).ino === lstatSync(receipt).ino) throw new Error('synthetic receipt failure');
        if (fault === 'directory' && fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory failure');
        return originalFsync(fd);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(listenOwnerSocket(app, home), new RegExp(`synthetic ${fault} failure`));
        assert.equal(listeners.at(-1)?.listening, false, `${fault}: helper leaked a live listener`);
        assert.equal(existsSync(socket), false);
        assert.equal(existsSync(receipt), false);
      } finally { stat.mock.restore(); write.mock.restore(); chmod.mock.restore(); fsync.mock.restore(); syncBuiltinESMExports(); }
    }
    const retry = await listenOwnerSocket(app, home);
    await closeServer(retry);
  } finally {
    for (const listener of listeners) if (listener.listening) { listener.closeAllConnections(); await closeServer(listener); }
    t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true });
  }
});


test("SIGKILL after Unix bind without an ownership receipt stays fail-closed and is not auto-unlinked", async()=>{
  const {spawn}=await import('node:child_process');
  const {createServer}=await import('node:http');
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-socket-kill-'));
  const {directory,socket}=authPaths(home);mkdirSync(directory,{mode:0o700});
  const child=spawn(process.execPath,['--input-type=module','-e',
    'import {createServer} from "node:net"; import {chmodSync} from "node:fs"; createServer().listen(process.argv[1],()=>{chmodSync(process.argv[1],0o600);process.stdout.write("bound\\n");});',socket],{stdio:['ignore','pipe','pipe']});
  const exited=new Promise<void>(done=>child.once('exit',()=>done()));
  try {
    await new Promise<void>((done,reject)=>{child.stdout.once('data',()=>done());child.once('error',reject);child.once('exit',()=>reject(new Error('fixture exited before bind')));});
    child.kill('SIGKILL');await exited;
    const before=lstatSync(socket);assert.equal(existsSync(`${socket}.json`),false);
    await assert.rejects(listenOwnerSocket(createServer(),home),/ENOENT/);
    assert.equal(lstatSync(socket).ino,before.ino);
  } finally {if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await exited;}rmSync(home,{recursive:true,force:true});}
});

test("owner socket UTF-8 path limit rejects before bind or bootstrap markers, with no truncated inode", async(t)=>{
  const {validateOwnerSocketPath}=await import('../src/auth-state.js');
  const {createServer,Server}=await import('node:http');
  const {readdirSync}=await import('node:fs');
  const root=mkdtempSync(join(AUTH_TEST_TMP,'cog-sun-'));
  const app=createServer();
  const boundaryNameBytes=103-Buffer.byteLength(authPaths(root).socket)-1;
  const boundaryHome=join(root,'a'.repeat(boundaryNameBytes));
  assert.equal(Buffer.byteLength(authPaths(boundaryHome).socket),103);
  assert.doesNotThrow(()=>validateOwnerSocketPath(boundaryHome));
  const listen=t.mock.method(Server.prototype,'listen',function(){throw new Error('oversized path reached native bind');});
  try {
    for(const home of [join(root,'a'.repeat(boundaryNameBytes+1)),join(root,'é'.repeat(boundaryNameBytes))]) {
      const paths=authPaths(home);
      assert.ok(Buffer.byteLength(paths.socket)>103);
      if(home.includes('é'))assert.ok(paths.socket.length<=103,'fixture distinguishes bytes from JS string length');
      mkdirSync(home,{mode:0o700});
      await assert.rejects(initializeOwner(home,origin,email,password),/103 UTF-8 bytes/);
      assert.equal(existsSync(paths.required),false);assert.equal(existsSync(paths.maintenance),false);assert.equal(existsSync(paths.directory),false);
      mkdirSync(paths.directory,{mode:0o700});
      const before=readdirSync(root,{recursive:true});
      await assert.rejects(listenOwnerSocket(app,home),/103 UTF-8 bytes/);
      await assert.rejects(ownerRequest('GET','/api/health',undefined,{COGITATOR_HOME:home}),/103 UTF-8 bytes/);
      assert.equal(listen.mock.callCount(),0);assert.deepEqual(readdirSync(root,{recursive:true}),before);
    }
    listen.mock.restore();
    mkdirSync(authPaths(boundaryHome).directory,{recursive:true,mode:0o700});
    const server=await listenOwnerSocket(app,boundaryHome);assert.ok(existsSync(authPaths(boundaryHome).socket));await closeServer(server);
  } finally {listen.mock.restore();rmSync(root,{recursive:true,force:true});}
});
