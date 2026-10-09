import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
  const client = new Client({ name: 'durable-spike', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../test/fixtures/echo-mcp-server.mjs', import.meta.url))], env: { PATH: process.env.PATH ?? '', HOME: directory } });
  try {
    await client.connect(transport);
    assert((await client.listTools()).tools.some(tool => tool.name === 'echo'));
    const echo = defineTool({
      name: 'fixture_mcp', description: 'One explicitly allowlisted harmless MCP echo',
      parameters: Type.Object({ message: Type.String() }), replay: 'safe',
      async execute(args) {
        const result = await client.callTool({ name: 'echo', arguments: args });
        assert.deepEqual(result.content, [{ type: 'text', text: 'ECHO: fixture' }]);
        return { content: [{ type: 'text', text: 'ECHO: fixture' }] };
      },
    });
    const profile = defineExtension({ name: 'fixture-compat-v1', tools: [echo], sections: [section('skills', () => formatSkillsForPrompt(skills.skills))] });
    registry.install(profile);
    await root.configure({ extensions: [profile] }, context);
    faux.setResponses([fauxAssistantMessage(fauxToolCall('fixture_mcp', { message: 'fixture' }), { stopReason: 'toolUse' }), fauxAssistantMessage('compat done')]);
    assert.equal((await (await root.submit({ type: 'input', content: 'compat', requestId: 'compat' }, context)).wait(context)).status, 'done');
    const entries = (await root.context(context)).entries;
    assert(entries.some(entry => entry.kind === 'pi.system' && JSON.stringify(entry).includes('fixture-skill')));
    assert(entries.some(entry => entry.kind === 'pi.tool-result' && JSON.stringify(entry).includes('ECHO: fixture')));
    registry.uninstall(profile);
    assert.equal((await root.agent(context)).tools.length, 0); // Negative case: future adapter must reject this profile.
  } finally { await client.close(); }

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
  console.log('PASS: real skill loader / Durable prompt; stdio MCP bridge; missing extension negative case; document/task version rejection');
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
