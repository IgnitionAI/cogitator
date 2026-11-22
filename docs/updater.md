# One-click updates on a VPS (cogitator-updater)

On a VPS where Cogitator runs as a **systemd service** from `/opt/cogitator/current` (see the [VPS guide](vps.md)), the release is owned by root on purpose: an agent running under the service account cannot change Cogitator's code. `cogitator-updater` keeps that protection and still lets you update from the **Updates** dialog.

```
Cogitator (service account) ──writes {version}──▶ /var/lib/cogitator-updater/inbox/request.json
                                                   │  (systemd .path unit)
cogitator-updater (root, oneshot) ◀────────────────┘
  1. accepts only the latest version published on npm, newer than the active release
  2. npm pack  @ignitionai/cogitator@<version>      (registry integrity)
  3. new release /opt/cogitator/releases/npm-<version>, npm install --omit=dev (+ pi peers)
  4. npm audit signatures                            (registry signatures + provenance; fails closed)
  5. switch /opt/cogitator/current atomically, systemctl restart cogitator.service
  6. checks the new version is served (server.pid + /api/status); otherwise switches back and restarts
```

The service account can only **drop a request**. The request contains just a version number, and the updater accepts only the latest published release. Signatures are verified before anything is switched. If the new version does not answer within 90 seconds, the previous release is restored automatically.

## Install (once, as root)

From the active release:

```sh
sudo node /opt/cogitator/current/dist/src/updater/cogitator-updater.js install \
  --user cogitator --unit cogitator.service --home /var/lib/cogitator --port 5320
```

This command:

- copies the updater to `/usr/local/lib/cogitator-updater/cogitator-updater.mjs` (root-owned, outside Cogitator's code);
- writes `/etc/cogitator-updater.json`;
- creates `/var/lib/cogitator-updater`: `status.json` (readable) and `inbox/` (`root:cogitator 0730`: the service can drop a file but not list or read the folder);
- installs and enables `cogitator-updater.path` (it watches the inbox) and `cogitator-updater.service` (oneshot).

Options: `--releases /opt/cogitator/releases`, `--current /opt/cogitator/current`, `--state-dir /var/lib/cogitator-updater`, `--config /etc/cogitator-updater.json`.

No change to `cogitator.service` is needed. Cogitator detects the updater through `/var/lib/cogitator-updater`, or `COGITATOR_UPDATER_DIR` if you moved it. The **Updates** dialog then shows **Update to X and restart** with each step: download, install, switch, check.

## Use

1. Open **Updates**, then click **Update to X and restart**. If conversations are still working, Cogitator asks before interrupting them.
2. The page follows the steps and reloads on the new version. On failure, the dialog shows the reason. If the new release did not start, the dialog also reports that it returned to the previous version.

From a shell: `sudo node /usr/local/lib/cogitator-updater/cogitator-updater.mjs status` and `journalctl -u cogitator-updater.service`.

## Releases and rollback

- Releases built by the updater are named `npm-<version>`. The active release, the previous one and the most recent `npm-*` are kept, up to 3. Other releases, such as your source builds, are never deleted.
- Manual rollback stays the same: point `/opt/cogitator/current` back to a previous release and restart the service. Read the release notes first, because code rollback is not database rollback (see the [VPS guide](vps.md#updating-and-rollback)).

## Requirements and limits

- Outbound access to `registry.npmjs.org` and, for signature checks, `tuf-repo-cdn.sigstore.dev`. If a check fails, nothing is switched.
- `npm install` runs as root in the new release directory, with the same trust as a manual deployment of the published package. Only the published npm package is installed, never code from the request.
- Updating the updater itself: run `install` again from the new release.
- Uninstall: `sudo node /usr/local/lib/cogitator-updater/cogitator-updater.mjs uninstall`. Your releases are kept.
