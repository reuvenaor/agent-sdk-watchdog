import type { HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { checkOption, resolveOptions } from './options.js'

/**
 * An in-process idle watchdog for `query()` sessions, on one shared tick per instance.
 *
 * - Idle policy: kill after `idleMs` with no activity of any kind (tool boundary, stream delta,
 *   provider heartbeat). Patience grows by `extendFactor` before the first write (reading and
 *   design are quiet) and while window utilization is at or above `highUtilization` (the
 *   provider paces responses).
 * - Hard ceiling: the caller's absolute cap, for a session that stays "active" forever.
 * - Settled: after a `result`, the idle policy waits for new work. The SDK bounds its own
 *   post-result wait (`session_state_changed: idle`, since 0.3.284).
 *
 * One idle line on purpose: a shorter line scaled by the number of live sessions killed
 * healthy ones, because each kill shortened the line for the rest.
 */

export type WatchdogKillKind = 'hard_ceiling' | 'watchdog_idle'

/** Why patience was extended; with both, `high_utilization`. */
export type WatchdogExtendReason = 'high_utilization' | 'pre_write'

export type WatchdogVerdict =
  | { verdict: 'ok' }
  /** Past base patience, but an extension condition holds. */
  | { verdict: 'extend'; reason: WatchdogExtendReason }
  | { verdict: 'kill'; kind: WatchdogKillKind }

export interface WatchdogConfig {
  /** Base idle patience, ms. */
  idleMs?: number
  /** How many times `idleMs` a session gets while an extension holds. */
  extendFactor?: number
  /** Window utilization (0 to 1) at or above which patience is extended. */
  highUtilization?: number
  /** How often the shared tick checks every registered session, ms. */
  tickMs?: number
  /** Tools whose first completed call ends the pre-write extension. */
  writeTools?: readonly string[]
  /** Whether `observe()` counts a `tool_progress` frame as activity. */
  toolHeartbeats?: boolean
  /** The window utilization at the tick's `now`, or `null` when unknown. */
  getUtilization?: (now: number) => number | null
  /** The clock, for every method called without a time. */
  now?: () => number
  /** Gets an error thrown by `onKill`, `onExtend` or `getUtilization`. */
  onError?: (error: unknown) => void
}

export type ResolvedWatchdogConfig = Readonly<Required<WatchdogConfig>>

export const WATCHDOG_DEFAULTS: ResolvedWatchdogConfig = Object.freeze({
  // 10 min: above the longest measured productive silence (8m48s).
  idleMs: 10 * 60 * 1000,
  extendFactor: 2,
  highUtilization: 0.9,
  tickMs: 30 * 1000,
  writeTools: Object.freeze(['Write', 'Edit']),
  toolHeartbeats: true,
  getUtilization: () => null,
  now: () => Date.now(),
  onError: () => {},
})

/** The limits the pure policy reads. */
export type WatchdogLimits = Pick<
  ResolvedWatchdogConfig,
  'idleMs' | 'extendFactor' | 'highUtilization'
>

export interface WatchdogTimeline {
  startedAt: number
  lastToolAt: number
  firstWriteAt: number | null
  hardCeilingMs: number
  /** Latest activity of any kind; absent means `lastToolAt`. */
  lastActivityAt?: number
  /** A `result` arrived and no new work since: only the hard ceiling applies. */
  settled?: boolean
}

/** Pure policy: one timeline, one instant, one utilization, the limits → verdict. */
export function evaluateWatchdog(
  t: WatchdogTimeline,
  now: number,
  utilization: number | null,
  limits: WatchdogLimits = WATCHDOG_DEFAULTS,
): WatchdogVerdict {
  if (now - t.startedAt >= t.hardCeilingMs) return { verdict: 'kill', kind: 'hard_ceiling' }
  if (t.settled) return { verdict: 'ok' }
  const lastActivityAt = Math.max(t.lastToolAt, t.lastActivityAt ?? t.lastToolAt)
  const idleMs = now - lastActivityAt
  const highUtil = utilization !== null && utilization >= limits.highUtilization
  const extended = highUtil || t.firstWriteAt === null
  const patienceMs = extended ? limits.idleMs * limits.extendFactor : limits.idleMs
  if (idleMs >= patienceMs) return { verdict: 'kill', kind: 'watchdog_idle' }
  if (idleMs >= limits.idleMs) {
    return { verdict: 'extend', reason: highUtil ? 'high_utilization' : 'pre_write' }
  }
  return { verdict: 'ok' }
}

/** What a kill recorded. */
export interface WatchdogKill {
  kind: WatchdogKillKind
  elapsedMs: number
  sinceToolMs: number
}

export interface WatchdogRegistration {
  hardCeilingMs: number
  /** Aborted on a kill, after `onKill`, even when `onKill` throws. */
  abortController: AbortController
  /** Called at most once, on a kill, before the abort. */
  onKill?: (kill: WatchdogKill) => void
  /** Called once, the first time patience is extended. */
  onExtend?: (reason: WatchdogExtendReason, utilization: number | null) => void
}

/** One supervised query. Feed it only from that query's own hooks and stream. */
export interface WatchdogHandle {
  /**
   * A tool boundary. Pass `toolName` only once the tool completed (PostToolUse): the first
   * write tool ends the pre-write extension.
   */
  activity(toolName?: string, now?: number): void
  /** A stream delta or thinking frame: a thinking model is not idle. */
  stream(now?: number): void
  /** A provider heartbeat (`rate_limit_event`). Moves only the idle clock: not tool progress. */
  heartbeat(now?: number): void
  /** A `result` arrived: the idle policy waits until {@link activity} or {@link stream}. */
  settle(): void
  /**
   * One SDK message. A stream event or a `system/thinking_tokens` frame is {@link stream}; a
   * `rate_limit_event` is {@link heartbeat}, and so is a `tool_progress` frame when
   * `toolHeartbeats` is on. A `result` is {@link settle}. Any other message changes nothing.
   */
  observe(message: SDKMessage, now?: number): void
  /** The kill, once there was one. Still readable after `unregister()`. */
  readonly kill: WatchdogKill | null
  /** Call when the query ends. */
  unregister(): void
}

export interface Watchdog {
  /**
   * Register a query that just started and return its handle. The tick runs while any query
   * is registered and never holds the process open.
   */
  register(reg: WatchdogRegistration, now?: number): WatchdogHandle
  /** One pass over the registered queries. Returns the kills this pass made. */
  tick(now?: number): WatchdogKill[]
  /** Stop the tick and forget every registered query. */
  close(): void
  readonly config: ResolvedWatchdogConfig
}

interface ActiveEntry extends WatchdogTimeline {
  reg: WatchdogRegistration
  kill: WatchdogKill | null
  extendNoted: boolean
}

export function createWatchdog(config: WatchdogConfig = {}): Watchdog {
  const c = resolveOptions(WATCHDOG_DEFAULTS, config)
  checkOption('idleMs', c.idleMs, 'a number > 0', (v) => v > 0)
  checkOption('extendFactor', c.extendFactor, 'a number >= 1', (v) => v >= 1)
  checkOption('highUtilization', c.highUtilization, 'a number in [0, 1]', (v) => v >= 0 && v <= 1)
  checkOption('tickMs', c.tickMs, 'a number > 0', (v) => v > 0)

  const active = new Set<ActiveEntry>()
  let ticker: NodeJS.Timeout | null = null

  // Callbacks run on the timer, where a throw would crash the host: report it and go on.
  const report = (error: unknown): void => {
    try {
      c.onError(error)
    } catch {
      // dropped: `onError` itself threw
    }
  }
  const notify = (cb: () => void): void => {
    try {
      cb()
    } catch (error) {
      report(error)
    }
  }

  /** Checks one query; returns the kill it made, if any. */
  const tickEntry = (
    e: ActiveEntry,
    now: number,
    utilization: number | null,
  ): WatchdogKill | null => {
    if (e.kill) return null
    const v = evaluateWatchdog(e, now, utilization, c)
    if (v.verdict === 'kill') {
      const kill = { kind: v.kind, elapsedMs: now - e.startedAt, sinceToolMs: now - e.lastToolAt }
      e.kill = kill
      notify(() => e.reg.onKill?.(kill))
      e.reg.abortController.abort()
      return kill
    }
    if (v.verdict === 'extend' && !e.extendNoted) {
      e.extendNoted = true
      notify(() => e.reg.onExtend?.(v.reason, utilization))
    }
    return null
  }

  const tick = (now = c.now()): WatchdogKill[] => {
    let utilization: number | null = null
    try {
      utilization = c.getUtilization(now)
    } catch (error) {
      report(error)
    }
    const kills: WatchdogKill[] = []
    for (const e of active) {
      const kill = tickEntry(e, now, utilization)
      if (kill) kills.push(kill)
    }
    return kills
  }

  const close = (): void => {
    active.clear()
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }

  const register = (reg: WatchdogRegistration, now = c.now()): WatchdogHandle => {
    const entry: ActiveEntry = {
      reg,
      hardCeilingMs: reg.hardCeilingMs,
      startedAt: now,
      lastToolAt: now,
      lastActivityAt: now,
      firstWriteAt: null,
      settled: false,
      kill: null,
      extendNoted: false,
    }
    active.add(entry)
    if (!ticker) {
      ticker = setInterval(() => tick(), c.tickMs)
      ticker.unref?.()
    }
    const alive = (at: number): void => {
      entry.lastActivityAt = at
    }
    const working = (at: number): void => {
      entry.settled = false
      alive(at)
    }
    return {
      activity(toolName, at = c.now()) {
        entry.lastToolAt = at
        working(at)
        if (entry.firstWriteAt === null && toolName && c.writeTools.includes(toolName)) {
          entry.firstWriteAt = at
        }
      },
      stream: (at = c.now()) => working(at),
      heartbeat: (at = c.now()) => alive(at),
      settle() {
        entry.settled = true
      },
      observe(message, at = c.now()) {
        if (message.type === 'result') entry.settled = true
        else if (message.type === 'rate_limit_event') alive(at)
        else if (isWork(message, c.toolHeartbeats)) working(at)
      },
      get kill() {
        return entry.kill
      },
      unregister() {
        active.delete(entry)
        if (active.size === 0 && ticker) {
          clearInterval(ticker)
          ticker = null
        }
      },
    }
  }

  return { register, tick, close, config: c }
}

/** Whether `message` shows the session is working (see {@link WatchdogHandle.observe}). */
function isWork(message: SDKMessage, toolHeartbeats: boolean): boolean {
  switch (message.type) {
    case 'stream_event':
      return true
    case 'system':
      return message.subtype === 'thinking_tokens'
    case 'tool_progress':
      return toolHeartbeats
    default:
      return false
  }
}

/**
 * Pre/PostToolUse and PostToolUseFailure hook: every tool boundary of one query feeds that
 * query's handle. Only PostToolUse passes the tool name: the first COMPLETED write ends the
 * pre-write extension, and a hook may still deny a PreToolUse write.
 */
export function makeWatchdogHook(handle: WatchdogHandle): HookCallback {
  return async (input) => {
    if (input.hook_event_name === 'PostToolUse') handle.activity(input.tool_name)
    else if (
      input.hook_event_name === 'PreToolUse' ||
      input.hook_event_name === 'PostToolUseFailure'
    ) {
      handle.activity()
    }
    return {}
  }
}
