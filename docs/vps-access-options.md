# Historical VPS access research: Authelia option

**Superseded on 2026-10-10:** [native product-owned authentication](context/plans/active/0003-native-owner-auth.md) is now the confirmed direction. Firetower provisioning and the administrator inventory are suspended. The research below records the former alternative, not a current requirement or request to configure an IdP.

Historical research note, not implementation, deployment instructions, or security certification.
Scope: one owner, selected Firetower VPS, no purchased domain or previously designated IdP. Later inspection found existing Authelia routing for AionUI; assess that service before choosing whether a new instance is necessary.
Baseline: [approved plan 0002](context/plans/active/0002-secure-vps-durable.md), especially its access boundary and P1 gates.
Official documentation below describes available behavior, not behavior verified on this VPS; pin versions and recheck during P1.

## Discovery after initial research

Read-only inspection of the existing Caddy routing found the `/authelia` portal and `/api/authz/forward-auth` proxy targeting loopback port 9091. That port is occupied and must not be repurposed. OIDC discovery at the existing public prefix returned HTTP 404 and public configuration returned HTTP 403; neither response proves the effective OIDC/MFA configuration. No privileged configuration or user database was inspected.

The then-proposed next step was the [administrator inventory](vps-access-setup.md), without service changes or credentials in chat; that handoff is now suspended. Prefer safe reuse if the existing service meets the required client policy; a fresh-service draft is not shipped/deployed before this assessment. The facts below remain relevant to either an explicitly approved extension or a separate service, not an instruction to duplicate the current IdP.

## Former recommendation and plan boundary

**Proposal:** retain Caddy → oauth2-proxy → loopback Cogitator, with a separate Authelia OIDC service requiring two factors for this client.
Use one file-backed owner, Authelia SQLite storage, and in-memory Authelia sessions; no Redis or external SQL server is necessary for this single-instance design [1–3].
Keep Authelia state separate from Cogitator; isolate its user file, signing keys, encryption key and database from workers, and include them in protected backup/restore procedures.
The owner had approved this access-preparation choice before confirming the replacement native-auth direction in Plan 0003/ADR-009. It is retained here only as historical context.
Authelia is not homemade authentication, but hosting the IdP ourselves adds credential, MFA-enrollment, recovery and signing-key operations. Approval is not verification: this note does not certify the resulting configuration or authorize public application enablement before the remaining gates.
Do not replace oauth2-proxy plus backend token checks with Authelia forward-auth alone.

## Official facts: small deployment and enrollment

- SQLite is supported, but its local database prevents multiple Authelia instances; upstream recommends an external database in production [1]. Choosing SQLite here is a deliberate single-instance trade-off, not upstream's preferred production topology.
- Memory is the default session provider; Redis is an alternative, primarily relevant to shared/stateless sessions [2]. Memory sessions are not durable across process loss; persistent identity/MFA data belongs in storage, not the session cache.
- The file authentication backend supports a local user database and password hashing, including Argon2id [3]. This avoids LDAP, not the responsibility to protect password hashes and maintain the account.
- Exactly one notifier must be configured: SMTP or filesystem [4]. Filesystem notifications contain plaintext email content and are explicitly recommended only for testing, not production [5]. “No mail service, read enrollment codes from a server file” is therefore not the recommended operating default.
- SMTP supports authenticated delivery and TLS controls [6]. An existing mail provider/relay can supply delivery; running a mail server or buying a domain is not intrinsically required by this architecture. Sender authorization and successful delivery still need validation.
- Privileged account actions use an elevated-session one-time-code process. `require_second_factor` can require an existing second factor for elevation, but users without one still use the code process for bootstrap [7]. This setting is **not** the OIDC client's MFA enforcement policy.

**Human setup:** with self-hosting approved, choose reachable HTTPS issuer/application names and an authorized SMTP sender; supply a real owner mailbox; create the sole owner/password through a private setup workflow; receive the enrollment code and register an authenticator (initially password + TOTP); test a fresh-browser login and deliberately wrong/password-only logins.
The owner must retain access to the authenticator/mailbox and establish a tested lost-factor recovery procedure with authenticated operator access. Do not assume enrollment, backup codes, or recovery are automatic.
Configure enrollment visibility/elevation deliberately: the elevated-session documentation explains how its second-factor options make registration available even without a `two_factor` access-control rule [7].
Mail is an enrollment/recovery dependency, not the proposed second factor for ordinary login.

