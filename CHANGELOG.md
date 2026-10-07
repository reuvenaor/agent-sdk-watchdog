# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may
break the API.

## [Unreleased]

## [0.1.0] - 2026-10-07

First release.

### Added

- `createWatchdog`: an idle watchdog for `query()` sessions. It kills a query with no activity
  for `idleMs`, extends patience before the first write and at high usage, and enforces a hard
  ceiling. `makeWatchdogHook` feeds it from the tool hooks.
- `createRateLimitMonitor`: merges the `rate_limit_event` readings into one, with a one-time
  warning at `warnAt`. `formatRateLimitReading` and `rateLimitResetIso` render a reading.
- `installSdkWarningFilter`: shows the first `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning once
  and swallows the rest.
- Peer dependency `@anthropic-ai/claude-agent-sdk` `>=0.3.280 <0.3.284`. SDK 0.3.284 added a
  wait after the result that the watchdog has not been checked against yet.
- The package is ESM only, for Node 22.12 or later.
  - TypeScript's `moduleResolution: "node10"` (the old `"node"`) cannot resolve it. Use
    `"node16"`, `"nodenext"` or `"bundler"`.
  - CommonJS code on Node 22.12 or later can `require()` it, because Node loads an ES module
    with no top-level `await` that way. `attw` still reports "ESM (dynamic import only)" for a
    CommonJS caller: its TypeScript version predates this Node feature.

[Unreleased]: https://github.com/reuvenaor/agent-sdk-watchdog/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/reuvenaor/agent-sdk-watchdog/releases/tag/v0.1.0
