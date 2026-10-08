#!/usr/bin/env tsx
/**
 * Watchdog harness: synthetic timelines on an injected clock — the pure policy
 * (`evaluateWatchdog`), one watchdog instance per case (`createWatchdog`, its handles,
 * `tick`), every option, and the tool hook. $0, no LLM; one case runs the real timer.
 *
 * Standalone: `npx tsx test/check-watchdog.ts`. Exits non-zero on mismatch.
 */
import type { HookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createRateLimitMonitor, type RateLimitMonitor } from '../src/rate-limit-monitor.js'
import {
  createWatchdog,
  evaluateWatchdog,
  makeWatchdogHook,
  WATCHDOG_DEFAULTS,
  type Watchdog,
  type WatchdogConfig,
  type WatchdogHandle,
  type WatchdogKill,
  type WatchdogRegistration,
  type WatchdogTimeline,
} from '../src/watchdog.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const MIN = 60_000
const T0 = 1_000_000_000
/** A healthy mid-flight query: started at T0, wrote early, 70-min hard ceiling. */
const timeline = (over: Partial<WatchdogTimeline>): WatchdogTimeline => ({
  startedAt: T0,
  lastToolAt: T0,
  firstWriteAt: T0 + 1 * MIN,
  hardCeilingMs: 70 * MIN,
  ...over,
})

// ── Pure policy timelines ───────────────────────────────────────────────────

// 1) The longest productive silent stall the patience was sized for (8m48s) must
//    survive at low utilization — the base patience sits above it.
{
  const now = T0 + 30 * MIN
  const v = evaluateWatchdog(timeline({ lastToolAt: now - (8 * MIN + 48_000) }), now, 0.4)
  check('8m48s productive stall, low util: ok', v.verdict === 'ok', v.verdict)
}

// 2) True idle past base patience (writes already seen, low util) → idle kill.
{
  const now = T0 + 30 * MIN
  const v = evaluateWatchdog(timeline({ lastToolAt: now - 11 * MIN }), now, 0.4)
  check(
    '11 min idle post-write: kill watchdog_idle',
    v.verdict === 'kill' && v.kind === 'watchdog_idle',
    JSON.stringify(v),
  )
}

// 3) The SAME 11-min idle at ≥0.90 utilization → patience doubled (extend, no kill).
{
  const now = T0 + 30 * MIN
  const v = evaluateWatchdog(timeline({ lastToolAt: now - 11 * MIN }), now, 0.92)
  check('11 min idle @0.92 util: extended patience', v.verdict === 'extend', v.verdict)
}

// 4) Doubled patience exhausted (21 min idle at high util) → kill after all.
{
  const now = T0 + 40 * MIN
  const v = evaluateWatchdog(timeline({ lastToolAt: now - 21 * MIN }), now, 0.92)
  check(
    '21 min idle @0.92 util: kill',
    v.verdict === 'kill' && v.kind === 'watchdog_idle',
    JSON.stringify(v),
  )
}

// 5) Pre-first-write (design/read stage): quiet 15 min tolerated, 21 min not.
{
  const now = T0 + 21 * MIN
  const vExtend = evaluateWatchdog(
    timeline({ firstWriteAt: null, lastToolAt: now - 15 * MIN }),
    now,
    0.3,
  )
  const vKill = evaluateWatchdog(
    timeline({ firstWriteAt: null, startedAt: T0 - 5 * MIN, lastToolAt: now - 21 * MIN }),
    now,
    0.3,
  )
  check('pre-write 15 min quiet: extend', vExtend.verdict === 'extend', vExtend.verdict)
  check(
    'pre-write 21 min quiet: kill',
    vKill.verdict === 'kill' && vKill.kind === 'watchdog_idle',
    JSON.stringify(vKill),
  )
}

// 6) Hard ceiling: recent activity does NOT save a query past the absolute cap.
{
  const now = T0 + 71 * MIN
  const v = evaluateWatchdog(timeline({ lastToolAt: now - 5_000 }), now, 0.2)
  check(
    'busy at 71 min vs 70-min ceiling: kill hard_ceiling',
    v.verdict === 'kill' && v.kind === 'hard_ceiling',
    JSON.stringify(v),
  )
}

