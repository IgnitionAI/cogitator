// Vite :5321; all API/SSE traffic is simulated inside an isolated browser.
// BROWSER_TOOLS_DIR=/path/to/browser-tools node scripts/ui-stream-recovery.mjs
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  for (const snapshot of ['Réponse', 'Réponse live complète']) {
    const page = await browser.newPage();
    let recovered = false;
    try {
      await page.setViewport({ width: 320, height: 750 });
      await page.evaluateOnNewDocument(() => {
        const sources = [];
        window.EventSource = class {
          static CLOSED = 2;
          readyState = 1;
          constructor(url) { this.url = url; sources.push(this); queueMicrotask(() => this.onopen?.()); }
          close() { this.readyState = 2; }
        };
        window.emitUiEvent = event => sources.filter(s => s.readyState === 1 && s.url.includes('/conversations/')).forEach(s => s.onmessage?.({ data: JSON.stringify(event) }));
      });
      await page.setRequestInterception(true);
      page.on('request', async request => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith('/api/')) return request.continue();
        const conversation = { id: 'recovery', title: 'Reprise du flux', status: 'active', provider: 'test', model: 'test', updated_at: '', workspace_id: null, agent_id: null, thinking: null };
        let body = {};
        let status = 200;
        if (path.endsWith('/history')) {
          status = recovered ? 200 : 503;
          body = recovered ? { entries: [{ type: 'user', text: 'Ancienne question' }, { type: 'assistant', text: 'Ancienne réponse' }, { type: 'user', text: 'Message envoyé' }, { type: 'assistant', text: snapshot }] } : { error: 'Historique indisponible' };
        } else if (path === '/api/conversations') body = { conversations: [conversation] };
        else if (path === '/api/conversations/recovery') body = { conversation, live: true };
        else if (path.endsWith('/messages')) body = { ok: true };
        else if (path.endsWith('/files')) body = { files: [] };
        else if (path === '/api/agents') body = { agents: [] };
        else if (path === '/api/skills') body = { skills: [] };
        await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto('http://localhost:5321', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.list-main');
      await page.click('.list-main');
      await page.waitForSelector('[role=alert]');
      await page.type('.chat-input textarea', 'Message envoyé');
      await page.click('.chat-input .btn-primary');
      await page.waitForFunction(() => document.querySelector('.msg-user .md')?.textContent === 'Message envoyé');
      await page.evaluate(() => {
        window.emitUiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
        window.emitUiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Réponse live' } });
      });
      await page.waitForFunction(() => document.querySelector('.msg-assistant .md')?.textContent === 'Réponse live');
      recovered = true;
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Réessayer l’historique').click());
      await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 4 && !document.querySelector('[role=alert]'));
      assert.deepEqual(await page.$$eval('.msg', elements => elements.map(e => e.querySelector('.md')?.textContent)), ['Ancienne question', 'Ancienne réponse', 'Message envoyé', 'Réponse live']);
      await page.evaluate(() => window.emitUiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' complète' } }));
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .md')].at(-1)?.textContent === 'Réponse live complète');
      assert.equal(await page.$$eval('.msg-assistant', elements => elements.length), 2);
      await new Promise(resolve => setTimeout(resolve, 250));
      await page.screenshot({ path: '/tmp/cogitator-stream-recovered.png' });
      console.log(`PASS: recovered snapshot ${JSON.stringify(snapshot)}, no duplicate, subsequent stream delta targets the existing bubble`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
