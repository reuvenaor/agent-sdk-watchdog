#!/usr/bin/env tsx
/**
 * Harness for the rate-limit reading (`src/rate-limit-monitor.ts`).
 *
 * The defect this pins: the CLI splits a park guard's two clauses across payload shapes —
 * `allowed` events carry `overageStatus` but hide `utilization` under `unifiedWindows`;
 * `allowed_warning` events carry a top-level `utilization` and omit the overage fields.
 * Stored wholesale, each event erased the other shape's field, so the
 * `utilization >= threshold && overageStatus === 'rejected'` park guards could never
 * fire. The fixtures are synthetic and shape-only: they encode the three payload SHAPES.
 *
 * Standalone: `npx tsx test/check-rate-limit-monitor.ts`. Exits non-zero on any
 * mismatch, printing one line per case.
 */
import type { SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { createRateLimitMonitor, RATE_LIMIT_DEFAULTS } from '../src/rate-limit-monitor.js'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The CLI's frame also carries `unifiedWindows`, which `SDKRateLimitInfo` leaves out. */
function wireFrame(info: SDKRateLimitInfo, unifiedWindows: object): SDKRateLimitInfo {
  return Object.assign({}, info, { unifiedWindows })
}

// Synthetic window clock: the reset sits one hour after "now".
const NOW_MS = 1_900_000_000_000
const RESETS_AT = NOW_MS / 1000 + 3600

/** `allowed` shape: overage fields present, utilization ONLY under unifiedWindows. */
const ALLOWED = wireFrame(
  {
    status: 'allowed',
    resetsAt: RESETS_AT,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
  },
  {
    five_hour: { utilization: 0.11, resetsAt: RESETS_AT },
    seven_day: { utilization: 0.06, resetsAt: RESETS_AT + 86400 },
  },
)

/** `allowed_warning` shape: top-level utilization, NO overage fields. */
const ALLOWED_WARNING_99 = wireFrame(
  {
    status: 'allowed_warning',
    resetsAt: RESETS_AT,
    rateLimitType: 'five_hour',
    utilization: 0.99,
  },
  {
    five_hour: { utilization: 0.99, resetsAt: RESETS_AT },
    seven_day: { utilization: 0.23, resetsAt: RESETS_AT + 86400 },
  },
)

console.log('rate-limit merge:')

const monitor = createRateLimitMonitor()

monitor.reset()
monitor.note(ALLOWED)
{
  const rl = monitor.latest()
  check(
    'allowed shape derives utilization from its own window',
    rl?.utilization === 0.11,
    `got ${String(rl?.utilization)}`,
  )
  check('allowed shape keeps its overage fields', rl?.overageStatus === 'rejected')
}

// The warning signal must not have fired at 0.11; it fires at the crossing.
{
  const signalled = monitor.note(ALLOWED_WARNING_99)
  const rl = monitor.latest()
  check('allowed_warning keeps its top-level utilization', rl?.utilization === 0.99)
  check(
    'absent overage fields carry forward from the last reading',
    rl?.overageStatus === 'rejected' && rl?.overageDisabledReason === 'out_of_credits',
    JSON.stringify({ s: rl?.overageStatus, r: rl?.overageDisabledReason }),
  )
  check('one-shot warning returns the merged reading', signalled?.utilization === 0.99)
}

// The warning is one-shot: a second crossing does not signal again.
check('the warning fires once per monitor', !monitor.note(ALLOWED_WARNING_99))

// The raw payload object is never mutated (a caller may still record it after this call).
{
  monitor.reset()
  const raw = structuredClone(ALLOWED)
  monitor.note(raw)
  check('ingest does not mutate the payload', JSON.stringify(raw) === JSON.stringify(ALLOWED))
}

// A reading whose reset has passed no longer describes the window: decisions drop it,
// displays keep it. Fixed clock; `resetsAt` is in seconds, the clock in milliseconds.
{
  monitor.reset()
  check('active: no reading → null', monitor.active(NOW_MS) === null)
  monitor.note(ALLOWED_WARNING_99)
  check('active: before the reset → the reading', monitor.active(NOW_MS)?.utilization === 0.99)
  check('active: at the reset → null', monitor.active(RESETS_AT * 1000) === null)
  check('active: after the reset → null', monitor.active(RESETS_AT * 1000 + 1) === null)
  check('latest: still shows the stale reading', monitor.latest()?.utilization === 0.99)
  monitor.reset()
  monitor.note({ status: 'allowed_warning', utilization: 0.9 })
  check(
    'active: a reading with no resetsAt never goes stale',
    monitor.active(Number.MAX_SAFE_INTEGER)?.utilization === 0.9,
  )
}

monitor.reset()

console.log('options:')

{
  const early = createRateLimitMonitor({ warnAt: 0.5 })
  const base = createRateLimitMonitor()
  const reading: SDKRateLimitInfo = { status: 'allowed_warning', utilization: 0.6 }
  check('warnAt: 0.6 crosses a 0.5 line', early.note(reading)?.utilization === 0.6)
  check('warnAt: 0.6 does not cross the default 0.85 line', base.note(reading) === null)
}

{
  const weekly = createRateLimitMonitor({ fallbackWindow: 'seven_day' })
  const base = createRateLimitMonitor()
  // No top-level utilization and no window of its own: only the fallback window can answer.
  const bare = wireFrame(
    { status: 'allowed' },
    { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.7 } },
  )
  weekly.note(bare)
  base.note(bare)
  check('fallbackWindow: seven_day reads that window', weekly.latest()?.utilization === 0.7)
  check('fallbackWindow: the default reads five_hour', base.latest()?.utilization === 0.1)
}