// ── Registry lifecycle (injected clock; the interval body is `tick`) ──

/** A fresh monitor, and a watchdog that reads its utilization. */
function pair(config: WatchdogConfig = {}): { monitor: RateLimitMonitor; wd: Watchdog } {
  const monitor = createRateLimitMonitor()
  const wd = createWatchdog({
    getUtilization: (now) => monitor.active(now)?.utilization ?? null,
    ...config,
  })
  return { monitor, wd }
}

/** One supervised query with a 70-min hard ceiling. */
const lane = (wd: Watchdog): WatchdogHandle =>
  wd.register({ hardCeilingMs: 70 * MIN, abortController: new AbortController() }, T0)

// 7) Activity resets patience; the first Write ends the design-stage extension;
//    a kill fires the effector exactly once and aborts the query.
{
  const { wd } = pair()
  const kills: WatchdogKill[] = []
  const reasons: string[] = []
  const abort = new AbortController()
  const w = wd.register(
    {
      hardCeilingMs: 200 * MIN,
      abortController: abort,
      onKill: (kill) => kills.push(kill),
      onExtend: (reason) => reasons.push(reason),
    },
    T0,
  )
  w.activity('Read', T0 + 9 * MIN)
  wd.tick(T0 + 12 * MIN) // 3 min idle → ok
  check('registry: fresh activity → no kill', kills.length === 0)
  wd.tick(T0 + 24 * MIN) // 15 min idle but still pre-write → extend
  check('registry: pre-write 15 min idle → no kill', kills.length === 0)
  check('registry: the extension names its reason', reasons.join(',') === 'pre_write')
  w.activity('Write', T0 + 25 * MIN)
  wd.tick(T0 + 36 * MIN) // 11 min idle post-write → kill
  check(
    'registry: post-write idle kill fired (effector invoked)',
    kills.length === 1 && kills[0].kind === 'watchdog_idle' && kills[0].elapsedMs === 36 * MIN,
    JSON.stringify(kills),
  )
  check('registry: onKill gets the since-last-tool gap', kills[0]?.sinceToolMs === 11 * MIN)
  check('registry: the kill aborts the query', abort.signal.aborted)
  wd.tick(T0 + 37 * MIN)
  check('registry: kill fires at most once', kills.length === 1)
  w.unregister()
  check(
    'registry: the kill stays readable after unregister',
    JSON.stringify(w.kill) === JSON.stringify(kills[0]),
  )
  wd.close()
}

// 8) The tick reads utilization from the rate-limit monitor (Step 5's holder).
{
  const { monitor, wd } = pair()
  const kills: string[] = []
  const extends_: [string, number | null][] = []
  const w = wd.register(
    {
      hardCeilingMs: 200 * MIN,
      abortController: new AbortController(),
      onKill: (kill) => kills.push(kill.kind),
      onExtend: (reason, utilization) => extends_.push([reason, utilization]),
    },
    T0,
  )
  w.activity('Write', T0 + 1 * MIN)
  monitor.note({ status: 'allowed_warning', utilization: 0.95 })
  wd.tick(T0 + 13 * MIN) // 12 min idle, but window at 0.95 → extended
  check('tick: high monitor utilization extends patience', kills.length === 0)
  wd.tick(T0 + 18 * MIN) // still extended; onExtend must not fire again
  check(
    'tick: onExtend fires once, with the reason and the utilization',
    extends_.length === 1 && extends_[0][0] === 'high_utilization' && extends_[0][1] === 0.95,
    JSON.stringify(extends_),
  )
  wd.tick(T0 + 23 * MIN) // 22 min idle → doubled patience exhausted
  check('tick: doubled patience exhausted → kill', kills.length === 1, JSON.stringify(kills))
  wd.close()
}

// 8b) A reading past its reset no longer doubles patience: the window it described is gone.
{
  const { monitor, wd } = pair()
  const w = wd.register({ hardCeilingMs: 200 * MIN, abortController: new AbortController() }, T0)
  w.activity('Write', T0 + 1 * MIN)
  monitor.note({ status: 'allowed_warning', utilization: 0.95, resetsAt: (T0 + 5 * MIN) / 1000 })
  wd.tick(T0 + 12 * MIN) // 11 min idle; the 0.95 reading reset at minute 5
  check(
    'tick: a reading past its reset does not extend patience',
    w.kill?.kind === 'watchdog_idle',
    String(w.kill?.kind),
  )
  wd.close()
}

