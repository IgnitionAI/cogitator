# Historical VPS identity inventory (suspended)

**Superseded on 2026-10-10:** the owner confirmed [native Cogitator login/MFA](context/plans/active/0003-native-owner-auth.md), independent of Firetower/Authelia. Do not execute the staged administrator handoff or perform further host changes. The procedure below is retained as historical evidence, not a current action or native-auth prerequisite.

At the earlier checkpoint, the instruction was not to install another identity provider yet. Read-only source evidence shows Caddy routes `/authelia` and `/authelia/*` to `localhost:9091` and uses `/api/authz/forward-auth`. This is routing evidence, not proof that authentication, MFA or OIDC works. The existing AionUI application must remain untouched.

At that checkpoint, no administrator SSH access was available to the agent. The now-suspended one-shot inventory was intended for the VPS owner to run locally as root; it is not an installer, configuration wizard or approval to change the VPS. Reuse versus a fresh deployment is a **later decision**. Reuse is permitted only after assessing existing ownership, OIDC capability and client isolation, MFA enforcement, and isolation from AionUI and other consumers.

## Historical owner procedure (not currently authorized)

Receive `inspect.py` and its **known SHA256 from the trusted handoff**, separately from the uploaded copy. Do not calculate the expected hash from the uploaded file. No credentials are requested. Review the script before running it.

The commands below are owner actions, not commands for the agent to execute remotely. Replace both placeholders. Use a new root-owned staging directory; if it already exists, stop and inspect it instead of reusing it blindly. Copying this inventory script is the only staging change; the inspector itself is read-only.

```sh
sudo mkdir -m 0700 /root/cogitator-inventory &&
sudo install -o root -g root -m 0600 /PATH/TO/UPLOADED/inspect.py /root/cogitator-inventory/inspect.py &&
sudo sh -c 'printf "%s  %s\n" "TRUSTED_KNOWN_SHA256" /root/cogitator-inventory/inspect.py | /usr/bin/sha256sum --check --status && /usr/bin/python3 -I /root/cogitator-inventory/inspect.py'
```

A hash mismatch prevents execution. Use a trusted system Python installation. The script requires Linux and root, fixes executable paths and a clean subprocess environment, and pins Docker to `/var/run/docker.sock` with an inert `/proc/self` configuration directory (no remote context). Every subprocess has a 15-second timeout. Missing binaries, socket access failures and unsupported metadata are reported as unknown, without stderr. Nothing is installed, pulled, restarted or executed inside containers.

## What it reports

- Docker container ID/name/image/ports for actual official Authelia image references or candidates publishing host port 9091. A port collision is explicitly **not proof of Authelia**. Stopped containers are included; presence does not establish service health.
- Selected inspect metadata only: ID, image reference/config digest, configured user, read-only root filesystem, capabilities/security options, port bindings and mount source/destination/type/read-only. No environment, commands, arguments, labels or full inspect dump is requested.
- Loaded `authelia*.service` unit metadata: unit ID, user, active state, main PID and fragment path. This is not exhaustive discovery of custom-named or unloaded native services; no `ExecStart` or environment is queried.
- **No service configuration files or user databases are opened, parsed or reported.** The initial optional YAML projection was removed after review: a byte limit does not bound YAML construction cost. The inventory needs no YAML parser or additional dependency. Passwords, SMTP addresses/users, client IDs/secrets and signing keys are not queried.

**Metadata is not effective configuration.** Image references are not provenance verification, and mount paths are only locators for the administrator. Flags, environment overrides, authentication policies, owner identity and configuration contents are deliberately not inspected. MFA and OIDC remain explicitly unproven; absence of a matching image/unit is not proof that no identity service exists.

Review output locally before sharing: even allowed metadata can expose infrastructure names and host paths. Do not paste secrets, configuration files or user databases into chat. Follow-up owner assessment must establish ownership, version/support, actual OIDC flow and MFA enforcement, session/cookie boundaries and safe client isolation without changing AionUI. Do not deploy a replacement or modify the existing IdP based solely on this inventory.

## Verified handoff checkpoint

The metadata-only implementation at `58c06bc` was independently reviewed on Standards and Spec axes. A YAML resource-amplification concern was resolved by removing configuration parsing entirely; neither re-review identified a remaining blocking local defect.

Historical checkpoint checks: five focused tests passed; application build and 105/105 application tests passed. The actual Docker `ps`/`inspect` templates and pinned-image-reference classification were exercised against one disposable, network-disabled local container; native systemd was not exercised in that fixture. An initial removal assertion raced Docker's asynchronous `--rm`; the verification was rerun with bounded waiting and confirmed removal. This is not target-host/root or authentication proof.

The reviewed script was staged under the selected VPS's unprivileged account (private directory 0700, file 0600). Its remote SHA256 matched the local artifact. An actual unprivileged Linux invocation returned `requires_linux_root` with exit 1 as expected, without scanning privileged metadata. Existing Caddy configuration hash was unchanged across staging and Caddy remained active. No IdP installation, service restart, application route or credential change was performed.

Trusted reviewed inspector SHA256:

```text
e015e67ff91f053cff89788bd47e8f9bd21fcdcbe7dc4e7afb0e1fa47a56c120
```

The former handoff required a separately verified upload path and a root-owned checked copy. That handoff is now suspended; the staged artifact remains inert. **Admin inventory execution, effective configuration, OIDC/MFA, public Cogitator access and P1–P5 remain NOT PROVEN.** The tracking issue remains open.

## Local checks

```sh
python3 -I scripts/vps-access/test_inspect.py
```

Five stdlib tests use a fake command runner, including a pinned image reference, unexpected metadata, credential sentinels, root/platform gates and timeout/error handling. A mounted synthetic YAML fixture must not be opened at all. Tests require no Docker, administrator access, YAML parser, network access or VPS changes. Subprocess output is captured before the accepted-size check; this is not a hard peak-memory bound and is intended for small local inventories.
