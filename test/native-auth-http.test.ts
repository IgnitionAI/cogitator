import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAuth, recoverOwner } from "../src/auth-state.js";
import { createConversation } from "../src/conversations.js";
import { request } from "node:http";
import { authenticated, closeServer, email, enroll, fixture, httpCall, origin, password } from "./native-auth-fixture.js";

test("all registered application routes reject anonymous and password-only requests before side effects", async () => {
  const f = await fixture();
  try {
    const browser = f.browser(); await browser.login();
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const routes = [...source.matchAll(/\["(GET|POST|PUT|DELETE)", "(\/api\/[^"\n]+)"/g)];
    assert.ok(routes.length > 40);
    for (const [, method, pattern] of routes) {
      const path = pattern!.replace(/:[A-Za-z]+/g, "missing");
      const body = method === "GET" ? undefined : {};
      assert.equal((await httpCall(f.port, path, method, body)).status, 401, `${method} ${path} anonymous`);
      assert.equal((await httpCall(f.port, path, method, body, { cookie: browser.cookie() })).status, 403, `${method} ${path} pre-MFA`);
    }
    for (const path of ["/api/health", "/api/fs/browse?path=/", "/secret.json", "/unknown-spa", "/icon.png"]) assert.equal((await httpCall(f.port,path)).status,401,path);
    assert.equal(f.spawns(), 0);
    assert.equal((await httpCall(f.port,"/api/status","GET",undefined,{host:`127.0.0.1:${f.port}`})).status,200);
    assert.equal((await httpCall(f.port,"/api/status")).text, '{"service":"cogitator","authentication":"required"}');
    assert.equal((await httpCall(f.port,"/api/auth/status")).text, '{"mode":"protected","state":"anonymous"}');
    assert.equal((await httpCall(f.port,"/")).status,200);
    for (const path of ["/api/auth/sign-up/email", "/api/auth/organization/create", "/api/auth/organization/accept-invitation", "/api/auth/request-password-reset", "/api/auth/reset-password", "/api/auth/admin/create-user", "/api/auth/sign-in/social", "/api/auth/sign-in/magic-link"]) assert.equal((await httpCall(f.port,path,"POST",{email,password,name:"Other"})).status,404,path);
  } finally { await f.close(); }
});

test("strict Host, Origin, route/body allowlist and safe library projection", async () => {
  const f = await fixture();
  try {
    const path = "/api/auth/sign-in/email";
    for (const headers of [{ host:"evil.invalid" }, { origin:"https://evil.invalid" }, { origin:"" }, { "content-type":"text/plain" }, { "sec-fetch-site":"cross-site" }]) {
      const r = await httpCall(f.port,path,"POST",{email,password},headers); assert.ok([400,403].includes(r.status));
    }
    for (const alias of ["/api/auth//sign-in/email","/api/auth/sign-in/email/","/api/auth/%73ign-in/email","/api/../api/auth/sign-in/email","/api/auth/sign-in/email?x=1"]) assert.ok([400,404].includes((await httpCall(f.port,alias,"POST",{email,password})).status),alias);
    for (const extra of [{rememberMe:true},{callbackURL:origin},{mfaApproved:true}]) assert.equal((await httpCall(f.port,path,"POST",{email,password,...extra})).data.error,"INVALID_INPUT");
    assert.equal((await httpCall(f.port,path,"POST","{" )).data.error,"INVALID_INPUT");
    const browser = f.browser(); const signed = await browser.login();
    assert.deepEqual(signed.data,{twoFactorRequired:false});
    assert.ok(signed.headers["set-cookie"]?.length);
    for (const cookie of signed.headers["set-cookie"] ?? []) { assert.match(cookie,/HttpOnly/i); assert.match(cookie,/Secure/i); assert.doesNotMatch(cookie,/Domain=/i); }
    assert.equal(signed.headers["cache-control"],"no-store");
    assert.doesNotMatch(signed.text,/token|mfaApproved/i);
    for (const endpoint of ["verify-totp","verify-backup-code"]) {
      assert.equal((await browser.call(`/api/auth/two-factor/${endpoint}`,{code:"123456",trustDevice:true})).data.error,"INVALID_INPUT");
      assert.equal((await browser.call(`/api/auth/two-factor/${endpoint}`,{code:"123456",disableSession:true})).data.error,"INVALID_INPUT");
    }
    for (const endpoint of ["disable","get-totp-uri","send-otp","verify-otp"]) assert.equal((await browser.call(`/api/auth/two-factor/${endpoint}`,{})).status,404);
    const giant = await httpCall(f.port,path,"POST",{email,password:"x".repeat(9000)}); assert.equal(giant.status,413);
  } finally { await f.close(); }
});

test("selected enrollment requires private key; no stale-session promotion; lost enable response can regenerate", async () => {
  const f = await fixture();
  try {
    const a=f.browser(), b=f.browser(); await a.login(); await b.login();
    assert.equal((await a.call('/api/auth/two-factor/enable',{password})).data.error,'SETUP_KEY_INVALID');
    assert.equal((await a.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).status,200);
    const busy=await b.call('/api/auth/two-factor/enable',{password,setupKey:f.key});
    assert.equal(busy.data.error,'ENROLLMENT_BUSY'); assert.equal(typeof busy.data.retryAt,'string');
    f.resetRates();
    const regenerated=await a.call('/api/auth/two-factor/enable',{password}); assert.equal(regenerated.status,200);
    const { createOTP } = await import('@better-auth/utils/otp'); const { base32 }=await import('@better-auth/utils/base32');
    const otp=createOTP(new TextDecoder().decode(base32.decode(new URL(regenerated.data.totpURI as string).searchParams.get('secret')!)));
    assert.equal((await a.call('/api/auth/two-factor/verify-totp',{code:await otp.totp()})).text,'{"ok":true}');
    assert.equal((await a.call('/api/auth/status')).data.state,'reauthenticate');
    assert.equal((await b.call('/api/auth/status')).data.state,'reauthenticate');
    assert.equal((await a.call('/api/health')).status,403);
    assert.equal((await b.call('/api/health')).status,403);
    assert.equal((await a.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).data.error,'REAUTH_REQUIRED');
  } finally { await f.close(); }
});

test("fresh MFA, logout scope, session expiration, SSE revocation and listener cleanup", async () => {
  const f = await fixture();
  try {
    const { browser, backupCodes } = await authenticated(f);
    assert.equal((await browser.call('/api/auth/status')).data.state,'authenticated');
    assert.equal((await browser.call('/api/health')).status,200);
    const token=(f.state.db.prepare('SELECT token FROM session WHERE mfaApproved=1').get() as {token:string}).token;
    assert.equal((await httpCall(f.port,'/api/health','GET',undefined,{authorization:`Bearer ${token}`})).status,401);
    const second=f.browser(); f.resetRates(); await second.login();
    assert.deepEqual((await second.call('/api/auth/two-factor/verify-backup-code',{code:backupCodes[0]})).data,{ok:true});
    let ready!:()=>void; const started=new Promise<void>(done=>{ready=done;});
    let ended!:()=>void; const closed=new Promise<void>(done=>{ended=done;});
    const req=request({host:'127.0.0.1',port:f.port,path:'/api/events',headers:{host:new URL(origin).host,cookie:browser.cookie()}},res=>{res.on('data',()=>ready()); res.on('end',ended);res.on('close',ended);});
    req.end();
    // A first event flushes headers without waiting for the heartbeat.
    for(let i=0;i<50 && f.events.listenerCount('event')!==1;i++) await new Promise(done=>setTimeout(done,10));
    f.events.emit('event',{type:'synthetic'}); await started;
    assert.equal(f.events.listenerCount('event'),1);
    assert.equal((await browser.call('/api/auth/sign-out',{})).status,200);
    f.events.emit('event',{type:'must-not-leak'}); await closed;
    await new Promise(done=>setImmediate(done));
    assert.equal(f.events.listenerCount('event'),0);
    assert.equal((await browser.call('/api/health')).status,401);
    assert.equal((await second.call('/api/health')).status,200);
    f.state.db.prepare('UPDATE session SET expiresAt=?').run(new Date(Date.now()-1000).toISOString());
    assert.equal((await second.call('/api/health')).status,401);
    assert.equal(f.spawns(),0);
  } finally { await f.close(); }
});

test("persistent bounded rate buckets ignore attacker forwarding headers", async () => {
  const f=await fixture();
  try {
    for(let i=0;i<10;i++) await httpCall(f.port,'/api/auth/sign-in/email','POST',{email,password:'wrong-password'}, {'x-forwarded-for':`10.0.0.${i}`,'x-cogitator-peer':`${i}`});
    const limited=await httpCall(f.port,'/api/auth/sign-in/email','POST',{email,password});assert.equal(limited.status,429);assert.equal(limited.data.error,'RATE_LIMITED');
    assert.ok(f.state.db.prepare('SELECT count FROM authThrottle').get());
    f.state.db.close(); Object.assign(f.state,loadAuth(f.home));
    assert.equal((await httpCall(f.port,'/api/auth/sign-in/email','POST',{email,password})).status,429);
    chmodSync(join(f.home,'auth','config.json'),0o644);
    assert.equal((await httpCall(f.port,'/api/health')).status,503);
  } finally { await f.close(); }
});


test("authorization is fresh after body reads and before delayed protected content", async () => {
  const f=await fixture();
  try {
    const {browser,backupCodes}=await authenticated(f);
    const body=JSON.stringify({dir:f.home,name:'must not create'});
    let complete!: (value:number)=>void;
    const response=new Promise<number>(done=>{complete=done;});
    const req=request({host:'127.0.0.1',port:f.port,path:'/api/workspaces',method:'POST',headers:{host:new URL(origin).host,origin,cookie:browser.cookie(),'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>complete(res.statusCode!));});
    req.write(body.slice(0,5));
    await new Promise(done=>setTimeout(done,30));
    await browser.call('/api/auth/sign-out',{});
    req.end(body.slice(5));
    assert.equal(await response,401);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM workspace').get() as {n:number}).n,0);
    f.resetRates();await browser.login();await browser.call('/api/auth/two-factor/verify-backup-code',{code:backupCodes[0]});
    const conv=createConversation(f.db,{workspaceId:null,agentId:null,spawn:{provider:'synthetic',model:'synthetic'}});
    let finish!:()=>void; let waiting=false;
    f.pool.isStreaming=async()=>{waiting=true;await new Promise<void>(done=>{finish=done;});return false;};
    const pending=httpCall(f.port,`/api/conversations/${conv.id}`,'GET',undefined,{cookie:browser.cookie()});
    for(let i=0;i<50 && !waiting;i++)await new Promise(done=>setTimeout(done,10));
    assert.equal(waiting,true);await browser.call('/api/auth/sign-out',{});finish();
    const protectedResult=await pending;assert.equal(protectedResult.status,401);assert.ok(!('conversation' in protectedResult.data));

  } finally {await f.close();}
});

test("both SSE streams close on a silent revocation heartbeat without spawning a real provider", {timeout:22_000}, async () => {
  const f=await fixture();
  try {
    const {browser}=await authenticated(f);
    const conv=createConversation(f.db,{workspaceId:null,agentId:null,spawn:{provider:'synthetic',model:'synthetic'}});
    f.pool.ensure=async()=>({sessionFile:join(f.home,'synthetic.jsonl')});
    const streams=['/api/events',`/api/conversations/${conv.id}/events`].map(path=>new Promise<void>((done,reject)=>{
      const req=request({host:'127.0.0.1',port:f.port,path,headers:{host:new URL(origin).host,cookie:browser.cookie()}},res=>{res.resume();res.on('end',done);res.on('error',reject);});req.on('error',reject);req.end();
    }));
    for(let i=0;i<50 && f.events.listenerCount('event')!==1;i++)await new Promise(done=>setTimeout(done,10));
    f.events.emit('event',{type:'ready'});
    await new Promise(done=>setTimeout(done,30));
    f.state.db.exec('DELETE FROM session');
    await Promise.all(streams);
    assert.equal(f.events.listenerCount('event'),0);
    assert.equal(f.spawns(),0);
  } finally {await f.close();}
});


test("interrupted real enrollment factor activation fails closed into offline recovery", async () => {
  const f=await fixture();
  try {
    const b=f.browser();await b.login();
    const setup=await b.call('/api/auth/two-factor/enable',{password,setupKey:f.key});assert.equal(setup.status,200);
    const {createOTP}=await import('@better-auth/utils/otp');const {base32}=await import('@better-auth/utils/base32');
    const otp=createOTP(new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI as string).searchParams.get('secret')!)));
    f.state.db.exec(`CREATE TRIGGER failFactor BEFORE UPDATE OF verified ON twoFactor BEGIN SELECT RAISE(ABORT,'synthetic factor fault'); END;`);
    const failed=await b.call('/api/auth/two-factor/verify-totp',{code:await otp.totp()});assert.equal(failed.data.error,'AUTH_UNAVAILABLE');
    assert.equal((await b.call('/api/auth/status')).status,503);assert.equal((await b.call('/api/health')).status,503);
    assert.throws(()=>loadAuth(f.home),/AUTH_UNAVAILABLE/);
    assert.equal((f.state.db.prepare('SELECT COUNT(*) AS n FROM session WHERE mfaApproved=1').get() as {n:number}).n,0);
    f.state.db.exec('DROP TRIGGER failFactor');
    await closeServer(f.app);f.state.db.close();
    await recoverOwner(f.home,password);Object.assign(f.state,loadAuth(f.home));
    assert.equal((f.state.db.prepare('SELECT COUNT(*) AS n FROM session').get() as {n:number}).n,0);
  } finally {await f.close();}
});

test("expired/revoked enrollment claims can be reclaimed, but a live claim cannot be stolen", async()=>{
  const f=await fixture();
  try {
    const a=f.browser(), b=f.browser();await a.login();await b.login();
    assert.equal((await a.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).status,200);
    assert.equal((await b.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).data.error,'ENROLLMENT_BUSY');
    f.state.db.prepare('UPDATE authPolicy SET claimExpires=?').run(Date.now()-1);
    assert.equal((await b.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).status,200);
    f.resetRates();
    assert.equal((await a.call('/api/auth/two-factor/verify-totp',{code:'123456'})).data.error,'REAUTH_REQUIRED');
    await b.call('/api/auth/sign-out',{});
    assert.equal((await a.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).status,200);
    await a.call('/api/auth/sign-out',{});await a.login();f.resetRates();
    f.state.db.prepare('UPDATE authPolicy SET setupExpires=?').run(Date.now()-1);
    assert.equal((await a.call('/api/auth/two-factor/enable',{password,setupKey:f.key})).data.error,'SETUP_KEY_EXPIRED');
  } finally {await f.close();}
});

test("a lost enrollment-verification response requires fresh password/MFA, never upgrades an old cookie",async()=>{
  const f=await fixture();
  try {
    const a=f.browser();await a.login();
    const setup=await a.call('/api/auth/two-factor/enable',{password,setupKey:f.key});
    const {createOTP}=await import('@better-auth/utils/otp');const {base32}=await import('@better-auth/utils/base32');
    const otp=createOTP(new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI as string).searchParams.get('secret')!)));
    // Deliberately discard the rotated Set-Cookie, as a lost response would.
    assert.equal((await httpCall(f.port,'/api/auth/two-factor/verify-totp','POST',{code:await otp.totp()},{cookie:a.cookie()})).status,200);
    assert.equal((await a.call('/api/auth/status')).data.state,'anonymous');assert.equal((await a.call('/api/health')).status,401);
    f.resetRates();assert.deepEqual((await a.login()).data,{twoFactorRequired:true});
    assert.equal((await a.call('/api/auth/two-factor/verify-totp',{code:await otp.totp()})).status,200);
    assert.equal((await a.call('/api/auth/status')).data.state,'authenticated');
  } finally {await f.close();}
});