// A callback that throws is a caller bug, but it must not disarm the watchdog: its query is
// still aborted, and the queries after it are still checked.
{
  const { wd } = pair()
  const abortA = new AbortController()
  const a = wd.register(
    {
      hardCeilingMs: 200 * MIN,
      abortController: abortA,
      onKill: () => {
        throw new Error('boom')
      },
    },
    T0,
  )
  const abortB = new AbortController()
  const b = wd.register({ hardCeilingMs: 200 * MIN, abortController: abortB }, T0)
  a.activity('Write', T0)
  b.activity('Write', T0)
  let thrown: unknown = null
  try {
    wd.tick(T0 + 11 * MIN)
  } catch (err) {
    thrown = err
  }
  check('throwing onKill: the tick does not throw', thrown === null)
  check('throwing onKill: its query is still aborted', abortA.signal.aborted)
  check(
    'throwing onKill: the next query is still checked',
    abortB.signal.aborted && b.kill?.kind === 'watchdog_idle',
  )
  wd.close()
}

// A registration may be a class instance: its methods live on the prototype, which a spread
// of the registration would drop.
{
  const { wd } = pair()
  class Supervisor implements WatchdogRegistration {
    hardCeilingMs = 200 * MIN
    abortController = new AbortController()
    kills: string[] = []
    onKill(kill: WatchdogKill): void {
      this.kills.push(kill.kind)
    }
  }
  const sup = new Supervisor()
  const w = wd.register(sup, T0)
  w.activity('Write', T0)
  wd.tick(T0 + 11 * MIN)
  check(
    'class registration: its onKill method runs with its own this',
    sup.kills.join(',') === 'watchdog_idle' && sup.abortController.signal.aborted,
    JSON.stringify(sup.kills),
  )
  wd.close()
}

// ── stream deltas are activity; the tool clock alone is not the idle clock ──
{
  const now = T0 + 30 * MIN
  // A THINKING model: 15 min since the last tool, but deltas 10 s ago → alive.
  const thinking = evaluateWatchdog(
    timeline({ lastToolAt: now - 15 * MIN, lastActivityAt: now - 10_000 }),
    now,
    0.4,
  )
  check('stream: thinking at 15 min since last tool → ok', thinking.verdict === 'ok')

  // Deltas that stopped 9.5 min ago: still under the ONE line. There is no shorter
  // line for a stream that once streamed and went quiet — that rule killed lanes
  // waiting on something the harness could not see.
  const quiet = evaluateWatchdog(
    timeline({ lastToolAt: now - 15 * MIN, lastActivityAt: now - 9.5 * MIN }),
    now,
    0.4,
  )
  check('stream: quiet 9.5 min after its last delta → ok', quiet.verdict === 'ok', quiet.verdict)
  const dead = evaluateWatchdog(
    timeline({ lastToolAt: now - 15 * MIN, lastActivityAt: now - 10.5 * MIN }),
    now,
    0.4,
  )
  check(
    'stream: quiet 10.5 min after its last delta → kill watchdog_idle',
    dead.verdict === 'kill' && dead.kind === 'watchdog_idle',
    JSON.stringify(dead),
  )
}

// `rate_limit_event` proves the provider is alive mid-turn. It moves the idle clock
// but NOT the tool clock: the line is still counted from the heartbeat, not stretched
// past it.
{
  const { wd } = pair()
  const w = lane(wd)
  w.activity('Write', T0 + 1 * MIN)
  w.heartbeat(T0 + 4 * MIN)
  wd.tick(T0 + 13 * MIN) // 12 min since the Write, 9 min since the heartbeat
  check('registry: a heartbeat defers the idle kill', w.kill === null)
  wd.tick(T0 + 14.5 * MIN) // 10.5 min since the heartbeat
  check('registry: the idle kill counts from the heartbeat', w.kill?.kind === 'watchdog_idle')
  wd.close()
}

