import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { SharedBrowser } from '../src/shared-browser.js';
import { closeSharedBrowser } from '../src/browser-http.js';
import { fixture, httpCall, origin } from './native-auth-fixture.js';
import WebSocket from 'ws';

function setup(){const home=mkdtempSync(join(tmpdir(),'browser-test-'));const {db}=openDb(join(home,'db.sqlite'));const agent=randomUUID(),other=randomUUID(),conv=randomUUID();
 for(const [id,name] of [[agent,'allowed'],[other,'other']])db.prepare('INSERT INTO agent_preset(id,slug,name,provider,model) VALUES (?,?,?,?,?)').run(id,name,name,'fake','fake');
 db.prepare('INSERT INTO conversation(id,agent_id,provider,model) VALUES (?,?,?,?)').run(conv,agent,'fake','fake');
 return {home,db,agent,other,conv,browser:new SharedBrowser(home,db)};}

test('profiles persist, default to human control, and enforce current agent assignment',async()=>{
 const f=setup();try{
  const profile=f.browser.create({name:'Marketing',agentIds:[f.agent]});
  assert.equal(statSync(join(f.home,'browsers/profiles.json')).mode&0o777,0o600);
  await assert.rejects(f.browser.act(profile.id,{action:'tabs'},f.conv),/HUMAN_CONTROL/);
  await f.browser.control(profile.id,false);
  assert.deepEqual(await f.browser.act(profile.id,{action:'tabs'},f.conv),{tabs:[]});
  f.browser.update(profile.id,{name:'Marketing',agentIds:[f.other]});
  await assert.rejects(f.browser.act(profile.id,{action:'tabs'},f.conv),/ACCESS_DENIED/);
  assert.equal(new SharedBrowser(f.home,f.db).list()[0]?.humanControl,true);
  assert.throws(()=>f.browser.create({name:'Bad',agentIds:[randomUUID()]}),/AGENT_NOT_FOUND/);
 }finally{await f.browser.dispose();f.db.close();}
});

