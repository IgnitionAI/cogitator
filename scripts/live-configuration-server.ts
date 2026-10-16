import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageDir, RpcClient } from '@earendil-works/pi-coding-agent';
import { openDb } from '../src/db.js';
import { getPaths } from '../src/paths.js';
import { PiPool } from '../src/pool.js';
import { createApp } from '../src/server.js';
import { createConversation, setConversationStatus } from '../src/conversations.js';

const root = process.env.LIVE_CONFIGURATION_ROOT;
assert(root && process.env.HOME === join(root, 'home'), 'Use live-configuration-run.mjs');
const paths = getPaths();
for (const dir of [paths.home, paths.piAgentDir, join(root, 'workspace')]) mkdirSync(dir, { recursive: true });
let sequence = 0;
const trace: Record<string, unknown>[] = [];
function record(kind: string, data: Record<string, unknown> = {}) {
  const entry = { seq: ++sequence, at: Date.now(), kind, ...data };
  trace.push(entry); appendFileSync(join(root!, 'trace.jsonl'), JSON.stringify(entry) + '\n'); return entry;
}
const requests: { provider: string; model: string; reasoning: string; body: Record<string, unknown>; seq: number }[] = [];
const held = new Map<number, () => void>();
let holdNext = false;
const fixture = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/control/disconnect') { app.closeAllConnections(); res.end('{}'); return; }
    if (req.method === 'POST' && req.url === '/control/hold') { holdNext = true; res.end('{}'); return; }
    if (req.method === 'POST' && req.url === '/control/release') { for (const release of held.values()) release(); res.end('{}'); return; }
    if (req.method === 'GET' && req.url === '/control/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ held: held.size, requests })); return; }
    assert(req.method === 'POST' && /^\/fixture-[ab]\/v1\/chat\/completions$/.test(req.url ?? ''), 'Unexpected model route');
    let text = ''; for await (const chunk of req) { text += chunk; assert(text.length < 2_000_000); }
    const body = JSON.parse(text);
    const provider = req.url!.split('/')[1]!;
    const entry = record('model_request', { provider, body });
    requests.push({ provider, model: body.model, reasoning: body.reasoning_effort, body, seq: entry.seq });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${entry.seq}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: 'Fixture response started. ' });
    const finish = () => { if (res.destroyed) return; chunk({ content: 'Fixture response complete.' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); record('model_complete', { request: entry.seq }); };
    if (holdNext) { holdNext = false; held.set(entry.seq, finish); res.on('close', () => held.delete(entry.seq)); }
    else finish();
  } catch (error) { record('fixture_error', { error: String(error) }); res.writeHead(400); res.end(String(error)); }
});
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixturePort = (fixture.address() as { port: number }).port;
const providers = Object.fromEntries(['fixture-a', 'fixture-b'].map(provider => [provider, {
  baseUrl: `http://127.0.0.1:${fixturePort}/${provider}/v1`, api: 'openai-completions', apiKey: 'local-fixture-only',
  models: ['model-one', 'model-two'].map(id => ({ id, name: `${provider} ${id}`, reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsReasoningEffort: true } })),
}]));
writeFileSync(paths.piModelsJson, JSON.stringify({ providers }));
writeFileSync(paths.piAuthJson, JSON.stringify(Object.fromEntries(Object.keys(providers).map(p => [p, { type: 'api_key', key: 'local-fixture-only' }]))));
writeFileSync(join(paths.piAgentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture-a', defaultModel: 'model-one', defaultThinkingLevel: 'low', retry: { enabled: false } }));
let opened = openDb(paths.db);
const clients: RpcClient[] = [];
const makePool = () => new PiPool({ max: 8, factory: opts => {
  const client = new RpcClient({ cliPath: join(getPackageDir(), 'dist/cli.js'), cwd: join(root, 'workspace'),
    args: [...opts.args, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools', '--offline'], env: opts.env });
  const clientId = clients.push(client);
  // Passive tracing: every method still calls the official RpcClient implementation.
  for (const method of ['getState', 'setModel', 'setThinkingLevel', 'prompt'] as const) {
    const original = client[method].bind(client) as (...args: unknown[]) => Promise<unknown>;
    Object.defineProperty(client, method, { value: async (...args: unknown[]) => {
      record('rpc_command', { clientId, method, args });
      try { const result = await original(...args); record('rpc_response', { clientId, method, result }); return result; }
      catch (error) { record('rpc_error', { clientId, method, error: String(error) }); throw error; }
    } });
  }
  client.onEvent(event => record('rpc_event', { clientId, event }));
  return client;
}, callbacks: { onStatus: (id, status) => setConversationStatus(opened.db, id, status) } });
let pool = makePool();
let app = createApp({ ...opened, dbPath: paths.db, dbVersion: opened.version, paths, pool });
await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
let url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
const state: Record<string, unknown> = { url, fixtureUrl: `http://127.0.0.1:${fixturePort}`, root, stage: 'implementation harness; not final verification', fixture: 'local deterministic HTTP; real official RpcClient subprocess', limitations: ['Fault injection, authorization revocation, retry/compaction coverage require separate regression tests.', 'Full npm test, typecheck, build and screenshot inspection are separate final-stage gates.'] };
const save = () => writeFileSync(join(root, 'evidence.json'), JSON.stringify(state, null, 2));
async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(`${url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const value = await response.json(); record('http', { path, method, status: response.status, body, value });
  assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (!(await check())) { assert(Date.now() < deadline, 'Timed out; inspect trace.jsonl'); await new Promise(r => setTimeout(r, 50)); }
}
const read = async (id: string) => (await api(`/conversations/${id}`)).conversation;
const tuple = (c: { provider: string; model: string; thinking: string }) => [c.provider, c.model, c.thinking];
const target = { provider: 'fixture-b', id: 'model-two', thinking: 'high' };
const switchModel = (id: string, body = target, expected = 200) => api(`/conversations/${id}/model`, 'POST', body, expected);
const prompt = (id: string, text: string) => api(`/conversations/${id}/messages`, 'POST', { text });
const settled = (from: number) => trace.slice(from).some(e => e.kind === 'rpc_event' && (e.event as { type: string }).type === 'agent_settled');
async function completePrompt(id: string, text: string) { const start = trace.length; await prompt(id, text); await until(() => settled(start)); }
async function restart(crash = false) {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  if (crash) {
    // Abandon process-local queued closures, as a controller crash would. dispose()
    // would cancel the accepted request and test graceful stop instead of recovery.
    await Promise.all(clients.map(client => client.stop()));
  } else await pool.dispose();
  opened.db.close();
  opened = openDb(paths.db);
  pool = makePool();
  app = createApp({ ...opened, dbPath: paths.db, dbVersion: opened.version, paths, pool });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  state.url = url;
  record('controller_restart', { crash, db: paths.db, url }); save();
}
async function shutdown() {
  for (const release of held.values()) release();
  await pool.dispose(); app.closeAllConnections(); app.close(); fixture.closeAllConnections(); fixture.close(); opened.db.close();
}
try {
  if (process.argv.includes('--rpc-smoke')) {
    const options = { cliPath: join(getPackageDir(), 'dist/cli.js'), cwd: join(root, 'workspace'), args: ['--model', 'fixture-a/model-one:low', '--no-extensions', '--no-skills', '--no-context-files', '--no-tools', '--offline'] };
    const rpc = new RpcClient(options);
    let sessionFile: string | undefined;
    try {
      rpc.onEvent(event => record('smoke_rpc_event', { event }));
      await rpc.start();
      await rpc.promptAndWait('fixture smoke first', undefined, 30000);
      assert.equal(requests.at(-1)?.reasoning, 'low');
      await rpc.setModel('fixture-b', 'model-two'); await rpc.setThinkingLevel('high');
      record('smoke_readback', { state: await rpc.getState() });
      await rpc.promptAndWait('fixture smoke second', undefined, 30000);
      assert.deepEqual([requests.at(-1)?.provider, requests.at(-1)?.model, requests.at(-1)?.reasoning], ['fixture-b', 'model-two', 'high']);
      sessionFile = (await rpc.getState()).sessionFile;
    } finally { await rpc.stop(); }
    assert(sessionFile);
    const resumed = new RpcClient({ ...options, args: [...options.args, '--session', sessionFile] });
    try {
      await resumed.start();
      assert.equal((await resumed.getState()).sessionFile, sessionFile);
      assert(JSON.stringify(await resumed.getMessages()).includes('fixture smoke first'));
      record('smoke_resume_readback', { state: await resumed.getState() });
    } finally { await resumed.stop(); }
    state.result = 'fixture/RpcClient smoke only; not app acceptance'; save();
  } else {
  const workspace = (await api('/workspaces', 'POST', { dir: join(root, 'workspace'), name: 'Live configuration fixture' }, 201)).workspace;
  const makeAgent = async (name: string) => (await api('/agents', 'POST', { name, provider: 'fixture-a', model: 'model-one', thinking: 'low', description: 'Preserve this unrelated field', default_workspace_id: workspace.id }, 201)).agent;
  const agent = await makeAgent('Live fixture alpha'); const second = await makeAgent('Live fixture beta');
  const create = async () => (await api('/conversations', 'POST', { agent_id: agent.id, workspace_id: workspace.id }, 201)).conversation;
  const conversation = await create(); const sibling = await create();
  Object.assign(state, { agentId: agent.id, workspaceId: workspace.id, conversationId: conversation.id, siblingId: sibling.id }); save();
  // A1 never-started configuration, then actual outbound model/reasoning.
  await switchModel(conversation.id);
  assert.deepEqual(tuple(await read(conversation.id)), ['fixture-b', 'model-two', 'high']);
  await completePrompt(conversation.id, 'LIVE-STANDALONE first history marker');
  assert.deepEqual([requests.at(-1)!.provider, requests.at(-1)!.model, requests.at(-1)!.reasoning], ['fixture-b', 'model-two', 'high']);
  const before = await read(conversation.id);
  // A2 hold the real HTTP stream open until the config and next prompt are accepted.
  holdNext = true; const start = trace.length; await prompt(conversation.id, 'LIVE-STANDALONE controlled streaming');
  await until(() => held.size === 1);
  const pending = await switchModel(conversation.id, { provider: 'fixture-a', id: 'model-one', thinking: 'low' }, 202);
  assert.equal((pending.conversation ?? pending).pending_configuration.status, 'pending');
  await switchModel(conversation.id, target, 409);
  const count = requests.length;
  await prompt(conversation.id, 'LIVE-STANDALONE queued next prompt');
  assert.equal(requests.length, count, 'Queued prompt must not dispatch while current stream is held');
  assert(!trace.slice(start).some(e => e.kind === 'rpc_command' && ['setModel', 'setThinkingLevel'].includes(String(e.method))), 'No setter while streaming');
  for (const release of held.values()) release();
  await until(() => requests.length === count + 1);
  await until(async () => !(await read(conversation.id)).pending_configuration);
  await until(() => trace.slice(start).filter(e => e.kind === 'rpc_event' && (e.event as { type: string }).type === 'agent_settled').length >= 2);
  assert.deepEqual([requests.at(-1)!.provider, requests.at(-1)!.model, requests.at(-1)!.reasoning], ['fixture-a', 'model-one', 'low']);
  const sequenceSlice = trace.slice(start);
  assert(sequenceSlice.findIndex(e => e.kind === 'rpc_event' && (e.event as { type: string }).type === 'agent_settled') < sequenceSlice.findIndex(e => e.kind === 'rpc_command' && e.method === 'setModel'));
  // A1 evict/resume; preserve session and user history.
  await pool.dispose(); await switchModel(conversation.id);
  await completePrompt(conversation.id, 'LIVE-STANDALONE resumed history marker');
  assert.equal((await read(conversation.id)).session_file, before.session_file);
  assert(JSON.stringify(requests.at(-1)!.body.messages).includes('first history marker'));
  const row = opened.db.prepare('SELECT * FROM conversation WHERE id = ?').get(conversation.id) as { spawn_args: string; provider: string; model: string; thinking: string };
  assert.deepEqual(tuple(row), ['fixture-b', 'model-two', 'high']);
  assert.deepEqual(tuple(JSON.parse(row.spawn_args)), tuple(row));
  // Whole controller recreation, same database and filesystem (not just eviction).
  await restart();
  assert.equal((await read(conversation.id)).session_file, before.session_file);
  assert.deepEqual(tuple(await read(conversation.id)), ['fixture-b', 'model-two', 'high']);
  await completePrompt(conversation.id, 'LIVE-STANDALONE controller restart history marker');
  assert(JSON.stringify(requests.at(-1)!.body.messages).includes('first history marker'));
  assert.deepEqual([requests.at(-1)!.provider, requests.at(-1)!.model, requests.at(-1)!.reasoning], ['fixture-b', 'model-two', 'high']);
  // Accepted pending request must survive as a visible failure, never replayed.
  holdNext = true;
  await prompt(conversation.id, 'LIVE-STANDALONE interrupted by controller restart');
  await until(() => held.size === 1);
  const interrupted = await switchModel(conversation.id, { provider: 'fixture-a', id: 'model-one', thinking: 'low' }, 202);
  const requestId = (interrupted.conversation ?? interrupted).pending_configuration.request_id;
  await restart(true);
  const recovered = await read(conversation.id);
  assert.equal(recovered.pending_configuration.request_id, requestId);
  assert.equal(recovered.pending_configuration.status, 'failed');
  assert.match(recovered.pending_configuration.error, /Controller restarted.*authorization/);
  assert.deepEqual(tuple(recovered), ['fixture-b', 'model-two', 'high']);
  assert.equal(pool.size, 0, 'Recovery must not spawn/replay under a later viewer');
  await completePrompt(conversation.id, 'LIVE-STANDALONE no implicit pending replay');
  assert.deepEqual(tuple(await read(conversation.id)), ['fixture-b', 'model-two', 'high']);
  assert.equal((await read(conversation.id)).pending_configuration.status, 'failed');
  assert.equal((await read(conversation.id)).session_file, before.session_file);
  assert(JSON.stringify(requests.at(-1)!.body.messages).includes('first history marker'));
  await api(`/conversations/${conversation.id}/model`, 'DELETE');
  await switchModel(conversation.id, { provider: 'fixture-a', id: 'model-one', thinking: 'low' });
  assert.equal((await read(conversation.id)).pending_configuration, null);
  await switchModel(conversation.id);
  state.restartChecks = ['idle controller restart preserves tuple/session/history', 'pending restart visibly failed, no automatic replay, explicit fresh local-owner retry'];
  // A3 scope isolation and future conversations.
  assert.deepEqual(tuple(await read(sibling.id)), ['fixture-a', 'model-one', 'low']);
  assert.deepEqual(tuple((await api(`/agents/${agent.id}`)).agent), ['fixture-a', 'model-one', 'low']);
  await api(`/conversations/${conversation.id}/model`, 'POST', { ...target, scope: 'preset' });
  const updated = (await api(`/agents/${agent.id}`)).agent;
  assert.equal(updated.description, 'Preserve this unrelated field');
  assert.deepEqual(tuple(updated), ['fixture-b', 'model-two', 'high']);
  assert.deepEqual(tuple(await create()), tuple(updated));
  assert.deepEqual(tuple(await read(sibling.id)), ['fixture-a', 'model-one', 'low']);
  // A4 input rejection must not alter committed state.
  await switchModel(conversation.id, { ...target, id: 'does-not-exist' }, 422);
  await switchModel(conversation.id, { ...target, thinking: 'xhigh' }, 422);
  assert.deepEqual(tuple(await read(conversation.id)), ['fixture-b', 'model-two', 'high']);
  await api(`/conversations/${conversation.id}/model`, 'DELETE');
  const adhoc = (await api('/conversations', 'POST', { provider: 'fixture-a', model: 'model-one', thinking: 'low', workspace_id: workspace.id }, 201)).conversation;
  await api(`/conversations/${adhoc.id}/model`, 'POST', { ...target, scope: 'preset' }, 409);
  // Seed Durable without starting a mission: the live endpoint must reject before any RPC/mutation.
  const durable = createConversation(opened.db, { workspaceId: workspace.id, agentId: null, runtimeKind: 'durable', spawn: { provider: 'fixture-a', model: 'model-one', thinking: 'low' } });
  const durableBefore = opened.db.prepare('SELECT * FROM conversation WHERE id = ?').get(durable.id);
  const rpcBefore = trace.filter(e => e.kind === 'rpc_command').length;
  await switchModel(durable.id, target, 409);
  assert.deepEqual(opened.db.prepare('SELECT * FROM conversation WHERE id = ?').get(durable.id), durableBefore);
  assert.equal(trace.filter(e => e.kind === 'rpc_command').length, rpcBefore);
  opened.db.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('LIVE-DURABLE', durable.id);
  state.durableId = durable.id;
  const pm = await makeAgent('Chef de projet');
  const embedded = (await api('/conversations', 'POST', { agent_id: pm.id, workspace_id: workspace.id }, 201)).conversation;
  state.embeddedId = embedded.id;
  state.embeddedAgentId = pm.id;
  const group = (await api('/groups', 'POST', { name: 'LIVE-GROUP', member_agent_ids: [agent.id, second.id], host_agent_id: agent.id, default_workspace_id: workspace.id }, 201)).group;
  state.group = group;
  const members = group.members;
  assert.equal(members.length, 2);
  const nonHost = members.find((m: { agent_id: string }) => m.agent_id === second.id);
  assert(nonHost, 'Adapt group member shape if contract changed');
  await switchModel(nonHost.conversation_id);
  await completePrompt(nonHost.conversation_id, 'LIVE-GROUP member history marker');
  state.result = 'implemented checks completed; final verification gates still required'; save();
  console.log(`Harness checks completed: ${join(root, 'evidence.json')}`);
  if (process.argv.includes('--serve')) {
    console.log(`Isolated browser target: ${url}`);
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
  }
} catch (error) { state.result = 'failed'; state.error = String(error); save(); throw error; }
finally { await shutdown(); }
