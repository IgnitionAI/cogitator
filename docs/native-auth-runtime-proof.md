# Native auth: isolated runtime feasibility proof

Research only, 2026-10-10. **The tested assurance seam is feasible; this is not implementation approval.**
Plan 0003 remains pending arbiter. No application integration, root dependency/lockfile changes, real owner, provider or VPS operations.

## Environment and method

- Node **v26.10.0**, darwin arm64; root's existing **better-sqlite3 12.11.1**, SQLite **3.53.2**, successfully loaded natively.
- Fresh `mktemp -d /tmp/cogitator-auth-proof.XXXXXX`; isolated npm project, `npm install --ignore-scripts --no-audit --no-fund better-auth@1.7.7`.
- Symlinked only that fixture's `node_modules/better-sqlite3` to the existing root module; did not rebuild it.
- Resolved Better Auth/core/Kysely adapter **1.7.7**, utils **0.4.2**, Kysely **0.29.6**, better-call **1.4.0**.
- Exercised real `auth.handler(Request)` calls with separate cookie jars, fake `example.invalid` owner, randomly generated fixture password/secret and temporary SQLite file. No listening server.
- Used library `createOTP` from `@better-auth/utils/otp` as a **synthetic authenticator only**. Decoded the returned enrollment URI with library base32; no custom verifier.
- Enabled email/password and `twoFactor()`; cookie cache disabled; rate limiting disabled to isolate this seam. HTTP localhost was fixture-only, not protected-mode configuration.
- Harness used `node:assert/strict`, inspected persisted rows, and checked every response body for absence of `mfaApproved`. Secret material never printed.
- Final completed harness SHA-256: `5b2b980982d9f8aa33e41ed4df149c24acd9dff929dbd18815caf03f9f9266f3`.
- Fixture lockfile SHA-256: `c9317164edd1f0943aeeb318f1e66c8864ddd2622157cf3ad27cb45ba2825f8e`.
- Initial harness assumed every error body was JSON; injected generic errors produce empty HTTP 500 bodies. Corrected harness to tolerate empty bodies and reran on fresh databases; final run completed all assertions.

## Migration API: executed, not inferred

Imported `getMigrations` from **`better-auth/db/migration`**, passing the exact auth options including two-factor plugin and:

```js
session: { cookieCache: { enabled: false }, additionalFields: {
  mfaApproved: { type: 'boolean', required: true, defaultValue: false,
    input: false, returned: false }
} }
```

Returned keys were exactly `compileMigrations`, `runMigrations`, `schemaProblems`, `toBeAdded`, `toBeAddedIndexes`, `toBeCreated`, `unsafeChanges`.
`await compileMigrations()` contained `mfaApproved`; `await runMigrations()` created the functioning schema.
Replanning returned zero tables to create and zero table entries to add. This proves fresh-schema migration, **not populated-schema upgrades or rate-limit schema**.

## Session-create hook observations

Fixture policy in `databaseHooks.session.create.before(session, ctx)` always overwrote `mfaApproved`:

```js
const eligible = ['/two-factor/verify-totp', '/two-factor/verify-backup-code']
  .includes(ctx?.path) && !ctx?.context.session;
return { data: { ...session, mfaApproved: eligible && session.userId === owner } };
```

| Actual exercise | Observed / asserted result |
| --- | --- |
| Signup and two separate password logins before enrollment | Persisted assurance false on all sessions. |
| Invalid enrollment TOTP | HTTP 401; no session-create hook invocation. |
| Successful enrollment TOTP | HTTP 200; rotation hook had an existing `ctx.context.session`; assurance false. |
| Old pre-enrollment cookie after factor activation | `get-session` user flag became true; original session row still false. |
| Valid TOTP with that old cookie | HTTP 200 but no new session/create hook; old session remained unapproved. |
| Enrolled password login | Temporary challenge response; intermediate credential session's hook remained false. |
| Invalid challenge TOTP | HTTP 401; no create hook. |
| Valid TOTP without challenge or session | HTTP 401; no create hook. |
| Fresh password challenge + valid TOTP | HTTP 200; hook had no existing session; DB session assurance true. |
| Fresh password challenge + valid recovery code | HTTP 200; hook had no existing session; assurance true. |
| Reuse of consumed recovery code with fresh challenge | HTTP 401; no create hook. |
| Valid challenge, deliberately mismatched configured owner ID | HTTP 200 from library; hook forced false. Exact-owner authorization remains application's responsibility. |

