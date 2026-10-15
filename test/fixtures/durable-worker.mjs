// Worker fixture longue durée (ticket #15) : vit jusqu'à 'stop' sur sa socket
// privée, écrit un marqueur de sortie. Détaché du driver : survit à un SIGKILL
// du contrôleur (c'est l'orphelin que la reprise doit classifier puis arrêter).
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [socketPath, scope] = process.argv.slice(2);

writeFileSync(join(scope, "worker.ready"), String(process.pid));

const server = createServer((socket) => {
  socket.on("data", () => {
    socket.end("stopped");
    writeFileSync(join(scope, "worker.exited"), "exited");
    server.close(() => process.exit(0));
  });
});
server.listen(socketPath);

// Garde-fou de nettoyage : ne jamais fuir indéfiniment si le test échoue.
setTimeout(() => {
  writeFileSync(join(scope, "worker.exited"), "timed-out");
  process.exit(1);
}, 60_000);
