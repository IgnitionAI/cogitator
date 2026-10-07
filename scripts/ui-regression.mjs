// Vite :5321 + installed Chrome; isolated headless browser, all APIs intercepted.
// BROWSER_TOOLS_DIR=/path/to/browser-tools node scripts/ui-regression.mjs
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
const workspace = { id: 'ui-workspace', name: 'Workspace de vérification', dir: '/tmp/ui-workspace', default_agent_id: 'ui-agent' };
const agent = { id: 'ui-agent', name: 'Agent de vérification', slug: 'chef-de-projet', description: '', provider: 'test', model: 'test-model', thinking: null, system_prompt: '', skills: [], mcp_servers: [], subagents: [], created_at: '', updated_at: '' };
const conversation = { id: 'ui-conversation', title: 'Historique de vérification', workspace_id: workspace.id, agent_id: agent.id, provider: 'test', model: 'test-model', thinking: null, session_file: '/tmp/ui.jsonl', status: 'idle', updated_at: '' };
const card = { id: 'ui-card', number: 1, url: '', title: 'Carte de vérification', description: '', status: 'todo', priority: 'medium', labels: [], assignee_agent_id: agent.id, conversation_ids: [], blocks: [], blocked_by: [], comments: [], created_at: '', updated_at: '' };
let failHistory = false;
let delayedFeed = false;
const writes = [];
const entries = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', text: `Message ${i}. ${'Un historique long doit défiler sans masquer la saisie. '.repeat(12)}` }));
const clickText = async (selector, text) => {
  await page.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].some(e => e.textContent.includes(text)), {}, selector, text);
  await page.evaluate((selector, text) => [...document.querySelectorAll(selector)].find(e => e.textContent.includes(text)).click(), selector, text);
};
const nav = text => clickText('.nav-item', text);
try {
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return request.continue();
    let result;
    let status = 200;
    let contentType = 'application/json';
    if (request.method() !== 'GET') {
      writes.push({ path: url.pathname, body: request.postData() });
      status = 503;
      result = { error: 'Échec simulé, aucune écriture réelle' };
    } else if (url.pathname.endsWith('/events')) {
      contentType = 'text/event-stream';
      result = ': mock stream\n\n';
    } else if (url.pathname.endsWith('/history')) {
      status = failHistory ? 503 : 200;
      result = failHistory ? { error: 'Historique indisponible' } : { entries, messages: [] };
    } else if (url.pathname === '/api/health') result = { ok: true, version: 'test', pi_version: 'test', sessions_active: 0, mcp_adapter_detected: true, db: { path: '/tmp/test', version: 1 } };
    else if (url.pathname === '/api/agents') result = { agents: [agent] };
    else if (url.pathname === '/api/providers') result = { providers: [{ id: 'test', source: 'builtin', auth: { configured: true, type: 'api-key', ready: true }, models: [{ id: 'test-model' }] }] };
    else if (url.pathname === '/api/skills') result = { skills: [] };
    else if (url.pathname === '/api/workspaces') result = { workspaces: [workspace, { ...workspace, id: 'ui-workspace-b', name: 'Second workspace' }] };
    else if (url.pathname === '/api/conversations') result = { conversations: [conversation] };
    else if (url.pathname === `/api/conversations/${conversation.id}`) result = { conversation, live: true };
    else if (url.pathname.endsWith('/board')) result = { cards: [card] };
    else if (url.pathname.endsWith('/activity')) result = { files: [], totals: { additions: 0, deletions: 0 }, conversations: 0 };
    else if (url.pathname.endsWith('/feed')) {
      const first = url.pathname.includes('/ui-workspace/');
      if (delayedFeed && first) await new Promise(r => setTimeout(r, 500));
      result = { events: delayedFeed ? [{ path: first ? 'a-only.txt' : 'b-only.txt', kind: 'write', at: '2026-01-01T12:00:00Z', additions: 1, deletions: 0, hunks: [], conversationId: conversation.id, conversationTitle: 'Session' }] : [], conversations: 0 };
    }
    else if (url.pathname.endsWith('/tree')) result = { root: workspace.dir, tree: [] };
    else if (url.pathname.endsWith('/files')) result = { files: [] };
    else if (url.pathname === '/api/fs/browse') result = { path: '/tmp', parent: '/', entries: [{ name: 'ui-workspace', path: workspace.dir, type: 'dir' }] };
    else result = {};
    await request.respond({ status, contentType, body: typeof result === 'string' ? result : JSON.stringify(result) });
  });
  await page.bringToFront();
  await page.setViewport({ width: 320, height: 750 });
  await page.goto('http://localhost:5321', { waitUntil: 'domcontentloaded' });
  await clickText('.list-main', conversation.title);
  await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 80);
  const geometry = await page.evaluate(() => {
    const input = document.querySelector('.chat-input').getBoundingClientRect();
    const scroll = document.querySelector('.chat-scroll');
    return { inputTop: input.top, inputBottom: input.bottom, height: innerHeight, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, width: document.body.scrollWidth, viewport: innerWidth };
  });
  assert(geometry.inputTop > 0 && geometry.inputBottom <= geometry.height + 1, JSON.stringify(geometry));
  assert(geometry.scrollHeight > geometry.clientHeight * 2, JSON.stringify(geometry));
  assert.equal(geometry.width, geometry.viewport);
  console.log('PASS: long mobile transcript scrolls, composer stays visible, no body overflow');

  await page.focus('.chat-input textarea');
  await page.keyboard.type('Brouillon conservé après un échec');
  await clickText('.chat-input button', 'Envoyer');
  await page.waitForSelector('[role=alert], .toast.err');
  assert.equal(await page.$eval('.chat-input textarea', e => e.value), 'Brouillon conservé après un échec');
  assert.equal(writes.filter(w => w.path.endsWith('/messages')).length, 1);
  console.log('PASS: failed send retains draft, simulated API only');

  await page.setViewport({ width: 1440, height: 900 });
  await nav('Workspaces');
  await clickText('.card button', 'Ouvrir');
  await page.waitForSelector('[role=tablist]');
  assert.equal(await page.$eval('.nav-item[aria-current=page]', e => e.textContent.trim()), 'Workspaces');
  await clickText('[role=tab]', 'Fichiers');
  await page.focus('[role=tab][aria-selected=true]');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]').textContent.includes('Conversations'));
  assert(await page.evaluate(() => document.activeElement === document.querySelector('[role=tab][aria-selected=true]')));
  const panelId = await page.$eval('[role=tab][aria-selected=true]', e => e.getAttribute('aria-controls'));
  assert(panelId && await page.$(`#${panelId}[role=tabpanel]`));
  await page.waitForSelector('button.card');
  assert(await page.$('button.card'));
  console.log('PASS: workspace navigation current, tabs keyboard/panels, native conversation button');

  await clickText('[role=tab]', 'Board');
  await clickText('.board-title', card.title);
  await page.waitForSelector('dialog[open]');
  const launchDisabled = await page.evaluate(() => {
    const input = document.querySelector('dialog input');
    input.focus(); input.select();
    return [...document.querySelectorAll('dialog button')].find(b => b.textContent.includes('Lancer'))?.disabled;
  });
  assert.equal(launchDisabled, false);
  await page.keyboard.type('Titre non enregistré');
  assert(await page.evaluate(() => [...document.querySelectorAll('dialog button')].find(b => b.textContent.includes('Lancer'))?.disabled));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  console.log('PASS: board launch requires saved configuration');

  await page.setViewport({ width: 320, height: 750 });
  await clickText('[role=tab]', 'Chef de Projet');
  await page.waitForFunction(() => document.querySelectorAll('.tab-chat .msg').length >= 80);
  assert(await page.$eval('.tab-chat .chat-input', e => { const r = e.getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight + 1; }));
  assert.equal(writes.filter(w => w.path === '/api/conversations').length, 0);
  console.log('PASS: embedded workspace chat composer visible, existing PM session reused');

  await page.setViewport({ width: 1440, height: 900 });
  await nav('Conversations');
  const ratio = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Nouvelle conversation'));
    button.setAttribute('id', 'contrast-check');
    return button.id;
  });
  await page.bringToFront();
  await page.mouse.move(0, 0);
  await page.hover(`#${ratio}`);
  await page.waitForFunction(() => document.querySelector('#contrast-check').matches(':hover'), { timeout: 2000 }).catch(async error => {
    console.log(await page.evaluate(() => { const e = document.querySelector('#contrast-check'); const r = e.getBoundingClientRect(); return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 400), dialogs: document.querySelectorAll('dialog[open]').length }; }));
    throw error;
  });
  await new Promise(r => setTimeout(r, 250));
  const contrast = await page.$eval(`#${ratio}`, element => {
    if (!element.matches(':hover')) throw new Error('Primary button is not hovered');
    const style = getComputedStyle(element);
    if (style.backgroundColor !== 'rgb(96, 108, 208)') throw new Error(`Unexpected hover background: ${style.backgroundColor}`);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  assert(contrast >= 4.5, `Hover contrast ${contrast}`);
  console.log(`PASS: enabled primary hover contrast ${contrast.toFixed(2)}:1`);

  failHistory = true;
  await clickText('.list-main', conversation.title);
  await page.waitForSelector('[role=alert]');
  assert.match(await page.$eval('[role=alert]', e => e.textContent), /Historique indisponible/);
  console.log('PASS: history load failure is explicit');

  delayedFeed = true;
  await nav('Workspaces');
  await page.waitForFunction(() => document.querySelectorAll('main .card').length === 2);
  await page.evaluate(() => [...document.querySelectorAll('main .card')][0].querySelectorAll('button')[2].click());
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  await page.evaluate(() => [...document.querySelectorAll('main .card')][1].querySelectorAll('button')[2].click());
  await page.waitForFunction(() => document.querySelector('dialog .feed-row')?.textContent.includes('b-only.txt'));
  await new Promise(r => setTimeout(r, 650));
  assert.match(await page.$eval('dialog', e => e.textContent), /b-only\.txt/);
  assert.doesNotMatch(await page.$eval('dialog', e => e.textContent), /a-only\.txt/);
  console.log('PASS: late feed response cannot overwrite another workspace');
  console.log(`All ${writes.length} mutation requests were intercepted; none reached the backend.`);
} finally {
  await page.close();
  await browser.close();
}
