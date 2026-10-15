// Déteneur de bail pour le test SIGKILL : acquiert le bail puis attend le kill.
import { acquireRuntimeLease } from "../../src/durable/lease.js";

const lease = acquireRuntimeLease(process.argv[2]!);
process.send?.("acquired");
setInterval(() => lease, 1_000); // garde la connexion SQLite vivante
