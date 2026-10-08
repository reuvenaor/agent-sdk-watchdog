# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may
break the API.

## [Unreleased]

## [0.2.0] - 2026-10-08

### Added

- `handle.settle()`, and `observe()` of a `result`, settle a query: the idle policy stops until
  a tool boundary or a stream frame shows new work. A `rate_limit_event` does not end it. The
  hard ceiling still applies. `WatchdogTimeline` has an optional `settled` field.

### Changed

- Peer dependency `@anthropic-ai/claude-agent-sdk` is now `>=0.3.280 <0.4.0`. Since SDK 0.3.284,
  a query with hooks waits after its `result` for `session_state_changed: idle`, for up to 10
  minutes. Before this release, the watchdog could kill a query during that wait, with its
  result already in hand. CI now also tests SDK 0.3.293.
- `observe()` of a `result` no longer leaves the idle clock running.

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

[Unreleased]: https://github.com/reuvenaor/agent-sdk-watchdog/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/reuvenaor/agent-sdk-watchdog/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/reuvenaor/agent-sdk-watchdog/releases/tag/v0.1.0
