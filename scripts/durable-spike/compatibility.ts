import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from '@earendil-works/pi-ai/providers/faux';
import { defineDoc, defineExtension, defineTask, defineTool, section, type Harness, type Conversation, type Registry } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { loadSkillsFromDir, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function compatibility(directory: string, harness: Harness, root: Conversation, registry: Registry, faux: FauxProviderHandle) {
  const skillDir = join(directory, 'fixture-skill');
  await mkdir(skillDir);
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Harmless fixture instructions\n---\nReturn fixture text.\n');
  const skills = loadSkillsFromDir({ dir: skillDir, source: 'durable-spike' });
  assert.equal(skills.skills.length, 1);
  assert.equal(skills.diagnostics.length, 0);
  const fixtureId = randomUUID();
  const fixtureSkills = [{ name: 'fixture-skill', description: fixtureId, path: join(skillDir, 'SKILL.md') }];
  let servedSkills = fixtureSkills;
  const expectedContent = [{ type: 'text' as const, text: JSON.stringify(fixtureSkills, null, 2) }];
  const requests: string[] = [];
  const backend = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/api/skills') {
      response.writeHead(403).end(JSON.stringify({ error: 'Fixture allows only skill listing' }));
      return;
    }
    response.end(JSON.stringify(servedSkills));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  assert(address && typeof address === 'object' && address.port !== 5320);
  const backendUrl = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'durable-spike', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../src/mcp-server.ts', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', HOME: directory, COGITATOR_URL: backendUrl, COGITATOR_PORT: '0' },
    stderr: 'pipe',
  });
  let serverLog = '';
  transport.stderr?.on('data', chunk => { serverLog += String(chunk); });
  try {
    await client.connect(transport);
    assert((await client.listTools()).tools.some(tool => tool.name === 'cogitator_list_skills'));
    const listSkills = defineTool({
      name: 'cogitator_list_skills', description: 'Required skill discovery through the real Cogitator MCP tool',
      parameters: Type.Object({}), replay: 'safe',
      async execute() {
        const result = await client.callTool({ name: 'cogitator_list_skills', arguments: {} });
        assert(!result.isError);
        assert.deepEqual(result.content, expectedContent);
        return { content: expectedContent };
      },
    });
    const profile = defineExtension({ name: 'fixture-compat-v1', tools: [listSkills], sections: [section('skills', () => formatSkillsForPrompt(skills.skills))] });
    registry.install(profile);
    await root.configure({ extensions: [profile] }, context);
    faux.setResponses([fauxAssistantMessage(fauxToolCall('cogitator_list_skills', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('compat done')]);
    assert.equal((await (await root.submit({ type: 'input', content: 'compat', requestId: 'compat' }, context)).wait(context)).status, 'done');
    const entries = (await root.context(context)).entries;
    assert(entries.some(entry => entry.kind === 'pi.system' && JSON.stringify(entry).includes('fixture-skill')));
    let toolEntries = entries.filter(entry => entry.kind === 'pi.tool-result');
    const requireMcpSuccess = () => {
      const message = toolEntries.at(-1)?.model?.[0];
      assert(message?.role === 'toolResult' && message.isError === false, 'MCP must have successful authoritative tool result');
      assert.deepEqual(message.content, expectedContent);
    };
    assert.equal(toolEntries.length, 1);
    requireMcpSuccess();

    // A diagnostic can contain expected fixture text even when the actual call failed.
    servedSkills = [];
    faux.setResponses([fauxAssistantMessage(fauxToolCall('cogitator_list_skills', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('wrong content observed')]);
    await (await root.submit({ type: 'input', content: 'wrong-content control', requestId: 'compat-wrong-content' }, context)).wait(context);
    toolEntries = (await root.context(context)).entries.filter(entry => entry.kind === 'pi.tool-result');
    assert.equal(toolEntries.length, 2);
    assert(JSON.stringify(toolEntries.at(-1)).includes(fixtureId), 'Negative control must reproduce the old diagnostic-text false match');
    assert.throws(requireMcpSuccess, /successful authoritative tool result/);
    assert.deepEqual(requests, ['GET /api/skills', 'GET /api/skills']);
    // The fixture-owned request ledger and exact result prove URL selection, not a destination log.
    assert(serverLog.includes('connecté (stdio)'), 'Real MCP server must confirm its stdio connection');
    registry.uninstall(profile);
    assert.equal((await root.agent(context)).tools.length, 0); // Negative case: future adapter must reject this profile.
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }

  const token = (version: number) => defineDoc({ kind: 'spike.version', version, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ value: 1 }) });
  await root.commit(async tx => { await tx.doc(token(2), root.id); }, context);
  await assert.rejects(() => harness.snapshot(token(1), root.id, context));
  const task = (version: number) => defineTask<null, { phase: 'wait' }, null>({
    name: 'spike.versioned-task', version, initial: () => ({ phase: 'wait' }),
    phases: { wait: async () => { throw new Error('Must not dispatch incompatible task'); } },
    abort: async () => { throw new Error('Not used'); },
  });
  // Raw task creation is durable; registry's older definition must not run it.
  registry.install(defineExtension({ name: 'version-fixture', tasks: [task(1)] }));
  const id = await root.commit(tx => tx.createTask(task(2), null, { ownership: { kind: 'conversation' } }), context);
  const inspected = (await harness.inspect(context)).tasks.find(item => item.record.id === id);
  assert.deepEqual(inspected?.state, { kind: 'blocked', reason: 'task_too_old' });
  console.log('PASS: real skill loader / Durable prompt; necessary Cogitator list_skills MCP against ephemeral HTTP fixture; missing extension negative case; document/task version rejection');
}

export async function schemaVersion(directory: string) {
  const path = join(directory, 'schema.sqlite');
  const database = await openNodeSqliteDatabase(path);
  const storage = await SqliteStorage.open(database);
  assert.equal((await database.get<{ version: number }>('SELECT version FROM durable_schema'))?.version, CURRENT_SQLITE_SCHEMA_VERSION);
  await database.run('UPDATE durable_schema SET version = ?', CURRENT_SQLITE_SCHEMA_VERSION + 1);
  await storage.close(context);
  const reopened = await openNodeSqliteDatabase(path);
  try { await assert.rejects(() => SqliteStorage.open(reopened), /newer than supported/); }
  finally { await reopened.close(); }
  console.log(`PASS: SQLite schema ${CURRENT_SQLITE_SCHEMA_VERSION}; future schema rejected`);
}
