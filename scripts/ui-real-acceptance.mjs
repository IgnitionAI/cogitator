// Opt-in, real mutations and model calls. No request interception or fake clients.
// Running backend :5320 also serves the built UI; override COGITATOR_UI_URL to use Vite.
// COGITATOR_REAL_TEST=1 BROWSER_TOOLS_DIR=/path/to/browser-tools node scripts/ui-real-acceptance.mjs setup
// Resume with ACCEPTANCE_DIR=<printed directory> and phase: conversation | board | cron | cleanup.
// Board creates ONE GitHub issue on the current repo remote; cleanup closes it (not deletion).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
if (process.env.COGITATOR_REAL_TEST !== '1') throw new Error('Set COGITATOR_REAL_TEST=1: this test calls real models and creates a GitHub issue.');
const phase = process.argv[2] ?? 'setup';
assert(['setup', 'conversation', 'board', 'cron', 'cleanup'].includes(phase));
const output = process.env.ACCEPTANCE_DIR ?? (phase === 'setup' ? mkdtempSync('/tmp/cogitator-real-acceptance-') : null);
assert(output, 'ACCEPTANCE_DIR is required after setup');
const statePath = join(output, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { name: `Recette UI temporaire ${basename(output)}`, proofs: {} };
const backend = process.env.COGITATOR_API_URL ?? 'http://127.0.0.1:5320';
const frontend = process.env.COGITATOR_UI_URL ?? backend;
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${backend}/api${path}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${result.error ?? ''}`);
  return result;
};
const poll = async (read, pass, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) { result = await read(); if (pass(result)) return result; await new Promise(r => setTimeout(r, 500)); }
  throw new Error(`Timed out waiting for backend read-back: ${JSON.stringify(result).slice(0, 500)}`);
};
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const browser = phase === 'cleanup' ? null : await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = browser ? await browser.newPage() : null;
const click = async (selector, text) => {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some(e => e.textContent.trim().includes(t) && !e.disabled), { timeout: 60000 }, selector, text);
  await page.evaluate((s, t) => [...document.querySelectorAll(s)].find(e => e.textContent.trim().includes(t) && !e.disabled).click(), selector, text);
};
const field = async (label, value) => {
  const selector = await page.evaluate(label => {
    const group = [...document.querySelectorAll('dialog label.field')].find(e => e.querySelector('.field-label')?.textContent === label);
    const control = group?.querySelector('input,textarea,select');
    if (!control) throw new Error(`Missing field ${label}`);
    control.id ||= `real-${Math.random().toString(36).slice(2)}`;
    return `#${control.id}`;
  }, label);
  const tag = await page.$eval(selector, e => e.tagName);
  if (tag === 'SELECT') {
    await page.waitForFunction((s, v) => [...document.querySelector(s).options].some(o => o.value === v), { timeout: 60000 }, selector, value);
    assert.deepEqual(await page.select(selector, value), [value]);
  }
  else { await page.focus(selector); await page.$eval(selector, e => e.select()); await page.keyboard.type(value); }
};
const response = (path, method = 'POST') => page.waitForResponse(r => new URL(r.url()).pathname === `/api${path}` && r.request().method() === method, { timeout: 120000 }).then(async r => { const body = await r.json(); assert(r.ok(), JSON.stringify(body)); return body; });
const shot = async name => { await new Promise(r => setTimeout(r, 250)); await page.screenshot({ path: join(output, `${name}.png`) }); };
const nav = async name => { await click('.nav-item', name); await page.waitForFunction(name => document.querySelector('main h1')?.textContent === name, {}, name); };
const openWorkspace = async () => {
  await nav('Workspaces');
  await page.waitForFunction(name => [...document.querySelectorAll('main .card')].some(c => c.querySelector('h4')?.textContent === name), {}, state.name);
  await page.evaluate(name => [...document.querySelectorAll('main .card')].find(c => c.querySelector('h4')?.textContent === name).querySelector('button').click(), state.name);
  await page.waitForSelector('[role=tablist]');
};
try {
  if (page) { await page.setViewport({ width: 1440, height: 900 }); await page.goto(frontend, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.nav-item'); }
  if (phase === 'setup') {
    assert(!state.agentId && !state.workspaceId, 'Setup is not repeatable; resume another phase.');
    state.baseline = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    state.provider = process.env.REAL_PROVIDER ?? 'kimi-coding';
    state.model = process.env.REAL_MODEL ?? 'kimi-for-coding';
    const providers = (await api('/providers')).providers;
    assert(providers.some(p => p.id === state.provider && p.auth.ready && p.models.some(m => m.id === state.model)), 'Selected provider/model must be available and authenticated');
    state.workspaceDir = join(output, 'workspace');
    mkdirSync(state.workspaceDir);
    state.remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', state.workspaceDir]);
    execFileSync('git', ['-C', state.workspaceDir, 'remote', 'add', 'origin', state.remote]);
    state.workspaceDir = realpathSync(state.workspaceDir);
    writeFileSync(join(state.workspaceDir, 'README.md'), 'Workspace temporaire de recette Cogitator. Aucun projet existant.\n');
    const workspace = await api('/workspaces', 'POST', { dir: state.workspaceDir, name: state.name });
    state.workspaceId = workspace.workspace.id; save();
    await nav('Agents'); await click('main button', 'Nouvel agent'); await page.waitForSelector('dialog[open]');
    await field('Nom', state.name); await field('Provider', state.provider); await field('Modèle', state.model); await field('Thinking', 'off');
    await field('Tools allowlist (vide = tous)', 'read, write, edit');
    await field('Description', 'Agent temporaire de recette réelle, à supprimer après validation.');
    await field('Prompt de scope (system prompt)', `Tu es un agent de recette dans ${state.workspaceDir}. Pour toute demande d’écriture de fichier, utilise write/edit, uniquement dans ce dossier. Ne consulte ni ne modifie aucun autre dossier, aucune configuration ou credential. N’utilise ni bash, ni réseau, ni subagent, ni skill. Ne modifie pas GitHub ou le board toi-même. Réponds brièvement sauf si le prompt demande explicitement une sortie longue pour tester Stop.`);
    const created = response('/agents'); await click('dialog button', 'Sauvegarder + Apply');
    state.agentId = (await created).agent.id; save();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 60000 });
    const validation = await api(`/agents/${state.agentId}/validate`, 'POST'); assert.deepEqual(validation.errors, []);
    state.proofs.setup = { agentCreatedViaUI: true, workspaceId: state.workspaceId, agentId: state.agentId, validationErrors: 0, provider: state.provider, model: state.model };
    await shot('agent-created');
  } else if (phase === 'conversation') {
    assert(state.agentId && state.workspaceId && !state.conversationId, 'Conversation already exists; do not create a duplicate on retry.');
    await nav('Conversations'); await click('main button', 'Nouvelle conversation'); await page.waitForSelector('dialog[open]');
    await field('Agent', state.agentId); await field('Workspace (optionnel)', state.workspaceId);
    const created = response('/conversations'); await click('dialog button', 'Créer');
    state.conversationId = (await created).conversation.id; save();
    await page.waitForSelector('.chat-input textarea', { timeout: 60000 });
    await page.evaluate(id => {
      window.acceptanceEvents = [];
      window.acceptanceSource = new EventSource(`/api/conversations/${id}/events`);
      window.acceptanceSource.onmessage = e => { const ev = JSON.parse(e.data); window.acceptanceEvents.push({ type: ev.type, subtype: ev.assistantMessageEvent?.type }); };
    }, state.conversationId);
    await page.waitForFunction(() => window.acceptanceEvents.some(e => e.type === 'session'), { timeout: 60000 });
    await page.type('.chat-input textarea', 'N’utilise aucun outil. Écris une liste de 3000 lignes numérotées, chaque ligne contenant une phrase française différente de douze mots. Commence immédiatement, sans introduction et sans condenser. Cette sortie sert uniquement à tester l’interruption du streaming.');
    const sent = response(`/conversations/${state.conversationId}/messages`); await click('.chat-input button', 'Envoyer'); await sent;
    await page.waitForFunction(() => window.acceptanceEvents.some(e => e.subtype === 'text_delta'), { timeout: 120000 });
    await page.waitForSelector('.msg-assistant');
    const stopped = response(`/conversations/${state.conversationId}/stop`); await click('.chat-head button', 'Stop'); await stopped;
    await page.waitForFunction(() => window.acceptanceEvents.some(e => e.type === 'agent_end'), { timeout: 30000 });
    const observed = await page.evaluate(() => window.acceptanceEvents);
    const history = await api(`/conversations/${state.conversationId}/history`);
    assert(history.entries.some(e => e.type === 'assistant' && e.text.length > 0));
    state.proofs.conversation = { createdViaUI: true, messageAccepted: true, textDeltas: observed.filter(e => e.subtype === 'text_delta').length, stopAccepted: true, agentEnd: true, sessionFile: (await api(`/conversations/${state.conversationId}`)).conversation.session_file };
    await page.setViewport({ width: 320, height: 750 }); await shot('conversation-stopped-mobile');
  } else if (phase === 'board') {
    assert(state.agentId && state.workspaceId && !state.cardId, 'Board phase creates a single issue; do not rerun after creation.');
    await openWorkspace(); await click('main button', '+ Carte'); await page.waitForSelector('dialog[open]');
    state.cardTitle = `[recette temporaire] ${state.name}`;
    await field('Titre', state.cardTitle);
    await field('Description', 'Recette technique temporaire. Crée le fichier acceptance-result.txt dans le workspace courant, avec exactement COGITATOR_REAL_ACCEPTANCE_OK suivi d’un saut de ligne. Utilise write. Ne modifie aucun autre fichier ni issue. Réponds brièvement une fois terminé.');
    const created = response(`/workspaces/${state.workspaceId}/board/cards`); await click('dialog button', 'Créer');
    const card = (await created).card; state.cardId = card.id; state.issueUrl = card.url; save();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await click('.board-title', state.cardTitle); await page.waitForSelector('dialog[open]');
    await field('Assigné (agent Cogitator)', state.agentId);
    assert(await page.evaluate(() => [...document.querySelectorAll('dialog button')].find(b => b.textContent.includes('Lancer')).disabled));
    const saved = response(`/workspaces/${state.workspaceId}/board/cards/${state.cardId}`, 'PUT'); await click('dialog button', 'Sauvegarder'); assert.equal((await saved).card.assignee_agent_id, state.agentId);
    await page.waitForFunction(() => [...document.querySelectorAll('dialog button')].some(b => b.textContent.includes('Lancer') && !b.disabled), { timeout: 60000 });
    state.commentText = 'Recette réelle : commentaire enregistré et visible sans fermer la carte.';
    await page.type('dialog input[placeholder="Commenter…"]', state.commentText);
    const commented = response(`/workspaces/${state.workspaceId}/board/cards/${state.cardId}/comments`); await click('dialog button', 'Envoyer'); await commented;
    await page.waitForFunction(text => [...document.querySelectorAll('.comment-text')].some(e => e.textContent === text), { timeout: 60000 }, state.commentText);
    await shot('board-comment');
    const started = response(`/workspaces/${state.workspaceId}/board/cards/${state.cardId}/start`); await click('dialog button', 'Lancer');
    const result = await started; state.boardConversationId = result.conversation.id; save();
    const files = await poll(() => api(`/conversations/${state.boardConversationId}/files`), r => r.files.some(f => f.path.endsWith('acceptance-result.txt')));
    assert.equal(readFileSync(join(state.workspaceDir, 'acceptance-result.txt'), 'utf8').trim(), 'COGITATOR_REAL_ACCEPTANCE_OK');
    const cards = await api(`/workspaces/${state.workspaceId}/board`); const updated = cards.cards.find(c => c.id === state.cardId);
    assert(updated.conversation_ids.includes(state.boardConversationId)); assert.equal(updated.status, 'in_progress');
    const activity = await api(`/workspaces/${state.workspaceId}/activity`); assert(activity.files.some(f => f.path.endsWith('acceptance-result.txt')));
    const cardActivity = await api(`/workspaces/${state.workspaceId}/board/cards/${state.cardId}/activity`); assert(cardActivity.totals.files >= 1);
    await nav('Workspaces'); await openWorkspace(); await click('[role=tab]', 'Activité');
    await page.waitForFunction(() => [...document.querySelectorAll('.file-path')].some(e => e.textContent.includes('acceptance-result.txt')), { timeout: 60000 });
    await shot('workspace-activity'); await click('[role=tab]', 'Fichiers'); await click('.tree-row', 'acceptance-result.txt');
    await page.waitForFunction(() => document.querySelector('.tree-content')?.textContent.includes('COGITATOR_REAL_ACCEPTANCE_OK')); await shot('workspace-file');
    state.proofs.board = { createdViaUI: true, issueUrl: state.issueUrl, assignmentPersisted: true, commentVisibleWithoutReopening: true, launchedViaUI: true, conversationLinked: true, status: updated.status, actualFileWritten: true, conversationFiles: files.files.length, activityFiles: cardActivity.totals.files, fileVisibleViaUI: true };
  } else if (phase === 'cron') {
    assert(state.agentId && state.workspaceId && !state.scheduleId);
    await nav('Cron'); await click('main button', 'Nouvelle tâche'); await page.waitForSelector('dialog[open]');
    await field('Nom', state.name); await field('Expression cron', '0 0 1 1 *'); await field("Prompt tiré à l'exécution", 'N’utilise aucun outil. Réponds exactement CRON_REAL_OK.');
    await field('Agent', state.agentId); await field('Workspace', state.workspaceId); await field('Sortie', 'append_session');
    const created = response('/schedules'); await click('dialog button', 'Sauvegarder'); state.scheduleId = (await created).schedule.id; save();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await api(`/schedules/${state.scheduleId}`, 'PUT', { enabled: false });
    const completed = [];
    for (let i = 0; i < 2; i++) {
      const launched = response(`/schedules/${state.scheduleId}/run`);
      await page.waitForSelector(`button[aria-label="Lancer ${state.name} maintenant"]`);
      await page.click(`button[aria-label="Lancer ${state.name} maintenant"]`);
      await launched;
      const runs = await poll(() => api(`/schedules/${state.scheduleId}/runs`), r => r.runs.length === i + 1 && r.runs.every(run => run.status !== 'running'));
      assert(runs.runs.every(run => run.status === 'ok'), JSON.stringify(runs));
      completed.push(runs.runs[0]);
    }
    assert(completed[0].session_file); assert.equal(completed[1].session_file, completed[0].session_file);
    const raw = readFileSync(completed[0].session_file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const replies = raw.filter(e => e.type === 'message' && e.message?.role === 'assistant' && JSON.stringify(e.message.content).includes('CRON_REAL_OK'));
    assert(replies.length >= 2, 'Both real assistant replies must exist in the same .jsonl');
    await page.evaluate(name => [...document.querySelectorAll('tbody tr')].find(row => row.querySelector('td')?.textContent === name).querySelector('button').click(), state.name);
    await page.waitForFunction(() => document.querySelectorAll('dialog tbody tr').length === 2, { timeout: 60000 }); await shot('cron-two-runs');
    state.proofs.cron = { createdViaUI: true, manuallyLaunchedViaUI: 2, statuses: completed.map(run => run.status), sameSession: true, sessionFile: completed[0].session_file, assistantRepliesInSession: replies.length, autoScheduleDisabled: true };
  } else {
    // Only resources created by this run; pi session files deliberately remain as evidence.
    const ownedWorkspace = (await api('/workspaces')).workspaces.find(w => w.id === state.workspaceId);
    const ownedAgent = (await api(`/agents/${state.agentId}`)).agent;
    assert(ownedWorkspace?.name === state.name && ownedWorkspace.dir === state.workspaceDir, 'Cleanup refuses an unrelated workspace');
    assert.equal(ownedAgent.name, state.name, 'Cleanup refuses an unrelated agent');
    const conversations = new Set([state.conversationId, state.boardConversationId].filter(Boolean));
    for (const id of conversations) { await api(`/conversations/${id}/stop`, 'POST'); await api(`/conversations/${id}`, 'DELETE'); }
    if (state.scheduleId) await api(`/schedules/${state.scheduleId}`, 'DELETE');
    if (state.cardId) await api(`/workspaces/${state.workspaceId}/board/cards/${state.cardId}`, 'DELETE');
    if (state.workspaceId) await api(`/workspaces/${state.workspaceId}`, 'DELETE');
    if (state.agentId) await api(`/agents/${state.agentId}`, 'DELETE');
    state.proofs.cleanup = { testAgentRemoved: true, testWorkspaceRemoved: true, conversationsRemoved: true, scheduleRemoved: true, issueClosedNotDeleted: Boolean(state.cardId), temporaryWorkspaceAndSessionsRetainedAsEvidence: true };
  }
  if (state.failure?.phase === phase || phase === 'cleanup') delete state.failure;
  save(); console.log(JSON.stringify({ phase, output, proof: state.proofs[phase] }, null, 2));
} catch (error) {
  state.failure = { phase, message: error.message }; save();
  if (page) await shot(`failed-${phase}`).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
}