For every challenge-created session, the hook read the signed `two_factor` cookie and asserted its identifier was **already absent from the verification table**, and the proposed session token was **not yet present in session storage**.
On successful TOTP and recovery hooks, `ctx.body.code` was a string. For recovery the encrypted backup-code list had already changed from its pre-redemption snapshot.
Thus successful factor verification/challenge consumption precedes this hook and session insertion follows it in the exercised flows; a generic endpoint before-hook would not provide this guarantee.
Every tested raw response omitted the private field, including authenticated `get-session`; querying the DB by the validated session ID recovered the true private assurance value.
**Session tokens remain in unprojected library JSON.** This probe does not implement or prove the required browser response projection.

## Concurrency and conservative replay reservation

- Two concurrent `Promise.all` recovery redemptions, same code and **independent password challenges**: HTTP **200 / 409**, exactly **one additional approved session**.
- Single process/one library SQLite connection; no claim of independent-process or multi-host concurrency coverage.
- Added a fixture-only `replay(digest TEXT PRIMARY KEY, expires INTEGER NOT NULL)` table. Only successful eligible owner TOTP hooks reserved an HMAC-SHA256 digest over owner ID and submitted code, with an independent random fixture key.
- Reservation was one SQLite statement: `INSERT ... ON CONFLICT(digest) DO UPDATE SET expires=excluded.expires WHERE replay.expires <= ?`, with expiry `now + 300000`. Zero changes threw before session insertion.
- Two concurrent valid TOTP redemptions with independent challenges and the same code: HTTP **200 / 500**, exactly **one additional approved session**. The loser had consumed its challenge but could not insert a session.
- All observed successful challenge hooks had `db.inTransaction === false`. A **second SQLite connection** could immediately read each successful claim from inside the hook, establishing committed visibility before the later library insert, not merely a read on the same connection.
- Injected a real SQLite `BEFORE INSERT ON session` trigger using `RAISE(ABORT, ...)`, after obtaining another fresh challenge. Used the library authenticator's previous-window code, accepted by the real verifier, to avoid the prior reservation.
- Result: HTTP **500**, no additional approved session, digest still visible from the independent connection. After closing both connections and reopening the database, the digest remained present.
- This establishes committed reservation survival across an actual session insertion failure and database reopen. **Not tested:** process kill/power loss, full auth-process restart with persisted digest key, expiry cleanup, or later replay rejection after such a restart. A production key must persist securely; this fixture key did not.
- Only the digest claim is atomic. Challenge consumption, reservation and library session insertion are **not** one transaction. Failures deliberately burn the claim/challenge without granting access; product error mapping and recovery guidance remain unimplemented.

## Limits and disposition

No blocker found for the narrowly tested exact-pin hook/migration design on this runtime. This does not prove the minimum supported Node 22 runtime, browser/TLS cookie behavior, input/route/Origin boundary, private IPC, rate limiting, bootstrap exclusivity, recovery interruption safety, enrollment intermediate-update faults, revocation/SSE, or deployed isolation.
The owner mismatch test changed the configured owner ID against a real valid challenge; it did not provision/enroll a second account.
The replay policy remains proposed application policy, not a built-in Better Auth one-use TOTP guarantee. No authorization is derived solely from the user's enrollment flag.
All fixture connections were closed; the owned temporary project, dependencies, harness, logs and synthetic database were removed. No fixture processes/listeners were left running. Only this research note was added to the repository.

## Primary implementation sources exercised

Published Better Auth **1.7.7**: `dist/db/get-migration.mjs`, `dist/db/with-hooks.mjs`, `dist/db/internal-adapter.mjs`, `dist/plugins/two-factor/totp/index.mjs`, `dist/plugins/two-factor/verify-two-factor.mjs`, `dist/plugins/two-factor/backup-codes/index.mjs`.
Published `@better-auth/utils` **0.4.2**: `dist/otp.mjs`; see [pinned source review](native-auth-library.md) and [pending design](context/plans/active/0003-native-owner-auth.md).
