# Contributing

Thank you for helping. Bug reports, fixes and documentation changes are all welcome. Everyone
who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

To report a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Before you start

- **A bug:** open an issue with the bug report form. A small script that shows the problem
  helps most.
- **A new feature or an API change:** open an issue first, so we can agree on the shape before
  you write code.
- **A typo or a small doc fix:** open a pull request directly.

## Set up

You need Node 22.12 or later. The repository's `.nvmrc` names Node 24, the version the release
uses.

```bash
git clone https://github.com/reuvenaor/agent-sdk-watchdog.git
cd agent-sdk-watchdog
npm ci
```

## Scripts

| Script                  | What it does                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`          | ESLint over `src/`, `test/` and `scripts/`.                                                                                                                               |
| `npm run format`        | Formats every file with Prettier. `npm run format:check` only checks.                                                                                                     |
| `npm run typecheck`     | `tsc --noEmit` over `src/`, `test/` and `scripts/`.                                                                                                                       |
| `npm test`              | Runs the test harnesses in `test/` with `tsx`.                                                                                                                            |
| `npm run build`         | Compiles `src/` to `dist/` (JavaScript, `.d.ts` files and source maps).                                                                                                   |
| `npm run check:package` | Builds and packs the package, runs publint and attw, then installs the tarball in an empty project, compiles a consumer and every `ts` block of the README, and loads it. |
| `npm run verify`        | `lint`, `format:check`, `typecheck`, `test` and `check:package`, in that order. CI runs it, and `npm publish` runs it first.                                              |

Run `npm run verify` before you open a pull request.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Make the change, with a test in `test/` for a bug fix or a new feature.
3. Update the README when the public API or its behavior changes.
4. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for a change users can see.
5. Run `npm run format` and `npm run verify`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>(<scope>): <short description>`, in the present tense. The types are `feat`, `fix`,
`docs`, `style`, `refactor`, `test` and `chore`. Example:
`fix(watchdog): keep the idle clock on a heartbeat`.

## Pull requests

- Open the pull request against `main` and fill in the template.
- CI must pass. It runs `npm run verify` and `npm audit signatures` on Node 22.12, 22 and 24,
  and a dependency review on changes to dependencies. The `ci-ok` check sums them up.
- A maintainer reviews the change. Pull requests are merged with squash, so the title becomes
  the commit message: write it as a Conventional Commit.

## License

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the license of this project.
