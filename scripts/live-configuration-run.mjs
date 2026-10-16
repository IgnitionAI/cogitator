// Always launches a new isolated controller; never accepts an existing server URL.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'cogitator-live-configuration-'));
const home = join(root, 'home');
mkdirSync(home);
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/live-configuration-server.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, LANG: 'en_US.UTF-8',
    LIVE_CONFIGURATION_ROOT: root, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), COGITATOR_PI_AGENT_DIR: join(home, '.pi', 'agent'),
    COGITATOR_HOME: join(home, '.cogitator'), COGITATOR_SKILLS_DIRS: '',
    ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
console.log(`Disposable evidence/data: ${root}`);
