// Vite :5321 + Chrome. APIs are intercepted: this check never writes user data.
// BROWSER_TOOLS_DIR=/path/to/browser-tools node scripts/ui-polish.mjs
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const output = process.env.UI_SCREENSHOTS ?? '/tmp/cogitator-polish';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const long = 'configuration-de-production-avec-un-nom-particulierement-long';
const agent = { id: 'agent', slug: 'chef-de-projet', name: 'Revue de code', description: 'Vérifie les changements et leurs tests.', provider: 'test', model: long, thinking: null, skills: [], subagents: [], mcp_servers: [], system_prompt: '', is_default: 1 };
const workspace = { id: 'workspace', name: long, dir: `/tmp/${long}/projet`, default_agent_id: agent.id, conversation_count: 1 };
const conversation = { id: 'conversation', title: long, status: 'idle', provider: 'test', model: long, agent_id: agent.id, workspace_id: workspace.id, updated_at: '2026-05-01T12:00:00Z' };
const card = { id: 'card', number: 1, title: long, description: 'Vérifier les états et les interactions au clavier.', status: 'todo', priority: 'medium', labels: [], conversation_ids: [], blocks: [], blocked_by: [], comments: [], assignee_agent_id: agent.id };
const schedule = { id: 'schedule', name: 'Revue quotidienne', cron_expr: '0 9 * * *', workspace_id: workspace.id, agent_id: agent.id, enabled: 1, catchup: 0, prompt: 'Vérifie les changements.', output_policy: 'new_session', busy_policy: 'skip', last_run_at: null, next_run_at: '2026-05-02T09:00:00Z' };
let mode = 'populated';
let writes = 0;
let mutationDelay = 0;
await page.setRequestInterception(true);
page.on('request', async request => {
  const { pathname } = new URL(request.url());
  if (!pathname.startsWith('/api/')) return request.continue();
  if (request.method() !== 'GET') {
    writes++;
    if (mutationDelay) await new Promise(resolve => setTimeout(resolve, mutationDelay));
    return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Échec simulé, brouillon conservé.' }) });
  }
  if (pathname.endsWith('/events')) return request.respond({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (mode === 'error' && !['/api/health'].includes(pathname)) return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service indisponible pour ce test.' }) });
  const list = value => mode === 'empty' ? [] : [value];
  let data = {};
  if (pathname === '/api/health') data = { ok: true, version: '0.1.1', pi_version: '1.0.4', sessions_active: 0, mcp_adapter_detected: false, db: { path: '/tmp/verification.db', version: 3 } };
  else if (pathname === '/api/agents') data = { agents: list(agent) };
  else if (pathname === '/api/agents/agent') data = { agent };
  else if (pathname === '/api/providers') data = { providers: list({ id: 'test', source: 'custom', auth: { configured: true, type: 'api-key', ready: true }, models: [{ id: long }] }) };
  else if (pathname === '/api/workspaces') data = { workspaces: list(workspace) };
  else if (pathname === '/api/conversations') data = { conversations: list(conversation) };
  else if (pathname === '/api/conversations/conversation') data = { conversation, live: true };
  else if (pathname === '/api/schedules') data = { schedules: list(schedule) };
  else if (pathname === '/api/mcp') data = { mcpServers: {} };
  else if (pathname === '/api/skills') data = { skills: [] };
  else if (pathname.endsWith('/board')) data = { cards: list(card) };
  else if (pathname.endsWith('/activity')) data = { files: [], totals: { additions: 0, deletions: 0 }, conversations: 1 };
  else if (pathname.endsWith('/feed')) data = { events: [], conversations: 1 };
  else if (pathname.endsWith('/tree')) data = { root: workspace.dir, tree: [] };
  else if (pathname.endsWith('/files')) data = { files: [] };
  else if (pathname.endsWith('/runs')) data = { runs: [] };
  else if (pathname.endsWith('/history')) data = { entries: [{ type: 'user', text: 'Vérifie cette interface.' }, { type: 'assistant', text: '## Vérification\n\nLes changements sont prêts pour une revue.\n\n- Navigation au clavier\n- Mise en page responsive\n\n```ts\nconst message = "Une ligne longue pour vérifier le défilement dans le bloc de code";\n```' }], messages: [] };
  else if (pathname === '/api/fs/browse') data = { path: '/tmp', parent: '/', entries: [{ name: long, path: workspace.dir, type: 'dir' }] };
  await request.respond({ contentType: 'application/json', body: JSON.stringify(data) });
});
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
const clickText = async (selector, text) => {
  await page.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].some(e => e.textContent.includes(text)), {}, selector, text).catch(error => { throw new Error(`Missing ${selector}: ${text}`, { cause: error }); });
  const button = await page.evaluateHandle((selector, text) => [...document.querySelectorAll(selector)].find(e => e.textContent.includes(text)), selector, text);
  await button.asElement().click();
  await button.dispose();
  await pause();
};
const nav = async index => {
  if (await page.$eval('.topbar', e => getComputedStyle(e).display !== 'none')) {
    await page.click('.topbar button');
    await pause();
  }
  await page.click(`.nav-item:nth-child(${index + 1})`);
  await pause();
};
async function checkLayout(name) {
  const issues = await page.evaluate(() => {
    const main = document.querySelector('main');
    const problems = [];
    if (document.body.scrollWidth > innerWidth || main.scrollWidth > main.clientWidth + 1) problems.push('page overflow');
    for (const element of document.querySelectorAll('dialog[open] .modal, dialog[open] .modal-body')) {
      const bounds = element.getBoundingClientRect();
      if (element.scrollWidth > element.clientWidth + 1 || bounds.left < 0 || bounds.right > innerWidth + 1) problems.push('dialog overflow');
    }
    const tabs = [...document.querySelectorAll('[role=tab]')];
    if (tabs.some(e => e.scrollWidth > e.clientWidth + 1)) problems.push('overlapping tab labels');
    for (const e of document.querySelectorAll('button')) {
      if (!e.textContent.trim() && !e.getAttribute('aria-label') && !e.getAttribute('title')) problems.push('unnamed button');
    }
    return problems;
  });
  await page.screenshot({ path: `${output}/${name}.png` });
  if (issues.length) console.log(name, await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(e => ({ tag: e.tagName, class: e.className, width: e.getBoundingClientRect().width, right: e.getBoundingClientRect().right }))));
  assert.deepEqual(issues, [], name);
}
try {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewport({ width, height: 900 });
    await page.goto('http://127.0.0.1:5321', { waitUntil: 'networkidle2' });
    for (const [index, name] of ['conversations', 'workspaces', 'agents', 'providers', 'cron', 'settings'].entries()) {
      await nav(index);
      await checkLayout(`${name}-${width}`);
    }
    console.log(`PASS: six populated pages, long names, ${width}px`);
  }

  // The drawer owns focus, closes on Escape and does not leave desktop inert on resize.
  await page.click('.topbar button');
  assert(await page.evaluate(() => document.querySelector('.sidebar').contains(document.activeElement)));
  await page.focus('.nav-item:last-child');
  await page.keyboard.press('Tab');
  assert(await page.$eval('.nav-close', e => e === document.activeElement));
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  assert(await page.$eval('.nav-item:last-child', e => e === document.activeElement));
  await page.keyboard.press('Escape');
  assert(await page.$eval('.topbar button', e => e === document.activeElement));
  await page.click('.topbar button');
  await page.setViewport({ width: 1440, height: 900 });
  await page.waitForFunction(() => !document.querySelector('main').inert);
  console.log('PASS: mobile drawer focus loop, Escape, restore and desktop resize');

  // Open each create form at mobile width, including native dialog focus restoration.
  await page.setViewport({ width: 390, height: 844 });
  for (const [index, text] of [[0, 'Nouvelle conversation'], [1, 'Ajouter un workspace'], [2, 'Nouvel agent'], [3, 'Ajouter un fournisseur'], [4, 'Nouvelle tâche']]) {
    await nav(index);
    await clickText('main .page-actions button', text);
    await page.waitForSelector('dialog[open]');
    assert(await page.$eval('dialog[open]', e => e.contains(document.activeElement)));
    await checkLayout(`form-${index}-390`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert(await page.evaluate(() => document.activeElement?.closest('.page-actions') !== null));
  }
  console.log('PASS: five mobile forms, focus and Escape');

  await nav(3);
  await clickText('main table button', 'Clé API');
  await page.type('dialog input', 'cle-de-test-non-enregistree');
  mutationDelay = 1200;
  await clickText('dialog button', 'Enregistrer');
  assert(await page.$eval('dialog input', e => e.matches(':disabled')));
  await page.keyboard.press('Escape');
  assert(await page.$('dialog[open]'));
  await page.click('dialog [aria-label="Fermer"]');
  assert(await page.$('dialog[open]'));
  await page.waitForSelector('dialog [role=alert]');
  assert.equal(await page.$eval('dialog input', e => e.value), 'cle-de-test-non-enregistree');
  await checkLayout('inline-error-390');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  mutationDelay = 0;
  console.log('PASS: pending dialog cannot close; failure stays inline and draft survives');

  await nav(1);
  await clickText('.card button', 'Ouvrir');
  await page.waitForSelector('[role=tablist]');
  const tabs = await page.$$eval('[role=tab]', elements => elements.map(e => e.textContent.trim()));
  for (const label of tabs) {
    await clickText('[role=tab]', label);
    await checkLayout(`workspace-${tabs.indexOf(label)}-390`);
  }
  console.log(`PASS: ${tabs.length} workspace tabs at 390px`);

  await nav(0);
  await clickText('.list-main', conversation.title);
  await page.waitForSelector('.msg-assistant');
  await checkLayout('chat-390');
  await page.focus('.chat-input textarea');
  await page.keyboard.type('Brouillon à conserver');
  await clickText('.chat-input button', 'Envoyer');
  assert.equal(await page.$eval('.chat-input textarea', e => e.value), 'Brouillon à conserver');
  console.log('PASS: chat render and failed-send draft preservation');

  for (mode of ['empty', 'error']) {
    await page.reload({ waitUntil: 'networkidle2' });
    for (let index = 0; index < 6; index++) {
      await nav(index);
      await checkLayout(`${mode}-${index}-390`);
      if (mode === 'error') assert(await page.$('[role=alert]'), `Missing error on page ${index}`);
    }
  }
  console.log('PASS: empty and failed-load states on every page');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert(await page.evaluate(() => {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    document.body.append(spinner);
    const stopped = getComputedStyle(spinner).animationName === 'none';
    spinner.remove();
    return stopped;
  }));
  const contrast = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = token => style.getPropertyValue(token).trim().slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    return [['--subtle', '--raised', 4.5], ['--muted', '--popover', 4.5], ['--control-border', '--raised', 3], ['--control-border', '--popover', 3]].map(([foreground, background, minimum]) => {
      const a = luminance(foreground), b = luminance(background);
      return { foreground, background, minimum, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  });
  for (const pair of contrast) assert(pair.ratio >= pair.minimum, JSON.stringify(pair));
  console.log('PASS: shared text/control contrast and reduced-motion spinner');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log(`PASS: no runtime errors; ${writes} writes intercepted. Screenshots: ${output}`);
} finally {
  await browser.close();
}