// ── fan-out: two live queries, each fed through its own handle ───────────────
// A busy worker must not keep a stalled sibling's clock fresh, or the sibling could only
// ever die at its own hard ceiling. Two lanes, one working, one silent.
{
  const { wd } = pair()
  const catalog = lane(wd)
  const detail = lane(wd)
  // Both write; only `catalog` keeps working. `detail` dies on its OWN idle time
  // (12 min at the tick).
  catalog.activity('Write', T0 + 1 * MIN)
  detail.activity('Write', T0 + 1 * MIN)
  for (let m = 2; m <= 12; m++) {
    catalog.stream(T0 + m * MIN)
    catalog.activity('Read', T0 + m * MIN)
  }
  wd.tick(T0 + 13 * MIN)
  check('fan-out: the working branch survives', catalog.kill === null)
  check(
    'fan-out: the stalled sibling is killed on its own idle time',
    detail.kill?.kind === 'watchdog_idle',
    String(detail.kill?.kind),
  )
  wd.close()
}

// Feeds found their entry by label once, and a label that matched no live entry marked
// EVERY entry: a status re-ask, registered as `<phase>-status` but fed through the phase's
// hooks, kept hung siblings alive. A handle has no label to miss.
{
  const { wd } = pair()
  const ended = lane(wd)
  ended.unregister()
  const stalled = lane(wd)
  stalled.activity('Write', T0 + 1 * MIN)
  for (let m = 2; m <= 12; m++) {
    ended.activity('Read', T0 + m * MIN)
    ended.stream(T0 + m * MIN)
    ended.heartbeat(T0 + m * MIN)
  }
  wd.tick(T0 + 13 * MIN)
  check(
    "isolation: an ended query's feeds never move a live query's clock",
    stalled.kill?.kind === 'watchdog_idle',
    String(stalled.kill?.kind),
  )
  check('isolation: an ended query is never killed', ended.kill === null)
  wd.close()
}

// ── no cascade: a sibling's death never moves a survivor's line ──────────────
// Four lanes, all past their first Write and all streaming at minute 1.5 except
// `d`, whose last activity is its Write at T0. A lane-scaled line would have put
// the other three at 9 min (×3 cap) and then at 6 min once one lane died; the ONE
// line keeps them at WATCHDOG_DEFAULTS.idleMs before and after `d` is killed.
{
  const { wd } = pair()
  const [a, b, c, d] = [lane(wd), lane(wd), lane(wd), lane(wd)]
  const survivors = [a, b, c]
  const kinds = (): string => survivors.map((w) => String(w.kill?.kind ?? null)).join('/')
  d.activity('Write', T0)
  for (const w of survivors) {
    w.activity('Write', T0 + 1.5 * MIN)
    w.stream(T0 + 1.5 * MIN)
  }
  wd.tick(T0 + 10.5 * MIN) // d: 10.5 min idle; a/b/c: 9 min idle
  check('cascade: the genuinely idle lane dies at the base line', d.kill?.kind === 'watchdog_idle')
  check(
    'cascade: three lanes at 9 min idle survive with a sibling dead',
    survivors.every((w) => w.kill === null),
    kinds(),
  )
  wd.tick(T0 + 11 * MIN) // a/b/c: 9.5 min idle — under the base line, whatever died
  check(
    'cascade: still alive at 9.5 min idle after the kill',
    survivors.every((w) => w.kill === null),
    kinds(),
  )
  wd.tick(T0 + 1.5 * MIN + WATCHDOG_DEFAULTS.idleMs) // exactly the base line
  check(
    'cascade: the survivors die only at the base line itself',
    survivors.every((w) => w.kill?.kind === 'watchdog_idle'),
    kinds(),
  )
  wd.close()
}

// ── options: each one changes the verdict it names ──────────────────────────

/** A query on `wd` that wrote at T0: the base line applies from then on. */
const written = (wd: Watchdog): WatchdogHandle => {
  const h = lane(wd)
  h.activity('Write', T0)
  return h
}

{
  const short = createWatchdog({ idleMs: 1 * MIN })
  const base = createWatchdog()
  const a = written(short)
  const b = written(base)
  short.tick(T0 + 2 * MIN)
  base.tick(T0 + 2 * MIN)
  check('idleMs: 2 min idle kills at a 1-min line', a.kill?.kind === 'watchdog_idle')
  check('idleMs: the default line keeps the same query alive', b.kill === null)
  short.close()
  base.close()
}

