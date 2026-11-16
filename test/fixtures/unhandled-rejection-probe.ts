/**
 * Processus enfant : installe le gestionnaire du CLI, injecte un rejet, reste vivant.
 * Sans gestionnaire, Node termine le process avant `still-alive`.
 */
import { onUnhandledRejection } from "../../src/unhandled-rejection.js";

process.on("unhandledRejection", onUnhandledRejection);
Promise.reject(new Error("injected-unhandled-rejection"));
setTimeout(() => {
  process.stdout.write("still-alive\n");
  process.exit(0);
}, 200);