test("logout cannot acknowledge or clear cookies when the real library swallows a session-delete failure",async()=>{
  const f=await fixture();
  try {
    const {browser}=await authenticated(f);const cookie=browser.cookie();
    f.state.db.exec(`CREATE TRIGGER failLogout BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT,'synthetic logout deletion fault'); END;`);
    const failed=await browser.call('/api/auth/sign-out',{});
    assert.equal(failed.status,503);assert.equal(failed.data.error,'AUTH_UNAVAILABLE');assert.equal(failed.headers['set-cookie'],undefined);
    assert.equal(browser.cookie(),cookie,'must retain the cookie so deletion can be retried');
    f.state.db.exec('DROP TRIGGER failLogout');
    assert.deepEqual((await browser.call('/api/auth/sign-out',{})).data,{ok:true});
    assert.equal((await httpCall(f.port,'/api/health','GET',undefined,{cookie})).status,401);
  } finally {await f.close();}
});

test("backup-code replacement rechecks authority at the real SQL mutation after paused password verification",async()=>{
  for(const invalidate of ['logout','expiry'] as const) {
    const f=await fixture();let release:(()=>void)|undefined;
    try {
      const {browser}=await authenticated(f);f.resetRates();
      const context=await f.state.auth.$context;const original=context.password.checkPassword;
      const before=(f.state.db.prepare('SELECT backupCodes FROM twoFactor').get() as {backupCodes:string}).backupCodes;
      let reached!:()=>void;const paused=new Promise<void>(done=>{reached=done;});const wait=new Promise<void>(done=>{release=done;});
      context.password.checkPassword=async(...args)=>{const result=await original(...args);reached();await wait;return result;};
      const pending=browser.call('/api/auth/two-factor/generate-backup-codes',{password});await paused;
      if(invalidate==='logout')assert.equal((await browser.call('/api/auth/sign-out',{})).status,200);
      else f.state.db.prepare('UPDATE session SET expiresAt=?').run(new Date(Date.now()-1000).toISOString());
      release!();const response=await pending;
      assert.equal(response.status,401);
      assert.ok((f.state.db.prepare('SELECT backupCodes FROM twoFactor').get() as {backupCodes:string}).backupCodes===before,`${invalidate}: rejected request still replaced recovery codes`);
    } finally {release?.();await f.close();}
  }
});

