// The public API of `agent-sdk-watchdog`.
export {
  createRateLimitMonitor,
  formatRateLimitReading,
  RATE_LIMIT_DEFAULTS,
  rateLimitResetIso,
  type RateLimitMonitor,
  type RateLimitMonitorConfig,
  type RateLimitWindow,
  type ResolvedRateLimitMonitorConfig,
} from './rate-limit-monitor.js'
export {
  installSdkWarningFilter,
  SHADOWED_CODE,
  WARNING_FILTER_DEFAULTS,
  type WarningFilterOptions,
} from './sdk-warning-filter.js'
export {
  createWatchdog,
  makeWatchdogHook,
  WATCHDOG_DEFAULTS,
  type ResolvedWatchdogConfig,
  type Watchdog,
  type WatchdogConfig,
  type WatchdogExtendReason,
  type WatchdogHandle,
  type WatchdogKill,
  type WatchdogKillKind,
  type WatchdogRegistration,
} from './watchdog.js'
