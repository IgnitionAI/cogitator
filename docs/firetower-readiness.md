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

## Owner choices still needed

- Canonical public hostname and DNS control.
- Off-host backup destination.
- Alert delivery channel.

The historical Authelia/root inventory handoff remains obsolete. Firetower selection does not reinstate that procedure or authorize changes to the existing identity service. The full remote product remains incomplete under [#7](https://github.com/IgnitionAI/cogitator/issues/7).
