import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, atomicWriteJson } from './json-files.js';
import type { Db } from './db.js';
import { checkRequestAuthorization } from './request-authorization.js';

export const profileInput = z.object({ name: z.string().trim().min(1).max(60), agentIds: z.array(z.string().uuid()).max(50).default([]) }).strict();
export const browserAction = z.object({
  action: z.enum(['tabs','open','navigate','read','screenshot','click','fill','press','scroll','back','forward','reload','close']),
  tabId: z.string().uuid().optional(), url: z.string().max(4096).optional(),
  selector: z.string().min(1).max(500).optional(), text: z.string().max(16000).optional(),
  key: z.string().max(80).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(),
  delta: z.number().min(-2000).max(2000).optional(),
}).strict();
export type BrowserAction = z.infer<typeof browserAction>;
export interface BrowserProfile { id: string; name: string; agentIds: string[] }
interface Running { context: BrowserContext; pages: Map<string, Page> }
export class BrowserProblem extends Error {}

/** Profiles contain credentials on disk. No profile bytes, cookies or CDP endpoints leave this service. */
export class SharedBrowser {
  private profiles: BrowserProfile[];
  private readonly directory: string;
  private readonly running = new Map<string, Running>();
  private readonly launching = new Map<string, Promise<Running>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly human = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private closing = false;
  constructor(home: string, private readonly db: Db, private readonly controllerOrigin?: string) {
    this.directory = join(home, 'browsers');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    const stored = readJson<unknown>(join(this.directory, 'profiles.json'), []);
    this.profiles = z.array(profileInput.extend({ id: z.string().uuid() })).parse(stored);
    // Restart never silently returns a signed-in browser to automation.
    for (const p of this.profiles) this.human.add(p.id);
  }
  list() { return this.profiles.map(p => ({ ...p, humanControl: this.human.has(p.id), running: this.running.has(p.id) })); }
  private profile(id: string) { const p = this.profiles.find(p => p.id === id); if (!p) throw new BrowserProblem('BROWSER_PROFILE_NOT_FOUND'); return p; }
  private save() { atomicWriteJson(join(this.directory, 'profiles.json'), this.profiles, 0o600); chmodSync(join(this.directory, 'profiles.json'), 0o600); }
  create(input: unknown) {
    const data = profileInput.parse(input); this.validateAgents(data.agentIds);
    if (this.profiles.length >= 20) throw new BrowserProblem('BROWSER_PROFILE_LIMIT');
    if (this.profiles.some(p => p.name === data.name)) throw new BrowserProblem('BROWSER_NAME_EXISTS');
    const profile = { id: randomUUID(), ...data }; checkRequestAuthorization();
    this.profiles.push(profile); this.human.add(profile.id); this.save(); return profile;
  }
  update(id: string, input: unknown) {
    const data = profileInput.parse(input); this.validateAgents(data.agentIds);
    const profile = this.profile(id); checkRequestAuthorization(); this.bump(id);
    Object.assign(profile, data); this.save(); return profile;
  }
  private validateAgents(ids: string[]) { for (const id of ids) if (!this.db.prepare('SELECT id FROM agent_preset WHERE id=?').get(id)) throw new BrowserProblem('BROWSER_AGENT_NOT_FOUND'); }
  private bump(id: string) { this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); }
  async control(id: string, human: boolean) {
    this.profile(id); checkRequestAuthorization(); this.bump(id);
    if (human) this.human.add(id); else this.human.delete(id);
    // Drain commands already sent before acknowledging takeover. New agent calls fail immediately.
    await this.queues.get(id)?.catch(() => undefined); checkRequestAuthorization();
    return { humanControl: this.human.has(id) };
  }
  agentProfiles(conversationId: string) {
    const row = this.db.prepare('SELECT agent_id FROM conversation WHERE id=?').get(conversationId) as {agent_id: string | null} | undefined;
    if (!row?.agent_id) throw new BrowserProblem('BROWSER_CONVERSATION_REQUIRED');
    return this.list().filter(p => p.agentIds.includes(row.agent_id!));
  }
  private agentCheck(id: string, conversationId: string) {
    if (!this.agentProfiles(conversationId).some(p => p.id === id)) throw new BrowserProblem('BROWSER_ACCESS_DENIED');
    if (this.human.has(id)) throw new BrowserProblem('BROWSER_HUMAN_CONTROL');
  }
  private validUrl(raw: string) {
    let url: URL; try { url = new URL(raw); } catch { throw new BrowserProblem('BROWSER_URL_INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || this.blocked(url)) throw new BrowserProblem('BROWSER_URL_DENIED');
    return url.href;
  }
  private blocked(url: URL) {
    // Never let the managed browser open its own controller/owner API.
    return url.port === (process.env.COGITATOR_PORT ?? '5320') || (!!this.controllerOrigin && url.origin === this.controllerOrigin);
  }
  private async launch(id: string): Promise<Running> {
    this.profile(id); if (this.closing) throw new BrowserProblem('BROWSER_STOPPING');
    const active = this.running.get(id); if (active) return active;
    const pending = this.launching.get(id); if (pending) return pending;
    if (this.running.size + this.launching.size >= 2) throw new BrowserProblem('BROWSER_RUNNING_LIMIT');
    const task = (async () => {
      const dir = join(this.directory, id); mkdirSync(dir, { recursive: true, mode: 0o700 });
      let context: BrowserContext;
      try { context = await chromium.launchPersistentContext(dir, {
        headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 800 },
        acceptDownloads: false, serviceWorkers: 'block', timeout: 20000,
        ...(process.env.COGITATOR_BROWSER_EXECUTABLE ? { executablePath: process.env.COGITATOR_BROWSER_EXECUTABLE } : {}),
      }); } catch { throw new BrowserProblem('BROWSER_START_FAILED'); }
      context.setDefaultTimeout(3000); context.setDefaultNavigationTimeout(15000);
      const run: Running = { context, pages: new Map() };
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return this.blocked(url) ? route.abort() : route.continue();
      });
      await context.routeWebSocket('**/*', socket => {
        const url = new URL(socket.url()); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        if (this.blocked(url)) socket.close(); else socket.connectToServer();
      });
      const register = (page: Page) => {
        if (run.pages.size >= 8) { void page.close(); return; }
        const tabId = randomUUID(); run.pages.set(tabId, page);
        page.on('close', () => run.pages.delete(tabId));
        page.on('dialog', dialog => { void dialog.dismiss().catch(() => undefined); });
      };
      context.pages().forEach(register); context.on('page', register);
      context.on('close', () => { this.running.delete(id); this.human.add(id); this.bump(id); });
      this.running.set(id, run); return run;
    })();
    this.launching.set(id, task);
    try { return await task; } finally { this.launching.delete(id); }
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  async tabs(id: string) {
    this.profile(id); const run = this.running.get(id);
    return Promise.all([...(run?.pages ?? [])].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title().catch(() => '') })));
  }
  async act(id: string, raw: unknown, conversationId?: string) {
    const input = browserAction.parse(raw); this.profile(id);
    const epoch = this.epochs.get(id) ?? 0;
    const check = () => { checkRequestAuthorization();
      if ((this.epochs.get(id) ?? 0) !== epoch) throw new BrowserProblem('BROWSER_CONTROL_CHANGED');
      if (conversationId) this.agentCheck(id, conversationId);
      else if (!this.human.has(id)) throw new BrowserProblem('BROWSER_TAKE_CONTROL');
    };
    check();
    return this.serial(id, async () => {
      check();
      if (input.action === 'tabs') return { tabs: await this.tabs(id) };
      const run = await this.launch(id); check();
      let page = input.tabId ? run.pages.get(input.tabId) : undefined;
      if (input.action === 'open') {
        const url = this.validUrl(input.url ?? ''); check();
        if (run.pages.size >= 8) throw new BrowserProblem('BROWSER_TAB_LIMIT');
        page = [...run.pages.values()].find(p => p.url() === "about:blank") ?? await run.context.newPage(); check();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      } else {
        if (!page || page.isClosed()) throw new BrowserProblem('BROWSER_TAB_NOT_FOUND');
        const locator = input.selector ? page.locator(input.selector) : undefined;
        switch (input.action) {
          case 'navigate': await page.goto(this.validUrl(input.url ?? ''), { waitUntil: 'domcontentloaded' }); break;
          case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
          case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break;
          case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break;
          case 'close': await page.close(); break;
          case 'read': { const text = await page.locator('body').ariaSnapshot({ timeout: 3000 }); check(); return { text: text.slice(0, 24000) }; }
          case 'screenshot': { const bytes = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000 }); check(); return { image: bytes.toString('base64'), mimeType: 'image/jpeg' }; }
          case 'click':
            if (locator) await locator.click({ timeout: 2000 });
            else if (input.x !== undefined && input.y !== undefined) await page.mouse.click(input.x * 1280, input.y * 800);
            else throw new BrowserProblem('BROWSER_TARGET_REQUIRED'); break;
          case 'fill': if (!locator || input.text === undefined) throw new BrowserProblem('BROWSER_TARGET_REQUIRED');
            // Credentials are entered by the human through takeover, never as agent tool arguments.
            if (conversationId && await locator.getAttribute('type') === 'password') throw new BrowserProblem('BROWSER_SECRET_TAKEOVER');
            check(); await locator.fill(input.text); break;
          case 'press': if (!input.key || !/^[A-Za-z0-9+_. -]{1,80}$/.test(input.key)) throw new BrowserProblem('BROWSER_KEY_INVALID'); await page.keyboard.press(input.key); break;
          case 'scroll': await page.mouse.wheel(0, input.delta ?? 500); break;
        }
      }
      check(); return { tabs: await this.tabs(id) };
    });
  }
  /** Human input only; never available as an agent tool. */
  async type(id: string, tabId: string, text: string) {
    if (text.length > 16000) throw new BrowserProblem('BROWSER_TEXT_LIMIT');
    return this.serial(id, async () => {
      checkRequestAuthorization(); if (!this.human.has(id)) throw new BrowserProblem('BROWSER_TAKE_CONTROL');
      const page = this.running.get(id)?.pages.get(tabId); if (!page) throw new BrowserProblem('BROWSER_TAB_NOT_FOUND');
      await page.keyboard.insertText(text); return {};
    });
  }
  async watch(id: string, tabId: string, send: (frame: Buffer) => void, check: () => void) {
    this.profile(id); check();
    const page = this.running.get(id)?.pages.get(tabId); if (!page) throw new BrowserProblem('BROWSER_TAB_NOT_FOUND');
    const session = await page.context().newCDPSession(page); check();
    let stopped = false;
    let latest: Buffer | undefined;
    const timer = setInterval(() => {
      if (!latest || stopped) return;
      try { check(); send(latest); latest = undefined; } catch { void stop(); }
    }, 100);
    session.on('Page.screencastFrame', event => {
      if (stopped) return;
      void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
      try { check(); latest = Buffer.from(event.data, 'base64'); }
      catch { void stop(); }
    });
    const stop = async () => { if (stopped) return; stopped = true; clearInterval(timer); latest = undefined; await session.detach().catch(() => undefined); };
    try { await session.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }); }
    catch (err) { await stop(); throw err; }
    return stop;
  }
  async stop(id: string) {
    this.profile(id); this.human.add(id); this.bump(id);
    await this.queues.get(id)?.catch(() => undefined);
    await this.running.get(id)?.context.close(); return {};
  }
  async dispose() { this.closing = true; await Promise.allSettled(this.launching.values()); await Promise.allSettled([...this.running.values()].map(r => r.context.close())); }
  installed() { return existsSync(process.env.COGITATOR_BROWSER_EXECUTABLE ?? chromium.executablePath()); }
}
