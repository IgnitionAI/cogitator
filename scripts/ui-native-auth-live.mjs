// Run after npm run build:web: BROWSER_TOOLS_DIR=/path/to/browser-tools node --import tsx scripts/ui-native-auth-live.mjs
// Real controller/library/TLS/browser only. No response mocks, provider calls, or user profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';
import { initializeOwner, loadAuth, lockHome } from '../src/auth-state.ts';
import { openDb } from '../src/db.ts';
import { getPaths } from '../src/paths.ts';
import { PiPool } from '../src/pool.ts';
import { createApp } from '../src/server.ts';
import { createAgent, getDefaultAgentId } from '../src/agents.ts';

const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const home = mkdtempSync(join(tmpdir(), 'cog-native-tls-'));
chmodSync(home, 0o700);
const email = 'owner@example.invalid', password = 'synthetic-only-owner-password-42';
const checks = [], errors = [], inspections = [];
const sockets = new Set(), upstreams = new Set();
let browser, proxy, app, state, db, unlock, origin, spawns = 0, stage = 'setup';
const events = new EventEmitter();
const sleep = ms => new Promise(done => setTimeout(done, ms));
const listen = server => new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const contains = (page, text) => page.waitForFunction(text => document.body.textContent.includes(text), { polling: 100 }, text);
async function button(page, text) {
  await page.waitForFunction(text => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === text && !b.disabled), { polling: 100 }, text);
  await page.evaluate(text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text).click(), text);
}
async function field(page, label, value) {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('label')].find(el => el.querySelector('.field-label')?.textContent === label)?.querySelector('input'), label);
  assert(handle.asElement(), `missing field: ${label}`);
  await handle.asElement().type(value); await handle.dispose();
}
async function pageIn(context, locale = 'en') {
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  await page.setViewport({ width: locale === 'fr' ? 390 : 1440, height: 900 });
  const paths = [];
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) paths.push(new URL(req.url()).pathname); });
  page.on('pageerror', () => errors.push('browser runtime error'));
  page.on('response', res => {
    if (!new URL(res.url()).pathname.startsWith('/api/auth/')) return;
    inspections.push((async () => {
      const data = await res.json();
      assert(!/"(?:token|sessionToken|accessToken|refreshToken)"\s*:/.test(JSON.stringify(data)), 'auth JSON exposes token');
      assert.equal(res.headers()['cache-control'], 'no-store');
    })().catch(() => { errors.push('auth response projection/cache inspection failed'); }));
  });
  await page.evaluateOnNewDocument(locale => {
    localStorage.setItem('cogitator.locale', locale);
    window.liveSources = [];
    const Native = window.EventSource;
    window.EventSource = class extends Native { constructor(...args) { super(...args); window.liveSources.push(this); } };
  }, locale);
  await page.goto(origin);
  return { page, paths };
}
async function barrier({ page, paths }) {
  assert.deepEqual(paths.filter(p => !p.startsWith('/api/auth/')), [], 'protected UI fetch before access');
  assert.equal(await page.evaluate(() => window.liveSources.length), 0);
  assert.equal(await page.$('.app'), null);
}
async function health(page) { return page.evaluate(async () => (await fetch('/api/health')).status); }
async function login(page) {
  await contains(page, 'Owner sign-in');
  await field(page, 'Email', email); await field(page, 'Current password', password); await button(page, 'Sign in');
}
async function code(page, value, recovery = false) {
  if (recovery) await button(page, 'Use a recovery code');
  await field(page, recovery ? 'Recovery code' : 'Authenticator code', value); await button(page, 'Verify code');
}
async function expectResponse(page, path, action, status = 200) {
  const response = page.waitForResponse(res => new URL(res.url()).pathname === path && res.request().method() === 'POST');
  await action(); const result = await response;
  assert.equal(result.status(), status, `unexpected status: ${path}`);
  return result.json();
}
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(home, 'key.pem'), '-out', join(home, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  chmodSync(join(home, 'key.pem'), 0o600);
  proxy = createServer({ key: readFileSync(join(home, 'key.pem')), cert: readFileSync(join(home, 'cert.pem')) }, (req, res) => {
    if (!app?.listening) { res.writeHead(503); res.end(); return; }
    // Preserve browser Host/Origin exactly; backend accepts only its configured HTTPS origin.
    const upstream = request({ hostname: '127.0.0.1', port: app.address().port, path: req.url, method: req.method, headers: req.headers }, incoming => {
      for (const cookie of incoming.headers['set-cookie'] ?? []) {
        if (!/;\s*Secure(?:;|$)/i.test(cookie) || !/;\s*HttpOnly(?:;|$)/i.test(cookie) || !/;\s*SameSite=Lax(?:;|$)/i.test(cookie) || /;\s*Domain=/i.test(cookie)) errors.push('Set-Cookie security attribute failure');
      }
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    });
    upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await listen(proxy); origin = `https://127.0.0.1:${proxy.address().port}`;
  unlock = lockHome(home);
  const setupKey = await initializeOwner(home, origin, email, password);
  state = loadAuth(home);
  const paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, 'pi'), COGITATOR_AGENTS_DIR: join(home, 'agents'), COGITATOR_SKILLS_DIRS: join(home, 'skills') });
  const catalog = openDb(paths.db); db = catalog.db;
  const agent = createAgent(db, { name: 'Synthetic TLS agent', provider: 'never-spawn', model: 'synthetic' });
  const pool = new PiPool({ factory: () => { spawns++; throw new Error('Provider spawn forbidden'); } });
  app = createApp({ db, dbPath: paths.db, dbVersion: catalog.version, paths, pool, events, auth: state });
  await listen(app);
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, userDataDir: join(home, 'chrome'), executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-proxy-server'] });
  const a = await browser.createBrowserContext();
  const first = await pageIn(a, 'fr'), page = first.page;
  stage = 'French mobile login barrier';
  await contains(page, 'Connexion propriétaire'); await barrier(first);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.select('select', 'en');
  stage = 'enrollment'; await login(page); await contains(page, 'Set up your authenticator'); await barrier(first);
  assert.equal(await health(page), 403);
  // Explicit probe above is not a UI fetch; reset only the observation list, never auth/rate state.
  first.paths.length = 0;
  await field(page, 'Current password', password); await field(page, 'CLI setup key', setupKey);
  const material = await expectResponse(page, '/api/auth/two-factor/enable', () => button(page, 'Create authenticator setup'));
  await page.waitForSelector('.auth-secret');
  assert.equal(await page.$eval('.auth-secret', el => el.textContent.trim()), new URL(material.totpURI).searchParams.get('secret'));
  const otp = createOTP(new TextDecoder().decode(base32.decode(new URL(material.totpURI).searchParams.get('secret'))));
  const enrollmentCode = await otp.totp();
  await expectResponse(page, '/api/auth/two-factor/verify-totp', () => code(page, enrollmentCode));
  await contains(page, 'Authenticator verified.'); await barrier(first); assert.equal(await health(page), 403);
  checks.push('FR 390px login, UI setup-key enrollment, real OTP, no App/fetch/SSE before approval; health 403 before and after enrollment');
  await button(page, 'Sign out of this browser'); await login(page); await contains(page, 'Verify your identity');
  // Obtain a genuinely fresh time step; do not alter replay reservations or the clock.
  while (await otp.totp() === enrollmentCode) await sleep(300);
  stage = 'fresh MFA';
  await expectResponse(page, '/api/auth/two-factor/verify-totp', async () => code(page, await otp.totp()));
  await page.waitForSelector('.app'); assert.equal(await health(page), 200);
  await page.setViewport({ width: 1440, height: 900 });
  const cookies = await a.cookies();
  assert(cookies.some(c => c.name.includes('session_token')));
  for (const c of cookies) {
    assert(c.secure && c.httpOnly && c.sameSite === 'Lax' && c.domain === '127.0.0.1' && c.path === '/', 'cookie security attributes');
    assert(!c.name.includes('trust_device'));
  }
  assert.equal(await page.evaluate(() => document.cookie), '');
  checks.push('Explicit enrollment signout + fresh password/TOTP; full App/health; real host-only Secure HttpOnly SameSite=Lax cookies invisible to JS');
  stage = 'no-body UI mutation';
  await button(page, 'Agents');
  const mutationRequest = page.waitForRequest(req => req.url().endsWith(`/api/agents/${agent.id}/default`));
  await expectResponse(page, `/api/agents/${agent.id}/default`, () => button(page, 'Set as default'));
  const mutation = await mutationRequest;
  assert.equal(mutation.headers()['content-type'], 'application/json');
  assert.equal(mutation.postData(), undefined);
  assert.equal(getDefaultAgentId(db), agent.id);
  checks.push('Actual UI no-body set-default POST accepted by JSON Content-Type boundary and persisted');
  stage = 'recovery replacement';
  await button(page, 'Settings'); await contains(page, 'Owner security');
  await field(page, 'Current password', password); await page.click('.auth-security input[type=checkbox]');
  const replacement = await expectResponse(page, '/api/auth/two-factor/generate-backup-codes', () => button(page, 'Replace recovery codes'));
  await contains(page, replacement.backupCodes[0]); await button(page, 'Dismiss codes');
  assert(!(await page.content()).includes(replacement.backupCodes[0]));
  // Respect the real shared factor rate window. No rate-counter resets anywhere.
  await sleep(11000);
  const b = await browser.createBrowserContext(); const second = await pageIn(b);
  await login(second.page); await contains(second.page, 'Verify your identity'); await barrier(second);
  await expectResponse(second.page, '/api/auth/two-factor/verify-backup-code', () => code(second.page, replacement.backupCodes[0], true));
  await second.page.waitForSelector('.app');
  checks.push('Settings replacement displays/dismisses real codes; isolated browser logs in with replacement code');
  stage = 'recovery replay';
  const c = await browser.createBrowserContext(); const third = await pageIn(c);
  await login(third.page); await contains(third.page, 'Verify your identity');
  const denied = third.page.waitForResponse(r => r.url().endsWith('/two-factor/verify-backup-code'));
  await code(third.page, replacement.backupCodes[0], true);
  assert.equal((await denied).status(), 401); await contains(third.page, 'The code is invalid');
  await barrier(third); assert.equal(await health(third.page), 401);
  await button(third.page, 'Sign out of this browser'); await login(third.page); await contains(third.page, 'Verify your identity');
  const oldDenied = third.page.waitForResponse(r => r.url().endsWith('/two-factor/verify-backup-code'));
  await code(third.page, material.backupCodes[0], true);
  assert.equal((await oldDenied).status(), 401);
  await contains(third.page, 'The code is invalid');
  assert.equal(await health(third.page), 401);
  await c.close();
  checks.push('Consumed recovery-code replay and superseded enrollment code rejected by real library, no protected mount/access');
  stage = 'logout and SSE revocation';
  const sibling = await pageIn(a); await sibling.page.waitForSelector('.app');
  stage = 'sibling SSE opens';
  await sibling.page.waitForFunction(() => window.liveSources.some(s => s.readyState === 1), { timeout: 22000, polling: 100 });
  const before = events.listenerCount('event'); assert(before >= 3);
  stage = 'current browser logout button';
  await button(page, 'Settings');
  await expectResponse(page, '/api/auth/sign-out', () => button(page, 'Sign out of this browser'));
  stage = 'current browser logout response';
  await contains(page, 'Owner sign-in');
  stage = 'sibling revoked SSE closes and gate rechecks';
  await sibling.page.waitForFunction(() => document.body.textContent.includes('Owner sign-in'), { timeout: 22000, polling: 100 });
  assert.equal(await sibling.page.evaluate(() => window.liveSources.every(s => s.readyState === 2)), true);
  assert.equal(await health(page), 401); assert.equal(await health(second.page), 200);
  assert(events.listenerCount('event') < before);
  stage = 'second context logout';
  await button(second.page, 'Settings');
  await button(second.page, 'Sign out of this browser'); await contains(second.page, 'Owner sign-in');
  await sleep(500); assert.equal(events.listenerCount('event'), 0);
  checks.push('Logout revokes only current context; sibling tab loses App and real SSE at heartbeat, second context retains access; all SSE listeners removed after logout');
  const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  assert(![password, setupKey, ...replacement.backupCodes, ...cookies.map(c => c.value)].some(secret => persisted.includes(secret)));
  await Promise.all(inspections); assert.deepEqual(errors, []); assert.equal(spawns, 0);
} catch (error) {
  // Never dump assertion operands, DOM, response bodies, cookies, or secret-bearing screenshots.
  console.error(`FAIL at ${stage}: ${error.name}${error.name === 'TimeoutError' ? ' (UI/stream deadline exceeded)' : ''}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const req of upstreams) req.destroy();
  for (const socket of sockets) socket.destroy();
  for (const server of [proxy, app]) if (server?.listening) {
    server.closeAllConnections(); await new Promise((done, reject) => server.close(err => err ? reject(err) : done()));
  }
  state?.db.close(); db?.close(); unlock?.(); rmSync(home, { recursive: true, force: true });
}
if (!process.exitCode) {
  console.log(`PASS: ${checks.length} real TLS/browser checks; zero provider spawns; zero rate resets; all owned resources cleaned.`);
  checks.forEach(check => console.log(`- ${check}`));
  console.log('Not covered: provider work continuation, VPS/deployment, offline recovery faults, full hostile HTTP matrix, performance/capacity, visual screenshots.');
}
