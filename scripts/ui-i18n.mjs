// Prerequisites: Vite UI running (no backend needed), Chrome, installed browser-tools.
// BROWSER_TOOLS_DIR=/path/to/browser-tools UI_BASE_URL=http://127.0.0.1:5321 node scripts/ui-i18n.mjs
// Optional: CHROME_PATH, UI_I18N_OUTPUT. Exactly four screenshots on a successful run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const base = process.env.UI_BASE_URL ?? 'http://127.0.0.1:5321';
const output = process.env.UI_I18N_OUTPUT ?? '/tmp/cogitator-i18n';
await mkdir(output, { recursive: true });
const catalog = {};
for (const name of ['common', 'screens', 'workspace', 'chat', 'diagnostics']) {
  const source = await readFile(new URL(`../web/src/locales/${name}.ts`, import.meta.url), 'utf8');
  Object.assign(catalog, runInNewContext(source.replace(/export const \w+\s*=/, '(').replace(/as const;?\s*$/, ')')));
}
let language = 'en';
const text = (key, values = {}) => {
  assert(catalog[key], `Missing catalog key: ${key}`);
  return catalog[key][language].replace(/\{(\w+)\}/g, (token, key) => values[key] ?? token);
};
const report = { base, started: new Date().toISOString(), checks: [], screenshots: [], requests: [], runtimeErrors: [], unexpectedRequests: [] };
let currentCheck = 'startup';
let mode = 'populated';
let failWrites = true;
const rawError = 'Fixture upstream unavailable: E_FIXTURE';
const agent = { id: 'agent', slug: 'chef-de-projet', name: 'Architecte — authored name', description: 'Description utilisateur', provider: 'fixture', model: 'fixture-model', thinking: null, skills: [], subagents: [], mcp_servers: [], system_prompt: '', is_default: 1 };
const workspace = { id: 'workspace', name: 'Atelier utilisateur', dir: '/tmp/i18n-fixture', default_agent_id: agent.id, conversation_count: 1 };
const conversation = { id: 'conversation', title: 'Conversation utilisateur', status: 'idle', provider: 'fixture', model: 'fixture-model', agent_id: agent.id, workspace_id: workspace.id, updated_at: '2026-05-01T12:34:56Z' };
const card = { id: 'card', number: 1234, title: 'Carte utilisateur', description: 'Description conservée', status: 'todo', priority: 'medium', labels: ['user-label'], conversation_ids: [], blocks: [], blocked_by: [], comments: [{ id: 'comment', author: 'user', at: conversation.updated_at, text: 'Commentaire conservé' }], assignee_agent_id: agent.id };
const schedule = { id: 'schedule', name: 'Revue utilisateur', cron_expr: '0 9 * * *', workspace_id: workspace.id, agent_id: agent.id, enabled: 1, catchup: 0, prompt: 'Prompt conservé', output_policy: 'new_session', busy_policy: 'skip', last_run_at: conversation.updated_at, next_run_at: '2026-05-02T09:00:00Z' };
const specs = [
  { version: 1, id: 'choices', kind: 'choices', title: 'Choix utilisateur', options: [{ id: 'a', label: 'Option conservée' }] },
  { version: 1, id: 'form', kind: 'form', title: 'Formulaire utilisateur', fields: [{ id: 'name', label: 'Nom conservé', type: 'text', required: true }, { id: 'days', label: 'Jours', type: 'number', required: true }, { id: 'target', label: 'Cible', type: 'select', required: true, options: [{ id: 'local', label: 'Local' }] }] },
  { version: 1, id: 'checklist', kind: 'checklist', title: 'Liste utilisateur', items: [{ id: 'a', label: 'Élément conservé' }] },
  { version: 1, id: 'table', kind: 'table', title: 'Table utilisateur', columns: [{ id: 'name', label: 'Nom' }, { id: 'count', label: 'Compte' }], rows: [{ name: 'Alpha', count: 1234.5 }, { name: 'Beta', count: 2 }] },
];
const fence = spec => '```cogitator-ui\n' + JSON.stringify(spec) + '\n```';
const legacy = { ...specs[0], id: 'legacy', title: 'Ancienne réponse' };
const initial = [
  { type: 'user', text: 'Message utilisateur conservé' },
  { type: 'tool', id: 'read', name: 'read', args: '{"path":"fixture.ts"}', result: '{"value":"contenu conservé"}', isError: false },
  { type: 'tool', id: 'error', name: 'bash', args: '{"command":"fixture-only"}', result: rawError, isError: true },
  { type: 'assistant', text: '## Contenu agent conservé\n\n```ts\nconst untouched = "conservé";\n```\n\n' + specs.map(fence).join('\n\n') + '\n\n' + fence(legacy) },
  { type: 'user', text: `Réponse à « ${legacy.title} » : transmise à l’agent.\n\n\`\`\`cogitator-response\n${JSON.stringify({ version: 1, request: legacy, values: { selection: 'a' } })}\n\`\`\`` },
  { type: 'assistant', text: fence({ version: 1, id: 'invalid', kind: 'html', title: 'Invalid', html: '<script>window.injected=1</script>' }) },
  { type: 'assistant', text: '```cogitator-ui\n{"version":1,' },
];
let history = [...initial];
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
let page;
async function instrument(target, storage = {}) {
  target.setDefaultTimeout(8000);
  target.on('pageerror', error => report.runtimeErrors.push(error.message.slice(0, 1000)));
  await target.evaluateOnNewDocument(({ denied, saved, languages }) => {
    if (languages) Object.defineProperty(navigator, 'languages', { get: () => languages });
    if (denied) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied by fixture', 'SecurityError'); } });
    else if (saved !== undefined) localStorage.setItem('cogitator.locale', saved);
    window.EventSource = class { readyState = 1; constructor() { setTimeout(() => this.onopen?.(), 0); } close() { this.readyState = 2; } };
  }, storage);
  await target.setRequestInterception(true);
  target.on('request', async request => {
    try {
      const url = new URL(request.url());
      if (!/^\/api(?:\/|$)/.test(url.pathname)) {
        if (url.origin === new URL(base).origin || ['data:', 'blob:'].includes(url.protocol)) return await request.continue();
        report.unexpectedRequests.push(url.href.slice(0, 200));
        return await request.abort();
      }
      const path = url.pathname;
      report.requests.push({ method: request.method(), path }); // Never log draft/key bodies.
      const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (request.method() !== 'GET') {
        await new Promise(resolve => setTimeout(resolve, 350));
        if (failWrites) return await respond({ error: path === '/api/mcp' ? 'serveur demo: command ou url requis' : rawError }, 503);
        assert(path.endsWith('/messages'), `Unexpected successful mutation fixture: ${path}`);
        history.push({ type: 'user', text: JSON.parse(request.postData()).text });
        return await respond({ ok: true });
      }
      if (mode === 'failure') return await respond({ error: rawError }, 503);
      const list = value => mode === 'empty' ? [] : [value];
      let data;
      if (path === '/api/health') data = { ok: true, version: 'fixture', pi_version: 'fixture', sessions_active: mode === 'empty' ? 0 : 1234, mcp_adapter_detected: false, db: { path: '/tmp/fixture.db', version: 3 } };
      else if (path === '/api/agents') data = { agents: list(agent) };
      else if (path === '/api/agents/agent') data = { agent };
      else if (path === '/api/providers') data = { providers: list({ id: 'fixture', source: 'custom', auth: { configured: true, type: 'api_key', ready: true }, models: [{ id: 'fixture-model' }] }) };
      else if (path === '/api/workspaces') data = { workspaces: list(workspace) };
      else if (path === '/api/conversations') data = { conversations: list(conversation) };
      else if (path === '/api/conversations/conversation') data = { conversation, live: true, streaming: false };
      else if (path === '/api/schedules') data = { schedules: list(schedule) };
      else if (path === '/api/mcp') data = { mcpServers: {} };
      else if (path === '/api/skills') data = { skills: [] };
      else if (path.endsWith('/history')) data = { entries: history, messages: [] };
      else if (path.endsWith('/board')) data = { cards: list(card) };
      else if (/\/board\/cards\/[^/]+\/activity$/.test(path)) data = { totals: { additions: 1234, deletions: 2, files: 0 }, perConversation: [] };
      else if (path.endsWith('/activity')) data = { files: [], totals: { additions: 1234, deletions: 2 }, conversations: 1 };
      else if (path.endsWith('/feed')) data = { events: mode === 'empty' ? [] : [{ path: 'fixture.ts', kind: 'edit', at: conversation.updated_at, additions: 1234, deletions: 2, hunks: [], conversationId: conversation.id, conversationTitle: conversation.title }], conversations: 1 };
      else if (path.endsWith('/tree')) data = { root: workspace.dir, tree: mode === 'empty' ? [] : [{ name: 'fixture.ts', path: 'fixture.ts', type: 'file', size: 1536 }] };
      else if (path.endsWith('/file')) data = { file: { path: 'fixture.ts', name: 'fixture.ts', size: 1536, content: 'const contenu = "conservé";', truncated: false } };
      else if (path.endsWith('/files')) data = { files: [] };
      else if (path.endsWith('/runs')) data = { runs: [] };
      else if (path === '/api/fs/browse') data = { path: '/tmp', parent: '/', entries: [{ name: 'i18n-fixture', path: workspace.dir, type: 'dir' }] };
      else { report.unexpectedRequests.push(path); return await respond({ error: 'Unmapped fixture route' }, 500); }
      await respond(data);
    } catch (error) { report.runtimeErrors.push(`Interception: ${error.message}`); if (!request.isInterceptResolutionHandled()) await request.abort(); }
  });
}
const pause = () => new Promise(resolve => setTimeout(resolve, 120));
async function check(name, action) { currentCheck = name; await action(); report.checks.push(name); console.log(`PASS ${name}`); }
async function expectText(selector, expected) {
  await page.waitForFunction((selector, expected) => [...document.querySelectorAll(selector)].some(e => e.textContent.includes(expected)), {}, selector, expected);
}
async function clickText(selector, expected) {
  await expectText(selector, expected);
  const handle = await page.evaluateHandle((selector, expected) => [...document.querySelectorAll(selector)].find(e => e.textContent.includes(expected)), selector, expected);
  await handle.asElement().click(); await handle.dispose();
}
async function nav(index) {
  if (await page.$eval('.topbar', e => getComputedStyle(e).display !== 'none')) await page.click('.topbar button');
  await page.click(`.nav-item:nth-child(${index + 1})`);
  await page.waitForSelector('main h1'); await pause();
}
async function locale(next) {
  language = next;
  await page.select('.language-picker select', next);
  await page.waitForFunction(next => document.documentElement.lang === next, {}, next);
}
async function closeDialog() { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]')); }
async function layout() {
  assert.deepEqual(await page.evaluate(() => {
    const problems = [];
    for (const e of [document.body, document.querySelector('main'), ...document.querySelectorAll('dialog[open] .modal, dialog[open] .modal-body')]) {
      if (e && e.scrollWidth > e.clientWidth + 1) problems.push(`${e.tagName}.${e.className}: overflow`);
    }
    for (const e of document.querySelectorAll('[role=tab]')) if (e.scrollWidth > e.clientWidth + 1) problems.push('tab label overflow');
    return problems;
  }), []);
}
async function screenshot(name) {
  assert(report.screenshots.length < 4, 'Screenshot budget exceeded');
  const path = resolve(output, `${name}.png`); await page.screenshot({ path }); report.screenshots.push(path);
}
async function openChat() { await nav(0); await page.click('.list-main'); await page.waitForSelector('[data-ui-id="form"]'); }
async function crossTab(next) {
  const other = await browser.newPage();
  try { await instrument(other); await other.goto(base, { waitUntil: 'networkidle2' }); await other.select('.language-picker select', next); }
  finally { await other.close(); }
  language = next;
  await page.waitForFunction(next => document.documentElement.lang === next, {}, next);
}
try {
  // A native getter throws before the module's first optional-storage support check.
  for (const scenario of [{ denied: true, languages: ['fr-FR'], expected: 'fr' }, { saved: 'invalid', languages: ['fr-CA'], expected: 'fr' }, { languages: ['de-DE'], expected: 'en' }]) {
    await check(`initial locale ${JSON.stringify(scenario)}`, async () => {
      const context = await browser.createBrowserContext();
      try { page = await context.newPage(); await instrument(page, scenario); await page.goto(base, { waitUntil: 'networkidle2' }); assert.equal(await page.$eval('html', e => e.lang), scenario.expected); await locale(scenario.expected === 'fr' ? 'en' : 'fr'); }
      finally { await context.close(); }
    });
  }
  page = await browser.newPage(); await instrument(page); await page.setViewport({ width: 1440, height: 900 }); await page.goto(base, { waitUntil: 'networkidle2' });
  for (const lang of ['en', 'fr']) {
    await locale(lang);
    for (const state of ['populated', 'empty', 'failure']) {
      mode = state; await page.reload({ waitUntil: 'networkidle2' });
      for (let index = 0; index < 6; index++) await check(`${lang} ${state} screen ${index}`, async () => {
        await nav(index);
        const keys = ['common.conversations', 'common.workspaces', 'common.agents', 'common.providers', 'common.cron', 'common.settings'];
        await expectText('.nav-item:nth-child(' + (index + 1) + ')', text(keys[index]));
        if (state === 'failure') await page.waitForSelector('main [role=alert]');
        else if (state === 'empty' && index < 5) await expectText('main', text(['chat.noConversations', 'screens.noWorkspaces', 'screens.noAgents', 'screens.noProviders', 'screens.noTasks'][index]));
        else if (state === 'populated') await expectText('main', [conversation.title, workspace.name, agent.name, 'fixture', schedule.name, 'fixture.db'][index]);
        await layout();
        if (state === 'populated' && index === 5) {
          const number = await page.evaluate(lang => new Intl.NumberFormat(lang).format(1234), lang);
          await expectText('main td', number); await screenshot(`${lang}-settings`);
        }
      });
    }
    mode = 'populated'; await page.reload({ waitUntil: 'networkidle2' });
    for (const [index, key] of ['chat.new', 'screens.addWorkspace', 'screens.newAgent', 'screens.addProvider', 'screens.newTask'].entries()) await check(`${lang} create dialog ${index}`, async () => {
      await nav(index); await clickText('main .page-actions button', text(key)); await page.waitForSelector('dialog[open]');
      assert(await page.$eval('dialog[open]', e => e.contains(document.activeElement)));
      const dialogHeading = await page.$eval('dialog h2', e => e.textContent.trim());
      assert(Object.values(catalog).some(entry => entry[lang] === dialogHeading), `Uncatalogued ${lang} dialog heading: ${dialogHeading}`);
      await layout(); await closeDialog();
      assert(await page.evaluate(() => !!document.activeElement.closest('.page-actions')));
    });
    await check(`${lang} API key failure preserves draft and modal across tabs`, async () => {
      await nav(3); await clickText('main table button', text('screens.apiKey')); await page.waitForSelector('dialog[open] input');
      await page.type('dialog input', 'not-a-credential-fixture');
      await page.evaluate(() => { window.retainedDialog = document.querySelector('dialog'); window.retainedInput = document.querySelector('dialog input'); });
      language = lang === 'en' ? 'fr' : 'en';
      await page.select('dialog .language-picker select', language);
      await page.waitForFunction(next => document.documentElement.lang === next, {}, language);
      await expectText('dialog button', text('screens.save'));
      assert.equal(await page.$eval('dialog input', e => e.value), 'not-a-credential-fixture');
      assert(await page.evaluate(() => window.retainedDialog === document.querySelector('dialog') && window.retainedInput === document.querySelector('dialog input')));
      await page.select('dialog .language-picker select', lang); language = lang;
      await crossTab(lang === 'en' ? 'fr' : 'en');
      assert(await page.evaluate(() => window.retainedDialog === document.querySelector('dialog') && window.retainedInput === document.querySelector('dialog input')));
      await expectText('dialog button', text('screens.save')); await crossTab(lang);
      await clickText('dialog button', text('screens.save')); await page.waitForSelector('dialog input:disabled'); await page.keyboard.press('Escape'); assert(await page.$('dialog[open]'));
      await page.waitForSelector('dialog [role=alert]'); assert.equal(await page.$eval('dialog input', e => e.value), 'not-a-credential-fixture'); await expectText('dialog [role=alert]', rawError); await closeDialog();
    });
    await check(`${lang} MCP save retains localized validation detail and draft`, async () => {
      await nav(5);
      const draft = '{"mcpServers":{"demo":{}}}';
      await page.$eval('main textarea', e => { e.focus(); e.select(); });
      await page.keyboard.type(draft);
      await clickText('main button', text('screens.saveConfig'));
      await expectText('main [role=alert]', text('screens.saveRejectedDetail', { error: text('diagnostic.serverCommand', { name: 'demo' }) }));
      assert.equal(await page.$eval('main textarea', e => e.value), draft);
      await locale(lang === 'en' ? 'fr' : 'en');
      await expectText('main [role=alert]', text('diagnostic.serverCommand', { name: 'demo' }));
      assert.equal(await page.$eval('main textarea', e => e.value), draft);
      await locale(lang);
    });
    await check(`${lang} seven workspace tabs and board details`, async () => {
      await nav(1); await page.click('.card .btn'); await page.waitForSelector('[role=tablist]'); assert.equal(await page.$$eval('[role=tab]', e => e.length), 7);
      for (let index = 0; index < 7; index++) {
        await page.click(`[role=tab]:nth-child(${index + 1})`); await pause(); await layout();
        assert.equal(await page.$eval(`[role=tab]:nth-child(${index + 1})`, e => e.getAttribute('aria-selected')), 'true');
        await expectText(`[role=tab]:nth-child(${index + 1})`, text(['workspace.board', 'workspace.activity', 'workspace.feed', 'workspace.files', 'workspace.conversations', 'workspace.team', 'workspace.pm'][index]));
        if (index === 2) { const day = await page.evaluate(({ lang, date }) => new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date)), { lang, date: conversation.updated_at }); await expectText('.feed-day', day); }
        if (index === 3) { await page.waitForSelector('.tree-row'); await expectText('.tree-size', text('workspace.kilobytes', { count: '2' })); await page.click('.tree-row'); await expectText('main', 'const contenu'); }
        if (index === 6) await page.waitForSelector('[data-ui-id="form"]');
        if (index === 0) { await page.waitForSelector('.board-title'); await page.click('.board-title'); await page.waitForSelector('dialog[open]'); await expectText('dialog', card.title); await expectText('.comment-text', 'Commentaire conservé'); const date = await page.evaluate(({ lang, date }) => new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date)), { lang, date: conversation.updated_at }); await expectText('.comment-head', date); await closeDialog(); }
      }
    });
    await check(`${lang} rich chat and legacy response replay`, async () => {
      history = [...initial]; await openChat();
      for (const spec of specs) { await page.waitForSelector(`[data-ui-id="${spec.id}"][data-ui-kind="${spec.kind}"]`); await expectText(`[data-ui-id="${spec.id}"]`, spec.title); }
      await expectText('[data-ui-id="legacy"] .gen-ui-summary', text('chat.sent'));
      assert.equal(await page.$('[data-ui-id="legacy"] button[type=submit]'), null);
      await expectText('.gen-ui-invalid', text('chat.incomplete')); assert.equal(await page.$$eval('.gen-ui-invalid', e => e.length), 2); assert.equal(await page.evaluate(() => window.injected), undefined);
      await expectText('[data-ui-id="form"]', text('chat.safety')); await expectText('.tool-chip', text('chat.done')); await expectText('.tool-chip.error', text('chat.error'));
      await expectText('button', text('chat.copyCode')); await expectText('.msg-assistant', 'Contenu agent conservé');
      await expectText('[data-ui-id="table"] td', await page.evaluate(lang => new Intl.NumberFormat(lang).format(1234.5), lang));
      if (lang === 'en') { await page.$eval('.chat-scroll', e => { e.scrollTop = 0; }); await screenshot('en-chat-desktop'); }
    });
    await check(`${lang} cross-tab chat state, validation, failure, submitting, submitted`, async () => {
      const requestsBeforeValidation = report.requests.filter(r => r.method !== 'GET').length;
      await page.click('[data-ui-id="form"] button[type=submit]');
      assert.equal(await page.$eval('[data-ui-id="form"] form', e => e.checkValidity()), false);
      assert.equal(report.requests.filter(r => r.method !== 'GET').length, requestsBeforeValidation, 'Invalid form must not send');
      await page.type('.chat-input textarea', 'Brouillon conservé'); await page.type('[data-ui-id="form"] input[type=text]', 'Version utilisateur');
      await page.type('[data-ui-id="form"] input[type=number]', '3'); await page.select('[data-ui-id="form"] select', 'local');
      await page.click('[data-ui-id="choices"] input'); await page.click('[data-ui-id="checklist"] input');
      await page.click('[data-ui-id="table"] th:nth-child(2) button');
      assert.equal(await page.$eval('[data-ui-id="table"] tbody tr:first-child td', e => e.textContent), 'Beta');
      await page.type('[data-ui-id="table"] input', 'Alpha');
      assert.equal(await page.$$eval('[data-ui-id="table"] tbody tr', rows => rows.length), 1);
      await page.evaluate(() => { window.retainedForm = document.querySelector('[data-ui-id="form"] input'); window.retainedChat = document.querySelector('.chat-input textarea'); });
      await crossTab(lang === 'en' ? 'fr' : 'en'); await expectText('[data-ui-id="form"]', text('chat.safety'));
      assert(await page.evaluate(() => window.retainedForm === document.querySelector('[data-ui-id="form"] input') && window.retainedChat === document.querySelector('.chat-input textarea')));
      assert.equal(await page.$eval('[data-ui-id="form"] input', e => e.value), 'Version utilisateur'); assert.equal(await page.$eval('[data-ui-id="form"] select', e => e.value), 'local');
      for (const id of ['choices', 'checklist']) assert(await page.$eval(`[data-ui-id="${id}"] input`, e => e.checked));
      assert.equal(await page.$eval('[data-ui-id="table"] input', e => e.value), 'Alpha'); await crossTab(lang);
      await page.click('[data-ui-id="form"] button[type=submit]'); await page.waitForSelector('[data-ui-id="form"] fieldset[disabled]'); await expectText('[data-ui-id="form"]', text('chat.submitting'));
      await page.waitForSelector('[data-ui-id="form"] [role=alert]'); await expectText('[data-ui-id="form"] [role=alert]', rawError);
      assert.equal(await page.$eval('[data-ui-id="form"] input', e => e.value), 'Version utilisateur');
      failWrites = false;
      for (const id of ['form', 'choices', 'checklist']) { await page.click(`[data-ui-id="${id}"] button[type=submit]`); await page.waitForSelector(`[data-ui-id="${id}"] .gen-ui-summary`); }
      failWrites = true; assert.equal(await page.$eval('.chat-input textarea', e => e.value), 'Brouillon conservé');
      await page.reload({ waitUntil: 'networkidle2' }); assert.equal(await page.$eval('html', e => e.lang), lang); await openChat();
      for (const id of ['form', 'choices', 'checklist', 'legacy']) await expectText(`[data-ui-id="${id}"] .gen-ui-summary`, text('chat.sent'));
    });
  }
  for (const width of [390, 320]) await check(`mobile ${width} navigation focus and bilingual overflow`, async () => {
    await page.setViewport({ width, height: 900 });
    for (const lang of ['en', 'fr']) {
      await page.click('.topbar button'); await locale(lang);
      assert(await page.$eval('.sidebar', e => e.contains(document.activeElement)));
      const focusable = await page.$$('.sidebar button:not([disabled]), .sidebar select, .sidebar a[href]');
      await focusable.at(-1).focus(); await page.keyboard.press('Tab'); assert(await page.$eval('.nav-close', e => e === document.activeElement));
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); assert(await page.$eval('.language-picker select', e => e === document.activeElement));
      await page.keyboard.press('Escape'); assert(await page.$eval('.topbar button', e => e === document.activeElement));
      for (let index = 0; index < 6; index++) { await nav(index); await layout(); }
      history = [...initial]; await openChat(); await layout();
      if (width === 390 && lang === 'fr') { await page.$eval('.chat-scroll', e => { e.scrollTop = 0; }); await screenshot('fr-chat-mobile'); }
    }
  });
  assert.equal(report.screenshots.length, 4);
  assert.deepEqual(report.runtimeErrors, [], 'Unexpected runtime errors'); assert.deepEqual(report.unexpectedRequests, [], 'Unmapped/external requests');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = { check: currentCheck, message: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') };
  try { report.diagnostics = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.querySelector('main h1')?.textContent, alerts: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent.slice(0, 400)).slice(0, 5), text: document.querySelector('main')?.innerText.slice(0, 2500) })); } catch { /* A closed page is already a failure, not an excuse to hide it. */ }
  console.error(JSON.stringify({ failure: report.failure, diagnostics: report.diagnostics, runtimeErrors: report.runtimeErrors.slice(0, 5), unexpectedRequests: report.unexpectedRequests.slice(0, 10) }, null, 2));
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(output, 'report.txt'), `${report.status}\n${report.checks.map(name => `PASS ${name}`).join('\n')}\n${report.failure ? `FAIL ${report.failure.check}: ${report.failure.message}\n` : ''}Intercepted API requests: ${report.requests.length}\nScreenshots (show every image to the user):\n${report.screenshots.join('\n')}\n`);
  await browser.close();
  console.log(`Report: ${output}/report.json (${report.status})`);
}
