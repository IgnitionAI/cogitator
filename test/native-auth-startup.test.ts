import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authPaths, initializeOwner, loadAuth, lockHome, maintenance, reservePort } from "../src/auth-state.js";
import { resolveStaticFile } from "../src/server.js";
import { AUTH_TEST_TMP, email, origin, password } from "./native-auth-fixture.js";

function cli(home: string, args: string[], port = 0, extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{code:number|null; output:string}>((done,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','src/cli.ts',...args],{env:{...process.env,COGITATOR_HOME:home,COGITATOR_PORT:String(port),COGITATOR_PI_AGENT_DIR:join(home,'pi'),COGITATOR_AGENTS_DIR:join(home,'agents'),COGITATOR_SKILLS_DIRS:join(home,'skills'),...extraEnv},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});child.on('error',reject);child.on('exit',code=>done({code,output}));
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI did not fail safely'));},10_000);timer.unref();child.on('exit',()=>clearTimeout(timer));
  });
}

test("CLI refuses non-TTY credentials, protected partial state and incompatible occupied port before catalog writes", async()=>{
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-cli-'));
  try {
    const result=await cli(home,['auth','init','--origin',origin,'--email',email]);assert.equal(result.code,1);assert.match(result.output,/interactive local TTY/);
    assert.equal(existsSync(join(home,'cogitator.db')),false);assert.equal(existsSync(join(home,'agents')),false);
    writeFileSync(authPaths(home).required,'required\n',{mode:0o600});
    const required=await cli(home,[]);assert.equal(required.code,1);assert.equal(existsSync(join(home,'cogitator.db')),false);
    const local=join(home,'local');mkdirSync(local,{mode:0o700});
    // A reservation is an incompatible/old listener: bootstrap may not assume a successful health contract.
    const {createServer}=await import('node:net');const occupied=createServer(socket=>socket.destroy());
    await new Promise<void>(done=>occupied.listen(0,'127.0.0.1',done));
    const port=(occupied.address() as {port:number}).port;
    try { const blocked=await cli(local,[],port);assert.equal(blocked.code,1);assert.match(blocked.output,/EADDRINUSE/);assert.equal(existsSync(join(local,'cogitator.db')),false);await assert.rejects(reservePort(port),/EADDRINUSE/); }
    finally {await new Promise<void>(done=>occupied.close(()=>done()));}
  } finally {rmSync(home,{recursive:true,force:true});}
});

test("interrupted initializing marker and completed signup resume privately; finalized owner never reinitialized",async()=>{
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-resume-'));const release=lockHome(home);
  try {
    writeFileSync(authPaths(home).required,'initializing\n',{mode:0o600});
    await initializeOwner(home,origin,email,password);
    const p=authPaths(home);const config=JSON.parse(readFileSync(p.config,'utf8')) as {ownerId:string};const id=config.ownerId;
    maintenance(home);config.ownerId='pending';writeFileSync(p.config,JSON.stringify(config));
    assert.throws(()=>loadAuth(home));
    await initializeOwner(home,origin,email,password);
    const resumed=loadAuth(home);assert.equal(resumed.config.ownerId,id);resumed.db.close();
    await assert.rejects(initializeOwner(home,origin,email,password),/already exists/);
  } finally {release();rmSync(home,{recursive:true,force:true});}
});

test("static login asset containment resolves symlinks and has no public SPA fallback",()=>{
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-assets-'));const root=join(home,'dist');mkdirSync(join(root,'assets'),{recursive:true});
  try {
    writeFileSync(join(root,'index.html'),'<div id="root"></div>');writeFileSync(join(root,'assets','app-testhash.js'),'fixture');writeFileSync(join(home,'secret.js'),'private');
    symlinkSync(join(home,'secret.js'),join(root,'assets','escape-testhash.js'));
    assert.equal(resolveStaticFile(root,'/',true),join(root,'index.html'));
    assert.equal(resolveStaticFile(root,'/assets/app-testhash.js',true),join(root,'assets','app-testhash.js'));
    assert.equal(resolveStaticFile(root,'/assets/escape-testhash.js',true),null);
    assert.equal(resolveStaticFile(root,'/anything',true),null);
    assert.equal(resolveStaticFile(root,'/../secret.js',true),null);
    assert.equal(resolveStaticFile(root,'/index.html.bak',true),null);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test("real protected CLI and stdio MCP use owner socket without a browser credential", {timeout:20_000},async()=>{
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-process-'));
  const release=lockHome(home);await initializeOwner(home,origin,email,password);release();
  const env={...process.env,COGITATOR_HOME:home,COGITATOR_PORT:'0',COGITATOR_PI_AGENT_DIR:join(home,'pi'),COGITATOR_AGENTS_DIR:join(home,'agents'),COGITATOR_SKILLS_DIRS:join(home,'skills')};delete env.COGITATOR_URL;
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts'],{env,stdio:['ignore','pipe','pipe']});
  let mcp:ReturnType<typeof spawn>|undefined;
  const exited=new Promise<void>(done=>child.once('exit',()=>done()));
  try {
    await new Promise<void>((done,reject)=>{
      let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes(`[cogitator] ${origin}`))done();});
      child.once('exit',()=>reject(new Error('Protected CLI exited before startup')));child.once('error',reject);
    });
    assert.ok(existsSync(authPaths(home).socket));
    mcp=spawn(process.execPath,['--import','tsx','src/mcp-server.ts'],{env,stdio:['pipe','pipe','pipe']});
    const peer=mcp;
    const result=await new Promise<Record<string,unknown>>((done,reject)=>{
      let lines='';peer.stdout!.on('data',chunk=>{
        lines+=String(chunk);
        while(lines.includes('\n')) {
          const end=lines.indexOf('\n');const line=lines.slice(0,end);lines=lines.slice(end+1);
          const response=JSON.parse(line) as {id?:number;result?:Record<string,unknown>};
          if(response.id===1) {
            peer.stdin!.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
            peer.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'cogitator_health',arguments:{}}})+'\n');
          }
          if(response.id===2)done(response.result!);
        }
      });peer.once('error',reject);peer.once('exit',()=>reject(new Error('MCP exited before response')));
      peer.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic-test',version:'0'}}})+'\n');
    });
    assert.equal(result.isError,undefined);
    const content=result.content as {text:string}[];assert.equal((JSON.parse(content[0]!.text) as {ok:boolean}).ok,true);
    const state=loadAuth(home);assert.equal(state.config.origin,origin);state.db.close();
  } finally {
    if(mcp) {const closed=new Promise<void>(done=>mcp!.once('exit',()=>done()));mcp.kill('SIGTERM');await closed;}
    child.kill('SIGTERM');await exited;
    assert.equal(existsSync(authPaths(home).socket),false);
    const unlock=lockHome(home);unlock();rmSync(home,{recursive:true,force:true});
  }
});

