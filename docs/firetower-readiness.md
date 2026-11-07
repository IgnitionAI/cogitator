# Firetower deployment readiness

Checkpoint: 2026-11-07. The owner selected **Firetower** for the VPS work. This is a readiness record, not a completed deployment or approval to change existing services.

## Observed on the target

Read-only SSH checks under the existing unprivileged account established:

| Check | Observation | Consequence |
| --- | --- | --- |
| Connectivity | SSH works; Linux host | Target can be inspected |
| Capacity inventory | 8 logical CPUs, about 16 GiB RAM, about 242 GiB free on `/` | Sizing inventory only; two-job load acceptance remains required |
| Node | `v20.19.2` | Below the application's `>=22.19.0` requirement |
| Host pi | `0.73.1` | Not the package's pinned pi 1.1.0 baseline; install/verify an isolated application runtime |
| Caddy | Active; ports 80/443 listening | Preserve existing routes and consumers |
| Backend port | No listener on 5320 | Available at inspection time; recheck before binding |
| Docker | Accessible daemon advertises AppArmor, seccomp and cgroup namespaces; no rootless security option | This daemon is not rootless-production evidence |
| User Docker service | Inactive under the inspected account; `rootlesskit` exists | A separate worker account and verified rootless transport still need provisioning |

No packages, services, firewall rules, reverse-proxy configuration or credentials were changed. No workload was dispatched on this host.

## Concrete next work

1. Provide an application-specific supported Node installation and the pinned pi dependencies. Preserve the host's existing Node/pi and the applications using them.
2. Prepare separate controller and worker accounts with private state, enrolled disposable workspaces and the execution limits in Plan 0002. Do not give the application the existing rootful Docker socket as a substitute for isolation.
3. Complete the immutable worker identity/lifecycle adapter ([#47](https://github.com/IgnitionAI/cogitator/issues/47)) and integrated recovery gates ([#17](https://github.com/IgnitionAI/cogitator/issues/17)). The adapter issue is separately in progress; avoid overlapping its implementation.
4. Complete scheduling reconciliation and backup/restore ([#18](https://github.com/IgnitionAI/cogitator/issues/18), [#19](https://github.com/IgnitionAI/cogitator/issues/19)). Local regression results do not establish restart or restore behavior on Firetower.
5. Bind the [deployment specification](deployment-spec.md) to the chosen HTTPS origin, bootstrap native owner authentication privately, then run the desktop/mobile, denial, resource, reboot, restore, alert and soak acceptance gates in [#20](https://github.com/IgnitionAI/cogitator/issues/20).

## Defaults selected after owner delegation — 2026-11-07

The owner delegated the remaining choices ("comme tu veux"). No further preference confirmation is required:

- **Hostname:** a dedicated `cogitator.<target-ip>.sslip.io` HTTPS origin. DNS resolution was checked against Firetower. The exact origin is kept in the private deployment bundle rather than committed here. No domain purchase or DNS-account change is needed.
- **Runtime:** isolated Node **26.13.0 LTS**, from the official release index checked on this date. Install it separately from host Node/pi; qualify the exact runtime before starting the application.
- **Backup destination:** a new, private Google Drive folder named **Cogitator — sauvegardes chiffrées**, created through the connected account and read back as not shared. No application data or credentials were uploaded. Default policy: coherent recovery sets encrypted with age **before** transfer, daily at **03:15 Europe/Paris**, seven daily and four weekly copies; decryption identity retained off-host and outside the backup folder. Unattended transfer, retention and restore acceptance remain to be implemented. A connector-accessible folder is not a daemon credential or a successful backup.
- **Alerts:** Codex notifications, with planned external health checks every 15 minutes for unavailable VPS, stalled recovery, needs-attention and backup failures. Monitor scheduling and actual notification delivery remain unconfigured; no automation was created to track deployment completion. A sleeping/offline Mac is not continuous external monitoring.

The private bundle lives under `~/.config/cogitator-deploy/firetower-*` (directory 0700, files 0600); `firetower-current-path.txt` identifies the current directory. It includes the decisions, protected service environment, systemd unit and separate maintenance/application Caddy drafts. The Caddy drafts were adapted successfully by Firetower's installed Caddy via stdin; this did not load configuration, request certificates or prove live HTTPS.

The existing `noosphere-backup.timer` and its Restic script were discovered without reading password contents or changing the job. An off-host destination was not established, so it was not reused or presented as off-host protection. The SSH account has no non-interactive sudo. Provisioning dedicated users, an isolated runtime/rootless workers, private owner bootstrap and the open product gates remain the deployment prerequisites. Existing services and ingress are unchanged.

The historical Authelia/root inventory handoff remains obsolete. Firetower selection does not reinstate that procedure or authorize changes to the existing identity service. The full remote product remains incomplete under [#7](https://github.com/IgnitionAI/cogitator/issues/7).
