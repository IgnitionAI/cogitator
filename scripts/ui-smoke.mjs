// Run with Vite on :5321 and installed Chrome (CHROME_PATH overrides the macOS default).
// BROWSER_TOOLS_DIR=/path/to/browser-tools node scripts/ui-smoke.mjs
// Reuses the browser skill's puppeteer-core; no app dependency added.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(resolve(process.env.BROWSER_TOOLS_DIR ?? '.', 'package.json'));
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
try {
  await page.setRequestInterception(true);
  page.on('request', request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ? request.continue() : request.abort());
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:5321', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main h1');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Nouvelle conversation')).click());
  await page.waitForSelector('dialog[open]');
  assert(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)));
  await page.waitForSelector('dialog textarea:not(:disabled)');
  await page.evaluate(() => document.querySelector('dialog textarea').focus());
  await page.keyboard.type('Brouillon de test non envoyé');
  assert(await page.evaluate(() => document.activeElement === document.querySelector('dialog textarea')));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  console.log('PASS: modal focus, typing, Escape');

  await page.evaluate(() => [...document.querySelectorAll('.nav-item')].find(b => b.textContent.trim() === 'Paramètres').click());
  await page.waitForSelector('textarea');
  await page.evaluate(() => { const input = document.querySelector('textarea'); input.focus(); input.select(); });
  await page.keyboard.type('{');
  assert.equal(await page.$eval('textarea', e => e.value), '{');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Enregistrer la configuration')).click());
  await page.waitForSelector('[role=alert]');
  assert.match(await page.$eval('[role=alert]', e => e.textContent), /JSON invalide/);
  assert.equal(await page.$eval('textarea', e => e.value), '{');
  console.log('PASS: invalid JSON retained, recovery displayed; nothing saved');

  await page.setViewport({ width: 320, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar');
  assert.equal(await page.$eval('.sidebar', e => getComputedStyle(e).visibility), 'hidden');
  await page.evaluate(() => document.querySelector('.topbar button').click());
  await page.waitForFunction(() => document.querySelector('main').inert);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('main').inert);
  console.log('PASS: mobile sidebar hidden, background inert, Escape');
} finally {
  await page.close();
  await browser.close();
}
