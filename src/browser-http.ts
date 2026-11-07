import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { SharedBrowser, BrowserProblem } from './shared-browser.js';
import type { AuthState } from './auth-state.js';
import { AuthError, ownerSession, requireApproved, sessionById } from './native-auth.js';
import { browserHeaders, validateBoundary, localCheck } from './auth-http.js';
import { requestAuthorization } from './request-authorization.js';

type Ctx = { params: Record<string,string>; body: unknown; req: IncomingMessage; res: ServerResponse; check: () => void };
type Route = [string, string, (ctx: Ctx) => Promise<void> | void];
export function browserRoutes(browser: SharedBrowser, privateRequest: (req: IncomingMessage) => boolean, send: (res: ServerResponse, status: number, data: unknown) => void, protectedMode: boolean): Route[] {
  const ui = (fn: (ctx: Ctx) => unknown | Promise<unknown>) => async (ctx: Ctx) => {
    if (privateRequest(ctx.req)) throw new AuthError('FORBIDDEN',403);
    try { ctx.check(); const value = await fn(ctx); ctx.check(); send(ctx.res,200,value); }
    catch (error) { if (error instanceof BrowserProblem || error instanceof z.ZodError) send(ctx.res,400,{error: error instanceof BrowserProblem ? error.message : 'BROWSER_INVALID_INPUT'}); else if (error instanceof AuthError) throw error; else send(ctx.res,400,{error:'BROWSER_ACTION_FAILED'}); }
  };
  return [
    ['GET','/api/browser/profiles',ui(() => ({profiles: browser.list(), installed: browser.installed()}))],
    ['POST','/api/browser/profiles',ui(ctx => browser.create(ctx.body))],
    ['PUT','/api/browser/profiles/:id',ui(ctx => browser.update(ctx.params.id!,ctx.body))],
    ['GET','/api/browser/profiles/:id/tabs',ui(async ctx => ({tabs: await browser.tabs(ctx.params.id!)}))],
    ['POST','/api/browser/profiles/:id/control',ui(ctx => browser.control(ctx.params.id!,z.object({human: z.boolean()}).strict().parse(ctx.body).human))],
    ['POST','/api/browser/profiles/:id/action',ui(ctx => browser.act(ctx.params.id!,ctx.body))],
    ['POST','/api/browser/profiles/:id/stop',ui(ctx => browser.stop(ctx.params.id!))],
    ['POST','/api/browser/agent',async ctx => {
      // Agent identity is attached by the bundled extension, not accepted on the public HTTP surface.
      if (!privateRequest(ctx.req) && protectedMode) throw new AuthError('FORBIDDEN',403);
      try {
        const b = z.object({conversationId:z.string().uuid(),profileId:z.string().uuid().optional(),command:z.unknown().optional()}).strict().parse(ctx.body);
        ctx.check(); const result = b.profileId ? await browser.act(b.profileId,b.command,b.conversationId) : {profiles:browser.agentProfiles(b.conversationId)};
        ctx.check(); send(ctx.res,200,result);
      } catch(error) { if(error instanceof BrowserProblem || error instanceof z.ZodError) send(ctx.res,400,{error:error instanceof BrowserProblem ? error.message : 'BROWSER_INVALID_INPUT'}); else if (error instanceof AuthError) throw error; else send(ctx.res,400,{error:'BROWSER_ACTION_FAILED'}); }
    }],
  ];
}
const cleanup = new WeakMap<Server, () => Promise<void>>();
export async function closeSharedBrowser(server: Server) { await cleanup.get(server)?.(); }
export function attachBrowserView(app: Server, browser: SharedBrowser, home: string, state?: AuthState) {
  const ws = new WebSocketServer({ noServer: true, maxPayload: 20000, perMessageDeflate: false });
  const dispose = async () => { for (const peer of ws.clients) peer.terminate(); ws.close(); await browser.dispose(); };
  cleanup.set(app,dispose); app.once('close',() => { void dispose(); });
  app.on('upgrade', async (req,socket,head) => {
    try {
      const match = /^\/api\/browser\/view\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(req.url ?? '');
      if (!match) throw new Error('route');
      let check = () => localCheck(home);
      if (state) {
        state.assertAvailable(); validateBoundary(req,state);
        if (req.headers.origin !== state.config.origin) throw new Error('origin');
        const session = await ownerSession(state.auth,state.db,state.config,browserHeaders(req)); requireApproved(session,state.config);
        check = () => { state.assertAvailable(); requireApproved(sessionById(state.db,state.config,session!.id),state.config); };
      } else {
        const expected = `http://${req.headers.host}`;
        if (req.headers.origin !== expected || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '')) throw new Error('origin');
      }
      check();
      const [profileId,tabId] = [match[1]!,match[2]!];
      if (!(await browser.tabs(profileId)).some(t => t.id === tabId)) throw new Error('tab');
      check();
      ws.handleUpgrade(req,socket,head,peer => {
        let stop: (()=>Promise<void>) | undefined;
        let busy = false;
        const alive = () => { check(); if (peer.readyState !== peer.OPEN) throw new Error('closed'); };
        void browser.watch(profileId,tabId,frame => { if(peer.bufferedAmount < 512000 && peer.readyState === peer.OPEN)peer.send(frame); },alive)
          .then(value => {stop=value; if(peer.readyState !== peer.OPEN)void stop();}).catch(()=>peer.close(1011));
        const timer = setInterval(()=>{ try{alive(); peer.send(JSON.stringify({type:'state',humanControl:browser.list().find(p=>p.id===profileId)?.humanControl}));}catch{peer.close(1008);} },1000);
        peer.on('message',data=> {
          if(busy)return;
          busy=true;
          void requestAuthorization.run(alive,async()=>{
            try {
              alive(); const message = JSON.parse(data.toString());
              if(message.action==='type'){
                const input=z.object({action:z.literal('type'),text:z.string().max(16000)}).strict().parse(message);
                await browser.type(profileId,tabId,input.text);
              } else {
                // UI transport is deliberately limited to human input, not arbitrary CDP or script execution.
                if(!['click','press','scroll'].includes(message.action))throw new BrowserProblem('BROWSER_INVALID_INPUT');
                await browser.act(profileId,{...message,tabId});
              }
              alive(); peer.send(JSON.stringify({type:'ack'}));
            }catch(error){if(peer.readyState===peer.OPEN)peer.send(JSON.stringify({type:'error',error:error instanceof BrowserProblem ? error.message : 'BROWSER_INPUT_FAILED'}));}
            finally{busy=false;}
          });
        });
        peer.on('error',()=>peer.terminate()); peer.once('close',()=>{clearInterval(timer);void stop?.();});
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
}