{
  const flat = createWatchdog({ extendFactor: 1 })
  const base = createWatchdog()
  const a = lane(flat)
  const b = lane(base)
  flat.tick(T0 + 11 * MIN)
  base.tick(T0 + 11 * MIN)
  check('extendFactor: 1 gives a pre-write query no extension', a.kill?.kind === 'watchdog_idle')
  check('extendFactor: the default 2 extends it', b.kill === null)
  flat.close()
  base.close()
}

{
  const low = createWatchdog({ highUtilization: 0.5, getUtilization: () => 0.6 })
  const base = createWatchdog({ getUtilization: () => 0.6 })
  const a = written(low)
  const b = written(base)
  low.tick(T0 + 11 * MIN)
  base.tick(T0 + 11 * MIN)
  check('highUtilization: 0.6 against a 0.5 line extends patience', a.kill === null)
  check(
    'highUtilization: 0.6 against the default 0.9 line does not',
    b.kill?.kind === 'watchdog_idle',
  )
  low.close()
  base.close()
}

{
  const bash = createWatchdog({ writeTools: ['Bash'] })
  const base = createWatchdog()
  const a = lane(bash)
  const b = lane(base)
  const c = lane(bash)
  a.activity('Bash', T0)
  b.activity('Bash', T0)
  c.activity('Write', T0)
  bash.tick(T0 + 11 * MIN)
  base.tick(T0 + 11 * MIN)
  check('writeTools: a listed tool ends the pre-write extension', a.kill?.kind === 'watchdog_idle')
  check('writeTools: by default Bash does not', b.kill === null)
  check('writeTools: a tool left off the list does not', c.kill === null)
  bash.close()
  base.close()
}

{
  const progress = {
    type: 'tool_progress',
    tool_use_id: 'toolu_1',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 30,
    heartbeat: true,
  } as unknown as SDKMessage
  const on = createWatchdog()
  const off = createWatchdog({ toolHeartbeats: false })
  const a = written(on)
  const b = written(off)
  for (let sec = 30; sec <= 12 * 60; sec += 30) {
    a.observe(progress, T0 + sec * 1000)
    b.observe(progress, T0 + sec * 1000)
  }
  on.tick(T0 + 12 * MIN)
  off.tick(T0 + 12 * MIN)
  check('toolHeartbeats: on by default, a running tool keeps the query alive', a.kill === null)
  check('toolHeartbeats: off, the same query dies idle', b.kill?.kind === 'watchdog_idle')
  on.close()
  off.close()
}

{
  const seen: number[] = []
  const wd = createWatchdog({
    getUtilization: (now) => {
      seen.push(now)
      return 0.95
    },
  })
  const h = written(wd)
  wd.tick(T0 + 11 * MIN)
  check("getUtilization: gets the tick's now", seen.join(',') === String(T0 + 11 * MIN))
  check('getUtilization: its reading extends patience', h.kill === null)
  wd.close()
}

{
  let clock = T0
  const wd = createWatchdog({ now: () => clock })
  const h = wd.register({ hardCeilingMs: 70 * MIN, abortController: new AbortController() })
  clock = T0 + 1 * MIN
  h.activity('Write')
  clock = T0 + 11.5 * MIN
  const kills = wd.tick()
  check(
    'now: register, activity and tick read the injected clock',
    kills.length === 1 && kills[0].elapsedMs === 11.5 * MIN && kills[0].sinceToolMs === 10.5 * MIN,
    JSON.stringify(kills),
  )
  wd.close()
}

{
  const errors: unknown[] = []
  const boom = new Error('boom')
  const wd = createWatchdog({
    onError: (e) => errors.push(e),
    getUtilization: () => {
      throw boom
    },
  })
  const abort = new AbortController()
  const h = wd.register(
    {
      hardCeilingMs: 70 * MIN,
      abortController: abort,
      onKill: () => {
        throw boom
      },
    },
    T0,
  )
  h.activity('Write', T0)
  wd.tick(T0 + 11 * MIN)
  check(
    'onError: gets a throwing getUtilization and a throwing onKill',
    errors.length === 2 && errors.every((e) => e === boom),
    String(errors.length),
  )
  check('onError: the query is still aborted', abort.signal.aborted)
  wd.close()
}

