import type { SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { checkOption, resolveOptions } from './options.js'

/** A window name, as `SDKRateLimitInfo.rateLimitType` spells it. */
export type RateLimitWindow = NonNullable<SDKRateLimitInfo['rateLimitType']>

export interface RateLimitMonitorConfig {
  /** Utilization (0 to 1) at or above which `note` returns its one-shot warning reading. */
  warnAt?: number
  /** The window read when a reading has no top-level utilization and names no window. */
  fallbackWindow?: RateLimitWindow
  /** The clock `active()` reads when it gets no `now`. */
  now?: () => number
}

export type ResolvedRateLimitMonitorConfig = Readonly<Required<RateLimitMonitorConfig>>

export const RATE_LIMIT_DEFAULTS: ResolvedRateLimitMonitorConfig = Object.freeze({
  warnAt: 0.85,
  fallbackWindow: 'five_hour',
  now: () => Date.now(),
})

/** The latest merged `rate_limit_event` reading of one process or one account. */
export interface RateLimitMonitor {
  /**
   * Fold one reading into the held one. It is a merge, because no payload shape carries both
   * utilization and overage:
   *
   * | `status`          | top-level `utilization`              | `overageStatus`      |
   * |-------------------|--------------------------------------|----------------------|
   * | `allowed`         | absent — only under `unifiedWindows` | present              |
   * | `allowed_warning` | present                              | absent               |
   * | `rejected`        | absent                               | present              |
   *
   * Utilization comes from the top level, then the reading's own window, then `fallbackWindow`;
   * absent overage fields carry forward. `info` is never mutated. Returns the merged reading
   * once, at the first reading at or above `warnAt`; else `null`.
   */
  note(info: SDKRateLimitInfo): SDKRateLimitInfo | null
  /** {@link note} for a `rate_limit_event`; any other message changes nothing and gives `null`. */
  observe(message: SDKMessage): SDKRateLimitInfo | null
  /** The held reading, stale or not: for display. Decisions use {@link active}. */
  latest(): SDKRateLimitInfo | null
  /** The held reading, or `null` once its `resetsAt` (seconds) has passed at `now` (ms). */
  active(now?: number): SDKRateLimitInfo | null
  /** Forget the reading and re-arm the warning. */
  reset(): void
}

export function createRateLimitMonitor(config: RateLimitMonitorConfig = {}): RateLimitMonitor {
  const c = resolveOptions(RATE_LIMIT_DEFAULTS, config)
  checkOption('warnAt', c.warnAt, 'a number in [0, 1]', (v) => v >= 0 && v <= 1)
  let latest: SDKRateLimitInfo | null = null
  let warned = false

  const note = (info: SDKRateLimitInfo): SDKRateLimitInfo | null => {
    const utilization =
      info.utilization ??
      (info.rateLimitType !== undefined
        ? windowUtilization(info, info.rateLimitType)
        : undefined) ??
      windowUtilization(info, c.fallbackWindow)
    latest = {
      ...info,
      ...(utilization !== undefined ? { utilization } : {}),
      ...(info.overageStatus === undefined && latest?.overageStatus !== undefined
        ? { overageStatus: latest.overageStatus }
        : {}),
      ...(info.overageDisabledReason === undefined && latest?.overageDisabledReason !== undefined
        ? { overageDisabledReason: latest.overageDisabledReason }
        : {}),
    }
    if (!warned && typeof latest.utilization === 'number' && latest.utilization >= c.warnAt) {
      warned = true
      return latest
    }
    return null
  }

  return {
    note,
    observe: (message) =>
      message.type === 'rate_limit_event' ? note(message.rate_limit_info) : null,
    latest: () => latest,
    active(now = c.now()) {
      if (latest && typeof latest.resetsAt === 'number' && latest.resetsAt * 1000 <= now) {
        return null
      }
      return latest
    },
    reset() {
      latest = null
      warned = false
    },
  }
}

/**
 * One window's utilization from the frame's `unifiedWindows` map. The CLI sends the map, but
 * `SDKRateLimitInfo` does not declare it, so it is read by narrowing. A missing window, or one
 * whose `utilization` is not a number, gives `undefined`.
 */
function windowUtilization(info: SDKRateLimitInfo, key: string): number | undefined {
  const windows: unknown = 'unifiedWindows' in info ? info.unifiedWindows : undefined
  if (typeof windows !== 'object' || windows === null) return undefined
  const entry: unknown = Reflect.get(windows, key)
  if (typeof entry !== 'object' || entry === null || !('utilization' in entry)) return undefined
  return typeof entry.utilization === 'number' ? entry.utilization : undefined
}

export function rateLimitResetIso(rl: SDKRateLimitInfo): string | null {
  return typeof rl.resetsAt === 'number' ? new Date(rl.resetsAt * 1000).toISOString() : null
}

/** One-line render of a reading: status, utilization, overage, reset. */
export function formatRateLimitReading(rl: SDKRateLimitInfo): string {
  const reset = rateLimitResetIso(rl)
  return (
    rl.status +
    (rl.utilization !== undefined ? ` at ${(rl.utilization * 100).toFixed(0)}%` : '') +
    (rl.overageStatus ? `, overage ${rl.overageStatus}` : '') +
    (rl.overageDisabledReason ? ` (${rl.overageDisabledReason})` : '') +
    (reset ? `, resets at ${reset}` : '')
  )
}
