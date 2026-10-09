// Isolated browser fixtures; no API request reaches the real backend.
// BROWSER_TOOLS_DIR=/path/to/browser-tools node scripts/ui-generative.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const output = process.env.UI_SCREENSHOTS ?? '/tmp/cogitator-generative';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
const runtimeErrors = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
const agent = { id: 'agent', name: 'Architecte', slug: 'chef-de-projet', provider: 'test', model: 'modele-test', skills: [], subagents: [] };
const workspace = { id: 'workspace', name: 'Atelier Cogitator', dir: '/tmp/atelier', conversation_count: 1, default_agent_id: 'agent' };
const conversation = { workspace_id: 'workspace', id: 'chat-ui', title: 'Préparer la prochaine version', agent_id: 'agent', status: 'idle', provider: 'test', model: 'modele-test', updated_at: '2026-05-01T10:00:00Z' };
const specs = [
  { version: 1, id: 'direction', kind: 'choices', title: 'Quel périmètre pour cette version ?', description: 'Les changements restent limités au chat. Choisis la priorité avant de poursuivre.', options: [{ id: 'lecture', label: 'Lecture et résultats', description: 'Hiérarchie des réponses, code et outils.' }, { id: 'interactions', label: 'Interfaces interactives', description: 'Formulaires et décisions dans le fil.' }] },
  { version: 1, id: 'brief', kind: 'form', title: 'Préciser la livraison', description: 'Ces valeurs servent à préparer le plan, pas à lancer un déploiement.', fields: [{ id: 'name', label: 'Nom de la version', type: 'text', required: true }, { id: 'days', label: 'Budget en jours', type: 'number', required: true }, { id: 'target', label: 'Environnement', type: 'select', required: true, options: [{ id: 'local', label: 'Local' }, { id: 'preview', label: 'Prévisualisation' }] }] },
  { version: 1, id: 'checks', kind: 'checklist', title: 'Points à vérifier', items: [{ id: 'keyboard', label: 'Navigation au clavier' }, { id: 'mobile', label: 'Mobile à 320 px' }, { id: 'recovery', label: 'Reprise après une erreur' }] },
  { version: 1, id: 'files', kind: 'table', title: 'Fichiers concernés', columns: [{ id: 'path', label: 'Fichier' }, { id: 'lines', label: 'Lignes' }, { id: 'status', label: 'État' }], rows: [{ path: 'web/src/ChatMessage.tsx', lines: 42, status: 'À vérifier' }, { path: 'web/src/GenerativeUI.tsx', lines: 128, status: 'Vérifié' }, { path: 'src/generative-ui.ts', lines: 96, status: 'Vérifié' }] },
];
const fence = spec => '```cogitator-ui\n' + JSON.stringify(spec) + '\n```';
const initial = [
  { type: 'user', text: 'Prépare la prochaine version du chat. Je veux des résultats lisibles et pouvoir répondre aux questions directement dans le fil.' },
  { type: 'tool', id: 'read-1', name: 'read', args: JSON.stringify({ path: 'web/src/ChatMessage.tsx' }), result: JSON.stringify({ fichier: 'ChatMessage.tsx', état: 'Lu', lignes: 42 }), isError: false },
  { type: 'assistant', text: '## Une conversation, plusieurs façons de répondre\n\nLe chat peut maintenant présenter ses résultats et recueillir tes décisions sans quitter le fil. Les détails techniques restent consultables.\n\n' + fence(specs[0]) },
  { type: 'assistant', text: fence(specs[1]) + '\n\n' + fence(specs[2]) + '\n\n' + fence(specs[3]) + '\n\n### Exemple de configuration\n\n```ts\nconst interfaceVersion = 1;\nconst mode = "lecture et interaction";\n```\n\n> Une réponse transmet des valeurs à l’agent, elle ne déclenche pas de déploiement.\n\n- [x] Contrat validé\n- [ ] Revue finale\n\n[Documentation](https://example.com/docs)' },
];
let history = [...initial];
let failNext = true;
const writes = [];
await page.evaluateOnNewDocument(() => {
  const sources = [];
  window.EventSource = class {
    static CLOSED = 2;
    readyState = 1;
    constructor(url) { this.url = url; sources.push(this); setTimeout(() => this.onopen?.(), 0); }
    close() { this.readyState = 2; }
  };
  window.emitChatEvent = event => sources.filter(source => source.readyState === 1 && source.url.includes('/conversations/')).forEach(source => source.onmessage?.({ data: JSON.stringify(event) }));
  window.reconnectChat = () => sources.filter(source => source.readyState === 1 && source.url.includes('/conversations/')).forEach(source => source.onopen?.());
});
await page.setRequestInterception(true);
page.on('request', async request => {
  const path = new URL(request.url()).pathname;
  if (!path.startsWith('/api/')) return request.continue();
  if (request.method() !== 'GET') {
    const body = JSON.parse(request.postData() ?? '{}');
    writes.push({ path, body });
    await new Promise(resolve => setTimeout(resolve, 400));
    if (failNext) { failNext = false; return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Connexion indisponible pour ce test' }) }); }
    if (path.endsWith('/messages')) history.push({ type: 'user', text: body.text });
    return request.respond({ contentType: 'application/json', body: '{"ok":true}' });
  }
  let data = {};
  if (path === '/api/health') data = { ok: true, version: 'test', pi_version: 'test', sessions_active: 0, db: { path: '/tmp/fixture', version: 3 } };
  else if (path === '/api/agents') data = { agents: [agent] };
  else if (path === '/api/workspaces') data = { workspaces: [workspace] };
  else if (path.endsWith('/activity')) data = { files: [], totals: { additions: 0, deletions: 0 } };
  else if (path.endsWith('/board')) data = { cards: [] };
  else if (path === '/api/conversations') data = { conversations: [conversation] };
  else if (path === '/api/conversations/chat-ui') data = { conversation, live: true, streaming: false };
  else if (path.endsWith('/history')) data = { entries: history, messages: [] };
  else if (path.endsWith('/files')) data = { files: [] };
  else if (path === '/api/skills') data = { skills: [] };
  await request.respond({ contentType: 'application/json', body: JSON.stringify(data) });
});
async function openChat() {
  await page.goto('http://127.0.0.1:5321', { waitUntil: 'networkidle2' });
  await page.click('.list-main');
  await page.waitForSelector('[data-ui-id="direction"]');
}
async function screenshot(name, selector) {
  if (selector) await page.$eval(selector, e => e.scrollIntoView({ block: 'start' }));
  await new Promise(resolve => setTimeout(resolve, 150));
  await page.screenshot({ path: `${output}/${name}.png` });
}
async function checkLayout(label) {
  const result = await page.evaluate(() => {
    const main = document.querySelector('main'), scroll = document.querySelector('.chat-scroll'), input = document.querySelector('.chat-input').getBoundingClientRect();
    const latest = document.querySelector('.chat-latest')?.getBoundingClientRect();
    return { latest: !latest || latest.top >= scroll.getBoundingClientRect().bottom - 1, body: document.body.scrollWidth <= innerWidth, main: main.scrollWidth <= main.clientWidth + 1, transcript: scroll.scrollWidth <= scroll.clientWidth + 1 && scroll.clientHeight >= 96, composer: input.bottom <= Math.min(innerHeight, main.getBoundingClientRect().bottom) + 1 && input.top > 0 };
  });
  assert(Object.values(result).every(Boolean), `${label}: ${JSON.stringify(result)}`);
}
try {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewport({ width, height: 900 });
    await openChat();
    await checkLayout(`${width}px`);
    assert.equal(await page.$('.composer-ui'), null, 'interactive UI must not require a dedicated composer button');
    assert(await page.$eval('.tool-head', e => e.getBoundingClientRect().height >= 40), 'tool disclosure must not shrink away');
    await page.$eval('.chat-scroll', e => { e.scrollTop = 0; });
    await screenshot(`conversation-${width}`);
    await screenshot(`choices-${width}`, '[data-ui-id="direction"]');
    await screenshot(`form-${width}`, '[data-ui-id="brief"]');
    await screenshot(`table-${width}`, '[data-ui-id="files"]');
    assert.equal(await page.$$eval('main h1', elements => elements.length), 1);
    console.log(`PASS: rich transcript and four UI components, ${width}px`);
  }
  await page.type('.chat-input textarea', 'Brouillon personnel conservé');
  const form = '[data-ui-id="brief"]';
  await page.type(`${form} input[type=text]`, 'Version 2');
  await page.type(`${form} input[type=number]`, '3');
  await page.select(`${form} select`, 'preview');
  await page.click(`${form} button[type=submit]`);
  assert(await page.$eval(`${form} input`, e => e.matches(':disabled')));
  await page.waitForSelector(`${form} [role=alert]`);
  assert.equal(await page.$eval(`${form} input[type=text]`, e => e.value), 'Version 2');
  assert.equal(writes.length, 1);
  assert(await page.$eval(`${form} [role=alert]`, e => e === document.activeElement), 'submission failure focuses the error');
  await screenshot('form-error-320', `${form} [role=alert]`);
  await page.click(`${form} button[type=submit]`);
  await page.waitForSelector(`${form} .gen-ui-summary`);
  assert.equal(writes.length, 2);
  assert(await page.$eval(form, e => e === document.activeElement), 'successful submission focuses its summary');
  assert.equal(await page.$eval('.chat-input textarea', e => e.value), 'Brouillon personnel conservé');
  assert.match(writes[1].body.text, /cogitator-response/);
  console.log('PASS: failure preserves form, retry succeeds, composer draft unaffected');

  await page.click('[data-ui-id="direction"] input[value=interactions]');
  await page.click('[data-ui-id="direction"] button[type=submit]');
  await page.waitForSelector('[data-ui-id="direction"] .gen-ui-summary');
  await page.click('[data-ui-id="checks"] input[value=keyboard]');
  await page.click('[data-ui-id="checks"] button[type=submit]');
  await page.waitForSelector('[data-ui-id="checks"] .gen-ui-summary');
  await openChat();
  for (const id of ['brief', 'direction', 'checks']) {
    await page.waitForSelector(`[data-ui-id="${id}"] .gen-ui-summary`);
    assert.equal(await page.$(`[data-ui-id="${id}"] button[type=submit]`), null);
  }
  console.log('PASS: form, choices and checklist submissions survive reload');

  const table = '[data-ui-id="files"]';
  await page.type(`${table} input[type=search]`, 'GenerativeUI');
  assert.equal(await page.$$eval(`${table} tbody tr`, rows => rows.length), 1);
  await page.$eval(`${table} input`, e => { e.focus(); e.select(); });
  await page.keyboard.press('Backspace');
  await page.click(`${table} th:nth-child(2) button`);
  assert.equal(await page.$eval(`${table} tbody tr:first-child td:nth-child(2)`, e => e.textContent), '42');
  console.log('PASS: table filters and sorts without sending a message');

  await page.focus('.chat-input textarea');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Joindre une image');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setViewport({ width: 720, height: 450 }); // 1440x900 viewport at 200% effective zoom.
  await checkLayout('200% effective viewport');
  await screenshot('zoom-200');
  console.log('PASS: composer keyboard order, reduced motion and 200% effective viewport');

  // A closed block is rendered only in assistant output; partial JSON stays inert.
  history = [{ type: 'user', text: fence(specs[0]) }, { type: 'assistant', text: 'Une interface est en préparation.\n\n```cogitator-ui\n{"version":1,' }];
  await page.goto('http://127.0.0.1:5321', { waitUntil: 'networkidle2' });
  await page.click('.list-main');
  await page.waitForFunction(() => document.querySelector('.gen-ui-invalid')?.textContent.includes('bloc JSON est incomplet'));
  assert.equal(await page.$('.gen-ui form'), null);
  assert.equal(await page.$('[data-ui-id="direction"]'), null);
  const streamed = fence({ ...specs[0], id: 'streamed' });
  await page.evaluate(first => {
    window.emitChatEvent({ type: 'turn_start' });
    window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: first } });
  }, streamed.slice(0, -4));
  assert.equal(await page.$('[data-ui-id="streamed"]'), null);
  await page.evaluate(last => window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: last } }), streamed.slice(-4));
  await page.waitForSelector('[data-ui-id="streamed"] fieldset[disabled]');
  await page.evaluate(() => window.emitChatEvent({ type: 'agent_end' }));
  await page.waitForSelector('[data-ui-id="streamed"] fieldset:not([disabled])');
  console.log('PASS: streamed interface activates only after completion and agent end');
  await page.evaluate(() => {
    window.emitChatEvent({ type: 'tool_execution_start', toolCallId: 'live', toolName: 'bash', args: { command: 'npm test' } });
    window.emitChatEvent({ type: 'tool_execution_update', toolCallId: 'live', partialResult: { content: [{ type: 'text', text: 'Vérification en cours…' }] } });
  });
  await page.waitForSelector('.tool-chip.running');
  await page.evaluate(() => window.emitChatEvent({ type: 'tool_execution_end', toolCallId: 'live', isError: true, result: { content: [{ type: 'text', text: 'Accès refusé pour cet exemple.' }] } }));
  await page.waitForSelector('.tool-chip.error');
  await page.click('.tool-chip.error summary');
  await screenshot('tool-error', '.tool-chip.error');
  console.log('PASS: live execution result and error are visible, not inferred from generated arguments');
  await page.evaluate(() => {
    window.emitChatEvent({ type: 'turn_start' });
    window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '```cogitator-ui\n{"version":1,"id":"unsafe","kind":"html","title":"Test","html":"<script>window.injected=1</script>"}\n```' } });
  });
  await page.waitForSelector('.gen-ui-invalid');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.$('.gen-ui-invalid script'), null);
  console.log('PASS: user code remains inert, interrupted UI offers correction, invalid HTML rejected');

  history = [...initial];
  await page.setViewport({ width: 390, height: 900 });
  await openChat();
  await page.type('[data-ui-id="brief"] input[type=text]', 'Saisie en cours');
  await page.evaluate(first => {
    window.emitChatEvent({ type: 'turn_start' });
    window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    window.emitChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: first } });
    window.emitChatEvent({ type: 'tool_execution_start', toolCallId: 'missed', toolName: 'read', args: { path: 'missing.ts' } });
    window.emitChatEvent({ type: 'tool_execution_update', toolCallId: 'missed', partialResult: { content: [{ type: 'text', text: 'Partiel' }] } });
  }, streamed.slice(0, -4));
  await page.waitForSelector('.tool-chip.running');
  history = [...initial.slice(0, 2), { type: 'thinking', text: 'Précisions de la proposition' }, ...initial.slice(2), { type: 'assistant', text: streamed }, { type: 'tool', id: 'missed', name: 'read', args: '{}', result: 'Erreur finale récupérée', isError: true }];
  await page.evaluate(() => window.reconnectChat());
  await page.waitForSelector('[data-ui-id="streamed"] fieldset:not([disabled])');
  await page.waitForSelector('.tool-chip.error');
  assert.equal(await page.$eval('[data-ui-id="brief"] input[type=text]', e => e.value), 'Saisie en cours', 'inserting recovered reasoning must not remount an edited form');
  history.push({ type: 'user', text: writes[1].body.text });
  await page.evaluate(() => window.reconnectChat());
  await page.waitForSelector('[data-ui-id="brief"] .gen-ui-summary');
  console.log('PASS: reconnect recovers missed closing fence, tool result, agent end and remote response; edited form survives inserted reasoning');
  history = [...initial];
  for (const width of [1440, 390, 320]) {
    await page.setViewport({ width, height: 900 });
    await page.goto('http://127.0.0.1:5321', { waitUntil: 'networkidle2' });
    if (width < 768) await page.click('.topbar button');
    await page.click('.nav-item:nth-child(2)');
    await page.waitForSelector('.card .btn');
    await page.click('.card .btn');
    await page.waitForSelector('[role=tablist]');
    await page.click('[role=tab]:last-child');
    await page.waitForSelector('[data-ui-id="direction"]');
    await checkLayout(`workspace ${width}px`);
    assert.equal(await page.$$eval('main h1', e => e.length), 1);
    assert(await page.$('.chat-heading h2'));
    await screenshot(`workspace-${width}`, '[data-ui-id="direction"]');
  }
  await page.setViewport({ width: 720, height: 450 });
  await page.$eval('.tab-chat', e => e.scrollIntoView({ block: 'start' }));
  await checkLayout('workspace 200% effective viewport');
  assert(await page.evaluate(() => document.querySelector('.chat-heading').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom), 'workspace chat heading must not hide under the app bar');
  await screenshot('workspace-zoom-200');
  console.log('PASS: workspace embedded chat, 1440/390/320px and 200% effective viewport, unique page heading');
  const contrast = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = token => (token === 'white' ? [1,1,1] : style.getPropertyValue(token).trim().slice(1).match(/../g).map(v => parseInt(v,16)/255)).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i],0);
    return [['--muted','--surface',4.5],['--subtle','--surface',4.5],['white','--accent',4.5],['--control-border','--raised',3]].map(([fg,bg,min]) => {const a=luminance(fg),b=luminance(bg);return {fg,bg,min,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
  });
  contrast.forEach(pair => assert(pair.ratio >= pair.min, JSON.stringify(pair)));
  console.log('PASS: chat/control contrast', JSON.stringify(contrast));
  assert.deepEqual(runtimeErrors, []);
  console.log(`PASS: no runtime errors; ${writes.length} requests intercepted. Screenshots: ${output}`);
} finally { await page.close(); await browser.close(); }
