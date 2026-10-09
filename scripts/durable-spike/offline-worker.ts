import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// Fixed profile supervisor; only a bounded, trusted Node test, no shell or descendants.
const [workspace, receipt, socket, mode] = process.argv.slice(2);
assert(workspace && receipt && socket && (mode === 'interrupt' || mode === 'complete'));
let commandClosed = false;
process.once('exit', () => {
  if (commandClosed) writeFileSync(join(dirname(receipt), 'worker.exited'), 'exited');
});
let stopping = false;
const command = spawn(process.execPath, ['--test', '--experimental-test-isolation=none', '--test-timeout=10000', 'offline.test.mjs'], {
  cwd: workspace, env: { FIXTURE_DELAY: mode === 'interrupt' ? '8000' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const server = createServer(connection => {
  connection.on('error', () => connection.destroy());
  connection.once('data', data => {
    if (data.toString() !== 'stop') return connection.destroy();
    stopping = true;
    command.kill('SIGTERM');
    command.once('close', () => connection.end('stopped'));
  });
});
const deadline = setTimeout(() => { stopping = true; command.kill('SIGKILL'); }, 12000);
command.on('error', () => { stopping = true; });
server.on('error', () => { stopping = true; command.kill('SIGKILL'); });
command.on('close', code => {
  commandClosed = true;
  writeFileSync(receipt, stopping ? 'terminated' : code === 0 ? 'passed' : 'failed');
  clearTimeout(deadline);
  server.close();
  try { unlinkSync(socket); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (process.connected) process.disconnect?.();
});
// Disconnect intentionally leaves the bounded worker alive so recovery must observe/stop it.
process.on('disconnect', () => {});
let listening = false;
let started = false;
function ready() { if (listening && started) process.send?.('running'); }
command.stdout.on('data', data => {
  if (!started && data.toString().includes('fixture-test-started')) { started = true; ready(); }
});
command.stderr.resume();
server.listen(socket, () => { listening = true; ready(); });
