import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTool } from '@earendil-works/pi-durable';
import { createEditTool } from '@earendil-works/pi-durable/tools';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export const Approval = defineDoc<{ digest: string; mission: string; target: string; artifact: string; arguments: string; uses: number; revoked: boolean; denied: boolean; expires: number; intentTask: number }>({
  kind: 'spike.approval', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ digest: 'sha256:fixture-only', mission: 'fixture-mission', target: 'fixture',
    artifact: digest('immutable fixture\n'), arguments: digest('{}'), uses: 1,
    revoked: false, denied: false, expires: 2000000000000, intentTask: 0 }),
});

// A deliberately narrow profile: only one known file and exact before/after bytes.
// Not a replacement for arbitrary shell recovery or a production policy gateway.
export function fixtureTools(directory: string, crash: boolean, beforeDispatch = false) {
  const edit = createEditTool();
  const localEdit = defineTool({
    name: 'fixture_edit', description: 'Reconcile one fixture edit', parameters: Type.Object({}), replay: 'safe',
    async execute(_args, api, context) {
      const intent = await api.memo('edit', { before: 'before\n', after: 'after\n' }, context);
      const current = await readFile(join(directory, 'workspace', 'fixture.txt'), 'utf8');
      assert(current === intent.before || current === intent.after, 'Conflicting file content requires attention');
      if (current === intent.before) {
        const result = await edit.execute({ path: 'fixture.txt', edits: [{ oldText: intent.before, newText: intent.after }] }, api, context);
        assert(!result.isError);
      }
      if (crash) {
        await api.details({ point: 'edit-written-before-receipt' }, context);
        process.send?.({ point: 'edit-written-before-receipt' });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
      return { content: [{ type: 'text', text: 'edit reconciled' }] };
    },
  });
  const unsafe = defineTool({
    name: 'fixture_unsafe', description: 'Harmless stand-in for an external effect', parameters: Type.Object({ action: Type.Optional(Type.String()) }), replay: 'unsafe',
    async execute(args, api, context) {
      const artifact = digest(await readFile(join(directory, 'workspace', 'artifact.txt'), 'utf8'));
      await api.commit(async tx => {
        const grant = await tx.doc(Approval, api.conversationId);
        assert(grant.uses === 1 && !grant.revoked && !grant.denied && grant.expires > Date.now() && grant.arguments === digest(JSON.stringify(args)) && grant.artifact === artifact, 'No valid fixture grant');
        grant.uses = 0;
        grant.intentTask = api.taskId;
      }, context);
      if (crash && beforeDispatch) {
        process.send?.({ point: 'consumed-before-dispatch' });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
      await api.details({ point: 'effect-dispatch', target: 'fixture' }, context);
      await appendFile(join(directory, 'effects.txt'), 'effect\n');
      if (crash) {
        process.send?.({ point: 'effect-succeeded-before-receipt' });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
      return { content: [{ type: 'text', text: 'effect' }] };
    },
  });
  const offline = defineTool({
    name: 'fixture_offline', description: 'Fixed no-network offline test', parameters: Type.Object({}), replay: 'safe',
    async execute(_args, api, context) {
      const execution = await api.memo<string>('execution', context);
      const id = await api.memo('execution', randomUUID(), context);
      const receipt = join(directory, `${id}.receipt`);
      const socket = join(directory, 'w.sock');
      if (execution) {
        let prior = await readFile(receipt, 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return '';
        });
        if (!prior) {
          const observed = await new Promise<string>((resolve, reject) => {
            const connection = createConnection(socket);
            let response = '';
            connection.setTimeout(2000, () => connection.destroy(new Error('Worker stop timed out')));
            connection.on('connect', () => connection.write('stop'));
            connection.on('data', data => { response += data.toString(); });
            connection.on('error', reject);
            connection.on('end', () => resolve(response));
          });
          assert.equal(observed, 'stopped');
          await api.details({ observedLiveWorker: id, stopped: true }, context);
          prior = await readFile(receipt, 'utf8');
        }
        assert(prior === 'terminated' || prior === 'passed', 'Unknown worker outcome requires attention');
        if (prior === 'passed') return { content: [{ type: 'text', text: 'previous test passed' }] };
      }
      await new Promise<void>((resolve, reject) => {
        const worker = fork(fileURLToPath(new URL('./offline-worker.ts', import.meta.url)),
          [join(directory, 'workspace'), receipt, socket, crash ? 'interrupt' : 'complete'],
          { execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH, HOME: directory }, silent: true });
        worker.on('error', reject);
        worker.on('message', message => {
          if (message === 'running' && crash) {
            void api.details({ execution: id, pid: worker.pid ?? 0 }, context)
              .then(() => process.send?.({ point: 'offline-running' }), reject);
          }
        });
        worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`Offline worker exit ${code}`)));
      });
      assert.equal(await readFile(receipt, 'utf8'), 'passed');
      return { content: [{ type: 'text', text: 'offline test passed' }] };
    },
  });
  return [localEdit, unsafe, offline];
}
