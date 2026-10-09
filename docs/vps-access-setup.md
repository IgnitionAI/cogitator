# VPS access: first admin inventory gate

Do not install another identity provider yet. Read-only source evidence shows Caddy routes `/authelia` and `/authelia/*` to `localhost:9091` and uses `/api/authz/forward-auth`. This is routing evidence, not proof that authentication, MFA or OIDC works. The existing AionUI application must remain untouched.

There is currently no administrator SSH access available to the agent. This one-shot inventory is for the VPS owner to run locally as root; it is not an installer, configuration wizard or approval to change the VPS. Reuse versus a fresh deployment is a **later decision**. Reuse is permitted only after assessing existing ownership, OIDC capability and client isolation, MFA enforcement, and isolation from AionUI and other consumers.

## Owner execution

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
- For an official Authelia image with exactly one `/config` bind mount, optional default `configuration.yml` and `configuration.yaml` declarations. Only bounded regular files without symlink components are read. Already-installed PyYAML `safe_load` is optional; no parser or inaccessible/invalid files means unknown. Named volumes, alternative filenames, custom images and native configuration are not searched.
- The candidate projection contains only declared authentication backend enum, default policy enum, notifier kind, OIDC section presence/client count/policy counts, and up to 33 validated cookie domains. Dynamic/invalid policy and domain values are not echoed. Passwords, SMTP addresses/users, client IDs/secrets, keys and user database contents are never reported; user databases are never opened.

**Candidate-file evidence is not effective configuration.** Flags and environment overrides are deliberately not inspected. Both default filenames may exist and are reported independently; the script does not choose precedence. Missing OIDC in a candidate does not prove runtime absence; a declared two-factor policy does not prove MFA enrollment/enforcement or successful OIDC authentication. Empty domain output means no validated declared domain was found, not that the runtime has no domains.

Review output locally before sharing: even allowed metadata can expose infrastructure names and host paths. Do not paste secrets, configuration files or user databases into chat. Follow-up owner assessment must establish ownership, version/support, actual OIDC flow and MFA enforcement, session/cookie boundaries and safe client isolation without changing AionUI. Do not deploy a replacement or modify the existing IdP based solely on this inventory.

## Local checks

```sh
python3 -I scripts/vps-access/test_inspect.py
```

Seven stdlib tests use a fake command runner and temporary synthetic config data. They require no Docker, administrator access, PyYAML, network access or VPS changes.
