// Run only against evidence.json produced by the still-running isolated --serve harness.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(process.argv[2] ?? '');
assert(root.includes('cogitator-live-configuration-'), 'Supply the disposable evidence directory');
const state = JSON.parse(readFileSync(join(root, 'evidence.json'), 'utf8'));
assert.equal(state.root, root);
assert.equal(new URL(state.url).hostname, '127.0.0.1');
const require = createRequire('/Users/salimlaimeche/.pi/agent/skills/browser-tools/package.json');
const browser = await require('puppeteer-core').launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', userDataDir: join(root, 'chrome') });
const page = await browser.newPage();
const evidence = { stage: 'browser acceptance harness; requires human screenshot inspection', http: [], sse: [], screenshots: [], checks: [], limitations: ['Embedded chat and Durable hidden controls require separate browser coverage.', 'This script does not simulate reconnect failure or authorization revocation.'] };
const pendingCaptures = [];
page.on('response', response => {
  if (!response.url().startsWith(`${state.url}/api/`) || response.headers()['content-type']?.includes('event-stream')) return;
  pendingCaptures.push(response.json().then(body => evidence.http.push({ url: response.url(), method: response.request().method(), status: response.status(), body })).catch(() => {}));
});
const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
cdp.on('Network.eventSourceMessageReceived', event => evidence.sse.push(event));
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${state.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert(response.ok(), `${path}: ${response.status}`); return response.json();
};
const control = async action => { const response = await fetch(`${state.fixtureUrl}/control/${action}`, { method: action === 'state' ? 'GET' : 'POST' }); assert(response.ok()); return response.json(); };
const until = async predicate => { const deadline = Date.now() + 30000; while (!(await predicate())) { assert(Date.now() < deadline, 'Timeout waiting for browser readback'); await new Promise(r => setTimeout(r, 75)); } };
const clickText = async (selector, text) => {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some(e => e.textContent.trim().includes(t)), {}, selector, text);
  const handle = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find(e => e.textContent.trim().includes(t)), selector, text);
  await handle.asElement().click(); await handle.dispose();
};
// Only these labels/selectors should need adapting if the editor wording changes.
const labels = { en: ['Provider', 'Model', 'Thinking level', 'Apply to'], fr: ['Fournisseur', 'Modèle', 'Niveau de raisonnement', 'Appliquer à'] };
async function selectField(scope, label, value) {
  const handle = await page.evaluateHandle((scope, label) => {
    const container = document.querySelector(scope);
    return [...container.querySelectorAll('label')].find(e => e.querySelector('.field-label')?.textContent.trim() === label)?.querySelector('select');
  }, scope, label);
  assert(handle.asElement(), `Missing accessible native select: ${label}`);
  await handle.asElement().select(value); await handle.dispose();
}
async function edit(scope, locale, values = ['fixture-a', 'model-one', 'low', 'conversation']) {
  for (let i = 0; i < values.length; i++) await selectField(scope, labels[locale][i], values[i]);
}
async function keyboardApply(scope, locale) {
  const button = await page.evaluateHandle((scope, text) => [...document.querySelector(scope).querySelectorAll('button')].find(e => e.textContent.trim() === text), scope, locale === 'en' ? 'Apply settings' : 'Appliquer les réglages');
  await button.asElement().focus(); await page.keyboard.press('Enter'); await button.dispose();
}
async function shot(name) { const path = join(root, `${name}.png`); await page.screenshot({ path, fullPage: true }); evidence.screenshots.push(path); }
async function home(locale) {
  await page.goto(state.url); await page.evaluate(locale => localStorage.setItem('cogitator.locale', locale), locale); await page.reload();
}
async function openStandalone() {
  await clickText('.nav-item', 'Conversations');
  await clickText('.list-main', 'LIVE-STANDALONE');
  await page.waitForSelector('.live-configuration summary'); await page.click('.live-configuration summary');
  await page.waitForFunction(() => document.querySelector('.live-configuration fieldset')?.disabled === false);
}
try {
  await page.setViewport({ width: 1440, height: 1050 }); await home('en'); await openStandalone();
  await page.type('.chat-input textarea', 'Unsaved composer survives configuration');
  await control('hold');
  await api(`/conversations/${state.conversationId}/messages`, 'POST', { text: 'LIVE-STANDALONE browser controlled stream' });
  await until(async () => (await control('state')).held === 1);
  await edit('.live-configuration', 'en');
  await keyboardApply('.live-configuration', 'en');
  await page.waitForFunction(() => document.querySelector('.live-configuration [role=status]')?.textContent.includes('Pending:'));
  assert.equal(await page.$eval('.chat-input textarea', e => e.value), 'Unsaved composer survives configuration');
  await shot('live-configuration-standalone-pending');
  await control('release');
  await until(async () => !(await api(`/conversations/${state.conversationId}`)).conversation.pending_configuration);
  await page.waitForFunction(() => document.querySelector('.configuration-effective')?.textContent.includes('fixture-a / model-one'));
  assert.equal(await page.$eval('.chat-input textarea', e => e.value), 'Unsaved composer survives configuration');
  evidence.checks.push('EN keyboard apply, real-stream pending, SSE effective update, composer preservation');
  // Reload and reopen via product navigation; conversation/history must remain.
  await page.reload(); await openStandalone();
  assert((await page.$eval('main', e => e.textContent)).includes('Fixture response complete.'));
  await selectField('.live-configuration', 'Thinking level', 'xhigh'); await keyboardApply('.live-configuration', 'en');
  await page.waitForFunction(() => document.querySelector('.live-configuration [role=alert]')?.textContent.trim().length > 0);
  assert.equal((await api(`/conversations/${state.conversationId}`)).conversation.thinking, 'low');
  evidence.checks.push('Reload history/effective settings and unsupported reasoning feedback');
  await home('en'); await clickText('.list-main', 'LIVE-GROUP');
  await page.waitForSelector('.group-configurations .live-configuration');
  const members = await page.$$('.group-configurations .live-configuration summary');
  assert.equal(members.length, 2); for (const member of members) await member.click();
  const member = state.group.members.find(m => !m.is_host);
  // Scope by member name, not position in API ordering.
  await page.evaluate(name => { const editor = [...document.querySelectorAll('.group-configurations .live-configuration')].find(e => e.querySelector('summary').textContent.includes(name)); if (!editor) throw Error('Missing member editor'); editor.id = 'acceptance-member'; }, member.name);
  await edit('#acceptance-member', 'en'); await keyboardApply('#acceptance-member', 'en');
  await until(async () => (await api(`/conversations/${member.conversation_id}`)).conversation.provider === 'fixture-a');
  assert.equal((await api(`/conversations/${state.group.members.find(m => m.is_host).conversation_id}`)).conversation.provider, 'fixture-b');
  await shot('live-configuration-group-member'); evidence.checks.push('Group non-host change leaves host effective tuple unchanged');
  await home('fr'); await clickText('.nav-item', 'Agents');
  await page.evaluate(() => { const card = [...document.querySelectorAll('.card')].find(e => e.querySelector('h2')?.textContent.includes('Live fixture alpha')); if (!card) throw Error('Missing preset card'); card.id = 'acceptance-preset'; });
  await edit('#acceptance-preset', 'fr', ['fixture-b', 'model-two', 'medium']);
  await keyboardApply('#acceptance-preset', 'fr');
  await until(async () => (await api(`/agents/${state.agentId}`)).agent.thinking === 'medium');
  assert.equal((await api(`/conversations/${state.conversationId}`)).conversation.thinking, 'low');
  await page.setViewport({ width: 390, height: 844 });
  await page.$eval('#acceptance-preset', e => e.scrollIntoView());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile horizontal overflow');
  await shot('live-configuration-mobile-preset-fr');
  evidence.checks.push('FR preset reasoning applies to future defaults only; mobile no horizontal overflow');
  assert(evidence.sse.some(event => event.data.includes('configuration_changed')), 'Expected real configuration_changed SSE');
  evidence.result = 'checks completed; screenshots need display/inspection';
} catch (error) { evidence.result = 'failed'; evidence.error = String(error); throw error; }
finally { await control('release').catch(() => {}); await Promise.all(pendingCaptures); writeFileSync(join(root, 'browser-evidence.json'), JSON.stringify(evidence, null, 2)); await browser.close(); }
