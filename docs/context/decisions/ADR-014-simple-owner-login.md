# ADR-014 — Simple login for independently installed Cogitator

Status: accepted, 2026-11-07. Supersedes the mandatory-MFA product policy in ADR-009/Plan 0003, preserving their session, transport and secret boundaries.

The owner explicitly requested email/password login without mandatory setup keys or authenticator enrollment, and clarified that each person installs their own Cogitator. This is not a shared hosted multi-user registration product.

- New protected installations default to `authentication: "password"`. The owner's password is still verified by the pinned Better Auth library. No factor/setup capability is required, and password sessions have the normal 24-hour lifetime without claiming that MFA occurred.
- MFA remains an explicit option (`auth init --mfa`, or offline `auth mode mfa`). Configurations predating this policy, without the new field, retain MFA rather than silently downgrading. Unknown policy values fail closed.
- Offline `auth mode password` preserves the existing owner and password while revoking sessions, clearing pending/verified factors and retiring setup capabilities. The switch never blesses old enrollment sessions. Maintenance remains on if any stage fails.
- Owner-only identity, HTTPS/Secure cookies, exact Host/Origin/JSON boundaries, persistent throttles, fresh database checks, expiry/revocation and the absence of public signup/reset routes remain in force.
- The UI shows email/password for the default flow and hides authenticator/recovery-code instructions and controls when the server declares password mode. Existing MFA installations retain those controls.
- This change does not certify remote worker integration or remove deployment execution gates.

Verification includes real-library password login, rejected credentials, 24-hour session expiry, logout/revocation, forged cookies, cross-origin writes, unavailable MFA/signup routes, default/legacy/unknown policies and fault-injected offline migration preserving owner/password while clearing an abandoned enrollment.