test("logout revokes the signed temporary MFA challenge, including a captured-cookie replay",async()=>{
  const f=await fixture();
  try {
    const {browser,backupCodes}=await enroll(f);await browser.call('/api/auth/sign-out',{});f.resetRates();await browser.login();
    const cookie=browser.cookie();assert.ok([...browser.cookies.keys()].some(key=>key.includes('two_factor')));
    assert.equal((await browser.call('/api/auth/sign-out',{})).status,200);
    const replay=await httpCall(f.port,'/api/auth/two-factor/verify-backup-code','POST',{code:backupCodes[0]},{cookie});
    assert.equal(replay.status,401);assert.equal((await browser.call('/api/health')).status,401);
  } finally {await f.close();}
});

test("challenge deletion failure preserves cookies for an honest failed logout and successful retry",async()=>{
  const f=await fixture();
  try {
    const {browser,backupCodes}=await enroll(f);await browser.call('/api/auth/sign-out',{});f.resetRates();await browser.login();
    const cookie=browser.cookie();
    f.state.db.exec(`CREATE TRIGGER failChallengeLogout BEFORE DELETE ON verification BEGIN SELECT RAISE(ABORT,'synthetic challenge deletion fault'); END;`);
    const failed=await browser.call('/api/auth/sign-out',{});assert.equal(failed.status,503);assert.equal(failed.headers['set-cookie'],undefined);assert.equal(browser.cookie(),cookie);
    f.state.db.exec('DROP TRIGGER failChallengeLogout');
    assert.equal((await browser.call('/api/auth/sign-out',{})).status,200);
    assert.equal((await httpCall(f.port,'/api/auth/two-factor/verify-backup-code','POST',{code:backupCodes[0]},{cookie})).status,401);
  } finally {await f.close();}
});