{
  const wd = createWatchdog({
    onError: () => {
      throw new Error('again')
    },
  })
  const h = wd.register(
    {
      hardCeilingMs: 70 * MIN,
      abortController: new AbortController(),
      onKill: () => {
        throw new Error('boom')
      },
    },
    T0,
  )
  h.activity('Write', T0)
  let thrown = false
  try {
    wd.tick(T0 + 11 * MIN)
  } catch {
    thrown = true
  }
  check('onError: a throwing onError is dropped', !thrown && h.kill !== null)
  wd.close()
}

// The one case on the real timer: `tickMs` decides when the check runs.
{
  const fast = createWatchdog({ tickMs: 5, idleMs: 1 })
  const slow = createWatchdog({ idleMs: 1 })
  let timer: NodeJS.Timeout | undefined
  const killed = await new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 1000)
    const h = fast.register({
      hardCeilingMs: 70 * MIN,
      abortController: new AbortController(),
      onKill: () => resolve(true),
    })
    h.activity('Write')
  })
  clearTimeout(timer)
  const s = slow.register({ hardCeilingMs: 70 * MIN, abortController: new AbortController() })
  s.activity('Write')
  check('tickMs: a 5 ms tick kills on the real timer', killed)
  check('tickMs: the default 30 s tick has not run yet', s.kill === null)
  fast.close()
  slow.close()
}

for (const [config, message] of [
  [{ idleMs: 0 }, 'idleMs must be a number > 0, got 0'],
  [{ extendFactor: 0.5 }, 'extendFactor must be a number >= 1, got 0.5'],
  [{ highUtilization: 1.5 }, 'highUtilization must be a number in [0, 1], got 1.5'],
  [{ tickMs: Number.NaN }, 'tickMs must be a number > 0, got NaN'],
] as const) {
  let error: unknown = null
  try {
    createWatchdog(config)
  } catch (e) {
    error = e
  }
  check(
    `RangeError: ${message}`,
    error instanceof RangeError && error.message === message,
    String(error),
  )
}

{
  const wd = createWatchdog({ idleMs: undefined, tickMs: 1000 })
  check(
    'config: an undefined option keeps its default',
    wd.config.idleMs === WATCHDOG_DEFAULTS.idleMs && wd.config.tickMs === 1000,
  )
  check(
    'config: the defaults and the resolved config are frozen',
    Object.isFrozen(WATCHDOG_DEFAULTS) &&
      Object.isFrozen(WATCHDOG_DEFAULTS.writeTools) &&
      Object.isFrozen(wd.config),
  )
}

// ── instances, tick, close ──────────────────────────────────────────────────

{
  const a = createWatchdog()
  const b = createWatchdog()
  const h = written(a)
  const fromB = b.tick(T0 + 11 * MIN)
  check("instances: one tick never checks another's queries", fromB.length === 0 && h.kill === null)
  const fromA = a.tick(T0 + 11 * MIN)
  check('instances: its own tick does', fromA.length === 1 && h.kill?.kind === 'watchdog_idle')
  a.close()
  b.close()
}

{
  const wd = createWatchdog()
  const x = written(wd)
  lane(wd) // pre-write: extended, not killed
  const first = wd.tick(T0 + 11 * MIN)
  check('tick: returns the kills of this pass', first.length === 1 && first[0] === x.kill)
  check('tick: a query killed earlier is not returned again', wd.tick(T0 + 12 * MIN).length === 0)
  wd.close()
}

{
  const wd = createWatchdog()
  const h = written(wd)
  wd.close()
  check('close: a closed watchdog checks nothing', wd.tick(T0 + 30 * MIN).length === 0)
  check('close: its queries are never killed', h.kill === null)
}

// ── observe: which messages move the idle clock ─────────────────────────────

for (const [name, frame, alive] of [
  ['a stream event', { type: 'stream_event', event: { type: 'message_start' } }, true],
  ['a thinking frame', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9 }, true],
  [
    'a rate_limit_event',
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    true,
  ],
  ['an assistant message', { type: 'assistant', message: { content: [] } }, false],
  ['system/init', { type: 'system', subtype: 'init', tools: [] }, false],
] as const) {
  const wd = createWatchdog()
  const h = written(wd)
  h.observe(frame as unknown as SDKMessage, T0 + 5 * MIN)
  wd.tick(T0 + 11 * MIN)
  check(
    `observe: ${name} ${alive ? 'moves' : 'does not move'} the idle clock`,
    (h.kill === null) === alive,
  )
  wd.close()
}

