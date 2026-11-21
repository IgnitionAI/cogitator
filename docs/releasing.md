# Releasing

Cogitator is published to npm as `@ignitionai/cogitator`. pi discovers it from npm through the `pi-package` keyword. The pi package page uses the published `README.md`, `CHANGELOG.md` and the `pi.image` from `package.json`. Publishing to npm is therefore what updates pi.

## One-time setup

On npmjs.com, open **@ignitionai/cogitator → Settings → Trusted publisher** and add:

- Provider: **GitHub Actions**
- Organization / user: `IgnitionAI`
- Repository: `cogitator`
- Workflow filename: `publish.yml`

No npm token is stored in GitHub. The workflow authenticates with OIDC and publishes with provenance.

## Each release

1. On `dev`, set `version` in `package.json` and date the matching `CHANGELOG.md` heading (`## [x.y.z] - YYYY-MM-DD`). Update `news.*` in `web/src/locales/screens.ts` (the in-app **What's new** dialog).
2. Merge to `dev` with a green `npm test`.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The **Publish to npm** workflow checks that the tag matches `package.json`. It skips versions that are already published, then runs `npm publish`, whose `prepublishOnly` builds and tests again.
5. Check `npm view @ignitionai/cogitator version`. Users update with `pi update` (or `pi install npm:@ignitionai/cogitator`), then restart the server from `/cogitator`.

You can rerun a failed publish from **Actions → Publish to npm → Run workflow** on the same tag.