test("enrollment activation rechecks real SQL authority after paused library TOTP crypto", {timeout:20_000}, async(t)=>{
  for(const invalidate of ['logout','session-expiry','claim-expiry'] as const) {
    const f=await fixture();let release:(()=>void)|undefined;
    try {
      const browser=f.browser();await browser.login();
      const setup=await browser.call('/api/auth/two-factor/enable',{password,setupKey:f.key});assert.equal(setup.status,200);
      const {createOTP}=await import('@better-auth/utils/otp');const {base32}=await import('@better-auth/utils/base32');
      const otp=createOTP(new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI as string).searchParams.get('secret')!)));
      const code=await otp.totp();
      // @better-auth/utils/otp -> createHMAC('SHA-1').sign -> WebCrypto.
      // Pause the real result, not a mocked successful verifier (cookie HMAC uses SHA-256).
      const subtle=globalThis.crypto.subtle;const original=subtle.sign.bind(subtle);
      let reached!:()=>void;const paused=new Promise<void>(done=>{reached=done;});const wait=new Promise<void>(done=>{release=done;});
      const sign=t.mock.method(subtle,'sign',async(...args:Parameters<typeof subtle.sign>)=>{
        const result=await original(...args);
        if((args[1].algorithm as HmacKeyAlgorithm).hash?.name==='SHA-1') {reached();await wait;}
        return result;
      });
      const pending=browser.call('/api/auth/two-factor/verify-totp',{code});await paused;
      if(invalidate==='logout') assert.equal((await browser.call('/api/auth/sign-out',{})).status,200);
      else if(invalidate==='session-expiry') f.state.db.prepare('UPDATE session SET expiresAt=?').run(new Date(Date.now()-1000).toISOString());
      else f.state.db.prepare('UPDATE authPolicy SET claimExpires=?').run(Date.now()-1);
      release!();const response=await pending;sign.mock.restore();
      assert.equal(response.status,401,invalidate);assert.equal(response.headers['set-cookie'],undefined);
      assert.equal((f.state.db.prepare('SELECT twoFactorEnabled AS n FROM user').get() as {n:number}).n,0);
      assert.equal((f.state.db.prepare('SELECT verified AS n FROM twoFactor').get() as {n:number}).n,0);
      assert.equal((f.state.db.prepare('SELECT COUNT(*) AS n FROM session').get() as {n:number}).n,invalidate==='logout'?0:1);
      assert.equal((await browser.call('/api/health')).status,invalidate==='claim-expiry'?403:401);
    } finally {release?.();t.mock.restoreAll();await f.close();}
  }
});