## Official facts: mandatory MFA and backend evidence

- An OIDC client's `authorization_policy` supports `two_factor` (also the documented default). It is distinct from reverse-proxy access-control rules and applies to **authorization requests** [8]. Set it explicitly; MFA capability or optional enrollment alone is insufficient.
- Authelia documents RFC 8176 `amr` in ID tokens [9]. Its values include `mfa` for multiple factors, `pwd` for password, and `otp` for TOTP [10]. These are usable evidence, not a universal `acr` assurance contract.
- Current claims documentation warns that many claims are no longer automatically included in ID tokens; scope requests may expose claims only through UserInfo [9]. Demonstrate actual `amr` and other required claims for the pinned version/client, configuring claim requests/policy as necessary; do not assume scope names guarantee token contents.
- oauth2-proxy documents `--pass-authorization-header` as forwarding the OIDC **ID token** in upstream `Authorization: Bearer`; `--set-authorization-header` is a response-header option for auth-request integrations [11]. An access token or email header is not a substitute.

**Proposed fail-closed contract:** use oauth2-proxy as the upstream reverse proxy behind Caddy and demonstrate the exact ID-token path. Strip client-supplied identity headers; verify signature/JWKS, issuer, audience, expiry and pinned owner subject in Cogitator with a maintained library.
For the initial password + TOTP profile, require verified `amr` containing `mfa`, `pwd` and `otp`; absent or unexpected evidence denies access. Supporting other factors later requires an explicit, tested claim policy, not a silent relaxation.
Require explicit client-policy evidence **and** a fresh password-only negative test. Valid MFA claims attest an authentication event, not a currently unrevoked session or recent second-factor challenge.
Refresh behavior, authentication age, key-cache limits, logout and owner revocation must be tested separately. The plan's ≤60-second REST/SSE revocation boundary is **not established** by a valid JWT, short cookie refresh, or OIDC `two_factor` alone; implement and prove a suitable revocation/revalidation mechanism before exposure.

## Environment evidence and remaining blockers

The following are supplied inspection findings, **not official documentation and not independently checked by this note**: Caddy already serves an `sslip.io` hostname; the candidate hostname resolves to the selected VPS. No actual hostname or address is recorded here.
Reusing that hostname may avoid a domain purchase, but a stable HTTPS issuer URL, callback URL, Authelia portal routing and cookie scope still need design and live validation; DNS resolution alone proves none of these.
The supplied inspection also reports root-owned Caddy configuration, password-required sudo and denied root SSH using the existing key. An authorized operator must perform privileged setup; no bypass is proposed.

Before enabling application access: resolve operator access; choose issuer/client/owner identity and portal routing; arrange SMTP/enrollment/recovery; pin versions; then pass P1's full token/MFA/header, wrong-owner, direct-port, outage, logout and revocation tests.
No managed alternative is recommended here: current free mandatory-MFA entitlements were not researched or verified.
No VPS access, provisioning, credentials, or configuration changes were performed for this note.

## Primary sources

1. Authelia SQLite: https://www.authelia.com/configuration/storage/sqlite/
2. Authelia sessions: https://www.authelia.com/configuration/session/introduction/
3. Authelia file users: https://www.authelia.com/configuration/first-factor/file/
4. Authelia notifier requirement: https://www.authelia.com/configuration/notifications/introduction/
5. Authelia filesystem notifier: https://www.authelia.com/configuration/notifications/file/
6. Authelia SMTP: https://www.authelia.com/configuration/notifications/smtp/
7. Authelia enrollment/elevation: https://www.authelia.com/configuration/identity-validation/elevated-session/
8. Authelia OIDC client policy: https://www.authelia.com/configuration/identity-providers/openid-connect/clients/#authorization_policy
9. Authelia OIDC claims: https://www.authelia.com/integration/openid-connect/openid-connect-1.0-claims/
10. Authelia authentication-method references: https://www.authelia.com/reference/guides/authentication-method-references/
11. oauth2-proxy configuration/header options: https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/
