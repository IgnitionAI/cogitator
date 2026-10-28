/**
 * Hôte miniature : spawn un vrai `pi --mode rpc`, signale les pid, reste vivant jusqu'au SIGKILL.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { OWNED_PI_ENV, ownedPiMarker } from "../../src/reap-orphans.js";
import { guardedRpcSpawn } from "../../src/pi-child.js";

const home = process.argv[2]!;
const cliPath = process.argv[3]!;
const pkg = process.argv[4]!;
const { RpcClient } = await import(pathToFileURL(join(pkg, "dist/index.js")).href) as {
  RpcClient: new (opts: object) => { start(): Promise<void>; prompt(text: string): Promise<unknown>; process?: { pid?: number } };
};
const spawn = guardedRpcSpawn(cliPath, {
  cwd: home,
  args: ["--model", "openai/gpt-5.4", "--offline", "--no-extensions", "--no-skills", "--no-tools"],
  env: { HOME: home, [OWNED_PI_ENV]: ownedPiMarker() ?? "", COGITATOR_HOME: home },
});
const client = new RpcClient(spawn);
await client.start();
process.send?.({ pid: process.pid, rpcPid: client.process?.pid });
setInterval(() => {}, 1000);
