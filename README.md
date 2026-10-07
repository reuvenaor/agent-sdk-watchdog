# agent-sdk-watchdog

[![npm version](https://img.shields.io/npm/v/agent-sdk-watchdog)](https://www.npmjs.com/package/agent-sdk-watchdog)
[![CI](https://github.com/reuvenaor/agent-sdk-watchdog/actions/workflows/ci.yml/badge.svg)](https://github.com/reuvenaor/agent-sdk-watchdog/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/reuvenaor/agent-sdk-watchdog/badge)](https://scorecard.dev/viewer/?uri=github.com/reuvenaor/agent-sdk-watchdog)
[![License](https://img.shields.io/github/license/reuvenaor/agent-sdk-watchdog)](LICENSE)
[![Node](https://img.shields.io/node/v/agent-sdk-watchdog)](package.json)

Liveness helpers for [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
`query()` sessions: three small modules for "the `query()` that always returns".

- an **idle watchdog** that aborts a query that stops moving;
- a **rate-limit monitor** that merges the usage readings into one;
- an **SDK warning filter** that shows one known SDK warning once instead of every time.

The structured-output ladder is the separate
[`agent-sdk-recovery`](https://github.com/reuvenaor/agent-sdk-recovery) package.

A community project, not affiliated with, endorsed by or sponsored by Anthropic. "Claude" is a
trademark of Anthropic, PBC, and is named here only to say which SDK these helpers work with.
Your use of the SDK itself is governed by
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).

**The package prints nothing.** When a module has something to report, it calls your callback
or returns a value, and you decide what to print.

## Contents

- [Install](#install)
- [Compatibility](#compatibility)
- [Quick start](#quick-start)
- [Idle watchdog: `createWatchdog(config?)`](#idle-watchdog-createwatchdogconfig)
- [Rate-limit monitor: `createRateLimitMonitor(config?)`](#rate-limit-monitor-createratelimitmonitorconfig)
- [SDK warning filter: `installSdkWarningFilter(options?)`](#sdk-warning-filter-installsdkwarningfilteroptions)
- [Good to know](#good-to-know)
- [Why](#why)
- [Dependencies](#dependencies)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install agent-sdk-watchdog @anthropic-ai/claude-agent-sdk@0.3.283
```

## Compatibility

| Needs                            | Version                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Node                             | 22.12 or later. The package is ESM only; CommonJS code can `require()` it on 22.12+. |
| TypeScript                       | 5.4 or later.                                                                        |
| Module resolution                | `node16`, `nodenext` or `bundler`. The old `node10` (`"node"`) cannot resolve it.    |
| `@anthropic-ai/claude-agent-sdk` | `>=0.3.280 <0.3.284`, as a peer. CI tests both ends of the range.                    |

**Why the SDK range stops at 0.3.283.** Since SDK 0.3.284, a query with hooks, `canUseTool` or
SDK MCP servers waits after its result for the session to go idle, for up to 10 minutes. The
watchdog has not been checked against that wait yet. The range opens in a later release, once
it has.

## Quick start

A pump that wires all three modules:

```ts
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import {
  createRateLimitMonitor,
  createWatchdog,
  formatRateLimitReading,
  installSdkWarningFilter,
  makeWatchdogHook,
} from 'agent-sdk-watchdog'

// One of each for the whole process, shared by every query.
const rateLimits = createRateLimitMonitor()
const watchdog = createWatchdog({
  getUtilization: (now) => rateLimits.active(now)?.utilization ?? null,
})
installSdkWarningFilter({
  onFirst: (_warning, code) => console.warn(`${code}: expected, shown once`),
})

export async function run(prompt: string, options: Options, label: string): Promise<void> {
  const abortController = new AbortController()
  const handle = watchdog.register({
    hardCeilingMs: 60 * 60 * 1000,
    abortController,
    onKill: (kill) => console.warn(`${label}: watchdog ${kill.kind}`),
  })
  // Every tool boundary of this query feeds its own handle.
  const feed = { hooks: [makeWatchdogHook(handle)] }
  const hooks = options.hooks ?? {}
  try {
    const q = query({
      prompt,
      options: {
        ...options,
        abortController,
        includePartialMessages: true, // stream events keep the idle clock moving
        hooks: {
          ...hooks,
          PreToolUse: [...(hooks.PreToolUse ?? []), feed],
          PostToolUse: [...(hooks.PostToolUse ?? []), feed],
          PostToolUseFailure: [...(hooks.PostToolUseFailure ?? []), feed],
        },
      },
    })
    for await (const message of q) {
      handle.observe(message)
      const crossed = rateLimits.observe(message)
      if (crossed) console.warn(`usage window high: ${formatRateLimitReading(crossed)}`)
    }
  } catch (err) {
    // A kill reaches the loop as the abort's error; `kill` says the watchdog caused it.
    const kill = handle.kill
    if (kill) throw new Error(`${label}: stopped by the watchdog (${kill.kind})`, { cause: err })
    throw err
  } finally {
    handle.unregister()
  }
}
```

## Idle watchdog: `createWatchdog(config?)`

A watchdog supervises every query you register with it, on one shared timer. It kills a query
that shows no activity of any kind for `idleMs`. Patience grows to `idleMs × extendFactor`
before the query's first completed write, since reading and planning are quiet, and while the
usage window is at or above `highUtilization`, since the provider then paces its answers. Each
query also has a hard ceiling on its age, active or not.

| Option            | Default             | What it changes                                                                         |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `idleMs`          | `600000` (10 min)   | Base idle patience, in ms. Must be > 0.                                                 |
| `extendFactor`    | `2`                 | How many times `idleMs` a query gets while an extension holds. Must be >= 1.            |
| `highUtilization` | `0.9`               | Usage (0 to 1) at or above which patience is extended.                                  |
| `tickMs`          | `30000` (30 s)      | How often the shared timer checks every query, in ms. Must be > 0.                      |
| `writeTools`      | `['Write', 'Edit']` | The tools whose first completed call ends the pre-write extension.                      |
| `toolHeartbeats`  | `true`              | Whether `observe()` counts a `tool_progress` frame as activity. See **Good to know**.   |
| `getUtilization`  | `() => null`        | The usage at a tick, or `null` when unknown. Wire it to a rate-limit monitor, as above. |
| `now`             | `Date.now`          | The clock for every method you call without a time.                                     |
| `onError`         | drops the error     | Gets an error that `onKill`, `onExtend` or `getUtilization` threw.                      |

`WATCHDOG_DEFAULTS` holds the defaults. An option you pass as `undefined` keeps its default. A
value out of range throws a `RangeError`, for example `idleMs must be a number > 0, got -1`.

The watchdog has four members:

- `register({ hardCeilingMs, abortController, onKill?, onExtend? })` starts supervising one
  query and returns its handle. The timer runs while any query is registered, and it never
  keeps the process alive.
- `tick(now?)` runs one check by hand and returns the kills it made. Tests use it.
- `close()` stops the timer and forgets every query.
- `config` is the resolved options.

On a kill, the watchdog calls `onKill({ kind, elapsedMs, sinceToolMs })` once, with `kind`
`'watchdog_idle'` or `'hard_ceiling'`. Then it aborts `abortController`, even when `onKill`
throws, so pass the same controller to `query()`. `onExtend(reason, utilization)` runs once,
the first time patience is extended, with `reason` `'pre_write'` or `'high_utilization'`.

Feed each handle from its own query only, so parallel queries keep separate clocks:

- `makeWatchdogHook(handle)` is a hook for `PreToolUse`, `PostToolUse` and
  `PostToolUseFailure`. Only `PostToolUse` passes the tool name, so a write that a hook denied
  does not end the pre-write extension.
- `handle.observe(message)` takes every SDK message. Stream events, `system/thinking_tokens`
  frames and `rate_limit_event`s count as activity, and so do `tool_progress` frames when
  `toolHeartbeats` is on. A thinking model streams, so it is never killed as idle. Stream
  events need `includePartialMessages: true`.
- `handle.activity(toolName?)`, `handle.stream()` and `handle.heartbeat()` do the same by hand.
- `handle.kill` holds the kill, or `null`, and stays readable after `unregister()`.
- `handle.unregister()`: call it when the query ends.

## Rate-limit monitor: `createRateLimitMonitor(config?)`

Merges each `rate_limit_event` into one reading, because no payload shape carries both the
utilization and the overage status. A reading is the SDK's `SDKRateLimitInfo`. An `allowed`
frame carries its utilization only in a per-window `unifiedWindows` map that the type does not
declare, so the monitor reads that map at run time.

| Option           | Default       | What it changes                                                                                    |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `warnAt`         | `0.85`        | Usage (0 to 1) at which `observe` and `note` return the reading, once, so you can print a warning. |
| `fallbackWindow` | `'five_hour'` | The window read when a reading has no top-level utilization and names no window.                   |
| `now`            | `Date.now`    | The clock `active()` reads when you pass no time.                                                  |

`RATE_LIMIT_DEFAULTS` holds the defaults; `warnAt` outside 0 to 1 throws a `RangeError`.

- `observe(message)` folds a `rate_limit_event` into the reading; any other message changes
  nothing. It returns the merged reading the first time utilization reaches `warnAt`, and
  `null` every other time.
- `note(info)` does the same for a bare `SDKRateLimitInfo`.
- `active(now?)` gives the reading, or `null` once its `resetsAt` has passed. Use it for
  decisions.
- `latest()` gives the reading, stale or not. Use it for display.
- `reset()` forgets the reading and arms the warning again.

`formatRateLimitReading(reading)` renders one line, and `rateLimitResetIso(reading)` gives the
reset time as an ISO string, or `null`.

## SDK warning filter: `installSdkWarningFilter(options?)`

The SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` on every `query()` that passes `canUseTool`
beside bare MCP tool names in `allowedTools`. When that combination is on purpose, the warning
repeats on every query. The filter swallows the warnings whose code is in `codes`, and calls
`onFirst(warning, code)` with the first one of each code. Every other warning reaches Node
untouched.

| Option    | Default                                                  | What it changes                                                               |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `codes`   | `['CLAUDE_SDK_CAN_USE_TOOL_SHADOWED']` (`SHADOWED_CODE`) | The warning codes to swallow.                                                 |
| `onFirst` | does nothing                                             | Called with the first warning of each code, and the code. A throw is dropped. |

`WARNING_FILTER_DEFAULTS` holds the defaults. The call returns `true` when it installed the
filter. A later call changes nothing and returns `false`: its options never apply.

## Good to know

- **Auth scope.** The rate-limit readings are claude.ai plan limits. The SDK documents
  `SDKRateLimitInfo` as "rate limit information for claude.ai subscription users". Its
  experimental `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` returns
  `rate_limits_available: false` and `rate_limits: null` for API-key, Bedrock and Vertex
  sessions. Under those logins, expect no utilization: the monitor never warns, and the
  watchdog's high-utilization rule never applies (its idle and pre-write rules still work).
  Anthropic does not let third-party products offer claude.ai login or rate limits, or route
  requests through a user's subscription
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
  [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). A product you
  build for other people uses API-key auth, where the monitor stays idle. It is for sessions
  you run under your own subscription.
- **Tool heartbeats and in-process MCP servers.** While a tool call runs, the CLI sends a
  `tool_progress` heartbeat every 30 seconds. With `toolHeartbeats: true`, the default, a long
  tool call is never killed as idle. The cost: a tool call that hangs sends heartbeats too, so
  only `hardCeilingMs` stops it. For a stdio or HTTP MCP server, the CLI's own
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` still aborts a stalled call, but it does not apply to
  in-process SDK servers (`createSdkMcpServer`). If your queries use in-process servers, think
  about `toolHeartbeats: false`: a tool call then must finish within the idle patience.

- **Instances, and one process-wide exception.** Watchdogs and monitors are separate
  instances: two monitors keep two readings, and two watchdogs run two timers. The warning
  filter is the exception. It patches `process.emitWarning` once per process, and every copy
  of the package shares that patch. If you need no callback, Node can hide the warning with
  no code at all:
  [`--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`](https://nodejs.org/api/cli.html#--disable-warningcode-or-type),
  on the command line or in `NODE_OPTIONS`.

## Why

The SDK repo has open reports of a `query()` iterator that never ends or never yields its
`result`: [#403](https://github.com/anthropics/claude-agent-sdk-typescript/issues/403) (after a
`rate_limit_event`), [#333](https://github.com/anthropics/claude-agent-sdk-typescript/issues/333)
(after the final tool result),
[#339](https://github.com/anthropics/claude-agent-sdk-typescript/issues/339) (after a subagent)
and [#427](https://github.com/anthropics/claude-agent-sdk-typescript/issues/427)
(`error_max_turns` never arrives). The watchdog turns each of those into an abort you can see.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` (peer, required): the `.d.ts` files use its types. The
  package imports it as types only, so the runtime never loads it.

Nothing else.

## Security

Please do not report a vulnerability in a public issue. Use
[private vulnerability reporting](https://github.com/reuvenaor/agent-sdk-watchdog/security/advisories/new)
or email info@reuvenaor.com. [SECURITY.md](SECURITY.md) has the details.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the setup,
the checks and the commit style. Everyone who takes part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE) © Reuven Naor