test('new browser routes and WebSocket upgrades require owner authentication',async()=>{
 const f=await fixture('password');try{
  for(const [path,method] of [['/api/browser/profiles','GET'],['/api/browser/profiles','POST'],['/api/browser/agent','POST'],['/api/browser/profiles/unknown/action','POST']])assert.equal((await httpCall(f.port,path!,method!,method==='GET'?undefined:{})).status,401);
  const browser=f.browser();await browser.login();
  assert.equal((await browser.call('/api/browser/agent',{conversationId:randomUUID()})).status,403);
  const rejected=await new Promise<number>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${f.port}/api/browser/view/${randomUUID()}/${randomUUID()}`,{origin,headers:{host:new URL(origin).host}});ws.on('unexpected-response',(_req,res)=>{resolve(res.statusCode!);res.resume();ws.terminate();});ws.on('error',()=>{});setTimeout(()=>reject(new Error('upgrade timed out')),2000).unref();});
  assert.equal(rejected,403);
 }finally{await closeSharedBrowser(f.app);await f.close();}
});

const real=process.env.COGITATOR_BROWSER_TESTS==='1';
test('real Chromium: navigation, agent interaction, takeover, isolated persistent sign-ins and screencast', {skip:!real,timeout:60000},async()=>{
 const f=setup();const http=httpServer((req,res)=>{
  if(req.url==='/login')res.setHeader('Set-Cookie','demo=connected; Max-Age=3600; HttpOnly; SameSite=Lax');
  res.setHeader('content-type','text/html');res.end(`<html><head><title>Browser acceptance</title></head><body><h1>${req.headers.cookie?.includes('demo=connected')?'Signed in':'Guest'}</h1><label>Message <input id="message"></label><button id="go" onclick="document.querySelector('h1').textContent='Clicked'">Continue</button></body></html>`);
 });await new Promise<void>(done=>http.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(http.address() as AddressInfo).port}`;
 try{
  const profile=f.browser.create({name:'Marketing',agentIds:[f.agent]});
  await f.browser.act(profile.id,{action:'open',url:url+'/login'});
  const tab=(await f.browser.tabs(profile.id)).at(-1)!;
  await assert.rejects(f.browser.act(profile.id,{action:'read',tabId:tab.id},f.conv),/HUMAN_CONTROL/);
  await f.browser.control(profile.id,false);
  await f.browser.act(profile.id,{action:'reload',tabId:tab.id},f.conv);
  assert.match(JSON.stringify(await f.browser.act(profile.id,{action:'read',tabId:tab.id},f.conv)),/Signed in/);
  await f.browser.act(profile.id,{action:'fill',tabId:tab.id,selector:'#message',text:'Agent writes'},f.conv);
  await f.browser.act(profile.id,{action:'click',tabId:tab.id,selector:'#go'},f.conv);
  assert.match(JSON.stringify(await f.browser.act(profile.id,{action:'read',tabId:tab.id},f.conv)),/Clicked/);
  await f.browser.control(profile.id,true);
  for(const action of ['read','screenshot','click'])await assert.rejects(f.browser.act(profile.id,{action,tabId:tab.id,x:.5,y:.5},f.conv),/HUMAN_CONTROL/);
  let stop:(()=>Promise<void>)|undefined;
  const frame=await new Promise<Buffer>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('no frame')),7000);void f.browser.watch(profile.id,tab.id,frame=>{clearTimeout(timer);resolve(frame);},()=>{}).then(s=>stop=s).catch(reject);});
  assert.equal(frame[0],0xff);await stop?.();
  await assert.rejects(f.browser.act(profile.id,{action:'open',url:'file:///etc/passwd'}),/URL_DENIED/);
  await assert.rejects(f.browser.act(profile.id,{action:'open',url:'http://localhost:5320/api/status'}),/URL_DENIED/);
  const separate=f.browser.create({name:'Development',agentIds:[]});await f.browser.act(separate.id,{action:'open',url});
  const other=(await f.browser.tabs(separate.id)).at(-1)!;assert.match(JSON.stringify(await f.browser.act(separate.id,{action:'read',tabId:other.id})),/Guest/);
  await f.browser.dispose();const restarted=new SharedBrowser(f.home,f.db);
  try{await restarted.act(profile.id,{action:'open',url});const t=(await restarted.tabs(profile.id)).at(-1)!;assert.match(JSON.stringify(await restarted.act(profile.id,{action:'read',tabId:t.id})),/Signed in/);assert.equal(restarted.list()[0]?.humanControl,true);}finally{await restarted.dispose();}
 }finally{await f.browser.dispose();f.db.close();await new Promise<void>(done=>http.close(()=>done()));}
});

test('live view rejects foreign origins and closes promptly on logout',{skip:!real,timeout:60000},async()=>{
 const f=await fixture('password');const owner=f.browser();await owner.login();
 const demo=httpServer((_req,res)=>res.end('<h1>Public synthetic page</h1>'));await new Promise<void>(done=>demo.listen(0,'127.0.0.1',done));
 let peer:WebSocket|undefined;
 try{
  const created=await owner.call('/api/browser/profiles',{name:'Live',agentIds:[]});assert.equal(created.status,200);const id=created.data.id;
  const opened=await owner.call(`/api/browser/profiles/${id}/action`,{action:'open',url:`http://127.0.0.1:${(demo.address() as AddressInfo).port}`});assert.equal(opened.status,200,opened.text);
  const tabs=opened.data.tabs as {id:string}[];const url=`ws://127.0.0.1:${f.port}/api/browser/view/${id}/${tabs.at(-1)!.id}`;
  await new Promise<void>((resolve,reject)=>{const bad=new WebSocket(url,{origin:'https://evil.invalid',headers:{host:new URL(origin).host,cookie:owner.cookie()}});bad.on('open',()=>reject(new Error('foreign origin accepted')));bad.on('error',()=>resolve());});
  peer=new WebSocket(url,{origin,headers:{host:new URL(origin).host,cookie:owner.cookie()}});
  await new Promise<void>((resolve,reject)=>{peer!.on('message',(_data,binary)=>{if(binary)resolve();});peer!.on('error',reject);setTimeout(()=>reject(new Error('no live frame')),8000).unref();});
  const closed=new Promise<void>((resolve,reject)=>{peer!.once('close',()=>resolve());setTimeout(()=>reject(new Error('logout left stream alive')),3000).unref();});
  await owner.call('/api/auth/sign-out',{});await closed;
 }finally{peer?.terminate();await closeSharedBrowser(f.app);await f.close();await new Promise<void>(done=>demo.close(()=>done()));}
});
