import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export async function fixtureRepository(directory: string) {
  const source = join(directory, 'source');
  await mkdir(source);
  git(source, 'init', '-q');
  await writeFile(join(source, 'fixture.txt'), 'before\n');
  await writeFile(join(source, 'artifact.txt'), 'immutable fixture\n');
  await writeFile(join(source, 'offline.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
test('offline clone content', async () => {
  console.log('fixture-test-started');
  await setTimeout(Number(process.env.FIXTURE_DELAY || 0));
  assert.equal(await readFile('fixture.txt', 'utf8'), 'before\\n');
});
`);
  git(source, 'add', '.');
  // Synthetic object in a private fixture repository only; never commits Cogitator work.
  const revision = git(source, 'commit-tree', git(source, 'write-tree'), '-m', 'offline fixture');
  git(source, 'update-ref', 'HEAD', revision);
  return { source, revision };
}

export async function cloneFixture(directory: string, source: string, revision: string) {
  await mkdir(directory, { recursive: true });
  git(directory, 'clone', '--no-local', source, 'workspace');
  assert.equal(git(join(directory, 'workspace'), 'rev-parse', 'HEAD'), revision);
  await writeFile(join(directory, 'revision'), revision);
}
