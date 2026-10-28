/**
 * Spawn un process marqué avec le pid/starttime de CE helper, puis quitte.
 * Le petit-fils survit (detached) ; l'hôte enregistré est mort → orphelin.
 * argv[3] optionnel : "rpc" pour coller au cmdline `--mode rpc`.
 */
import { spawn } from "node:child_process";
import { OWNED_PI_ENV, ownedPiMarker } from "../../src/reap-orphans.js";

const home = process.argv[2];
if (!home) throw new Error("home requis");
const rpc = process.argv[3] !== "plain";
const marker = ownedPiMarker();
if (!marker) throw new Error("marqueur hôte illisible");
const args = rpc
  ? ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc"]
  : ["-e", "setInterval(() => {}, 1000)"];
const child = spawn(process.execPath, args, {
  env: { ...process.env, [OWNED_PI_ENV]: marker, COGITATOR_HOME: home },
  detached: true,
  stdio: "ignore",
});
if (!child.pid) throw new Error("spawn sans pid");
process.stdout.write(String(child.pid));
child.unref();
