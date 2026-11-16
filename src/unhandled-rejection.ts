/** Journalise un rejet non géré. Ne relance pas : le processus reste vivant. */
export function onUnhandledRejection(reason: unknown): void {
  console.error(`[cogitator] unhandledRejection`, reason instanceof Error ? reason.message : reason);
}
