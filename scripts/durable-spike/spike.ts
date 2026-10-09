import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, watchEvents, defineExtension, defineDoc, AgentDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';

import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { compatibility, schemaVersion } from './compatibility.js';
import { cloneFixture, fixtureRepository, git } from './repository.js';
import { fixtureTools, Approval, digest, readOptional, cleanupWorker } from './tools.js';

const Frozen = defineDoc({ kind: 'spike.profile', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ code: '', revision: '' }) });

async function open(directory: string, slow: boolean, scenario = 'model') {
  const database = await openNodeSqliteDatabase(join(directory, 'runtime.sqlite'));
  assert.equal((await database.get<{ synchronous: number }>('PRAGMA synchronous'))?.synchronous, 1);
  await database.exec('PRAGMA synchronous = FULL');
  assert.equal((await database.get<{ synchronous: number }>('PRAGMA synchronous'))?.synchronous, 2);
  const storage = await SqliteStorage.open(database);
  const faux = fauxProvider(slow ? { tokensPerSecond: 10, tokenSize: { min: 1, max: 1 } } : {});
  faux.setResponses([fauxAssistantMessage(slow ? 'partial '.repeat(1000) : 'recovered'), fauxAssistantMessage('queued answer')]);
  if (scenario.startsWith('fixture_')) faux.setResponses(slow
    ? [fauxAssistantMessage(fauxToolCall(scenario === 'fixture_grant_boundary' ? 'fixture_unsafe' : (scenario === 'fixture_conflict' || scenario === 'fixture_edit_mutant') ? 'fixture_edit' : scenario, {}), { stopReason: 'toolUse' })]
    : [fauxAssistantMessage('recovered tool')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const profile = defineExtension({ name: 'fixture-v1', tools: fixtureTools(directory, slow, scenario === 'fixture_grant_boundary', scenario === 'fixture_edit_mutant' ? 'unsafe' : 'safe') });
  registry.install(profile);
  const harness = await Harness.open(storage, { models, registry, env: () => new NodeExecutionEnv({ cwd: join(directory, 'workspace') }), settings: { compaction: { enabled: false }, retry: { enabled: false }, progress: { partialIntervalMs: 1 } } }, context);
  const model = faux.getModel();
  const code = digest((await Promise.all(['tools.ts', 'offline-worker.ts'].map(file => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n'));
  const revision = git(join(directory, 'workspace'), 'rev-parse', 'HEAD');
  const root = await harness.root(context, { agent: { extensions: [profile], model: { provider: model.provider, modelId: model.id } }, init: async (tx, id) => {
    Object.assign(await tx.doc(Frozen, id), { code, revision });
  } });
  async function preflight() {
    assert.deepEqual(await harness.snapshot(Frozen, root.id, context), { code, revision }, 'Frozen fixture profile mismatch');
    assert.deepEqual((await harness.snapshot(AgentDoc, root.id, context))?.extensions, ['fixture-v1'], 'Unknown fixture extension');
    const installed = registry.snapshot().extension('fixture-v1');
    assert(installed, 'Missing fixture extension');
    assert.deepEqual(installed.tools?.map(tool => tool.name), ['fixture_edit', 'fixture_unsafe', 'fixture_offline']);
  }
  return { harness, root, storage, registry, faux, profile, preflight };
}

async function child(directory: string, mode: string, witness: string) {
  const [phase, scenario = 'model'] = mode.split(':');
  const runtime = await open(directory, phase === 'seed', scenario);
  const { harness, root, storage, faux, registry, profile, preflight } = runtime;
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (scenario.startsWith('profile_')) {
    if (phase === 'seed') {
      if (scenario === 'profile_unknown') await root.configure({ extensions: [defineExtension({ name: 'unknown' })] }, context);
      process.send?.({ point: scenario });
      setInterval(() => {}, 1000);
      return;
    }
    if (scenario === 'profile_missing') registry.uninstall(profile);
    await assert.rejects(preflight, /fixture extension/);
    assert.equal((await harness.inspect(context)).scheduling, 'paused');
    await harness.close(context);
    process.send?.({ denied: scenario });
    return;
  }
  await preflight();
  if (scenario.startsWith('acceptance_')) {
    if (phase === 'seed') {
      const accepted = scenario === 'acceptance_after'
        ? await root.submit({ type: 'input', content: 'boundary', requestId: 'boundary' }, context) : undefined;
      process.send?.({ accepted: accepted?.id ?? null });
      setInterval(() => {}, 1000);
      return;
    }
    const record = await root.commit(tx => tx.submissionByRequest(root.id, 'boundary'), context);
    const previous: unknown = JSON.parse(witness);
    assert(previous && typeof previous === 'object' && 'accepted' in previous);
    assert.equal(record?.id ?? null, previous.accepted);
    assert.equal(faux.state.callCount, 0);
    const submission = await root.submit({ type: 'input', content: 'boundary', requestId: 'boundary' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    assert.equal((await root.context(context)).entries.filter(entry => entry.kind === 'pi.user').length, 1);
    assert.equal(faux.state.callCount, 1);
    await harness.close(context);
    process.send?.({ recovered: scenario });
    return;
  }
  if (scenario.startsWith('grant_')) {
    if (phase === 'seed') {
      await root.commit(async tx => {
        const grant = await tx.doc(Approval, root.id);
        if (scenario === 'grant_mission') grant.mission = 'different-mission';
        if (scenario === 'grant_target') grant.target = 'different-target';
        if (scenario === 'grant_action') grant.digest = digest('different-action');
        if (scenario === 'grant_expired') grant.expires = 0;
        if (scenario === 'grant_revoked') grant.revoked = true;
        if (scenario === 'grant_denied') grant.denied = true;
        if (scenario === 'grant_arguments') grant.arguments = digest(JSON.stringify({ action: 'approved-only' }));
      }, context);
      process.send?.({ point: 'grant-persisted' });
      setInterval(() => {}, 1000);
      return;
    }
    const grant = await harness.snapshot(Approval, root.id, context);
    assert(grant);
    if (scenario === 'grant_expired') assert.equal(grant.expires, 0);
    if (scenario === 'grant_revoked') assert.equal(grant.revoked, true);
    if (scenario === 'grant_denied') assert.equal(grant.denied, true);
    faux.setResponses([fauxAssistantMessage(fauxToolCall('fixture_unsafe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('denied')]);
    await (await root.submit({ type: 'input', content: 'protected operation', requestId: 'protected' }, context)).wait(context);
    assert.equal(await readOptional(join(directory, 'effects.txt')), '');
    assert(JSON.stringify((await root.context(context)).entries).includes('No valid fixture grant'));
    assert.equal((await harness.snapshot(Approval, root.id, context))?.uses, 1);
    await harness.close(context);
    process.send?.({ denied: scenario });
    return;
  }
  if (scenario.startsWith('fixture_')) {
    if (phase === 'seed') {
      await root.submit({ type: 'input', content: 'fixture tool', requestId: 'tool' }, context);
      return;
    }
    if (scenario === 'fixture_unsafe' || scenario === 'fixture_grant_boundary') {
      const grant = await harness.snapshot(Approval, root.id, context);
      assert.equal(grant?.uses, 0);
      assert(grant.intentTask > 0);
    }
    const submitted = await root.submit({ type: 'input', content: 'fixture tool', requestId: 'tool' }, context);
    assert.equal((await submitted.wait(context)).status, 'done');
    const entries = (await root.context(context)).entries;
    const results = entries.filter(entry => entry.kind === 'pi.tool-result');
    assert.equal(results.length, 1);
    if (scenario === 'fixture_conflict') {
      assert.equal(await readFile(join(directory, 'workspace', 'fixture.txt'), 'utf8'), 'conflict\n');
      assert(JSON.stringify(results).includes('Conflicting file content requires attention'));
    } else if (scenario === 'fixture_edit' || scenario === 'fixture_edit_mutant') {
      const requireReconciled = () => {
        const message = results[0]?.model?.[0];
        assert(message?.role === 'toolResult' && message.isError === false, 'Edit must have successful authoritative tool result');
        assert.deepEqual(message.content, [{ type: 'text', text: 'edit reconciled' }]);
      };
      if (scenario === 'fixture_edit_mutant') {
        assert(JSON.stringify(results).includes('interrupted'));
        assert.throws(requireReconciled, /successful authoritative tool result/);
      } else requireReconciled();
      assert.equal(await readFile(join(directory, 'workspace', 'fixture.txt'), 'utf8'), 'after\n');
      assert(!JSON.stringify(results).includes('tool_error'));
    } else if (scenario === 'fixture_unsafe' || scenario === 'fixture_grant_boundary') {
      assert.equal(await readOptional(join(directory, 'effects.txt')), scenario === 'fixture_grant_boundary' ? '' : 'effect\n');
      assert(JSON.stringify(results).includes('interrupted'));
      if (scenario !== 'fixture_grant_boundary') assert(JSON.stringify(results).includes('effect-dispatch'));
      faux.setResponses([fauxAssistantMessage(fauxToolCall('fixture_unsafe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('denied')]);
      await (await root.submit({ type: 'input', content: 'attempt same action again', requestId: 'repeat-effect' }, context)).wait(context);
      assert.equal(await readOptional(join(directory, 'effects.txt')), scenario === 'fixture_grant_boundary' ? '' : 'effect\n');
      assert(JSON.stringify((await root.context(context)).entries).includes('No valid fixture grant'));
    } else {
      assert(JSON.stringify(results).includes('offline test passed'));
      assert(!JSON.stringify(results).includes('tool_error'));
      assert(JSON.stringify(results).includes('observedLiveWorker'));
    }
    await harness.close(context);
    process.send?.({ recovered: scenario });
    return;
  }
  if (mode.startsWith('seed')) {
    await root.commit(async tx => { await tx.doc(Approval, root.id); }, context);
    const stream = await watchEvents(harness, root.id, context);
    const partial = Promise.withResolvers<void>();
    stream.start(async events => { if (events.some(event => event.type === 'message_update')) partial.resolve(); });
    const first = await root.submit({ type: 'input', content: 'first', requestId: 'first' }, context);
    const queued = await root.submit({ type: 'input', content: 'queued', requestId: 'queued' }, context);
    assert.equal((await queued.status(context)).status, 'queued');
    await assert.rejects(() => root.submit({ type: 'input', content: 'reject while busy', requestId: 'rejected', whenBusy: 'reject' }, context));
    assert.equal(await root.commit(tx => tx.submissionByRequest(root.id, 'rejected'), context), undefined);
    await partial.promise;
    process.send?.({ ids: [first.id, queued.id] });
    return; // Parent kills this still-streaming process, not a graceful close.
  }
  const ids: unknown = JSON.parse(witness);
  assert(Array.isArray(ids));
  assert.equal((await harness.inspect(context)).scheduling, 'paused');
  assert.deepEqual(await harness.snapshot(Approval, root.id, context), Approval.definition.initial());
  const snapshot = await root.watch(context);
  assert(JSON.stringify(snapshot.value.docs['pi.live']).includes('message'));
  await snapshot.stop();
  const events = await watchEvents(harness, root.id, context);
  const committedIds: number[] = [];
  const checked = Promise.withResolvers<void>();
  events.start(async batch => {
    for (const event of batch) {
      if (event.type !== 'message_end') continue;
      assert.deepEqual((await storage.entry(event.entry.id, context))?.entry, event.entry);
      committedIds.push(event.entry.id);
      if (event.entry.model?.some(message => message.role === 'assistant' && message.stopReason === 'stop')) checked.resolve();
    }
  });
  const first = await root.submit({ type: 'input', content: 'first', requestId: 'first' }, context);
  const queued = await root.submit({ type: 'input', content: 'queued', requestId: 'queued' }, context);
  assert.deepEqual([first.id, queued.id], ids);
  assert.equal((await first.wait(context)).status, 'done');
  assert.equal((await queued.wait(context)).status, 'done');
  await checked.promise;
  const entries = (await root.context(context)).entries;
  assert.equal(entries.filter(entry => entry.kind === 'pi.user').length, 2);
  assert(entries.some(entry => entry.model?.some(message => message.role === 'assistant' && message.stopReason === 'aborted')));
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  assert(committedIds.length > 0);
  await events.stop();
  await harness.close(context);
  process.send?.({ recovered: true });
}

async function runChild(directory: string, mode: string, witness = 'null', timeoutMs = 20000) {
  return new Promise<unknown>((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['child', directory, mode, witness], {
      execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, silent: true,
    });
    let stderr = '';
    let result: unknown;
    let failure: Error | undefined;
    const timeout = setTimeout(() => { failure = new Error(`Timed out ${mode}`); child.kill('SIGKILL'); }, timeoutMs);
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { failure = error; });
    child.on('message', message => { result = message; if (mode.startsWith('seed')) child.kill('SIGKILL'); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (mode.startsWith('seed') ? signal !== 'SIGKILL' : code !== 0) reject(new Error(`${mode}: exit ${code}/${signal}: ${stderr}`));
      else if (result === undefined) reject(new Error(`${mode}: no evidence: ${stderr}`));
      else resolve(result);
    });
  });
}

if (process.argv[2] === 'child') {
  await child(process.argv[3]!, process.argv[4]!, process.argv[5]!);
} else {
  const directory = await mkdtemp('/tmp/dsp-');
  try {
    const { source, revision } = await fixtureRepository(directory);
    await cloneFixture(directory, source, revision);
    console.log(`Fixture source revision: ${revision}`);
    const witness = await runChild(directory, 'seed');
    assert(witness !== null && typeof witness === 'object' && 'ids' in witness);
    await runChild(directory, 'reopen', JSON.stringify(witness.ids));
    console.log('PASS: SIGKILL generation; durable queued request IDs; approval data; committed events; FULL connection setting');
    for (const scenario of ['fixture_edit', 'fixture_edit_mutant', 'fixture_conflict', 'fixture_unsafe', 'fixture_grant_boundary', 'fixture_offline', 'profile_unknown', 'profile_missing', 'acceptance_before', 'acceptance_after', 'grant_expired', 'grant_revoked', 'grant_denied', 'grant_arguments', 'grant_artifact', 'grant_mission', 'grant_target', 'grant_action']) {
      const scope = join(directory, scenario);
      await cloneFixture(scope, source, revision);
      const boundary = await runChild(scope, `seed:${scenario}`);
      if (scenario === 'fixture_conflict') await writeFile(join(scope, 'workspace', 'fixture.txt'), 'conflict\n');
      if (scenario === 'grant_artifact') await writeFile(join(scope, 'workspace', 'artifact.txt'), 'different artifact\n');
      await runChild(scope, `reopen:${scenario}`, JSON.stringify(boundary));
      console.log(`PASS: SIGKILL ${scenario} / reopen`);
    }
    const failureScope = join(directory, 'failure-cleanup');
    await cloneFixture(failureScope, source, revision);
    await runChild(failureScope, 'seed:fixture_offline');
    await assert.rejects(() => runChild(failureScope, 'timeout', 'null', 300), /Timed out/);
    await cleanupWorker(failureScope);
    assert.equal(await readOptional(join(failureScope, 'worker.exited')), 'exited');
    await assert.rejects(() => readOptional(join(failureScope, 'workspace')), /EISDIR/);
    await rm(failureScope, { recursive: true });
    console.log('PASS: timeout waits for harness close; live supervisor cleanup before rm; non-ENOENT read errors propagate');
    const scope = join(directory, 'compat');
    await cloneFixture(scope, source, revision);
    const runtime = await open(scope, false);
    try { await compatibility(scope, runtime.harness, runtime.root, runtime.registry, runtime.faux); }
    finally { await runtime.harness.close(context); }
    await schemaVersion(scope);
    assert.equal(await readFile(join(source, 'fixture.txt'), 'utf8'), 'before\n');
    console.log('P0 LOCAL SUPPORTED PROFILE: PASS — not production integration, isolation, or deployment.');
  } finally {
    await cleanupWorker(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await cleanupWorker(join(directory, entry.name));
    }
    await rm(directory, { recursive: true, force: true });
  }
}