{
  let clock = NOW_MS
  const timed = createRateLimitMonitor({ now: () => clock })
  timed.note(ALLOWED_WARNING_99)
  check('now: active() reads the injected clock before the reset', timed.active() !== null)
  clock = RESETS_AT * 1000
  check('now: and after it', timed.active() === null)
}

for (const [warnAt, message] of [
  [1.5, 'warnAt must be a number in [0, 1], got 1.5'],
  [-0.1, 'warnAt must be a number in [0, 1], got -0.1'],
  [Number.NaN, 'warnAt must be a number in [0, 1], got NaN'],
] as const) {
  let error: unknown = null
  try {
    createRateLimitMonitor({ warnAt })
  } catch (e) {
    error = e
  }
  check(
    `RangeError: ${message}`,
    error instanceof RangeError && error.message === message,
    String(error),
  )
}

check(
  'defaults: frozen, and an undefined option keeps its default',
  Object.isFrozen(RATE_LIMIT_DEFAULTS) &&
    createRateLimitMonitor({ warnAt: undefined }).note({
      status: 'allowed_warning',
      utilization: 0.85,
    }) !== null,
)

console.log('observe and instances:')

{
  const m = createRateLimitMonitor()
  const event = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', utilization: 0.9 },
  } as unknown as SDKMessage
  const other = { type: 'assistant', message: { content: [] } } as unknown as SDKMessage
  check('observe: an unrelated message gives null', m.observe(other) === null)
  check('observe: and changes nothing', m.latest() === null)
  check('observe: a rate_limit_event is noted', m.observe(event)?.utilization === 0.9)
  check('observe: the reading is held', m.latest()?.utilization === 0.9)
}

{
  const a = createRateLimitMonitor()
  const b = createRateLimitMonitor()
  a.note(ALLOWED_WARNING_99)
  check('instances: one reading never reaches another monitor', b.latest() === null)
  check('instances: each warns once on its own', b.note(ALLOWED_WARNING_99) !== null)
}

if (failures > 0) {
  console.error(`check-rate-limit-monitor: ${failures} failure(s)`)
  process.exit(1)
}
console.log('check-rate-limit-monitor: all green')