test("activation guards later rotation writes, defers only intentional retirement, and cleans failed replacements", {timeout:30_000}, async()=>{
  for(const boundary of ['session-insert','old-retirement','factor-verified'] as const) {
    for(const invalidate of ['session-expiry','claim-expiry','session-deletion','rotated-expiry','rotated-deletion'] as const) {
      if(invalidate.startsWith('rotated-') && boundary!=='factor-verified')continue;
      const f=await fixture();let release:(()=>void)|undefined;
      try {
        const browser=f.browser();await browser.login();
        const setup=await browser.call('/api/auth/two-factor/enable',{password,setupKey:f.key});assert.equal(setup.status,200);
        const {createOTP}=await import('@better-auth/utils/otp');const {base32}=await import('@better-auth/utils/base32');
        const otp=createOTP(new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI as string).searchParams.get('secret')!)));
        const {claimId}=f.state.db.prepare('SELECT claimId FROM authPolicy').get() as {claimId:string};
        const context=await f.state.auth.$context;
        let reached!:()=>void;const paused=new Promise<void>(done=>{reached=done;});const wait=new Promise<void>(done=>{release=done;});
        const pause=async()=>{reached();await wait;};
        if(boundary==='session-insert') {
          const original=context.internalAdapter.createSession;
          context.internalAdapter.createSession=async(...args)=>{await pause();return original(...args);};
        } else {
          const original=context.internalAdapter.deleteSession;
          context.internalAdapter.deleteSession=async(...args)=>{
            if(boundary==='old-retirement')await pause();
            const result=await original(...args);
            if(boundary==='factor-verified')await pause();
            return result;
          };
        }
        const pending=browser.call('/api/auth/two-factor/verify-totp',{code:await otp.totp()});await paused;
        assert.ok(f.state.db.prepare('SELECT 1 FROM session WHERE id=?').get(claimId),'original authority must survive intentional library retirement');
        assert.equal((f.state.db.prepare('SELECT twoFactorEnabled AS n FROM user').get() as {n:number}).n,1);
        if(invalidate==='session-expiry')f.state.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),claimId);
        else if(invalidate==='claim-expiry')f.state.db.prepare('UPDATE authPolicy SET claimExpires=?').run(Date.now()-1);
        else if(invalidate==='session-deletion') f.state.db.prepare('DELETE FROM session WHERE id=?').run(claimId);
        else if(invalidate==='rotated-expiry') f.state.db.prepare('UPDATE session SET expiresAt=? WHERE id<>?').run(new Date(Date.now()-1000).toISOString(),claimId);
        else f.state.db.prepare('DELETE FROM session WHERE id<>?').run(claimId);
        release!();const response=await pending;
        assert.ok(response.status>=400,`${boundary}/${invalidate}`);assert.equal(response.headers['set-cookie'],undefined);
        assert.equal((f.state.db.prepare('SELECT verified AS n FROM twoFactor').get() as {n:number}).n,0);
        assert.equal((f.state.db.prepare('SELECT COUNT(*) AS n FROM session WHERE id<>?').get(claimId) as {n:number}).n,0,'failed replacement must not survive');
        assert.equal((await browser.call('/api/health')).status,503);assert.throws(()=>loadAuth(f.home),/AUTH_UNAVAILABLE/);
      } finally {release?.();await f.close();}
    }
  }
});

test("final enrollment retirement failure rolls back verification and removes the restricted replacement",async()=>{
  const f=await fixture();
  try {
    const browser=f.browser();await browser.login();
    const setup=await browser.call('/api/auth/two-factor/enable',{password,setupKey:f.key});
    const {createOTP}=await import('@better-auth/utils/otp');const {base32}=await import('@better-auth/utils/base32');
    const otp=createOTP(new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI as string).searchParams.get('secret')!)));
    f.state.db.exec(`CREATE TRIGGER failRetirement BEFORE DELETE ON session
      WHEN EXISTS(SELECT 1 FROM twoFactor WHERE verified=1)
      BEGIN SELECT RAISE(IGNORE); END;`);
    const response=await browser.call('/api/auth/two-factor/verify-totp',{code:await otp.totp()});
    assert.equal(response.status,401);assert.equal(response.headers['set-cookie'],undefined);
    assert.equal((f.state.db.prepare('SELECT verified AS n FROM twoFactor').get() as {n:number}).n,0);
    assert.equal((f.state.db.prepare('SELECT COUNT(*) AS n FROM session').get() as {n:number}).n,1);
    assert.equal((await browser.call('/api/auth/status')).status,503);
  } finally {await f.close();}
});
