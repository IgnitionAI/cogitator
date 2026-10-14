import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { request, type Server } from "node:http";
import { connect } from "node:net";
import { authPaths, checkPrivate, protectedRequired, validateOwnerSocketPath } from "./auth-state.js";
import { authenticationRequired, BASE_URL } from "./config.js";
import { getPaths } from "./paths.js";
import { createPrivateServer } from "./server.js";

async function socketLive(path: string): Promise<boolean> {
  return new Promise((done, reject) => {
    const socket = connect(path);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Owner socket probe timed out")); });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", (err: NodeJS.ErrnoException) => err.code === "ECONNREFUSED" ? done(false) : reject(err));
  });
}
/** TCP must already be reserved. Only reconcile a stale inode recorded by this implementation.
 * A SIGKILL between bind and receipt leaves an unrecognized socket: fail closed for stopped-owner inspection. */
export async function listenOwnerSocket(app: Server, home: string): Promise<Server> {
  validateOwnerSocketPath(home);
  const { directory, socket } = authPaths(home);
  const receipt = `${socket}.json`;
  checkPrivate(directory, true);
  if (existsSync(socket)) {
    const s = lstatSync(socket);
    if (!s.isSocket() || s.isSymbolicLink() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error("Unsafe owner socket");
    checkPrivate(receipt);
    const recorded: unknown = JSON.parse(readFileSync(receipt, "utf8"));
    if (!recorded || typeof recorded !== "object" || !("ino" in recorded) || !("dev" in recorded) || recorded.ino !== s.ino || recorded.dev !== s.dev) throw new Error("Unrecognized owner socket");
    if (await socketLive(socket)) throw new Error("Owner socket is already live");
    unlinkSync(socket); unlinkSync(receipt);
  } else if (existsSync(receipt)) { checkPrivate(receipt); unlinkSync(receipt); }
  const server = createPrivateServer(app);
  let ownSocket: Stats | undefined;
  let ownReceipt: Stats | undefined;
  const cleanup = () => { removeOwnedFile(socket, ownSocket); removeOwnedFile(receipt, ownReceipt); };
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(socket, done); });
    ownSocket = lstatSync(socket);
    chmodSync(socket, 0o600);
    // Capture the exclusive receipt's identity before any write/fsync can fail.
    const fd = openSync(receipt, "wx", 0o600);
    try {
      ownReceipt = fstatSync(fd);
      writeFileSync(fd, JSON.stringify({ ino: ownSocket.ino, dev: ownSocket.dev }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    server.once("close", cleanup);
    return server;
  } catch (error) {
    // The caller has no server handle until this function returns successfully.
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    try { cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Owner socket setup and cleanup failed"); }
    throw error;
  }
}
function removeOwnedFile(path: string, own: Stats | undefined): void {
  if (!own || !existsSync(path)) return;
  const current = lstatSync(path);
  if (current.ino === own.ino && current.dev === own.dev) unlinkSync(path);
}

/** Explicit URLs, including loopback overrides, always retain ordinary HTTP semantics. */
export async function ownerRequest<T>(method: string, path: string, body?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const home = getPaths(env).home;
  const required = authenticationRequired(env);
  if (env.COGITATOR_URL !== undefined || !protectedRequired(home, required)) {
    const response = await fetch(`${env.COGITATOR_URL ?? BASE_URL}${path}`, { method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
    return data as T;
  }
  validateOwnerSocketPath(home);
  const { directory, socket } = authPaths(home);
  checkPrivate(directory, true);
  const s = lstatSync(socket);
  if (!s.isSocket() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error("Unsafe owner socket");
  return new Promise<T>((done, reject) => {
    const req = request({ socketPath: socket, method, path, headers: { "content-type": "application/json" }, timeout: 30_000 }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if ((res.statusCode ?? 500) >= 400) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.statusCode}`);
          done(data as T);
        } catch (err) { reject(err); }
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Owner request timed out")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
