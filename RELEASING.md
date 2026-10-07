# Releasing

How a new version of `agent-sdk-watchdog` reaches npm. Only a maintainer can do this.

## Prepare the release

1. On `main`, move the entries under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to a new
   `## [x.y.z] - YYYY-MM-DD` section, and update the link lines at the end of the file.
2. Set the version: `npm version x.y.z --no-git-tag-version`.
3. Merge these changes to `main` through a pull request.

Semantic Versioning applies. Before 1.0.0, a minor version may break the API.

## Publish from your machine (0.1.0)

The first release is published by hand:

```bash
npm login            # once; use an npm account with two-factor authentication on
npm publish          # runs npm run verify first and publishes nothing if it fails
```

Then tag the release commit and create the GitHub Release with that version's CHANGELOG
section. `gh release create vx.y.z --notes-file <file>` does both.

## Publish from GitHub Actions (later versions)

The `release` workflow publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
and provenance, so no npm token is stored anywhere. Set it up once:

1. On npmjs.com, open the package, then **Settings → Trusted publisher → GitHub Actions**.
2. Enter the owner `reuvenaor`, the repository `agent-sdk-watchdog` and the workflow `release.yml`. Leave
   the environment empty.

After that, to release:

1. Prepare the release as above.
2. In the **Actions** tab, run the **release** workflow on `main`.

The workflow runs `npm run verify`, stops if the tag `v<version>` exists already, publishes with
provenance, then pushes the tag and creates the GitHub Release from the CHANGELOG section. It runs
only when started by hand, never on a tag push.
