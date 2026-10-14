// Isolated, headless, synthetic HTTP fixtures only. No real auth/provider calls.
// BROWSER_TOOLS_DIR=/path/to/browser-tools UI_BASE_URL=http://127.0.0.1:5321 node scripts/ui-native-auth.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const base = process.env.UI_BASE_URL ?? 'http://127.0.0.1:5321';
const output = process.env.UI_AUTH_OUTPUT ?? '/tmp/cogitator-native-auth-ui';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const report = { checks: [], runtimeErrors: [], screenshots: [] };
const authenticated = () => ({ mode: 'protected', state: 'authenticated', expiresAt: new Date(Date.now() + 60000).toISOString() });
const enrolled = (requiresSetupKey = true, pending = false) => ({ mode: 'protected', state: 'enrollment', expiresAt: new Date(Date.now() + 60000).toISOString(), enrollment: { requiresSetupKey, pending } });
const anonymous = { mode: 'protected', state: 'anonymous' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function button(page, text) {
  await page.waitForFunction(text => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === text && !b.disabled), {}, text);
  await page.evaluate(text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text)?.click(), text);
}
async function contains(page, text) { await page.waitForFunction(text => document.body.textContent.includes(text), {}, text); }
async function field(page, label, value) {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('label')].find(el => el.querySelector('.field-label')?.textContent === label)?.querySelector('input'), label);
  await handle.asElement().type(value);
  await handle.dispose();
}
async function fixture(initial, locale = 'en') {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.setViewport({ width: 390, height: 844 });
  const state = { status: initial, requests: [], statusDelay: 0, offline: false, failCode: false, failEnable: false, loseEnable: false, failLogout: false, delaySignIn: 0, next: authenticated(), protectedFailure: false };
  page.on('pageerror', error => report.runtimeErrors.push(error.message));
  await page.evaluateOnNewDocument(locale => {
    localStorage.setItem('cogitator.locale', locale);
    window.sources = [];
    window.EventSource = class {
      static CLOSED = 2;
      readyState = 1;
      constructor(url) { this.url = url; window.sources.push(this); queueMicrotask(() => this.onopen?.()); }
      close() { this.readyState = 2; }
    };
  }, locale);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      if (url.origin !== new URL(base).origin) return request.abort();
      return request.continue();
    }
    const path = url.pathname;
    state.requests.push(path);
    let status = 200;
    let body = {};
    if (path === '/api/auth/status') {
      if (state.statusDelay) await wait(state.statusDelay);
      if (state.offline) return request.abort('connectionrefused');
      body = state.status;
    } else if (path === '/api/auth/sign-in/email') {
      const input = JSON.parse(request.postData());
      assert.deepEqual(Object.keys(input).sort(), ['email', 'password']);
      if (state.delaySignIn) await wait(state.delaySignIn);
      body = { twoFactorRequired: state.next.state === 'authenticated' };
      if (!body.twoFactorRequired) state.status = state.next;
    } else if (path === '/api/auth/two-factor/enable') {
      if (state.failEnable) { status = 409; body = { error: 'ENROLLMENT_BUSY', retryAt: new Date(Date.now() + 60000).toISOString() }; }
      else {
        state.status = enrolled(false, true);
        if (state.loseEnable) { state.loseEnable = false; return request.abort('connectionrefused'); }
        body = { totpURI: 'otpauth://totp/Fixture?secret=JBSWY3DPEHPK3PXP', backupCodes: ['fixture-code-a', 'fixture-code-b'] };
      }
    } else if (path.includes('/api/auth/two-factor/verify-')) {
      if (state.failCode) { status = 400; body = { error: 'INVALID_CODE' }; }
      else { if (state.status.state !== 'enrollment') state.status = authenticated(); body = { ok: true }; }
    } else if (path === '/api/auth/sign-out') {
      if (state.failLogout) return request.abort('connectionrefused');
      state.status = anonymous; body = { ok: true };
    } else if (path === '/api/auth/two-factor/generate-backup-codes') body = { backupCodes: ['new-fixture-a', 'new-fixture-b'] };
    else if (state.protectedFailure) { status = 403; body = { error: 'FORBIDDEN' }; }
    else if (path === '/api/health') body = { version: '0.3.0', pi_version: 'fixture', db: { path: '/fixture', version: 1 }, sessions_active: 0 };
    else if (path === '/api/agents') body = { agents: [] };
    else if (path === '/api/conversations') body = { conversations: [] };
    else if (path === '/api/mcp') body = { mcpServers: {} };
    else if (path === '/api/skills') body = { skills: [] };
    else { status = 404; body = { error: 'NOT_FOUND' }; }
    await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { page, state };
}
const protectedRequests = state => state.requests.filter(path => !path.startsWith('/api/auth/'));
try {
  {
    const { page, state } = await fixture({ mode: 'broken' }, 'fr');
    state.statusDelay = 250;
    await page.goto(base);
    await contains(page, 'Authentification indisponible');
    assert.deepEqual(protectedRequests(state), []);
    assert.equal(await page.evaluate(() => window.sources.length), 0);
    await page.select('select', 'en');
    await contains(page, 'Authentication is unavailable');
    await page.screenshot({ path: `${output}/unavailable-mobile.png` });
    report.screenshots.push('unavailable-mobile.png');
    state.offline = true;
    await button(page, 'Check access again');
    await contains(page, 'Unable to reach the server');
    state.offline = false; state.status = { mode: 'local' };
    await button(page, 'Check access again');
    await page.waitForSelector('.app');
    assert(protectedRequests(state).includes('/api/health'));
    await button(page, 'Settings');
    assert.equal(await page.$('.auth-security'), null);
    report.checks.push('Malformed/offline status fails closed, language before login, explicit local mode restores original App without security controls');
    await page.close();
  }
  {
    const { page, state } = await fixture(anonymous);
    await page.goto(base);
    await contains(page, 'Owner sign-in');
    assert.deepEqual(protectedRequests(state), []);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'email');
    await field(page, 'Email', 'owner@fixture.test');
    await field(page, 'Current password', 'fixture-password');
    state.delaySignIn = 300;
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await wait(80);
    assert.equal(await page.$eval('fieldset', el => el.disabled), true);
    await contains(page, 'Verify your identity');
    assert.equal(state.requests.filter(p => p.endsWith('/sign-in/email')).length, 1);
    assert.deepEqual(protectedRequests(state), []);
    state.failCode = true;
    await field(page, 'Authenticator code', '123456');
    await button(page, 'Verify code');
    await contains(page, 'The code is invalid');
    assert.equal(await page.$eval('input[autocomplete="one-time-code"]', el => el.value), '123456');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
    state.failCode = false;
    await button(page, 'Use a recovery code');
    await field(page, 'Recovery code', 'fixture-recovery');
    await button(page, 'Verify code');
    await page.waitForSelector('.app');
    await button(page, 'Settings');
    await contains(page, 'Owner security');
    await field(page, 'Current password', 'fixture-password');
    await page.click('.auth-security input[type=checkbox]');
    await button(page, 'Replace recovery codes');
    await contains(page, 'new-fixture-a');
    await button(page, 'Dismiss codes');
    assert.equal((await page.content()).includes('new-fixture-a'), false);
    const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert(!/fixture-password|fixture-recovery|new-fixture/.test(persisted));
    await page.screenshot({ path: `${output}/security-mobile.png` });
    report.screenshots.push('security-mobile.png');
    state.failLogout = true;
    await button(page, 'Sign out of this browser');
    await contains(page, 'server sign-out could not be confirmed');
    assert.equal(await page.$('.app'), null);
    assert.equal(await page.evaluate(() => window.sources.filter(s => s.readyState !== 2).length), 0);
    state.failLogout = false;
    await button(page, 'Sign out of this browser');
    await contains(page, 'Owner sign-in');
    report.checks.push('Password/MFA mount barrier, pending lock, recoverable invalid code with focus and preserved input, recovery-code login, settings regeneration/dismissal/no persistence, failed logout locks views and closes all SSE then retries');
    await page.close();
  }
  {
    const { page, state } = await fixture(enrolled());
    await page.goto(base);
    await contains(page, 'Set up your authenticator');
    state.failEnable = true;
    await field(page, 'Current password', 'fixture-password');
    await field(page, 'CLI setup key', 'fixture-key');
    await button(page, 'Create authenticator setup');
    await contains(page, 'Another browser is setting up MFA');
    await contains(page, 'Retry after');
    state.failEnable = false;
    state.loseEnable = true;
    await button(page, 'Create authenticator setup');
    await contains(page, 'Setup is pending.');
    assert.equal((await page.content()).includes('JBSWY3DPEHPK3PXP'), false);
    assert.equal(await page.$$eval('button', els => els.find(b => b.textContent === 'Replace pending setup').disabled), true);
    await page.click('.auth-check input');
    await button(page, 'Replace pending setup');
    await contains(page, 'JBSWY3DPEHPK3PXP');
    await contains(page, 'fixture-code-a');
    assert.equal(await page.$$eval('img', els => els.length), 0);
    assert.equal(await page.$$eval('button', els => els.find(b => b.textContent === 'Replace pending setup').disabled), true);
    assert.deepEqual(protectedRequests(state), []);
    await field(page, 'Authenticator code', '123456');
    await button(page, 'Verify code');
    await contains(page, 'Authenticator verified.');
    assert.equal((await page.content()).includes('JBSWY3DPEHPK3PXP'), false);
    assert.deepEqual(protectedRequests(state), []);
    await button(page, 'Sign out of this browser');
    await contains(page, 'Owner sign-in');
    assert(state.requests.includes('/api/auth/sign-out'));
    report.checks.push('Restricted setup requires password/key, competing claim deadline, manual secret/codes only, replacement invalidation confirmation, verification never mounts App, explicit logout for fresh MFA');
    await page.close();
  }
  {
    const { page, state } = await fixture(enrolled(false, true), 'fr');
    await page.goto(base);
    await contains(page, 'Une configuration est en attente');
    assert(await page.$('input[autocomplete="one-time-code"]'));
    assert.deepEqual(protectedRequests(state), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.$eval('.auth-check', el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `${output}/pending-enrollment-fr-mobile.png` });
    report.screenshots.push('pending-enrollment-fr-mobile.png');
    report.checks.push('French pending enrollment can resume OTP without regenerating, no 390px overflow');
    await page.close();
  }
  {
    const status = enrolled(true, true);
    status.enrollment.busyUntil = new Date(Date.now() + 2500).toISOString();
    const { page, state } = await fixture(status);
    await page.goto(base);
    await contains(page, 'Another browser has claimed setup until');
    assert.equal(await page.$$eval('form fieldset', els => els.every(el => el.disabled)), true);
    assert.equal(await page.$$eval('.auth-session-actions button', els => els.every(el => !el.disabled)), true);
    await page.$$eval('form', forms => forms.forEach(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))));
    await wait(100);
    assert.equal(state.requests.some(path => path.includes('/two-factor/')), false, 'live claims block setup and OTP handlers, not only controls');
    await button(page, 'Check access again');
    await page.waitForFunction(() => [...document.querySelectorAll('form fieldset')].every(el => !el.disabled));
    await button(page, 'Sign out of this browser');
    await contains(page, 'Owner sign-in');
    report.checks.push('Live competing claim disables setup and OTP including submission handlers, retry/logout remain usable, deadline unlocks controls');
    await page.close();
  }
  {
    const { page, state } = await fixture(authenticated());
    await page.goto(base);
    await page.waitForSelector('.app');
    const before = state.requests.filter(p => p.endsWith('/auth/status')).length;
    state.protectedFailure = true;
    await button(page, 'Settings');
    await wait(300);
    assert(state.requests.filter(p => p.endsWith('/auth/status')).length > before);
    assert(await page.$('.app'));
    state.status = anonymous;
    await page.evaluate(() => window.sources.filter(s => s.readyState === 1).forEach(s => s.onerror?.()));
    await contains(page, 'Owner sign-in');
    assert.equal(await page.$('.app'), null);
    assert.equal(await page.evaluate(() => window.sources.filter(s => s.readyState !== 2).length), 0);
    const count = state.requests.length;
    await wait(5500);
    assert.equal(state.requests.length, count);
    report.checks.push('Business 403 revalidates without logout; SSE error revalidates revocation, closes feeds, no reconnect storm');
    await page.close();
  }
  {
    const { page, state } = await fixture({ ...authenticated(), expiresAt: new Date(Date.now() + 1800).toISOString() });
    await page.goto(base);
    await page.waitForSelector('.app');
    state.status = anonymous;
    await contains(page, 'Owner sign-in');
    assert.equal(await page.$('.app'), null);
    assert.equal(await page.evaluate(() => window.sources.filter(s => s.readyState !== 2).length), 0);
    report.checks.push('Fixed expiresAt removes protected view and feeds without relying on a request failure');
    await page.close();
  }
  assert.deepEqual(report.runtimeErrors, []);
  console.log(`PASS: ${report.checks.length} isolated native-auth UI journeys; evidence ${output}`);
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