// ── settled: after a result, only new work restarts the idle policy ──────────

const RESULT = { type: 'result', subtype: 'success' } as unknown as SDKMessage
const RATE = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed' },
} as unknown as SDKMessage
const DELTA = { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage

// 1) The SDK's post-result idle wait (up to 10 min since 0.3.284) is not a hang.
{
  const wd = createWatchdog()
  const h = written(wd)
  h.observe(RESULT, T0 + 5 * MIN)
  wd.tick(T0 + 40 * MIN)
  check('settled: a result stops the idle kill', h.kill === null)
  wd.close()
}

// 2) A heartbeat after the result is not new work: still settled.
{
  const wd = createWatchdog()
  const h = written(wd)
  h.observe(RESULT, T0 + 5 * MIN)
  h.observe(RATE, T0 + 6 * MIN)
  wd.tick(T0 + 40 * MIN)
  check('settled: a rate_limit_event after the result keeps it settled', h.kill === null)
  wd.close()
}

// 3) New work after the result (a stream frame, a tool boundary) starts the idle clock again.
for (const [name, work] of [
  ['a stream frame', (h: WatchdogHandle) => h.observe(DELTA, T0 + 6 * MIN)],
  ['a tool boundary', (h: WatchdogHandle) => h.activity(undefined, T0 + 6 * MIN)],
] as const) {
  const wd = createWatchdog()
  const h = written(wd)
  h.observe(RESULT, T0 + 5 * MIN)
  work(h)
  wd.tick(T0 + 17 * MIN)
  check(
    `settled: ${name} after the result restarts the idle kill`,
    h.kill?.kind === 'watchdog_idle',
  )
  wd.close()
}

// 4) settle() is the manual form of observe(result); the hard ceiling still applies.
{
  const wd = createWatchdog()
  const h = written(wd)
  h.settle()
  wd.tick(T0 + 30 * MIN)
  check('settled: settle() stops the idle kill', h.kill === null)
  wd.tick(T0 + 70 * MIN)
  check('settled: the hard ceiling still kills', h.kill?.kind === 'hard_ceiling')
  wd.close()
}

// 5) The pure policy: a settled timeline is ok until the hard ceiling.
{
  const now = T0 + 30 * MIN
  const v = evaluateWatchdog(timeline({ lastToolAt: now - 25 * MIN, settled: true }), now, 0.4)
  check('settled timeline, 25 min idle: ok', v.verdict === 'ok', v.verdict)
}

// ── makeWatchdogHook: every tool boundary is activity; only PostToolUse names the tool ──
{
  let clock = T0
  const wd = createWatchdog({ now: () => clock })
  const reg = (): WatchdogRegistration => ({
    hardCeilingMs: 70 * MIN,
    abortController: new AbortController(),
  })
  const [pre, post, failed] = [wd.register(reg()), wd.register(reg()), wd.register(reg())]
  const input = (event: string): HookInput =>
    ({ hook_event_name: event, tool_name: 'Write', tool_input: {} }) as unknown as HookInput
  const opts = { signal: new AbortController().signal }
  clock = T0 + 10 * MIN
  await makeWatchdogHook(pre)(input('PreToolUse'), undefined, opts)
  await makeWatchdogHook(post)(input('PostToolUse'), undefined, opts)
  await makeWatchdogHook(failed)(input('PostToolUseFailure'), undefined, opts)
  clock = T0 + 21 * MIN // 11 min after the hooks, 21 min after the start
  wd.tick()
  check('hook: PostToolUse Write ends the pre-write extension', post.kill?.kind === 'watchdog_idle')
  check('hook: PreToolUse is activity, but not a completed write', pre.kill === null)
  check('hook: PostToolUseFailure is activity, but not a write', failed.kill === null)
  wd.close()
}

if (failures > 0) {
  console.error(`\ncheck-watchdog: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\ncheck-watchdog: all checks pass')
