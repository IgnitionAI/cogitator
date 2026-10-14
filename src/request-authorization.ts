import { AsyncLocalStorage } from "node:async_hooks";

// Carries a fresh DB check through asynchronous route helpers, never a token or a cached approval.
export const requestAuthorization = new AsyncLocalStorage<() => void>();
export function checkRequestAuthorization(): void { requestAuthorization.getStore()?.(); }