test("interactive init hides split-UTF8 passwords on a real local pseudo-TTY", {skip:process.platform!=='darwin',timeout:15_000},async()=>{
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-tty-'));
  const terminalPassword=`${password}-é🔐`;
  const child=spawn('/bin/sh',['-c','cat | /usr/bin/script -q /dev/null "$@"','auth-tty-test',process.execPath,'--import','tsx','src/cli.ts','auth','init','--origin',origin,'--email',email],{env:{...process.env,COGITATOR_HOME:home,COGITATOR_PORT:'0'},stdio:['pipe','pipe','pipe']});
  let output='';let step=0;child.stderr.on('data',chunk=>{output+=String(chunk);});
  try {
    const code=await new Promise<number|null>((done,reject)=>{
      child.stdout.on('data',chunk=>{
        output+=String(chunk);
        if(step===0 && output.includes('Type STOPPED:')) {step++;child.stdin.write('STOPPED\r');}
        if(step===1 && output.includes('New owner password')) {step++;const bytes=Buffer.from(terminalPassword);const split=Buffer.byteLength(`${password}-`)+1;child.stdin.write(bytes.subarray(0,split));setTimeout(()=>child.stdin.write(Buffer.concat([bytes.subarray(split),Buffer.from('\r')])),20);}
        if(step===2 && output.includes('Confirm password:')) {step++;child.stdin.write(`${terminalPassword}x\u007f\r`);}
        if(step===3 && output.includes('Start Cogitator,'))child.stdin.end();
      });child.on('error',reject);child.on('exit',done);
    });
    assert.equal(code,0,output);assert.equal(step,3);assert.ok(!output.includes(password));assert.match(output,/Setup key \(expires in 30 minutes/);
    const state=loadAuth(home);assert.equal(state.config.origin,origin);
    assert.ok(await state.auth.api.signInEmail({body:{email,password:terminalPassword}}));state.db.close();
    assert.equal(existsSync(join(home,'cogitator.db')),false);
  } finally {if(child.exitCode===null)child.kill('SIGTERM');rmSync(home,{recursive:true,force:true});}
});


test("invalid required-mode environment and main CLI options fail before creating a local catalog", async()=>{
  const { authenticationRequired } = await import('../src/config.js');
  assert.equal(authenticationRequired({}),false);
  assert.equal(authenticationRequired({COGITATOR_AUTH_REQUIRED:'0'}),false);
  assert.equal(authenticationRequired({COGITATOR_AUTH_REQUIRED:'1'}),true);
  for(const value of ['true','false','','yes',' 1','2']) assert.throws(()=>authenticationRequired({COGITATOR_AUTH_REQUIRED:value}),/must be unset, 0, or 1/);
  const home=mkdtempSync(join(AUTH_TEST_TMP,'cog-auth-options-'));
  try {
    for(const [args,env] of [
      [[],{COGITATOR_AUTH_REQUIRED:'true'}],
      [['--auth-required'],{COGITATOR_AUTH_REQUIRED:'true'}],
      [['--auth-requred'],{COGITATOR_AUTH_REQUIRED:'0'}],
      [['--auth-required=false'],{}],
      [['serve'],{}],
    ] as const) {
      const result=await cli(home,[...args],0,env);assert.equal(result.code,1);
      assert.match(result.output,/COGITATOR_AUTH_REQUIRED must|Usage: cogitator/);
      assert.equal(existsSync(join(home,'cogitator.db')),false);
      assert.equal(existsSync(join(home,'owner-lock.sqlite')),false);
    }
  } finally {rmSync(home,{recursive:true,force:true});}
});
